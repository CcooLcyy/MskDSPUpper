pub mod proto;
pub mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new("127.0.0.1:7000".to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .run(tauri::generate_context!())
        .expect("failed to start MskDSP Upper");
}
