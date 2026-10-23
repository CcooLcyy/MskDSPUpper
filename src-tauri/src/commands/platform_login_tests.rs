use super::*;
use crate::{
    platform_auth::PlatformAuthManager,
    remote_access::{RemoteConnection, RemoteDevice},
    runtime_paths::RuntimePaths,
};
use std::sync::Arc;
use tauri::Manager;

// 页面刷新不会销毁 Rust 状态，退出必须主动丢弃设备和缓存，同时保留现场地址设置。
#[tokio::test]
async fn logout_clears_selected_device_and_runtime_cache_without_resetting_direct_address() {
    let mut state = AppState::new("192.0.2.1:17999".into(), RuntimePaths::discover().unwrap());
    state.platform_auth = Arc::new(PlatformAuthManager::test_session(
        "http://127.0.0.1:1".into(),
    ));
    let remote = RemoteConnection::new(
        RemoteDevice {
            device_id: "old-account-device".into(),
            display_name: "原账号设备".into(),
            online: true,
            allow_grpc: true,
            allow_ssh: true,
            services: vec!["ModuleManager".into()],
            agent_version: "test".into(),
        },
        state.platform_auth.clone(),
    )
    .unwrap();
    state.conn_manager.select_remote(Some(remote.clone())).await;
    state
        .conn_manager
        .update_module_addr("IEC104", "192.0.2.1:17543");
    let generation = state.conn_manager.runtime_generation();
    let app = tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    let status = platform_logout(app.state()).await.unwrap();
    let state = app.state::<AppState>();
    assert!(!status.authenticated);
    assert!(!remote.active());
    assert!(state.conn_manager.remote_connection().is_none());
    assert!(state.conn_manager.get_module_addr("IEC104").is_none());
    assert!(state.conn_manager.runtime_generation() > generation);
    assert_eq!(state.conn_manager.manager_addr(), "192.0.2.1:17999");
    assert!(state.platform_auth.auto_login().await.is_err());
}
