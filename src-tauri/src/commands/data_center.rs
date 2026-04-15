use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::grpc::data_center::DataCenterClient;
use crate::proto::data_center_proto::{
    point_value, ConnectionInfo, Endpoint, GetLatestRequest, ListRoutesRequest, PointUpdate, Route,
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
    pub conn_id: u32,
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

fn endpoint_from_proto(ep: Option<Endpoint>) -> EndpointDto {
    match ep {
        Some(e) => EndpointDto {
            conn_id: e.conn_id,
            tag: e.tag,
        },
        None => EndpointDto {
            conn_id: 0,
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

impl From<Route> for RouteDto {
    fn from(r: Route) -> Self {
        Self {
            src: endpoint_from_proto(r.src),
            dst: endpoint_from_proto(r.dst),
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
            conn_id: self.conn_id,
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

fn route_uses_hidden_connection(route: &Route, hidden_conn_ids: &HashSet<u32>) -> bool {
    route
        .src
        .as_ref()
        .map(|endpoint| hidden_conn_ids.contains(&endpoint.conn_id))
        .unwrap_or(false)
        || route
            .dst
            .as_ref()
            .map(|endpoint| hidden_conn_ids.contains(&endpoint.conn_id))
            .unwrap_or(false)
}

async fn list_hidden_connection_ids(client: &DataCenterClient<'_>) -> Result<HashSet<u32>, String> {
    let resp = client.list_connections().await.map_err(|e| e.to_string())?;

    Ok(resp
        .conns
        .into_iter()
        .filter(is_protocol_shadow_connection)
        .map(|conn| conn.conn_id)
        .collect())
}

#[tauri::command]
pub async fn dc_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfoDto>, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let resp = client.list_connections().await.map_err(|e| e.to_string())?;
    Ok(resp
        .conns
        .into_iter()
        .filter(|conn| !is_protocol_shadow_connection(conn))
        .map(|c| c.into())
        .collect())
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
        .map_err(|e| e.to_string())?;
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
    let hidden_conn_ids = list_hidden_connection_ids(&client).await?;
    let resp = client
        .list_routes(ListRoutesRequest {
            src_conn_id,
            src_tag,
            dst_conn_id,
            dst_tag,
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp
        .routes
        .into_iter()
        .filter(|route| !route_uses_hidden_connection(route, &hidden_conn_ids))
        .map(|r| r.into())
        .collect())
}

#[tauri::command]
pub async fn dc_upsert_routes(
    state: State<'_, AppState>,
    routes: Vec<RouteDto>,
    replace: bool,
) -> Result<(), String> {
    let client = DataCenterClient::new(&state.conn_manager);
    client
        .upsert_routes(routes.into_iter().map(|r| r.to_proto()).collect(), replace)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dc_delete_routes(
    state: State<'_, AppState>,
    routes: Vec<RouteDto>,
) -> Result<(), String> {
    let client = DataCenterClient::new(&state.conn_manager);
    client
        .delete_routes(routes.into_iter().map(|r| r.to_proto()).collect())
        .await
        .map_err(|e| e.to_string())?;
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
        .map_err(|e| e.to_string())?;
    Ok(resp.updates.into_iter().map(|u| u.into()).collect())
}

#[tauri::command]
pub async fn dc_start_protocol_shadow_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = protocol_shadow::sync_all_protocol_shadow(state.conn_manager.as_ref()).await;
    state
        .protocol_shadow
        .ensure_started(app_handle, state.conn_manager.clone());
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
    .map_err(|e| e.to_string())?;

    Ok(updates.into_iter().map(PointUpdateDto::from).collect())
}
