use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::commands::data_center::PointUpdateDto;
use crate::grpc::{
    connection::ConnectionManager, data_center::DataCenterClient, dlt645::Dlt645Client,
    iec104::Iec104Client, modbus_rtu::ModbusRtuClient, module_manager::ModuleManagerClient,
};
use crate::proto::data_center_proto::{
    ConnectionInfo, Endpoint, GetLatestRequest, ListRoutesRequest, Route, SubscribeRequest,
};

pub const PROTOCOL_SHADOW_MODULE_NAME: &str = "MskDSPUpper";
pub const PROTOCOL_SHADOW_CONN_NAME: &str = "__protocol_shadow__";
pub const PROTOCOL_SHADOW_UPDATE_EVENT: &str = "protocol-shadow-update";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolShadowModule {
    Iec104,
    ModbusRtu,
    Dlt645,
}

impl ProtocolShadowModule {
    pub fn module_name(self) -> &'static str {
        match self {
            Self::Iec104 => "IEC104",
            Self::ModbusRtu => "ModbusRTU",
            Self::Dlt645 => "DLT645",
        }
    }
}

#[derive(Default)]
pub struct ProtocolShadowRuntime {
    stream_task: Mutex<Option<JoinHandle<()>>>,
}

impl ProtocolShadowRuntime {
    pub fn stop(&self) {
        if let Some(handle) = self.stream_task.lock().take() {
            handle.abort();
        }
    }

    pub fn ensure_started(&self, app_handle: AppHandle, conn_manager: Arc<ConnectionManager>) {
        let mut guard = self.stream_task.lock();

        if let Some(handle) = guard.as_ref() {
            if !handle.is_finished() {
                return;
            }
        }

        if let Some(handle) = guard.take() {
            handle.abort();
        }

        *guard = Some(tokio::spawn(run_protocol_shadow_stream(
            app_handle,
            conn_manager,
        )));
    }
}

pub async fn sync_all_protocol_shadow(conn_manager: &ConnectionManager) -> Result<ConnectionInfo> {
    let _ = refresh_running_module_cache(conn_manager).await;

    let shadow = ensure_protocol_shadow_connection(conn_manager).await?;

    for module in [
        ProtocolShadowModule::Iec104,
        ProtocolShadowModule::ModbusRtu,
        ProtocolShadowModule::Dlt645,
    ] {
        let _ = sync_protocol_shadow_module(conn_manager, module).await;
    }

    Ok(shadow)
}

pub async fn sync_protocol_shadow_module(
    conn_manager: &ConnectionManager,
    module: ProtocolShadowModule,
) -> Result<()> {
    let shadow = ensure_protocol_shadow_connection(conn_manager).await?;
    let dc_client = DataCenterClient::new(conn_manager);
    let connections = dc_client.list_connections().await?;
    let conn_module_map: HashMap<u32, String> = connections
        .conns
        .into_iter()
        .map(|connection| (connection.conn_id, connection.module_name))
        .collect();

    let existing_shadow_routes = dc_client
        .list_routes(ListRoutesRequest {
            src_conn_id: 0,
            src_tag: String::new(),
            dst_conn_id: shadow.conn_id,
            dst_tag: String::new(),
        })
        .await?
        .routes;

    let mut current_module_routes = Vec::new();
    let mut preserved_routes = Vec::new();

    for route in existing_shadow_routes {
        let Some(src) = route.src.as_ref() else {
            continue;
        };

        let route_module_name = conn_module_map
            .get(&src.conn_id)
            .map(String::as_str)
            .unwrap_or_default();

        if route_module_name == module.module_name() {
            current_module_routes.push(route);
        } else {
            preserved_routes.push(route);
        }
    }

    let desired_routes =
        collect_shadow_routes_for_module(conn_manager, module, shadow.conn_id).await?;
    let current_route_keys: HashSet<String> =
        current_module_routes.iter().filter_map(route_key).collect();
    let desired_route_keys: HashSet<String> = desired_routes.iter().filter_map(route_key).collect();

    let routes_to_delete: Vec<Route> = current_module_routes
        .into_iter()
        .filter(|route| {
            route_key(route)
                .map(|key| !desired_route_keys.contains(&key))
                .unwrap_or(false)
        })
        .collect();

    if !routes_to_delete.is_empty() {
        dc_client.delete_routes(routes_to_delete).await?;
    }

    let combined_routes = preserved_routes
        .iter()
        .cloned()
        .chain(desired_routes.iter().cloned())
        .collect::<Vec<_>>();
    let combined_tags = combined_routes
        .iter()
        .filter_map(|route| route.dst.as_ref().map(|endpoint| endpoint.tag.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    dc_client
        .upsert_conn_tags(shadow.conn_id, combined_tags, true)
        .await?;

    let routes_to_upsert: Vec<Route> = desired_routes
        .into_iter()
        .filter(|route| {
            route_key(route)
                .map(|key| !current_route_keys.contains(&key))
                .unwrap_or(false)
        })
        .collect();

    if !routes_to_upsert.is_empty() {
        dc_client.upsert_routes(routes_to_upsert, false).await?;
    }

    Ok(())
}

pub async fn get_protocol_shadow_latest(
    conn_manager: &ConnectionManager,
    source_conn_id: u32,
    source_tags: Vec<String>,
) -> Result<Vec<crate::proto::data_center_proto::PointUpdate>> {
    let shadow = ensure_protocol_shadow_connection(conn_manager).await?;
    let dc_client = DataCenterClient::new(conn_manager);
    let shadow_tags = if source_tags.is_empty() {
        dc_client
            .list_routes(ListRoutesRequest {
                src_conn_id: source_conn_id,
                src_tag: String::new(),
                dst_conn_id: shadow.conn_id,
                dst_tag: String::new(),
            })
            .await?
            .routes
            .into_iter()
            .filter_map(|route| route.dst.map(|endpoint| endpoint.tag))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        source_tags
            .into_iter()
            .map(|tag| shadow_tag_for_source(source_conn_id, &tag))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    };

    let resp = dc_client
        .get_latest(GetLatestRequest {
            conn_id: shadow.conn_id,
            tags: shadow_tags,
        })
        .await?;

    Ok(resp.updates)
}

async fn run_protocol_shadow_stream(app_handle: AppHandle, conn_manager: Arc<ConnectionManager>) {
    let mut retry_delay_secs = 1u64;

    loop {
        let shadow = match sync_all_protocol_shadow(conn_manager.as_ref()).await {
            Ok(shadow) => shadow,
            Err(error) => {
                eprintln!("protocol shadow sync failed: {error}");
                tokio::time::sleep(Duration::from_secs(retry_delay_secs)).await;
                retry_delay_secs = (retry_delay_secs * 2).min(10);
                continue;
            }
        };

        let client = DataCenterClient::new(conn_manager.as_ref());
        match client
            .subscribe(SubscribeRequest {
                conn_id: shadow.conn_id,
                tags: Vec::new(),
                snapshot: true,
            })
            .await
        {
            Ok(mut stream) => {
                retry_delay_secs = 1;

                loop {
                    match stream.message().await {
                        Ok(Some(update)) => {
                            if let Err(error) = app_handle
                                .emit(PROTOCOL_SHADOW_UPDATE_EVENT, PointUpdateDto::from(update))
                            {
                                eprintln!("protocol shadow emit failed: {error}");
                            }
                        }
                        Ok(None) => {
                            break;
                        }
                        Err(error) => {
                            eprintln!("protocol shadow stream failed: {error}");
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                eprintln!("protocol shadow subscribe failed: {error}");
            }
        }

        tokio::time::sleep(Duration::from_secs(retry_delay_secs)).await;
        retry_delay_secs = (retry_delay_secs * 2).min(10);
    }
}

async fn refresh_running_module_cache(conn_manager: &ConnectionManager) -> Result<()> {
    let client = ModuleManagerClient::new(conn_manager);
    client.get_running_module_info().await?;
    Ok(())
}

async fn ensure_protocol_shadow_connection(
    conn_manager: &ConnectionManager,
) -> Result<ConnectionInfo> {
    let client = DataCenterClient::new(conn_manager);
    client
        .get_or_create_connection(
            PROTOCOL_SHADOW_MODULE_NAME.to_string(),
            PROTOCOL_SHADOW_CONN_NAME.to_string(),
        )
        .await
}

async fn collect_shadow_routes_for_module(
    conn_manager: &ConnectionManager,
    module: ProtocolShadowModule,
    shadow_conn_id: u32,
) -> Result<Vec<Route>> {
    let bindings = match module {
        ProtocolShadowModule::Iec104 => collect_iec104_sources(conn_manager).await?,
        ProtocolShadowModule::ModbusRtu => collect_modbus_rtu_sources(conn_manager).await?,
        ProtocolShadowModule::Dlt645 => collect_dlt645_sources(conn_manager).await?,
    };

    Ok(bindings
        .into_iter()
        .flat_map(|(source_conn_id, tags)| {
            tags.into_iter().map(move |source_tag| {
                build_shadow_route(source_conn_id, source_tag, shadow_conn_id)
            })
        })
        .collect())
}

async fn collect_iec104_sources(
    conn_manager: &ConnectionManager,
) -> Result<Vec<(u32, Vec<String>)>> {
    let client = Iec104Client::new(conn_manager);
    let links = client.list_links().await?;
    let mut sources = Vec::new();

    for link in links {
        let Some(config) = link.config else {
            continue;
        };
        if link.conn_id == 0 {
            continue;
        }

        let point_table = client.get_point_table(config.conn_name).await.ok();
        let tags = point_table
            .map(|table| {
                table
                    .points
                    .into_iter()
                    .map(|point| point.tag)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        sources.push((link.conn_id, tags));
    }

    Ok(sources)
}

async fn collect_modbus_rtu_sources(
    conn_manager: &ConnectionManager,
) -> Result<Vec<(u32, Vec<String>)>> {
    let client = ModbusRtuClient::new(conn_manager);
    let links = client.list_links().await?;
    let mut sources = Vec::new();

    for link in links {
        let Some(config) = link.config else {
            continue;
        };
        if link.conn_id == 0 {
            continue;
        }

        let point_table = client.get_point_table(config.conn_name).await.ok();
        let tags = point_table
            .map(|table| {
                table
                    .points
                    .into_iter()
                    .map(|point| point.tag)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        sources.push((link.conn_id, tags));
    }

    Ok(sources)
}

async fn collect_dlt645_sources(
    conn_manager: &ConnectionManager,
) -> Result<Vec<(u32, Vec<String>)>> {
    let client = Dlt645Client::new(conn_manager);
    let links = client.list_links().await?;
    let mut sources = Vec::new();

    for link in links {
        let Some(config) = link.config else {
            continue;
        };
        if link.conn_id == 0 {
            continue;
        }

        let point_table = client.get_point_table(config.conn_name).await.ok();
        let tags = point_table
            .map(|table| {
                table
                    .points
                    .into_iter()
                    .map(|point| point.tag)
                    .chain(
                        table
                            .blocks
                            .into_iter()
                            .flat_map(|block| block.items.into_iter().map(|item| item.tag)),
                    )
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        sources.push((link.conn_id, tags));
    }

    Ok(sources)
}

fn build_shadow_route(source_conn_id: u32, source_tag: String, shadow_conn_id: u32) -> Route {
    Route {
        src: Some(Endpoint {
            conn_id: source_conn_id,
            tag: source_tag.clone(),
        }),
        dst: Some(Endpoint {
            conn_id: shadow_conn_id,
            tag: shadow_tag_for_source(source_conn_id, &source_tag),
        }),
    }
}

fn shadow_tag_for_source(source_conn_id: u32, source_tag: &str) -> String {
    format!("conn_{source_conn_id}::{source_tag}")
}

fn route_key(route: &Route) -> Option<String> {
    let src = route.src.as_ref()?;
    let dst = route.dst.as_ref()?;
    Some(format!(
        "{}:{}->{}:{}",
        src.conn_id, src.tag, dst.conn_id, dst.tag
    ))
}
