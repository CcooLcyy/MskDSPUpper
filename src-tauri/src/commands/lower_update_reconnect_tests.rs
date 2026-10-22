use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
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

#[derive(Clone, Default)]
struct Manager {
    info_calls: Arc<AtomicUsize>,
    running_calls: Arc<AtomicUsize>,
    fail_running: Arc<AtomicBool>,
    block_running: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[tonic::async_trait]
impl ModuleManage for Manager {
    async fn get_module_info(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::ModuleInfos>, Status> {
        self.info_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Response::new(service::ModuleInfos::default()))
    }
    async fn get_running_module_info(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::ModuleRunningInfos>, Status> {
        self.running_calls.fetch_add(1, Ordering::SeqCst);
        if self.block_running.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        if self.fail_running.load(Ordering::SeqCst) {
            return Err(Status::unavailable("starting"));
        }
        Ok(Response::new(service::ModuleRunningInfos {
            module_running_info: vec![service::ModuleRunningInfo {
                module_name: "IEC104".into(),
                outer_grpc_server: "0.0.0.0:17234".into(),
                ..Default::default()
            }],
        }))
    }
    async fn start_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn stop_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn upload_module(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn delete_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn save_module_start_config(
        &self,
        _: Request<service::ModuleInfos>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn get_platform_access_config(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::PlatformAccessStatus>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn set_platform_access_config(
        &self,
        _: Request<service::SetPlatformAccessConfigRequest>,
    ) -> Result<Response<service::PlatformAccessStatus>, Status> {
        Err(Status::unimplemented("unused"))
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
    let connection = Arc::new(ConnectionManager::new(
        listener.local_addr().unwrap().to_string(),
    ));
    let manager = Manager::default();
    let server = tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(ModuleManageServer::new(manager.clone()))
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    (connection, manager, Server(server.abort_handle()))
}

fn request() -> LowerUpdateReconnectRequestDto {
    LowerUpdateReconnectRequestDto {
        upload_account: "user@127.0.0.1:10022".into(),
        remote_target: None,
    }
}

// 真实随机 localhost RPC 验证两类列表均被查询，并重新解析设备通配地址。
#[tokio::test]
async fn real_rpc_refreshes_both_lists_and_replaces_old_module_addresses() {
    let (connection, manager, _server) = manager().await;
    let address = connection.manager_addr();
    connection.update_module_addr("old", "127.0.0.1:1");
    assert!(reconnect_runtime(&connection, request()).await.unwrap());
    assert_eq!(manager.info_calls.load(Ordering::SeqCst), 1);
    assert_eq!(manager.running_calls.load(Ordering::SeqCst), 1);
    assert_eq!(connection.manager_addr(), address);
    assert_eq!(
        connection.get_module_addr("IEC104").as_deref(),
        Some("127.0.0.1:17234")
    );
    assert!(connection.get_module_addr("old").is_none());
}

// 在 RPC 内设置同步屏障，确定性覆盖更新期间用户切换设备的竞态。
#[tokio::test]
async fn real_rpc_in_flight_target_change_cannot_publish_previous_device_addresses() {
    let (connection, manager, _server) = manager().await;
    manager.block_running.store(true, Ordering::SeqCst);
    let worker_connection = connection.clone();
    let task = tokio::spawn(async move { reconnect_runtime(&worker_connection, request()).await });
    tokio::time::timeout(Duration::from_secs(3), manager.entered.notified())
        .await
        .unwrap();
    connection.set_manager_addr("next-device:17999".into());
    connection.clear_runtime_cache();
    connection.update_module_addr("new", "next-device:17001");
    manager.release.notify_one();
    assert!(!task.await.unwrap().unwrap());
    assert_eq!(
        connection.get_module_addr("new").as_deref(),
        Some("next-device:17001")
    );
    assert!(connection.get_module_addr("IEC104").is_none());
}

// 首个 RPC 成功而第二个失败时保持原缓存，重试完整成功后才整体发布。
#[tokio::test]
async fn real_rpc_partial_failure_preserves_previous_cache_until_retry_succeeds() {
    let (connection, manager, _server) = manager().await;
    manager.fail_running.store(true, Ordering::SeqCst);
    connection.update_module_addr("old", "127.0.0.1:1");
    let generation = connection.runtime_generation();
    assert!(reconnect_runtime(&connection, request()).await.is_err());
    assert_eq!(connection.runtime_generation(), generation);
    assert_eq!(
        connection.get_module_addr("old").as_deref(),
        Some("127.0.0.1:1")
    );
    manager.fail_running.store(false, Ordering::SeqCst);
    assert!(reconnect_runtime(&connection, request()).await.unwrap());
    assert!(connection.get_module_addr("old").is_none());
}
