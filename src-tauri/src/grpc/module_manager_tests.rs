use super::*;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

#[allow(dead_code)]
mod service {
    tonic::include_proto!("module_manager_proto");
}
use service::module_manage_server::{ModuleManage, ModuleManageServer};

#[derive(Clone)]
struct Manager {
    stall: bool,
}

#[tonic::async_trait]
impl ModuleManage for Manager {
    async fn get_module_info(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::ModuleInfos>, Status> {
        if self.stall {
            std::future::pending::<()>().await;
        }
        Ok(Response::new(service::ModuleInfos::default()))
    }
    async fn get_running_module_info(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::ModuleRunningInfos>, Status> {
        if self.stall {
            std::future::pending::<()>().await;
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
        Err(Status::unimplemented("测试未使用此操作"))
    }
    async fn stop_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("测试未使用此操作"))
    }
    async fn upload_module(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("测试未使用此操作"))
    }
    async fn delete_module(
        &self,
        _: Request<service::ModuleInfo>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("测试未使用此操作"))
    }
    async fn save_module_start_config(
        &self,
        _: Request<service::ModuleInfos>,
    ) -> Result<Response<service::Empty>, Status> {
        Err(Status::unimplemented("测试未使用此操作"))
    }
    async fn get_platform_access_config(
        &self,
        _: Request<service::Empty>,
    ) -> Result<Response<service::PlatformAccessStatus>, Status> {
        Err(Status::unimplemented("测试未使用此操作"))
    }
    async fn set_platform_access_config(
        &self,
        _: Request<service::SetPlatformAccessConfigRequest>,
    ) -> Result<Response<service::PlatformAccessStatus>, Status> {
        Err(Status::unimplemented("测试未使用此操作"))
    }
}

struct Server(tokio::task::AbortHandle);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn manager(stall: bool) -> (ConnectionManager, Server) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let connection = ConnectionManager::new(listener.local_addr().unwrap().to_string());
    let server = tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(ModuleManageServer::new(Manager { stall }))
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    (connection, Server(server.abort_handle()))
}

// 正常现场直连仍返回两类列表，并解析模块监听通配地址。
#[tokio::test]
async fn direct_module_lists_still_return_successfully() {
    let (connection, _server) = manager(false).await;
    let client = ModuleManagerClient::new(&connection);
    assert!(client.get_module_info().await.unwrap().is_empty());
    assert_eq!(client.get_running_module_info().await.unwrap().len(), 1);
    assert_eq!(
        connection.get_module_addr("IEC104").as_deref(),
        Some("127.0.0.1:17234")
    );
}

// 服务已经接受 gRPC，但不返回可用模块列表时，现场直连应在五秒预算后退出。
#[tokio::test]
async fn direct_available_list_has_bounded_rpc_wait() {
    let (connection, _server) = manager(true).await;
    let client = ModuleManagerClient::new(&connection);
    let error = tokio::time::timeout(Duration::from_secs(6), client.get_module_info())
        .await
        .expect("可用模块列表未在六秒内退出")
        .unwrap_err();
    assert!(error.to_string().contains("现场直连") && error.to_string().contains("超时"));
}

// 服务不返回运行模块列表时，同样应超时，且不能覆盖之前的地址缓存。
#[tokio::test]
async fn direct_running_list_has_bounded_rpc_wait() {
    let (connection, _server) = manager(true).await;
    connection.update_module_addr("old", "127.0.0.1:1");
    let client = ModuleManagerClient::new(&connection);
    let error = tokio::time::timeout(Duration::from_secs(6), client.get_running_module_info())
        .await
        .expect("运行模块列表未在六秒内退出")
        .unwrap_err();
    assert!(error.to_string().contains("现场直连") && error.to_string().contains("超时"));
    assert_eq!(
        connection.get_module_addr("old").as_deref(),
        Some("127.0.0.1:1")
    );
}

// TCP 接受连接后不应答 HTTP/2 时，建连与读取也受同一个总预算约束。
#[tokio::test]
async fn direct_silent_peer_has_bounded_total_wait() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let connection = ConnectionManager::new(listener.local_addr().unwrap().to_string());
    let peer = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let _peer = Server(peer.abort_handle());
    let client = ModuleManagerClient::new(&connection);
    let error = tokio::time::timeout(Duration::from_secs(6), client.get_module_info())
        .await
        .expect("静默连接未在六秒内退出")
        .unwrap_err();
    assert!(error.to_string().contains("现场直连") && error.to_string().contains("超时"));
}
