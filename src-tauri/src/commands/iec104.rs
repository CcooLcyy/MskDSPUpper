use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::iec104::Iec104Client;
use crate::proto::iec104_proto::{
    ApciParameters, Endpoint, LinkConfig, LinkInfo, Point, PointTable,
};
use crate::protocol_shadow::{self, ProtocolShadowModule};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EndpointDto {
    pub ip: String,
    pub port: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApciParametersDto {
    pub k: u32,
    pub w: u32,
    pub t0: u32,
    pub t1: u32,
    pub t2: u32,
    pub t3: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LinkConfigDto {
    pub conn_name: String,
    pub role: i32,
    pub local: Option<EndpointDto>,
    pub remote: Option<EndpointDto>,
    pub ca: u32,
    pub oa: u32,
    pub apci: Option<ApciParametersDto>,
    pub point_batch_window_ms: u32,
    pub point_max_asdu_bytes: u32,
    pub point_use_standard_limit: bool,
    pub point_dedupe: Option<bool>,
    pub time_sync_tag: String,
    pub station_role: i32,
    pub point_with_time: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LinkInfoDto {
    pub config: Option<LinkConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointDto {
    pub tag: String,
    pub ioa: u32,
    pub point_type: i32,
    pub scale: f64,
    pub offset: f64,
    pub deadband: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointTableDto {
    pub conn_name: String,
    pub points: Vec<PointDto>,
}

impl From<Endpoint> for EndpointDto {
    fn from(endpoint: Endpoint) -> Self {
        Self {
            ip: endpoint.ip,
            port: endpoint.port,
        }
    }
}

impl From<ApciParameters> for ApciParametersDto {
    fn from(apci: ApciParameters) -> Self {
        Self {
            k: apci.k,
            w: apci.w,
            t0: apci.t0,
            t1: apci.t1,
            t2: apci.t2,
            t3: apci.t3,
        }
    }
}

impl From<LinkConfig> for LinkConfigDto {
    fn from(config: LinkConfig) -> Self {
        Self {
            conn_name: config.conn_name,
            role: config.role,
            local: config.local.map(|endpoint| endpoint.into()),
            remote: config.remote.map(|endpoint| endpoint.into()),
            ca: config.ca,
            oa: config.oa,
            apci: config.apci.map(|apci| apci.into()),
            point_batch_window_ms: config.point_batch_window_ms,
            point_max_asdu_bytes: config.point_max_asdu_bytes,
            point_use_standard_limit: config.point_use_standard_limit,
            point_dedupe: config.point_dedupe,
            time_sync_tag: config.time_sync_tag,
            station_role: config.station_role,
            point_with_time: config.point_with_time,
        }
    }
}

impl From<LinkInfo> for LinkInfoDto {
    fn from(link: LinkInfo) -> Self {
        Self {
            config: link.config.map(|config| config.into()),
            conn_id: link.conn_id,
            state: link.state,
            last_error: link.last_error,
        }
    }
}

impl From<Point> for PointDto {
    fn from(point: Point) -> Self {
        Self {
            tag: point.tag,
            ioa: point.ioa,
            point_type: point.r#type,
            scale: point.scale,
            offset: point.offset,
            deadband: point.deadband,
        }
    }
}

impl From<PointTable> for PointTableDto {
    fn from(table: PointTable) -> Self {
        Self {
            conn_name: table.conn_name,
            points: table.points.into_iter().map(|point| point.into()).collect(),
        }
    }
}

impl EndpointDto {
    pub(crate) fn to_proto(&self) -> Endpoint {
        Endpoint {
            ip: self.ip.clone(),
            port: self.port,
        }
    }
}

impl ApciParametersDto {
    pub(crate) fn to_proto(&self) -> ApciParameters {
        ApciParameters {
            k: self.k,
            w: self.w,
            t0: self.t0,
            t1: self.t1,
            t2: self.t2,
            t3: self.t3,
        }
    }
}

impl LinkConfigDto {
    pub(crate) fn to_proto(&self) -> LinkConfig {
        LinkConfig {
            conn_name: self.conn_name.clone(),
            role: self.role,
            local: self.local.as_ref().map(|endpoint| endpoint.to_proto()),
            remote: self.remote.as_ref().map(|endpoint| endpoint.to_proto()),
            ca: self.ca,
            oa: self.oa,
            apci: self.apci.as_ref().map(|apci| apci.to_proto()),
            point_batch_window_ms: self.point_batch_window_ms,
            point_max_asdu_bytes: self.point_max_asdu_bytes,
            point_use_standard_limit: self.point_use_standard_limit,
            point_dedupe: self.point_dedupe,
            time_sync_tag: self.time_sync_tag.clone(),
            station_role: self.station_role,
            point_with_time: self.point_with_time,
        }
    }
}

impl PointDto {
    pub(crate) fn to_proto(&self) -> Point {
        Point {
            tag: self.tag.clone(),
            ioa: self.ioa,
            r#type: self.point_type,
            scale: self.scale,
            offset: self.offset,
            deadband: self.deadband,
        }
    }
}

#[tauri::command]
pub async fn iec104_upsert_link(
    state: State<'_, AppState>,
    config: LinkConfigDto,
    create_only: bool,
) -> Result<LinkInfoDto, String> {
    let conn_name = config.conn_name.clone();
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, create_only, "开始保存协议连接配置");
    let client = Iec104Client::new(&state.conn_manager);
    let link = client
        .upsert_link(config.to_proto(), create_only)
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "保存协议连接配置失败");
            error.to_string()
        })?;
    if let Err(error) = protocol_shadow::sync_protocol_shadow_module(
        state.conn_manager.as_ref(),
        ProtocolShadowModule::Iec104,
    )
    .await {
        tracing::warn!(protocol = "IEC104", error = %error, "协议实时数据模块同步失败");
    }
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "保存协议连接配置完成");
    Ok(link.into())
}

#[tauri::command]
pub async fn iec104_rename_link(
    state: State<'_, AppState>,
    old_conn_name: String,
    new_conn_name: String,
) -> Result<LinkInfoDto, String> {
    tracing::info!(protocol = "IEC104", old_conn_name = %old_conn_name, new_conn_name = %new_conn_name, "开始重命名协议连接");
    let client = Iec104Client::new(&state.conn_manager);
    let link = client
        .rename_link(old_conn_name.clone(), new_conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", old_conn_name = %old_conn_name, new_conn_name = %new_conn_name, error = %error, "重命名协议连接失败");
            error.to_string()
        })?;
    if let Err(error) = protocol_shadow::sync_protocol_shadow_module(
        state.conn_manager.as_ref(),
        ProtocolShadowModule::Iec104,
    )
    .await {
        tracing::warn!(protocol = "IEC104", error = %error, "协议实时数据模块同步失败");
    }
    tracing::info!(protocol = "IEC104", old_conn_name = %old_conn_name, new_conn_name = %new_conn_name, "重命名协议连接完成");
    Ok(link.into())
}

#[tauri::command]
pub async fn iec104_get_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<LinkInfoDto, String> {
    let client = Iec104Client::new(&state.conn_manager);
    let link = client
        .get_link(conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "获取协议连接失败");
            error.to_string()
        })?;
    Ok(link.into())
}

#[tauri::command]
pub async fn iec104_list_links(state: State<'_, AppState>) -> Result<Vec<LinkInfoDto>, String> {
    let client = Iec104Client::new(&state.conn_manager);
    let links = client.list_links().await.map_err(|error| {
        tracing::error!(protocol = "IEC104", error = %error, "获取协议连接列表失败");
        error.to_string()
    })?;
    tracing::info!(protocol = "IEC104", link_count = links.len(), "获取协议连接列表完成");
    Ok(links.into_iter().map(|link| link.into()).collect())
}

#[tauri::command]
pub async fn iec104_delete_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "开始删除协议连接");
    let client = Iec104Client::new(&state.conn_manager);
    client
        .delete_link(conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "删除协议连接失败");
            error.to_string()
        })?;
    if let Err(error) = protocol_shadow::sync_protocol_shadow_module(
        state.conn_manager.as_ref(),
        ProtocolShadowModule::Iec104,
    )
    .await {
        tracing::warn!(protocol = "IEC104", error = %error, "协议实时数据模块同步失败");
    }
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "删除协议连接完成");
    Ok(())
}

#[tauri::command]
pub async fn iec104_start_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "开始启动协议连接");
    let client = Iec104Client::new(&state.conn_manager);
    client
        .start_link(conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "启动协议连接失败");
            error.to_string()
        })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "启动协议连接请求完成");
    Ok(())
}

#[tauri::command]
pub async fn iec104_stop_link(state: State<'_, AppState>, conn_name: String) -> Result<(), String> {
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "开始停止协议连接");
    let client = Iec104Client::new(&state.conn_manager);
    client
        .stop_link(conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "停止协议连接失败");
            error.to_string()
        })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "停止协议连接请求完成");
    Ok(())
}

#[tauri::command]
pub async fn iec104_upsert_point_table(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<PointDto>,
    replace: bool,
) -> Result<(), String> {
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, point_count = points.len(), replace, "开始保存协议点表");
    let client = Iec104Client::new(&state.conn_manager);
    client
        .upsert_point_table(
            conn_name.clone(),
            points.into_iter().map(|point| point.to_proto()).collect(),
            replace,
        )
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "保存协议点表失败");
            error.to_string()
        })?;
    if let Err(error) = protocol_shadow::sync_protocol_shadow_module(
        state.conn_manager.as_ref(),
        ProtocolShadowModule::Iec104,
    )
    .await {
        tracing::warn!(protocol = "IEC104", error = %error, "协议实时数据模块同步失败");
    }
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "保存协议点表完成");
    Ok(())
}

#[tauri::command]
pub async fn iec104_get_point_table(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<PointTableDto, String> {
    let client = Iec104Client::new(&state.conn_manager);
    let table = client
        .get_point_table(conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "获取协议点表失败");
            error.to_string()
        })?;
    Ok(table.into())
}

#[tauri::command]
pub async fn iec104_send_time_sync(
    state: State<'_, AppState>,
    conn_name: String,
    ts_ms: i64,
) -> Result<(), String> {
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, timestamp_ms = ts_ms, "开始发送时间同步");
    let client = Iec104Client::new(&state.conn_manager);
    client
        .send_time_sync(conn_name.clone(), ts_ms)
        .await
        .map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "发送时间同步失败");
            error.to_string()
        })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, "发送时间同步请求完成");
    Ok(())
}
