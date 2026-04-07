use std::sync::Arc;

use crate::grpc::connection::ConnectionManager;

pub struct AppState {
    pub conn_manager: Arc<ConnectionManager>,
}

impl AppState {
    pub fn new(manager_addr: String) -> Self {
        Self {
            conn_manager: Arc::new(ConnectionManager::new(manager_addr)),
        }
    }
}
