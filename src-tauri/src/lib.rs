pub mod commands;
pub mod grpc;
pub mod proto;
pub mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new("127.0.0.1:7000".to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::module_ops::set_manager_addr,
            commands::module_ops::get_module_info,
            commands::module_ops::get_running_module_info,
            commands::module_ops::start_module,
            commands::module_ops::stop_module,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start MskDSP Upper");
}
