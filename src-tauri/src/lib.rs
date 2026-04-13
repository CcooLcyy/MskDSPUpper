pub mod commands;
pub mod grpc;
pub mod proto;
pub mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new("127.0.0.1:17000".to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::module_ops::set_manager_addr,
            commands::module_ops::get_module_info,
            commands::module_ops::get_running_module_info,
            commands::module_ops::start_module,
            commands::module_ops::stop_module,
            commands::iec104::iec104_upsert_link,
            commands::iec104::iec104_get_link,
            commands::iec104::iec104_list_links,
            commands::iec104::iec104_delete_link,
            commands::iec104::iec104_start_link,
            commands::iec104::iec104_stop_link,
            commands::iec104::iec104_upsert_point_table,
            commands::iec104::iec104_get_point_table,
            commands::iec104::iec104_send_time_sync,
            commands::modbus_rtu::modbus_rtu_update_config,
            commands::modbus_rtu::modbus_rtu_upsert_link,
            commands::modbus_rtu::modbus_rtu_get_link,
            commands::modbus_rtu::modbus_rtu_list_links,
            commands::modbus_rtu::modbus_rtu_delete_link,
            commands::modbus_rtu::modbus_rtu_start_link,
            commands::modbus_rtu::modbus_rtu_stop_link,
            commands::modbus_rtu::modbus_rtu_upsert_point_table,
            commands::modbus_rtu::modbus_rtu_get_point_table,
            commands::dlt645::dlt645_update_config,
            commands::dlt645::dlt645_upsert_link,
            commands::dlt645::dlt645_get_link,
            commands::dlt645::dlt645_list_links,
            commands::dlt645::dlt645_delete_link,
            commands::dlt645::dlt645_start_link,
            commands::dlt645::dlt645_stop_link,
            commands::dlt645::dlt645_upsert_point_table,
            commands::dlt645::dlt645_get_point_table,
            commands::data_center::dc_list_connections,
            commands::data_center::dc_get_conn_tags,
            commands::data_center::dc_list_routes,
            commands::data_center::dc_upsert_routes,
            commands::data_center::dc_delete_routes,
            commands::data_center::dc_get_latest,
            commands::agc::agc_upsert_group,
            commands::agc::agc_get_group,
            commands::agc::agc_list_groups,
            commands::agc::agc_delete_group,
            commands::agc::agc_start_group,
            commands::agc::agc_stop_group,
            commands::export_config::save_full_config_export,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start MskDSP Upper");
}
