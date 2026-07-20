use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::grpc::data_center::{
    DataCenterClient, StableRoute as Route, StableRouteEndpoint as Endpoint,
};
use crate::proto::data_center_proto::{
    point_value, ConnectionInfo, GetLatestRequest, ListRoutesRequest, PointUpdate,
};
use crate::protocol_shadow;
use crate::state::AppState;

// ── DTOs ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionInfoDto {
    pub conn_id: u32,
    pub module_name: String,
    pub conn_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnTagsDto {
    pub conn_id: u32,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EndpointDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conn_id: Option<u32>,
    #[serde(default)]
    pub module_name: String,
    #[serde(default)]
    pub conn_name: String,
    pub tag: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RouteDto {
    pub src: EndpointDto,
    pub dst: EndpointDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointUpdateDto {
    pub src_conn_id: u32,
    pub src_tag: String,
    pub dst_conn_id: u32,
    pub dst_tag: String,
    pub value: Option<PointValueDto>,
    pub ts_ms: i64,
    pub quality: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "value")]
pub enum PointValueDto {
    Bool(bool),
    Int(i64),
    Double(f64),
    String(String),
    Bytes(Vec<u8>),
}

// ── From Proto ──

impl From<ConnectionInfo> for ConnectionInfoDto {
    fn from(info: ConnectionInfo) -> Self {
        Self {
            conn_id: info.conn_id,
            module_name: info.module_name,
            conn_name: info.conn_name,
        }
    }
}

impl From<crate::proto::data_center_proto::ConnTags> for ConnTagsDto {
    fn from(ct: crate::proto::data_center_proto::ConnTags) -> Self {
        Self {
            conn_id: ct.conn_id,
            tags: ct.tags,
        }
    }
}

fn endpoint_from_proto(
    ep: Option<Endpoint>,
    connection_lookup: &HashMap<u32, (String, String)>,
) -> EndpointDto {
    match ep {
        Some(e) => {
            let (fallback_module_name, fallback_conn_name) = connection_lookup
                .get(&e.conn_id)
                .cloned()
                .unwrap_or_else(|| (String::new(), String::new()));
            let module_name = if e.module_name.is_empty() {
                fallback_module_name
            } else {
                e.module_name
            };
            let conn_name = if e.conn_name.is_empty() {
                fallback_conn_name
            } else {
                e.conn_name
            };

            EndpointDto {
                conn_id: (e.conn_id != 0).then_some(e.conn_id),
                module_name,
                conn_name,
                tag: e.tag,
            }
        }
        None => EndpointDto {
            conn_id: None,
            module_name: String::new(),
            conn_name: String::new(),
            tag: String::new(),
        },
    }
}

fn point_value_from_proto(
    pv: Option<crate::proto::data_center_proto::PointValue>,
) -> Option<PointValueDto> {
    pv.and_then(|v| {
        v.kind.map(|k| match k {
            point_value::Kind::BoolValue(b) => PointValueDto::Bool(b),
            point_value::Kind::IntValue(i) => PointValueDto::Int(i),
            point_value::Kind::DoubleValue(d) => PointValueDto::Double(d),
            point_value::Kind::StringValue(s) => PointValueDto::String(s),
            point_value::Kind::BytesValue(b) => PointValueDto::Bytes(b),
        })
    })
}

impl RouteDto {
    fn from_proto(r: Route, connection_lookup: &HashMap<u32, (String, String)>) -> Self {
        Self {
            src: endpoint_from_proto(r.src, connection_lookup),
            dst: endpoint_from_proto(r.dst, connection_lookup),
        }
    }
}

impl From<PointUpdate> for PointUpdateDto {
    fn from(pu: PointUpdate) -> Self {
        Self {
            src_conn_id: pu.src_conn_id,
            src_tag: pu.src_tag,
            dst_conn_id: pu.dst_conn_id,
            dst_tag: pu.dst_tag,
            value: point_value_from_proto(pu.value),
            ts_ms: pu.ts_ms,
            quality: pu.quality,
        }
    }
}

// ── To Proto ──

impl EndpointDto {
    fn to_proto(&self) -> Endpoint {
        Endpoint {
            conn_id: self.conn_id.unwrap_or_default(),
            module_name: self.module_name.clone(),
            conn_name: self.conn_name.clone(),
            tag: self.tag.clone(),
        }
    }
}

impl RouteDto {
    fn to_proto(&self) -> Route {
        Route {
            src: Some(self.src.to_proto()),
            dst: Some(self.dst.to_proto()),
        }
    }
}

// ── Tauri Commands ──

fn is_protocol_shadow_connection(info: &ConnectionInfo) -> bool {
    info.module_name == protocol_shadow::PROTOCOL_SHADOW_MODULE_NAME
        && info.conn_name == protocol_shadow::PROTOCOL_SHADOW_CONN_NAME
}

fn endpoint_uses_hidden_connection(
    endpoint: &Endpoint,
    hidden_conn_ids: &HashSet<u32>,
    hidden_connection_keys: &HashSet<(String, String)>,
) -> bool {
    hidden_conn_ids.contains(&endpoint.conn_id)
        || hidden_connection_keys
            .contains(&(endpoint.module_name.clone(), endpoint.conn_name.clone()))
}

fn route_uses_hidden_connection(
    route: &Route,
    hidden_conn_ids: &HashSet<u32>,
    hidden_connection_keys: &HashSet<(String, String)>,
) -> bool {
    route
        .src
        .as_ref()
        .map(|endpoint| {
            endpoint_uses_hidden_connection(endpoint, hidden_conn_ids, hidden_connection_keys)
        })
        .unwrap_or(false)
        || route
            .dst
            .as_ref()
            .map(|endpoint| {
                endpoint_uses_hidden_connection(endpoint, hidden_conn_ids, hidden_connection_keys)
            })
            .unwrap_or(false)
}

#[tauri::command]
pub async fn dc_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfoDto>, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let resp = client.list_connections().await.map_err(|error| {
        tracing::error!(error = %error, "获取 DataCenter 连接列表失败");
        error.to_string()
    })?;
    let connections = resp
        .conns
        .into_iter()
        .filter(|conn| !is_protocol_shadow_connection(conn))
        .map(|c| c.into())
        .collect::<Vec<_>>();
    tracing::info!(connection_count = connections.len(), "获取 DataCenter 连接列表完成");
    Ok(connections)
}

#[tauri::command]
pub async fn dc_get_conn_tags(
    state: State<'_, AppState>,
    conn_id: u32,
) -> Result<ConnTagsDto, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let ct = client
        .get_conn_tags(conn_id)
        .await
        .map_err(|error| {
            tracing::error!(conn_id, error = %error, "获取 DataCenter 连接标签失败");
            error.to_string()
        })?;
    Ok(ct.into())
}

#[tauri::command]
pub async fn dc_list_routes(
    state: State<'_, AppState>,
    src_conn_id: u32,
    src_tag: String,
    dst_conn_id: u32,
    dst_tag: String,
) -> Result<Vec<RouteDto>, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let connections = client.list_connections().await.map_err(|error| {
        tracing::error!(error = %error, "获取 DataCenter 连接列表失败");
        error.to_string()
    })?;
    let mut connection_lookup = HashMap::new();
    let mut hidden_conn_ids = HashSet::new();
    let mut hidden_connection_keys = HashSet::new();

    for conn in connections.conns {
        if is_protocol_shadow_connection(&conn) {
            hidden_conn_ids.insert(conn.conn_id);
            hidden_connection_keys.insert((conn.module_name.clone(), conn.conn_name.clone()));
        }

        connection_lookup.insert(conn.conn_id, (conn.module_name, conn.conn_name));
    }

    let resp = client
        .list_routes(ListRoutesRequest {
            src_conn_id,
            src_tag,
            dst_conn_id,
            dst_tag,
        })
        .await
        .map_err(|error| {
            tracing::error!(src_conn_id, dst_conn_id, error = %error, "获取 DataCenter 路由失败");
            error.to_string()
        })?;
    let routes = resp
        .routes
        .into_iter()
        .filter(|route| {
            !route_uses_hidden_connection(route, &hidden_conn_ids, &hidden_connection_keys)
        })
        .map(|r| RouteDto::from_proto(r, &connection_lookup))
        .collect::<Vec<_>>();
    tracing::info!(route_count = routes.len(), "获取 DataCenter 路由完成");
    Ok(routes)
}

#[tauri::command]
pub async fn dc_upsert_routes(
    state: State<'_, AppState>,
    routes: Vec<RouteDto>,
    replace: bool,
) -> Result<(), String> {
    tracing::info!(route_count = routes.len(), replace, "开始保存 DataCenter 路由");
    let client = DataCenterClient::new(&state.conn_manager);
    client
        .upsert_routes(routes.into_iter().map(|r| r.to_proto()).collect(), replace)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "保存 DataCenter 路由失败");
            error.to_string()
        })?;
    tracing::info!("保存 DataCenter 路由完成");
    Ok(())
}

#[tauri::command]
pub async fn dc_delete_routes(
    state: State<'_, AppState>,
    routes: Vec<RouteDto>,
) -> Result<(), String> {
    tracing::info!(route_count = routes.len(), "开始删除 DataCenter 路由");
    let client = DataCenterClient::new(&state.conn_manager);
    client
        .delete_routes(routes.into_iter().map(|r| r.to_proto()).collect())
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "删除 DataCenter 路由失败");
            error.to_string()
        })?;
    tracing::info!("删除 DataCenter 路由完成");
    Ok(())
}

#[tauri::command]
pub async fn dc_get_latest(
    state: State<'_, AppState>,
    conn_id: u32,
    tags: Vec<String>,
) -> Result<Vec<PointUpdateDto>, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let resp = client
        .get_latest(GetLatestRequest { conn_id, tags })
        .await
        .map_err(|error| {
            tracing::error!(conn_id, error = %error, "获取 DataCenter 最新点值失败");
            error.to_string()
        })?;
    Ok(resp.updates.into_iter().map(|u| u.into()).collect())
}

#[tauri::command]
pub async fn dc_start_protocol_shadow_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("开始启动协议实时数据流");
    state
        .protocol_shadow
        .ensure_started(app_handle, state.conn_manager.clone());
    tracing::info!("协议实时数据流启动请求完成");
    Ok(())
}

#[tauri::command]
pub async fn dc_get_protocol_shadow_latest(
    state: State<'_, AppState>,
    source_conn_id: u32,
    source_tags: Vec<String>,
) -> Result<Vec<PointUpdateDto>, String> {
    let updates = protocol_shadow::get_protocol_shadow_latest(
        state.conn_manager.as_ref(),
        source_conn_id,
        source_tags,
    )
    .await
    .map_err(|error| {
        tracing::error!(source_conn_id, error = %error, "获取协议实时数据失败");
        error.to_string()
    })?;

    Ok(updates.into_iter().map(PointUpdateDto::from).collect())
}
