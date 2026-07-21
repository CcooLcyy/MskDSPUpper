pub mod commands;
pub mod grpc;
pub mod logging;
pub mod proto;
pub mod protocol_shadow;
pub mod runtime_paths;
pub mod state;

use state::AppState;
use std::time::Duration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_paths = runtime_paths::RuntimePaths::discover()
        .unwrap_or_else(|error| panic!("初始化上位机运行目录失败: {error}"));
    match logging::init(runtime_paths.log_dir()) {
        Ok(log_path) => tracing::info!(log_path = %log_path.display(), "上位机运行日志已初始化"),
        Err(error) => {
            eprintln!("上位机运行日志初始化失败: {error}");
            let _ = tracing_subscriber::fmt()
                .with_writer(std::io::stderr)
                .with_ansi(false)
                .with_target(false)
                .with_max_level(tracing::Level::INFO)
                .try_init();
            tracing::error!(error = %error, "上位机运行日志文件不可用，已切换到标准错误输出");
        }
    }

    tracing::info!(
        pid = std::process::id(),
        app_version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "上位机进程启动"
    );
    match runtime_paths::cleanup_stale_updater_directories(Duration::from_secs(24 * 60 * 60)) {
        Ok(removed) if removed > 0 => tracing::info!(removed, "已清理过期的上位机更新临时目录"),
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "清理上位机更新临时目录失败"),
    }
    let startup_cache_root = runtime_paths.lower_update_dir();
    match runtime_paths::migrate_legacy_lower_update_cache(&startup_cache_root) {
        Ok(migrated_files) if migrated_files > 0 => {
            tracing::info!(migrated_files, "已迁移旧版下位机更新缓存")
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "迁移旧版下位机更新缓存失败"),
    }
    let app_state = AppState::new("127.0.0.1:17000".to_string(), runtime_paths);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .setup(move |_| {
            let cache_root = startup_cache_root.clone();
            tauri::async_runtime::spawn(async move {
                match commands::lower_update::cleanup_lower_update_cache_startup(&cache_root).await
                {
                    Ok(result) if result.removed_files > 0 => tracing::info!(
                        removed_files = result.removed_files,
                        reclaimed_bytes = result.reclaimed_bytes,
                        "已完成下位机更新缓存启动清理"
                    ),
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "下位机更新缓存启动清理失败"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_storage::load_app_settings,
            commands::app_storage::save_app_setting,
            commands::app_storage::migrate_legacy_app_settings,
            commands::app_storage::get_runtime_paths,
            commands::app_storage::open_runtime_directory,
            commands::module_ops::set_manager_addr,
            commands::module_ops::get_module_info,
            commands::module_ops::get_running_module_info,
            commands::module_ops::start_module,
            commands::module_ops::stop_module,
            commands::iec104::iec104_upsert_link,
            commands::iec104::iec104_rename_link,
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
            commands::modbus_rtu::modbus_rtu_rename_link,
            commands::modbus_rtu::modbus_rtu_get_link,
            commands::modbus_rtu::modbus_rtu_list_links,
            commands::modbus_rtu::modbus_rtu_delete_link,
            commands::modbus_rtu::modbus_rtu_start_link,
            commands::modbus_rtu::modbus_rtu_stop_link,
            commands::modbus_rtu::modbus_rtu_upsert_point_table,
            commands::modbus_rtu::modbus_rtu_get_point_table,
            commands::dlt645::dlt645_update_config,
            commands::dlt645::dlt645_upsert_link,
            commands::dlt645::dlt645_rename_link,
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
            commands::data_center::dc_start_protocol_shadow_stream,
            commands::data_center::dc_get_protocol_shadow_latest,
            commands::agc::agc_upsert_group,
            commands::agc::agc_get_group,
            commands::agc::agc_list_groups,
            commands::agc::agc_delete_group,
            commands::agc::agc_start_group,
            commands::agc::agc_stop_group,
            commands::avc::avc_upsert_group,
            commands::avc::avc_rename_group,
            commands::avc::avc_get_group,
            commands::avc::avc_list_groups,
            commands::avc::avc_delete_group,
            commands::avc::avc_start_group,
            commands::avc::avc_stop_group,
            commands::export_config::save_full_config_export,
            commands::export_config::load_full_config_export,
            commands::lower_update::check_lower_update,
            commands::lower_update::get_lower_update_runtime_info,
            commands::lower_update::download_lower_update,
            commands::lower_update::upload_lower_update_package,
            commands::lower_update::install_lower_update_package,
            commands::lower_update::get_lower_update_password,
            commands::lower_update::clear_lower_update_password,
            commands::lower_update::clear_lower_update_cache,
        ])
        .run(tauri::generate_context!())
        .map_err(|error| {
            tracing::error!(error = %error, "上位机运行失败");
            error
        })
        .expect("启动 MskDSP 上位机失败");

    tracing::info!("上位机进程退出");
}
