use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::iec104::Iec104Client;
use crate::proto::iec104_proto::{
    ApciParameters, Endpoint, LinkConfig, LinkInfo, Point, PointTable, PointType, QuerySoeRequest,
    SimulationPoint, SoeAcknowledgedFilter,
};
use crate::state::AppState;

const REMOTE_CONTROL_TYPE_SINGLE: i32 = 1;
const COMMAND_EXECUTION_MODE_SELECT_EXECUTE: i32 = 2;

fn default_remote_control_type() -> i32 {
    REMOTE_CONTROL_TYPE_SINGLE
}

fn default_command_execution_mode() -> i32 {
    COMMAND_EXECUTION_MODE_SELECT_EXECUTE
}

fn normalize_remote_control_type(value: i32) -> i32 {
    if value == 0 {
        default_remote_control_type()
    } else {
        value
    }
}

fn normalize_command_execution_mode(value: i32) -> i32 {
    if value == 0 {
        default_command_execution_mode()
    } else {
        value
    }
}

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
    pub connection_state: i32,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointDto {
    pub tag: String,
    pub ioa: u32,
    pub point_type: i32,
    #[serde(default)]
    pub business_type: i32,
    #[serde(default = "default_remote_control_type")]
    pub remote_control_type: i32,
    #[serde(default = "default_command_execution_mode")]
    pub command_execution_mode: i32,
    pub scale: f64,
    pub offset: f64,
    pub deadband: f64,
    #[serde(default)]
    pub scale_decimal: String,
    #[serde(default)]
    pub offset_decimal: String,
    #[serde(default)]
    pub deadband_decimal: String,
    #[serde(default)]
    pub fixed_value_enabled: bool,
    #[serde(default)]
    pub fixed_value: f64,
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
            connection_state: link.connection_state,
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
            business_type: point.business_type,
            remote_control_type: normalize_remote_control_type(point.remote_control_type),
            command_execution_mode: normalize_command_execution_mode(point.command_execution_mode),
            scale: point.scale,
            offset: point.offset,
            deadband: point.deadband,
            scale_decimal: point.scale_decimal,
            offset_decimal: point.offset_decimal,
            deadband_decimal: point.deadband_decimal,
            fixed_value_enabled: point.fixed_value_enabled,
            fixed_value: point.fixed_value,
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
            business_type: self.business_type,
            remote_control_type: normalize_remote_control_type(self.remote_control_type),
            command_execution_mode: normalize_command_execution_mode(self.command_execution_mode),
            scale: self.scale,
            offset: self.offset,
            deadband: self.deadband,
            scale_decimal: self.scale_decimal.clone(),
            offset_decimal: self.offset_decimal.clone(),
            deadband_decimal: self.deadband_decimal.clone(),
            fixed_value_enabled: self.fixed_value_enabled,
            fixed_value: self.fixed_value,
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
    tracing::info!(
        protocol = "IEC104",
        link_count = links.len(),
        "获取协议连接列表完成"
    );
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
    for point in &points {
        tracing::info!(protocol = "IEC104", conn_name = %conn_name, tag = %point.tag,
            ioa = point.ioa, fixed_value_enabled = point.fixed_value_enabled,
            fixed_value = point.fixed_value, "保存逐点固定上报值配置，原倍率与偏移保持不变");
    }
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
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, point_count = table.points.len(), "获取协议点表完成");
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimulationPointDto {
    pub tag: String,
    pub point_type: i32,
    pub bool_value: Option<bool>,
    pub double_value: Option<f64>,
    pub quality: u32,
    pub ts_ms: i64,
}

/// 手动模拟值只传工程量；品质和时间统一由下位机生成。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ManualSimulationPointDto {
    pub tag: String,
    pub point_type: i32,
    pub bool_value: Option<bool>,
    pub double_value: Option<f64>,
}

impl TryFrom<ManualSimulationPointDto> for SimulationPoint {
    type Error = String;

    fn try_from(point: ManualSimulationPointDto) -> Result<Self, Self::Error> {
        if point.tag.trim().is_empty() {
            return Err("手动模拟点的 Tag 不能为空".to_string());
        }
        match PointType::try_from(point.point_type) {
            Ok(PointType::Float) => {
                if point.bool_value.is_some() {
                    return Err(format!("手动模拟点“{}”是遥测，不能填写遥信值", point.tag));
                }
                let value = point.double_value.ok_or_else(|| {
                    format!("手动模拟点“{}”未填写遥测值", point.tag)
                })?;
                if !value.is_finite() {
                    return Err(format!("手动模拟点“{}”的遥测值必须是有限数值", point.tag));
                }
            }
            Ok(PointType::Single) => {
                if point.double_value.is_some() {
                    return Err(format!("手动模拟点“{}”是遥信，不能填写遥测值", point.tag));
                }
                if point.bool_value.is_none() {
                    return Err(format!("手动模拟点“{}”未填写遥信值", point.tag));
                }
            }
            _ => return Err(format!("手动模拟点“{}”的点位类型不支持", point.tag)),
        }
        Ok(Self {
            tag: point.tag,
            r#type: point.point_type,
            bool_value: point.bool_value,
            double_value: point.double_value,
            quality: 0,
            ts_ms: 0,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimulationSnapshotDto {
    pub conn_name: String,
    pub points: Vec<SimulationPointDto>,
}

impl From<crate::proto::iec104_proto::SimulationSnapshot> for SimulationSnapshotDto {
    fn from(snapshot: crate::proto::iec104_proto::SimulationSnapshot) -> Self {
        Self {
            conn_name: snapshot.conn_name,
            points: snapshot.points.into_iter().map(|point| SimulationPointDto {
                tag: point.tag,
                point_type: point.r#type,
                bool_value: point.bool_value,
                double_value: point.double_value,
                quality: point.quality,
                ts_ms: point.ts_ms,
            }).collect(),
        }
    }
}

#[tauri::command]
pub async fn iec104_generate_simulation_values(
    state: State<'_, AppState>, conn_name: String, mode: String, bool_mode: String,
) -> Result<SimulationSnapshotDto, String> {
    let mode = match mode.as_str() {
        "increment" => 1,
        "random" => 0,
        _ => return Err("模拟值模式不支持".to_string()),
    };
    let bool_mode = match bool_mode.as_str() {
        "random" => 0,
        "all_false" => 1,
        "all_true" => 2,
        "invert_current" => 3,
        _ => return Err("遥信模拟值模式不支持".to_string()),
    };
    let client = Iec104Client::new(&state.conn_manager);
    client.generate_simulation_values(conn_name.clone(), mode, bool_mode).await.map(Into::into).map_err(|error| {
        tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "生成模拟值失败");
        error.to_string()
    })
}

#[tauri::command]
pub async fn iec104_set_simulation_values(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<ManualSimulationPointDto>,
) -> Result<SimulationSnapshotDto, String> {
    // 完整转换成功后才访问服务端，避免无效草稿产生运行态副作用。
    let points = points.into_iter().map(SimulationPoint::try_from)
        .collect::<Result<Vec<_>, _>>().map_err(|error| {
            tracing::warn!(protocol = "IEC104", conn_name = %conn_name, error = %error, "手动模拟值校验失败");
            error
        })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, point_count = points.len(), "开始保存手动模拟值");
    let client = Iec104Client::new(&state.conn_manager);
    let snapshot = client.set_simulation_values(conn_name.clone(), points).await.map_err(|error| {
        tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "保存手动模拟值失败");
        format!("保存手动模拟值失败：{error}")
    })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, point_count = snapshot.points.len(), "保存手动模拟值完成");
    Ok(snapshot.into())
}

#[tauri::command]
pub async fn iec104_get_simulation_snapshot(
    state: State<'_, AppState>, conn_name: String,
) -> Result<SimulationSnapshotDto, String> {
    let client = Iec104Client::new(&state.conn_manager);
    client.get_simulation_snapshot(conn_name.clone()).await.map(Into::into).map_err(|error| {
        tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "读取模拟值失败");
        error.to_string()
    })
}

#[tauri::command]
pub async fn iec104_apply_simulation_values(
    state: State<'_, AppState>, conn_name: String,
) -> Result<(), String> {
    let client = Iec104Client::new(&state.conn_manager);
    client.apply_simulation_values(conn_name.clone()).await.map_err(|error| {
        tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "应用模拟值失败");
        error.to_string()
    })
}

#[tauri::command]
pub async fn iec104_clear_simulation_values(
    state: State<'_, AppState>, conn_name: String,
) -> Result<(), String> {
    let client = Iec104Client::new(&state.conn_manager);
    client.clear_simulation_values(conn_name.clone()).await.map_err(|error| {
        tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "清除模拟值失败");
        error.to_string()
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimulationPeriodicStatusDto {
    pub conn_name: String,
    pub enabled: bool,
    pub interval_seconds: u32,
    pub running: bool,
    pub last_sent_ms: i64,
}

impl From<crate::proto::iec104_proto::SimulationPeriodicStatus> for SimulationPeriodicStatusDto {
    fn from(status: crate::proto::iec104_proto::SimulationPeriodicStatus) -> Self {
        Self {
            conn_name: status.conn_name,
            enabled: status.enabled,
            interval_seconds: status.interval_seconds,
            running: status.running,
            last_sent_ms: status.last_sent_ms,
        }
    }
}

fn validate_periodic_interval(interval_seconds: f64) -> Result<u32, String> {
    if !interval_seconds.is_finite()
        || interval_seconds.fract() != 0.0
        || !(1.0..=3600.0).contains(&interval_seconds)
    {
        return Err("周期上报间隔必须是 1～3600 秒的整数".to_string());
    }
    Ok(interval_seconds as u32)
}

fn periodic_simulation_error(error: &anyhow::Error) -> String {
    if error.downcast_ref::<tonic::Status>().is_some_and(|status| {
        status.code() == tonic::Code::Unimplemented
    }) {
        return "当前下位机 IEC104 模块版本不支持模拟值周期上报，请升级下位机；生成、手动发送和清除模拟值仍可使用".to_string();
    }
    format!("模拟值周期上报操作失败：{error}")
}

#[tauri::command]
pub async fn iec104_set_simulation_periodic_report(
    state: State<'_, AppState>,
    conn_name: String,
    enabled: bool,
    interval_seconds: f64,
) -> Result<SimulationPeriodicStatusDto, String> {
    // 在访问下位机前完成范围校验，无效输入不改变运行态配置。
    let interval_seconds = validate_periodic_interval(interval_seconds).map_err(|error| {
        tracing::warn!(protocol = "IEC104", conn_name = %conn_name, error = %error, "模拟值周期上报配置校验失败");
        error
    })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, enabled, interval_seconds, "开始设置模拟值周期上报");
    let client = Iec104Client::new(&state.conn_manager);
    let status = client.set_simulation_periodic_report(conn_name.clone(), enabled, interval_seconds)
        .await.map_err(|error| {
            tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "设置模拟值周期上报失败");
            periodic_simulation_error(&error)
        })?;
    tracing::info!(protocol = "IEC104", conn_name = %conn_name, enabled = status.enabled, running = status.running, "设置模拟值周期上报完成");
    Ok(status.into())
}

#[tauri::command]
pub async fn iec104_get_simulation_periodic_status(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<SimulationPeriodicStatusDto, String> {
    let client = Iec104Client::new(&state.conn_manager);
    client.get_simulation_periodic_status(conn_name.clone()).await.map(Into::into).map_err(|error| {
        tracing::error!(protocol = "IEC104", conn_name = %conn_name, error = %error, "查询模拟值周期上报状态失败");
        periodic_simulation_error(&error)
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SoeQueryDto {
    pub conn_name: String,
    pub start_ts_ms: Option<i64>,
    pub end_ts_ms: Option<i64>,
    pub ioa: Option<u32>,
    pub acknowledged_filter: Option<i32>,
    pub page_size: Option<u32>,
    pub before_event_sequence: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SoeRecordDto {
    pub event_sequence: u64,
    pub conn_name: String,
    pub ioa: u32,
    pub state: bool,
    pub ts_ms: i64,
    pub quality: u32,
    pub acknowledged: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SoePageDto {
    pub events: Vec<SoeRecordDto>,
    pub has_more: bool,
    pub next_event_sequence: Option<u64>,
    pub total_count: u32,
    pub unacknowledged_count: u32,
}

#[tauri::command]
pub async fn iec104_query_soe(
    state: State<'_, AppState>,
    query: SoeQueryDto,
) -> Result<SoePageDto, String> {
    let filter = match query.acknowledged_filter.unwrap_or(0) {
        0 => SoeAcknowledgedFilter::All as i32,
        1 => SoeAcknowledgedFilter::Acknowledged as i32,
        2 => SoeAcknowledgedFilter::Unacknowledged as i32,
        value => return Err(format!("SOE 确认状态筛选值非法: {value}")),
    };
    let conn_name = query.conn_name.clone();
    tracing::debug!(protocol = "IEC104", conn_name = %conn_name, "查询 SOE 历史");
    let request = QuerySoeRequest {
        conn_name,
        start_ts_ms: query.start_ts_ms,
        end_ts_ms: query.end_ts_ms,
        ioa: query.ioa,
        acknowledged_filter: filter,
        page_size: query.page_size.unwrap_or(0),
        before_event_sequence: query.before_event_sequence,
    };
    let client = Iec104Client::new(&state.conn_manager);
    let response = client.query_soe(request).await.map_err(|error| {
        tracing::error!(protocol = "IEC104", error = %error, "查询 SOE 历史失败");
        error.to_string()
    })?;
    Ok(SoePageDto {
        events: response.events.into_iter().map(|event| SoeRecordDto {
            event_sequence: event.event_sequence,
            conn_name: event.conn_name,
            ioa: event.ioa,
            state: event.state,
            ts_ms: event.ts_ms,
            quality: event.quality,
            acknowledged: event.acknowledged,
        }).collect(),
        has_more: response.has_more,
        next_event_sequence: response.next_event_sequence,
        total_count: response.total_count,
        unacknowledged_count: response.unacknowledged_count,
    })
}

#[cfg(test)]
mod periodic_simulation_tests {
    use super::{periodic_simulation_error, validate_periodic_interval, SimulationPeriodicStatusDto};
    use crate::proto::iec104_proto::SimulationPeriodicStatus;

    #[test]
    fn periodic_interval_accepts_integer_boundaries_and_default() {
        for seconds in [1.0, 5.0, 3600.0] {
            assert_eq!(validate_periodic_interval(seconds).unwrap(), seconds as u32);
        }
    }

    #[test]
    fn periodic_interval_rejects_non_integer_out_of_range_and_non_finite_values() {
        for seconds in [-1.0, 0.0, 1.5, 3600.5, 3601.0, f64::NAN, f64::INFINITY] {
            assert!(validate_periodic_interval(seconds).unwrap_err().contains("1～3600"));
        }
    }

    #[test]
    fn periodic_status_preserves_paused_and_last_sent_fields() {
        let dto = SimulationPeriodicStatusDto::from(SimulationPeriodicStatus {
            conn_name: "测试连接".to_string(),
            enabled: true,
            interval_seconds: 5,
            running: false,
            last_sent_ms: 1_793_000_000_123,
        });
        assert_eq!(serde_json::to_value(dto).unwrap(), serde_json::json!({
            "conn_name": "测试连接", "enabled": true, "interval_seconds": 5,
            "running": false, "last_sent_ms": 1_793_000_000_123_i64,
        }));
    }

    #[test]
    fn old_module_error_explains_compatibility_without_hiding_other_failures() {
        let unsupported = anyhow::Error::new(tonic::Status::unimplemented("unknown method"))
            .context("调用周期上报接口失败");
        let message = periodic_simulation_error(&unsupported);
        assert!(message.contains("版本不支持"));
        assert!(message.contains("手动发送"));
        let invalid = anyhow::Error::new(tonic::Status::invalid_argument("模拟快照为空"));
        assert!(periodic_simulation_error(&invalid).contains("模拟快照为空"));
        assert!(!periodic_simulation_error(&invalid).contains("版本不支持"));
    }
}

#[cfg(test)]
mod manual_simulation_tests {
    use super::ManualSimulationPointDto;
    use crate::proto::iec104_proto::SimulationPoint;

    fn point(point_type: i32, bool_value: Option<bool>, double_value: Option<f64>) -> ManualSimulationPointDto {
        ManualSimulationPointDto { tag: "测试点".to_string(), point_type, bool_value, double_value }
    }

    #[test]
    fn manual_values_preserve_zero_and_false_without_client_metadata() {
        let float: SimulationPoint = point(1, None, Some(0.0)).try_into().unwrap();
        assert_eq!(float.double_value, Some(0.0));
        assert_eq!(float.bool_value, None);
        assert_eq!(float.quality, 0);
        assert_eq!(float.ts_ms, 0);

        let single: SimulationPoint = point(2, Some(false), None).try_into().unwrap();
        assert_eq!(single.bool_value, Some(false));
        assert_eq!(single.double_value, None);
        assert_eq!(single.tag, "测试点");
        assert_eq!(single.r#type, 2);
    }

    #[test]
    fn manual_values_reject_missing_mismatched_and_unsupported_types() {
        for value in [
            point(1, None, None), point(2, None, None),
            point(1, Some(false), None), point(2, None, Some(0.0)),
            point(1, Some(true), Some(1.0)), point(2, Some(false), Some(0.0)),
            point(0, None, Some(1.0)), point(3, Some(true), None),
        ] {
            assert!(SimulationPoint::try_from(value).is_err());
        }
    }

    #[test]
    fn manual_values_reject_non_finite_numbers_and_empty_tags() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(SimulationPoint::try_from(point(1, None, Some(value))).is_err());
        }
        for tag in ["", "   "] {
            let mut value = point(1, None, Some(1.0));
            value.tag = tag.to_string();
            assert!(SimulationPoint::try_from(value).is_err());
        }
    }

    #[test]
    fn manual_input_distinguishes_absent_values_from_explicit_zero_and_false() {
        let missing: ManualSimulationPointDto = serde_json::from_value(serde_json::json!({
            "tag": "测试点", "point_type": 1
        })).unwrap();
        assert!(SimulationPoint::try_from(missing).is_err());
        let zero: ManualSimulationPointDto = serde_json::from_value(serde_json::json!({
            "tag": "测试点", "point_type": 1, "double_value": 0, "bool_value": null
        })).unwrap();
        assert_eq!(SimulationPoint::try_from(zero).unwrap().double_value, Some(0.0));
        let single: ManualSimulationPointDto = serde_json::from_value(serde_json::json!({
            "tag": "测试点", "point_type": 2, "bool_value": false, "double_value": null
        })).unwrap();
        assert_eq!(SimulationPoint::try_from(single).unwrap().bool_value, Some(false));
    }

    #[test]
    fn manual_input_rejects_client_metadata_and_wrong_json_value_types() {
        for fields in [
            serde_json::json!({ "quality": 128 }),
            serde_json::json!({ "ts_ms": 123 }),
            serde_json::json!({ "double_value": "0" }),
            serde_json::json!({ "bool_value": 0 }),
        ] {
            let mut json = serde_json::json!({ "tag": "测试点", "point_type": 1 });
            json.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            assert!(serde_json::from_value::<ManualSimulationPointDto>(json).is_err());
        }
    }
}

#[cfg(test)]
mod fixed_value_tests {
    use super::{Point, PointDto};

    fn legacy_point_json() -> serde_json::Value {
        serde_json::json!({
            "tag": "电压", "ioa": 16385, "point_type": 1,
            "business_type": 2, "scale": 2.5, "offset": -3.0, "deadband": 0.1,
            "scale_decimal": "2.5", "offset_decimal": "-3", "deadband_decimal": "0.1"
        })
    }

    // 验证旧 JSON 缺省关闭固定值，仍保留原工程量参数。
    #[test]
    fn legacy_point_defaults_to_live_value() {
        let dto: PointDto = serde_json::from_value(legacy_point_json()).unwrap();
        assert!(!dto.fixed_value_enabled);
        assert_eq!(dto.fixed_value, 0.0);
        assert_eq!(dto.to_proto().scale, 2.5);
        assert_eq!(dto.to_proto().offset_decimal, "-3");
    }

    // 验证固定零值、非零值和关闭后保留值经过 JSON 与 protobuf 双向转换不丢失。
    #[test]
    fn fixed_values_survive_json_and_proto_round_trip() {
        for (enabled, value) in [(true, 0.0), (true, 10.0), (false, 10.0)] {
            let mut json = legacy_point_json();
            json["fixed_value_enabled"] = serde_json::json!(enabled);
            json["fixed_value"] = serde_json::json!(value);
            let dto: PointDto = serde_json::from_value(json).unwrap();
            let proto: Point = dto.to_proto();
            assert_eq!(proto.fixed_value_enabled, enabled);
            assert_eq!(proto.fixed_value, value);
            let output = serde_json::to_value(PointDto::from(proto)).unwrap();
            assert_eq!(output["fixed_value_enabled"], serde_json::json!(enabled));
            assert_eq!(output["fixed_value"], serde_json::json!(value));
            assert_eq!(output["scale"], serde_json::json!(2.5));
            assert_eq!(output["offset"], serde_json::json!(-3.0));
            assert_eq!(output["scale_decimal"], "2.5");
        }
    }
}
