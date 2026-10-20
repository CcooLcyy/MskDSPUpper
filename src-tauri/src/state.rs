use std::sync::Arc;

use crate::grpc::connection::ConnectionManager;
use crate::{commands::app_storage::AppSettingsStore, runtime_paths::RuntimePaths};

pub struct AppState {
    pub conn_manager: Arc<ConnectionManager>,
    pub runtime_paths: RuntimePaths,
    pub settings_store: Arc<AppSettingsStore>,
    pub app_updates: Arc<crate::commands::app_update::AppUpdateStore>,
    pub platform_auth: Arc<crate::platform_auth::PlatformAuthManager>,
}

impl AppState {
    pub fn new(manager_addr: String, runtime_paths: RuntimePaths) -> Self {
        let settings_store = Arc::new(AppSettingsStore::new(runtime_paths.settings_file()));
        let platform_auth = Arc::new(crate::platform_auth::PlatformAuthManager::new(
            runtime_paths.data_dir().join("platform-login.json"),
        ));
        Self {
            conn_manager: Arc::new(ConnectionManager::new(manager_addr)),
            runtime_paths,
            settings_store,
            app_updates: Arc::default(),
            platform_auth,
        }
    }
}
