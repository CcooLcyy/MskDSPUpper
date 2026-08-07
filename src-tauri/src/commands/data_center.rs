use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::data_center::{
    DataCenterClient, StableRoute as Route, StableRouteEndpoint as Endpoint,
};
use crate::proto::data_center_proto::{
    point_value, ConnectionInfo, ConnectionKey, GetLatestRequest, GetSourceLatestRequest,
    ListRoutesRequest, PointUpdate, SourcePointUpdate,
};
use crate::state::AppState;

const LEGACY_PROTOCOL_SHADOW_MODULE_NAME: &str = "MskDSPUpper";
const LEGACY_PROTOCOL_SHADOW_CONN_NAME: &str = "__protocol_shadow__";

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
pub struct SourcePointUpdateDto {
    pub conn_id: u32,
    pub tag: String,
    pub value: Option<PointValueDto>,
    pub ts_ms: i64,
    pub quality: i32,
    pub sequence: u64,
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

impl From<SourcePointUpdate> for SourcePointUpdateDto {
    fn from(update: SourcePointUpdate) -> Self {
        Self {
            conn_id: update.conn_id,
            tag: update.tag,
            value: point_value_from_proto(update.value),
            ts_ms: update.ts_ms,
            quality: update.quality,
            sequence: update.sequence,
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

fn is_legacy_protocol_shadow_connection(info: &ConnectionInfo) -> bool {
    info.module_name == LEGACY_PROTOCOL_SHADOW_MODULE_NAME
        && info.conn_name == LEGACY_PROTOCOL_SHADOW_CONN_NAME
}

fn endpoint_uses_legacy_protocol_shadow(endpoint: &Endpoint) -> bool {
    endpoint.module_name == LEGACY_PROTOCOL_SHADOW_MODULE_NAME
        && endpoint.conn_name == LEGACY_PROTOCOL_SHADOW_CONN_NAME
}

fn route_uses_legacy_protocol_shadow(route: &Route) -> bool {
    route
        .src
        .as_ref()
        .is_some_and(endpoint_uses_legacy_protocol_shadow)
        || route
            .dst
            .as_ref()
            .is_some_and(endpoint_uses_legacy_protocol_shadow)
}

async fn cleanup_legacy_protocol_shadow_connections(
    client: &DataCenterClient<'_>,
    connections: &[ConnectionInfo],
) {
    for connection in connections
        .iter()
        .filter(|connection| is_legacy_protocol_shadow_connection(connection))
    {
        let key = ConnectionKey {
            module_name: connection.module_name.clone(),
            conn_name: connection.conn_name.clone(),
        };
        if let Err(error) = client.delete_connection(key).await {
            tracing::warn!(
                conn_id = connection.conn_id,
                error = %error,
                "清理历史协议影子连接失败"
            );
        } else {
            tracing::info!(
                conn_id = connection.conn_id,
                "已清理历史协议影子连接及其路由"
            );
        }
    }
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
    cleanup_legacy_protocol_shadow_connections(&client, &resp.conns).await;
    let connections = resp
        .conns
        .into_iter()
        .filter(|connection| !is_legacy_protocol_shadow_connection(connection))
        .map(|c| c.into())
        .collect::<Vec<_>>();
    tracing::info!(
        connection_count = connections.len(),
        "获取 DataCenter 连接列表完成"
    );
    Ok(connections)
}

#[tauri::command]
pub async fn dc_get_conn_tags(
    state: State<'_, AppState>,
    conn_id: u32,
) -> Result<ConnTagsDto, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let ct = client.get_conn_tags(conn_id).await.map_err(|error| {
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
    cleanup_legacy_protocol_shadow_connections(&client, &connections.conns).await;
    let mut connection_lookup = HashMap::new();
    for conn in connections.conns {
        if is_legacy_protocol_shadow_connection(&conn) {
            continue;
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
        .filter(|route| !route_uses_legacy_protocol_shadow(route))
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
    tracing::info!(
        route_count = routes.len(),
        replace,
        "开始保存 DataCenter 路由"
    );
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
pub async fn dc_get_source_latest(
    state: State<'_, AppState>,
    conn_id: u32,
    tags: Vec<String>,
) -> Result<Vec<SourcePointUpdateDto>, String> {
    let client = DataCenterClient::new(&state.conn_manager);
    let resp = client
        .get_source_latest(GetSourceLatestRequest { conn_id, tags })
        .await
        .map_err(|error| {
            tracing::error!(conn_id, error = %error, "获取 DataCenter 源端最新点值失败");
            error.to_string()
        })?;
    tracing::debug!(
        conn_id,
        update_count = resp.updates.len(),
        "获取 DataCenter 源端最新点值完成"
    );
    Ok(resp
        .updates
        .into_iter()
        .map(SourcePointUpdateDto::from)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        is_legacy_protocol_shadow_connection, route_uses_legacy_protocol_shadow, Route,
        LEGACY_PROTOCOL_SHADOW_CONN_NAME, LEGACY_PROTOCOL_SHADOW_MODULE_NAME,
    };
    use crate::grpc::data_center::StableRouteEndpoint;
    use crate::proto::data_center_proto::ConnectionInfo;

    // 验证历史影子连接只按保留的模块名和连接名识别，不误伤普通连接。
    #[test]
    fn legacy_protocol_shadow_connection_match_is_exact() {
        let legacy = ConnectionInfo {
            conn_id: 7,
            module_name: LEGACY_PROTOCOL_SHADOW_MODULE_NAME.to_string(),
            conn_name: LEGACY_PROTOCOL_SHADOW_CONN_NAME.to_string(),
        };
        let regular = ConnectionInfo {
            conn_id: 8,
            module_name: "IEC104".to_string(),
            conn_name: LEGACY_PROTOCOL_SHADOW_CONN_NAME.to_string(),
        };

        assert!(is_legacy_protocol_shadow_connection(&legacy));
        assert!(!is_legacy_protocol_shadow_connection(&regular));
    }

    // 验证历史影子路由会被隐藏，普通业务路由不会被清理过滤。
    #[test]
    fn legacy_protocol_shadow_route_filter_preserves_business_routes() {
        let legacy_endpoint = StableRouteEndpoint {
            conn_id: 7,
            tag: "conn_1::P".to_string(),
            module_name: LEGACY_PROTOCOL_SHADOW_MODULE_NAME.to_string(),
            conn_name: LEGACY_PROTOCOL_SHADOW_CONN_NAME.to_string(),
        };
        let business_endpoint = StableRouteEndpoint {
            conn_id: 8,
            tag: "P".to_string(),
            module_name: "AGC".to_string(),
            conn_name: "group-1".to_string(),
        };

        let legacy_route = Route {
            src: Some(business_endpoint.clone()),
            dst: Some(legacy_endpoint),
        };
        let business_route = Route {
            src: Some(business_endpoint.clone()),
            dst: Some(business_endpoint),
        };

        assert!(route_uses_legacy_protocol_shadow(&legacy_route));
        assert!(!route_uses_legacy_protocol_shadow(&business_route));
    }
}
