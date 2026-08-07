use std::sync::Arc;

use crate::grpc::connection::ConnectionManager;
use crate::{commands::app_storage::AppSettingsStore, runtime_paths::RuntimePaths};

pub struct AppState {
    pub conn_manager: Arc<ConnectionManager>,
    pub runtime_paths: RuntimePaths,
    pub settings_store: Arc<AppSettingsStore>,
}

impl AppState {
    pub fn new(manager_addr: String, runtime_paths: RuntimePaths) -> Self {
        let settings_store = Arc::new(AppSettingsStore::new(runtime_paths.settings_file()));
        Self {
            conn_manager: Arc::new(ConnectionManager::new(manager_addr)),
            runtime_paths,
            settings_store,
        }
    }
}
