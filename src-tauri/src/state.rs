use std::sync::Arc;

use crate::grpc::connection::ConnectionManager;
use crate::protocol_shadow::ProtocolShadowRuntime;

pub struct AppState {
    pub conn_manager: Arc<ConnectionManager>,
    pub protocol_shadow: Arc<ProtocolShadowRuntime>,
}

impl AppState {
    pub fn new(manager_addr: String) -> Self {
        Self {
            conn_manager: Arc::new(ConnectionManager::new(manager_addr)),
            protocol_shadow: Arc::new(ProtocolShadowRuntime::default()),
        }
    }
}
