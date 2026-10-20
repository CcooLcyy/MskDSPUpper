use super::*;
use protocol::remote_access_service_server::{RemoteAccessService, RemoteAccessServiceServer};
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::sync::Notify;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Response, Status};

#[derive(Clone, Default)]
struct Platform {
    mode: Arc<AtomicU8>,
    revoke: Arc<Notify>,
}
#[tonic::async_trait]
impl RemoteAccessService for Platform {
    async fn list_devices(
        &self,
        _: Request<ListDevicesRequest>,
    ) -> std::result::Result<Response<ListDevicesResponse>, Status> {
        Ok(Response::new(ListDevicesResponse { devices: vec![] }))
    }
    type OpenTunnelStream = ReceiverStream<std::result::Result<TunnelFrame, Status>>;
    async fn open_tunnel(
        &self,
        request: Request<tonic::Streaming<TunnelFrame>>,
    ) -> std::result::Result<Response<Self::OpenTunnelStream>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer test-session"
        );
        let mut input = request.into_inner();
        let (tx, rx) = mpsc::channel(8);
        let mode = self.mode.load(Ordering::SeqCst);
        let revoke = self.revoke.clone();
        tokio::spawn(async move {
            assert!(matches!(
                input.message().await.unwrap().unwrap().payload,
                Some(Payload::Open(_))
            ));
            if mode == 4 {
                tx.send(Ok(frame(Payload::Data(vec![1])))).await.unwrap();
                return;
            }
            if tx
                .send(Ok(frame(Payload::Ready(TunnelReady {}))))
                .await
                .is_err()
            {
                return;
            }
            if mode == 1 {
                tx.send(Ok(frame(Payload::HalfClose(TunnelHalfClose {}))))
                    .await
                    .unwrap();
                revoke.notified().await;
                let _ = tx.send(Err(Status::permission_denied("授权撤销"))).await;
                return;
            }
            if mode == 2 {
                let _ = tx.send(Ok(frame(Payload::Data(vec![])))).await;
                return;
            }
            if mode == 3 {
                let _ = tx
                    .send(Ok(frame(Payload::HalfClose(TunnelHalfClose {}))))
                    .await;
                let _ = tx.send(Ok(frame(Payload::Data(vec![1])))).await;
                return;
            }
            if mode == 5 {
                let _ = tx
                    .send(Ok(frame(Payload::Data(vec![0; FRAME_LIMIT + 1]))))
                    .await;
                return;
            }
            if mode == 6 {
                let _ = tx.send(Ok(TunnelFrame { payload: None })).await;
                return;
            }
            while let Ok(Some(message)) = input.message().await {
                match message.payload.unwrap() {
                    Payload::Data(bytes) => {
                        assert!(bytes.len() <= FRAME_LIMIT);
                        if tx.send(Ok(frame(Payload::Data(bytes)))).await.is_err() {
                            break;
                        }
                    }
                    Payload::HalfClose(_) => {
                        let _ = tx.send(Ok(frame(Payload::Data(b"tail".to_vec())))).await;
                        let _ = tx
                            .send(Ok(frame(Payload::HalfClose(TunnelHalfClose {}))))
                            .await;
                        break;
                    }
                    _ => panic!("不合法的上位机隧道帧"),
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn platform(mode: u8) -> (String, Platform, JoinHandleAbort) {
    let service = Platform::default();
    service.mode.store(mode, Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(RemoteAccessServiceServer::new(service.clone()))
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    (endpoint, service, JoinHandleAbort(server.abort_handle()))
}
struct JoinHandleAbort(tokio::task::AbortHandle);
impl Drop for JoinHandleAbort {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    (local, listener.accept().await.unwrap().0)
}
fn device() -> RemoteDevice {
    RemoteDevice {
        device_id: "field".into(),
        display_name: "现场".into(),
        online: true,
        allow_grpc: true,
        allow_ssh: true,
        services: vec!["ModuleManager".into(), "ssh".into()],
        agent_version: "test".into(),
    }
}

#[test]
fn remote_control_uses_existing_http_endpoint_and_rejects_other_schemes_or_invalid_urls() {
    for endpoint in [
        "http://60.208.15.90:50000",
        "http://example.com:50000",
        "http://192.168.1.2:50000",
        "http://localhost:50000",
        "http://127.0.0.1:50000",
        "http://[::1]:50000",
    ] {
        validate_remote_endpoint(endpoint).unwrap();
    }
    for endpoint in [
        "https://example.com:50000",
        "http://name:password@localhost:50000",
        "file:///tmp/socket",
        "http://example.com/rpc",
        "http://example.com?token=secret",
        "http://example.com#fragment",
        "not-a-url",
    ] {
        assert!(validate_remote_endpoint(endpoint).is_err());
    }
}

#[tokio::test]
async fn remote_connection_can_select_existing_public_plaintext_endpoint() {
    let auth = Arc::new(PlatformAuthManager::test_session(
        "http://60.208.15.90:50000".into(),
    ));
    let remote = RemoteConnection::new(device(), auth).unwrap();
    assert!(remote.active());
    assert_eq!(remote.endpoint, "http://60.208.15.90:50000");
}

#[tokio::test]
async fn binary_echo_preserves_tail_after_local_half_close() {
    let (endpoint, _, _server) = platform(0).await;
    let (mut local, socket) = pair().await;
    let transfer = tokio::spawn(async move {
        tunnel(socket, &endpoint, "test-session", "field", "ModuleManager").await
    });
    let bytes: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
    local.write_all(&bytes).await.unwrap();
    local.shutdown().await.unwrap();
    let mut actual = Vec::new();
    timeout(Duration::from_secs(3), local.read_to_end(&mut actual))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual, [bytes, b"tail".to_vec()].concat());
    timeout(Duration::from_secs(3), transfer)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn remote_half_close_still_observes_revocation_while_local_input_idle() {
    let (endpoint, platform, _server) = platform(1).await;
    let (mut local, socket) = pair().await;
    let transfer =
        tokio::spawn(
            async move { tunnel(socket, &endpoint, "test-session", "field", "ssh").await },
        );
    let mut byte = [0];
    assert_eq!(
        timeout(Duration::from_secs(3), local.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    platform.revoke.notify_one();
    assert!(timeout(Duration::from_secs(3), transfer)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    // local 的写方向仍未关闭；撤销必须独立终止隧道。
    drop(local);
}

#[tokio::test]
async fn invalid_ready_empty_oversize_and_data_after_halfclose_are_rejected() {
    for mode in [2, 3, 4, 5, 6] {
        let (endpoint, _, _server) = platform(mode).await;
        let (_local, socket) = pair().await;
        assert!(
            timeout(
                Duration::from_secs(3),
                tunnel(socket, &endpoint, "test-session", "field", "ssh")
            )
            .await
            .unwrap()
            .is_err(),
            "mode {mode}"
        );
    }
}

#[tokio::test]
async fn switching_modes_cancels_listener_and_preserves_remote_when_restoring_direct_address() {
    let (endpoint, _, _server) = platform(0).await;
    let auth = Arc::new(PlatformAuthManager::test_session(endpoint));
    let remote = RemoteConnection::new(device(), auth).unwrap();
    let manager = crate::grpc::connection::ConnectionManager::new("192.0.2.1:17000".into());
    let old_generation = manager.runtime_generation();
    manager.select_remote(Some(remote.clone())).await;
    assert!(manager.is_remote());
    assert!(!manager.set_manager_addr("192.0.2.2:17000".into()));
    assert_eq!(manager.manager_addr(), "192.0.2.1:17000");
    assert!(!manager.update_module_addrs_if_generation(old_generation, HashMap::new()));
    let address = remote.adapter("ssh").await.unwrap();
    assert!(TcpStream::connect(&address).await.is_ok());
    manager.select_remote(None).await;
    assert!(!remote.active());
    timeout(Duration::from_secs(3), async {
        while TcpStream::connect(&address).await.is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(manager.set_manager_addr("192.0.2.2:17000".into()));
}

#[tokio::test]
async fn newly_loaded_module_is_not_blocked_by_initial_device_services() {
    let (endpoint, _, _server) = platform(0).await;
    let auth = Arc::new(PlatformAuthManager::test_session(endpoint));
    let remote = RemoteConnection::new(device(), auth).unwrap();
    // 初始列表不包含 Calc，新增服务访问交由平台使用当前白名单授权。
    assert!(remote.adapter("Calc").await.is_ok());
    assert!(remote.adapter("192.0.2.1:22").await.is_err());
}

#[tokio::test]
async fn cancellation_before_subscribe_is_observed_immediately() {
    let (cancel, _) = watch::channel(false);
    cancel.send_replace(true);
    timeout(
        Duration::from_millis(100),
        wait_canceled(cancel.subscribe()),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn logout_invalidates_remote_access_and_closes_listener() {
    let (endpoint, _, _server) = platform(0).await;
    let auth = Arc::new(PlatformAuthManager::test_session(endpoint));
    let remote = RemoteConnection::new(device(), auth.clone()).unwrap();
    let address = remote.adapter("ssh").await.unwrap();
    auth.logout().await.unwrap();
    assert!(!remote.active());
    timeout(Duration::from_secs(3), wait_canceled(remote.subscribe()))
        .await
        .unwrap();
    assert!(remote.adapter("ssh").await.is_err());
    timeout(Duration::from_secs(3), async {
        while TcpStream::connect(&address).await.is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn closing_one_service_does_not_cancel_other_service_or_device_selection() {
    let (endpoint, _, _server) = platform(0).await;
    let auth = Arc::new(PlatformAuthManager::test_session(endpoint));
    let remote = RemoteConnection::new(device(), auth).unwrap();
    let first = remote.adapter("Calc").await.unwrap();
    let second = remote.adapter("ModuleManager").await.unwrap();
    let mut closing = TcpStream::connect(first).await.unwrap();
    closing.shutdown().await.unwrap();
    let mut tail = Vec::new();
    closing.read_to_end(&mut tail).await.unwrap();
    assert!(remote.active());
    let mut other = TcpStream::connect(second).await.unwrap();
    other.write_all(b"still-online").await.unwrap();
    let mut bytes = [0; 12];
    timeout(Duration::from_secs(3), other.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"still-online");
}
