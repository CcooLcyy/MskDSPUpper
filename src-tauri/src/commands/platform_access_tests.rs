use super::*;
use parking_lot::Mutex;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use tokio::{net::TcpListener, sync::Notify};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

#[allow(dead_code)]
mod service {
    tonic::include_proto!("module_manager_proto");
}
use service::module_manage_server::{ModuleManage, ModuleManageServer};
#[derive(Clone)]
struct Manager {
    state: Arc<Mutex<service::PlatformAccessStatus>>,
    requests: Arc<Mutex<Vec<service::SetPlatformAccessConfigRequest>>>,
    mode: Arc<AtomicU8>,
    wait_read: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}
impl Default for Manager {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(service::PlatformAccessStatus {
                platform_target: PLATFORM_TARGET.into(),
                device_id: "field-1".into(),
                token_configured: true,
                ssh_port: 22,
                revision: 9_007_199_254_740_993,
                ..Default::default()
            })),
            requests: Arc::default(),
            mode: Arc::default(),
            wait_read: Arc::default(),
            entered: Arc::default(),
            release: Arc::default(),
        }
    }
}
#[tonic::async_trait]
impl ModuleManage for Manager {
    async fn get_platform_access_config(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::PlatformAccessStatus>, Status> {
        if self.mode.load(Ordering::SeqCst) == 1 {
            return Err(Status::unimplemented("legacy-device"));
        }
        if self.wait_read.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(Response::new(self.state.lock().clone()))
    }
    async fn set_platform_access_config(
        &self,
        request: Request<service::SetPlatformAccessConfigRequest>,
    ) -> Result<Response<service::PlatformAccessStatus>, Status> {
        let request = request.into_inner();
        self.requests.lock().push(request.clone());
        if self.mode.load(Ordering::SeqCst) == 2 {
            return Err(Status::failed_precondition("network-secret-detail"));
        }
        let mut state = self.state.lock();
        if request.expected_revision != state.revision {
            return Err(Status::aborted("server-detail-must-not-escape"));
        }
        state.enabled = request.enabled;
        state.device_id = request.device_id;
        state.ssh_enabled = request.ssh_enabled;
        state.ssh_port = request.ssh_port;
        if let Some(network) = request.network_config {
            state.network_config = Some(network);
            state.network_applied = true;
        }
        if request.clear_device_token {
            state.token_configured = false;
        } else if !request.device_token.is_empty() {
            state.token_configured = true;
        }
        state.revision += 1;
        Ok(Response::new(state.clone()))
    }
    async fn get_module_info(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::ModuleInfos>, Status> {
        Ok(Response::new(service::ModuleInfos::default()))
    }
    async fn get_running_module_info(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::ModuleRunningInfos>, Status> {
        Ok(Response::new(service::ModuleRunningInfos::default()))
    }
    async fn start_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Ok(Response::new(service::Empty {}))
    }
    async fn stop_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Ok(Response::new(service::Empty {}))
    }
    async fn upload_module(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::Empty>, Status> {
        Ok(Response::new(service::Empty {}))
    }
    async fn delete_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Ok(Response::new(service::Empty {}))
    }
    async fn save_module_start_config(
        &self,
        _: Request<service::ModuleInfos>,
    ) -> Result<Response<service::Empty>, Status> {
        Ok(Response::new(service::Empty {}))
    }
}
struct Server(tokio::task::AbortHandle);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn manager() -> (Arc<ConnectionManager>, Manager, Server) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let conn = Arc::new(ConnectionManager::new(
        listener.local_addr().unwrap().to_string(),
    ));
    let manager = Manager::default();
    let server = tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(ModuleManageServer::new(manager.clone()))
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    (conn, manager, Server(server.abort_handle()))
}
fn request(status: &PlatformAccessDto) -> PlatformAccessWriteDto {
    PlatformAccessWriteDto {
        expected_revision: status.revision.clone(),
        enabled: true,
        device_id: status.device_id.clone(),
        device_token: String::new(),
        ssh_enabled: true,
        ssh_port: 0,
        clear_device_token: false,
        connection_generation: status.connection_generation.clone(),
        manager_address: status.manager_address.clone(),
        network_config: None,
    }
}

#[tokio::test]
async fn real_manager_rpc_preserves_empty_token_and_exact_revision_without_secret_readback() {
    let (conn, manager, _server) = manager().await;
    let status = read(&conn).await.unwrap();
    assert_eq!(status.revision, "9007199254740993");
    assert!(status.token_configured);
    let updated = write(&conn, request(&status)).await.unwrap();
    assert_eq!(updated.revision, "9007199254740994");
    assert!(!updated.online);
    assert!(manager.requests.lock()[0].device_token.is_empty());
    assert_eq!(manager.requests.lock()[0].ssh_port, 22);
    let mut changed = request(&updated);
    changed.device_token = "new-device-secret".into();
    let updated = write(&conn, changed).await.unwrap();
    let json = serde_json::to_string(&updated).unwrap();
    assert!(!json.contains("new-device-secret"));
    assert!(!json.contains("device_token"));
}

#[tokio::test]
async fn conflict_and_legacy_device_errors_are_explicit_and_do_not_retry_or_leak_details() {
    let (conn, manager, _server) = manager().await;
    let status = read(&conn).await.unwrap();
    manager.state.lock().revision += 1;
    let error = write(&conn, request(&status)).await.err().unwrap();
    assert_eq!(error.kind, "revision_conflict");
    assert!(error.message.contains("重新读取"));
    assert!(!error.message.contains("server-detail"));
    assert_eq!(manager.requests.lock().len(), 1);
    manager.mode.store(1, Ordering::SeqCst);
    let error = read(&conn).await.err().unwrap();
    assert_eq!(error.kind, "unsupported");
    assert!(error.message.contains("升级"));
}

#[tokio::test]
async fn prior_device_write_context_is_rejected_before_rpc_is_sent() {
    let (conn, manager, _server) = manager().await;
    let status = read(&conn).await.unwrap();
    conn.clear_runtime_cache();
    let error = write(&conn, request(&status)).await.err().unwrap();
    assert_eq!(error.kind, "connection_changed");
    assert!(manager.requests.lock().is_empty());
}

#[tokio::test]
async fn pending_response_cannot_overwrite_after_connection_switch() {
    let (conn, manager, _server) = manager().await;
    manager.wait_read.store(true, Ordering::SeqCst);
    let reading = conn.clone();
    let pending = tokio::spawn(async move { read(&reading).await });
    manager.entered.notified().await;
    conn.set_manager_addr("127.0.0.1:1".into());
    conn.clear_runtime_cache();
    manager.release.notify_one();
    let error = pending.await.unwrap().err().unwrap();
    assert_eq!(error.kind, "connection_changed");
}

#[tokio::test]
async fn remote_mode_is_rejected_without_contacting_lower_manager() {
    let (conn, manager, _server) = manager().await;
    let previous = read(&conn).await.unwrap();
    let auth = Arc::new(crate::platform_auth::PlatformAuthManager::test_session(
        "http://127.0.0.1:1".into(),
    ));
    let remote = crate::remote_access::RemoteConnection::new(
        crate::remote_access::RemoteDevice {
            device_id: "other".into(),
            display_name: "other".into(),
            online: true,
            allow_grpc: true,
            allow_ssh: false,
            services: vec!["ModuleManager".into()],
            agent_version: "test".into(),
        },
        auth,
    )
    .unwrap();
    conn.select_remote(Some(remote)).await;
    assert_eq!(read(&conn).await.err().unwrap().kind, "direct_only");
    assert_eq!(
        write(&conn, request(&previous)).await.err().unwrap().kind,
        "direct_only"
    );
    assert!(manager.requests.lock().is_empty());
}

#[test]
fn write_validation_rejects_conflicting_tokens_and_invalid_identifiers_without_echoing_secrets() {
    let status = PlatformAccessDto {
        enabled: false,
        platform_target: PLATFORM_TARGET,
        device_id: "field".into(),
        token_configured: true,
        ssh_enabled: false,
        ssh_port: 22,
        revision: "0".into(),
        online: false,
        last_error: String::new(),
        connection_generation: "0".into(),
        manager_address: "127.0.0.1:17000".into(),
        network_config: None,
        network_applied: false,
        network_error: String::new(),
        network_source_address: String::new(),
    };
    let mut invalid = request(&status);
    invalid.device_token = "private-secret".into();
    invalid.clear_device_token = true;
    let error = invalid.into_proto().err().unwrap();
    assert_eq!(error.kind, "invalid");
    assert!(!error.message.contains("private-secret"));
    let mut invalid = request(&status);
    invalid.device_id = "not/a/device".into();
    assert!(invalid.into_proto().is_err());
}

// 普通网络与平台启停独立，省略配置保留原值，网络错误不得泄露远端详情。
#[tokio::test]
async fn ordinary_network_roundtrips_and_apply_failure_is_explicit() {
    let (conn, manager, _server) = manager().await;
    manager.state.lock().network_config = Some(service::OrdinaryNetworkConfig::default());
    let status = read(&conn).await.unwrap();
    assert!(status.network_config.is_some());
    let mut update = request(&status);
    update.enabled = false;
    update.network_config = Some(OrdinaryNetworkDto {
        interface_name: "eth0.102".into(),
        gateway: "192.168.2.1".into(),
        dns_servers: vec!["192.168.2.1".into()],
    });
    let saved = write(&conn, update).await.unwrap();
    assert_eq!(
        saved.network_config.as_ref().unwrap().interface_name,
        "eth0.102"
    );
    assert!(saved.network_applied);
    assert!(!saved.enabled);
    let saved = write(&conn, request(&saved)).await.unwrap();
    assert!(saved.network_config.is_some());
    assert!(manager
        .requests
        .lock()
        .last()
        .unwrap()
        .network_config
        .is_none());
    manager.mode.store(2, Ordering::SeqCst);
    let error = write(&conn, request(&saved)).await.err().unwrap();
    assert_eq!(error.kind, "network_apply_failed");
    assert!(!error.message.contains("network-secret-detail"));
}

// 旧服务端缺少支持声明时，新的网络字段不得被静默忽略。
#[tokio::test]
async fn legacy_network_configuration_is_rejected_before_write() {
    let (conn, manager, _server) = manager().await;
    let status = read(&conn).await.unwrap();
    let mut update = request(&status);
    update.network_config = Some(OrdinaryNetworkDto {
        interface_name: String::new(),
        gateway: String::new(),
        dns_servers: vec![],
    });
    assert_eq!(
        write(&conn, update).await.err().unwrap().kind,
        "unsupported"
    );
    assert!(manager.requests.lock().is_empty());
    assert!(write(&conn, request(&status)).await.is_ok());
}

// Rust 边界独立校验网口、IPv4 网关和 DNS，防止绕过前端校验。
#[test]
fn ordinary_network_validation_rejects_invalid_values() {
    for (interface, gateway, dns) in [
        ("ppp0", "192.168.2.1", "8.8.8.8"),
        ("eth0.102", "192.168.2.999", "8.8.8.8"),
        ("eth0.102", "192.168.2.1", "8.8.8.999"),
        ("eth0.102", "192.168.2.1", "127.0.0.1"),
        ("", "192.168.2.1", "8.8.8.8"),
    ] {
        let value = OrdinaryNetworkDto {
            interface_name: interface.into(),
            gateway: gateway.into(),
            dns_servers: vec![dns.into()],
        };
        assert!(value.into_proto().is_err());
    }
}

#[tokio::test]
async fn total_deadline_bounds_an_unresponsive_local_tcp_peer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let conn = ConnectionManager::new(listener.local_addr().unwrap().to_string());
    // 只接收 TCP，不回复 HTTP/2：通道建立或首个 RPC 均不能无限等待。
    let blocked = tokio::spawn(async move {
        let _socket = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        read_before(
            &conn,
            tokio::time::Instant::now() + Duration::from_millis(50),
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.err().unwrap().kind, "timeout");
    blocked.abort();
}
