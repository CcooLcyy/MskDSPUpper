use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::modbus_rtu::ModbusRtuClient;
use crate::proto::modbus_rtu_proto::{
    LinkConfig, LinkInfo, MqttConfig as ProtoMqttConfig, Point, PointTable, ReadBlock, ReadPlan,
    SerialConfig, UpdateConfigResponse,
};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusSerialConfigDto {
    pub device: String,
    pub baud_rate: u32,
    pub data_bits: u32,
    pub parity: i32,
    pub stop_bits: i32,
    pub read_timeout_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusMqttConfigDto {
    pub host: String,
    pub port: u32,
    pub client_id: String,
    pub username: String,
    pub password: String,
    pub keepalive_sec: u32,
    pub clean_session: bool,
    pub connect_timeout_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusReadBlockDto {
    pub function: i32,
    pub start: u32,
    pub quantity: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusReadPlanDto {
    pub mode: i32,
    pub blocks: Vec<ModbusReadBlockDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusLinkConfigDto {
    pub conn_name: String,
    pub serial: Option<ModbusSerialConfigDto>,
    pub device_id: u32,
    pub poll_interval_ms: u32,
    pub address_base: i32,
    pub read_plan: Option<ModbusReadPlanDto>,
    pub transport_type: i32,
    pub serial_port: String,
    pub request_timeout_ms: u32,
    pub serial_byte_timeout_ms: u32,
    pub serial_frame_timeout_ms: u32,
    pub serial_est_size: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusLinkInfoDto {
    pub config: Option<ModbusLinkConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusPointDto {
    pub tag: String,
    pub function: i32,
    pub address: u32,
    pub data_type: i32,
    pub scale: f64,
    pub offset: f64,
    pub deadband: f64,
    pub reg_count: u32,
    pub word_order: i32,
    pub byte_order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusPointTableDto {
    pub conn_name: String,
    pub points: Vec<ModbusPointDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusUpdateConfigResponseDto {
    pub ok: bool,
    pub message: String,
}

impl From<SerialConfig> for ModbusSerialConfigDto {
    fn from(config: SerialConfig) -> Self {
        Self {
            device: config.device,
            baud_rate: config.baud_rate,
            data_bits: config.data_bits,
            parity: config.parity,
            stop_bits: config.stop_bits,
            read_timeout_ms: config.read_timeout_ms,
        }
    }
}

impl From<ProtoMqttConfig> for ModbusMqttConfigDto {
    fn from(config: ProtoMqttConfig) -> Self {
        Self {
            host: config.host,
            port: config.port,
            client_id: config.client_id,
            username: config.username,
            password: config.password,
            keepalive_sec: config.keepalive_sec,
            clean_session: config.clean_session,
            connect_timeout_ms: config.connect_timeout_ms,
        }
    }
}

impl From<ReadBlock> for ModbusReadBlockDto {
    fn from(block: ReadBlock) -> Self {
        Self {
            function: block.function,
            start: block.start,
            quantity: block.quantity,
        }
    }
}

impl From<ReadPlan> for ModbusReadPlanDto {
    fn from(plan: ReadPlan) -> Self {
        Self {
            mode: plan.mode,
            blocks: plan.blocks.into_iter().map(|block| block.into()).collect(),
        }
    }
}

impl From<LinkConfig> for ModbusLinkConfigDto {
    fn from(config: LinkConfig) -> Self {
        Self {
            conn_name: config.conn_name,
            serial: config.serial.map(|serial| serial.into()),
            device_id: config.device_id,
            poll_interval_ms: config.poll_interval_ms,
            address_base: config.address_base,
            read_plan: config.read_plan.map(|plan| plan.into()),
            transport_type: config.transport_type,
            serial_port: config.serial_port,
            request_timeout_ms: config.request_timeout_ms,
            serial_byte_timeout_ms: config.serial_byte_timeout_ms,
            serial_frame_timeout_ms: config.serial_frame_timeout_ms,
            serial_est_size: config.serial_est_size,
        }
    }
}

impl From<LinkInfo> for ModbusLinkInfoDto {
    fn from(link: LinkInfo) -> Self {
        Self {
            config: link.config.map(|config| config.into()),
            conn_id: link.conn_id,
            state: link.state,
            last_error: link.last_error,
        }
    }
}

impl From<Point> for ModbusPointDto {
    fn from(point: Point) -> Self {
        Self {
            tag: point.tag,
            function: point.function,
            address: point.address,
            data_type: point.r#type,
            scale: point.scale,
            offset: point.offset,
            deadband: point.deadband,
            reg_count: point.reg_count,
            word_order: point.word_order,
            byte_order: point.byte_order,
        }
    }
}

impl From<PointTable> for ModbusPointTableDto {
    fn from(table: PointTable) -> Self {
        Self {
            conn_name: table.conn_name,
            points: table.points.into_iter().map(|point| point.into()).collect(),
        }
    }
}

impl From<UpdateConfigResponse> for ModbusUpdateConfigResponseDto {
    fn from(resp: UpdateConfigResponse) -> Self {
        Self {
            ok: resp.ok,
            message: resp.message,
        }
    }
}

impl ModbusSerialConfigDto {
    pub(crate) fn to_proto(&self) -> SerialConfig {
        SerialConfig {
            device: self.device.clone(),
            baud_rate: self.baud_rate,
            data_bits: self.data_bits,
            parity: self.parity,
            stop_bits: self.stop_bits,
            read_timeout_ms: self.read_timeout_ms,
        }
    }
}

impl ModbusMqttConfigDto {
    pub(crate) fn to_proto(&self) -> ProtoMqttConfig {
        ProtoMqttConfig {
            host: self.host.clone(),
            port: self.port,
            client_id: self.client_id.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            keepalive_sec: self.keepalive_sec,
            clean_session: self.clean_session,
            connect_timeout_ms: self.connect_timeout_ms,
        }
    }
}

impl ModbusReadBlockDto {
    pub(crate) fn to_proto(&self) -> ReadBlock {
        ReadBlock {
            function: self.function,
            start: self.start,
            quantity: self.quantity,
        }
    }
}

impl ModbusReadPlanDto {
    pub(crate) fn to_proto(&self) -> ReadPlan {
        ReadPlan {
            mode: self.mode,
            blocks: self.blocks.iter().map(|block| block.to_proto()).collect(),
        }
    }
}

impl ModbusLinkConfigDto {
    pub(crate) fn to_proto(&self) -> LinkConfig {
        LinkConfig {
            conn_name: self.conn_name.clone(),
            serial: self.serial.as_ref().map(|serial| serial.to_proto()),
            device_id: self.device_id,
            poll_interval_ms: self.poll_interval_ms,
            address_base: self.address_base,
            read_plan: self.read_plan.as_ref().map(|plan| plan.to_proto()),
            transport_type: self.transport_type,
            serial_port: self.serial_port.clone(),
            request_timeout_ms: self.request_timeout_ms,
            serial_byte_timeout_ms: self.serial_byte_timeout_ms,
            serial_frame_timeout_ms: self.serial_frame_timeout_ms,
            serial_est_size: self.serial_est_size,
        }
    }
}

impl ModbusPointDto {
    pub(crate) fn to_proto(&self) -> Point {
        Point {
            tag: self.tag.clone(),
            function: self.function,
            address: self.address,
            r#type: self.data_type,
            scale: self.scale,
            offset: self.offset,
            deadband: self.deadband,
            reg_count: self.reg_count,
            word_order: self.word_order,
            byte_order: self.byte_order,
        }
    }
}

#[tauri::command]
pub async fn modbus_rtu_update_config(
    state: State<'_, AppState>,
    mqtt: ModbusMqttConfigDto,
) -> Result<ModbusUpdateConfigResponseDto, String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    let resp = client
        .update_config(mqtt.to_proto())
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp.into())
}

#[tauri::command]
pub async fn modbus_rtu_upsert_link(
    state: State<'_, AppState>,
    config: ModbusLinkConfigDto,
    create_only: bool,
) -> Result<ModbusLinkInfoDto, String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    let link = client
        .upsert_link(config.to_proto(), create_only)
        .await
        .map_err(|e| e.to_string())?;
    Ok(link.into())
}

#[tauri::command]
pub async fn modbus_rtu_rename_link(
    state: State<'_, AppState>,
    old_conn_name: String,
    new_conn_name: String,
) -> Result<ModbusLinkInfoDto, String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    let link = client
        .rename_link(old_conn_name, new_conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(link.into())
}

#[tauri::command]
pub async fn modbus_rtu_get_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<ModbusLinkInfoDto, String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    let link = client
        .get_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(link.into())
}

#[tauri::command]
pub async fn modbus_rtu_list_links(
    state: State<'_, AppState>,
) -> Result<Vec<ModbusLinkInfoDto>, String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    let links = client.list_links().await.map_err(|e| e.to_string())?;
    Ok(links.into_iter().map(|link| link.into()).collect())
}

#[tauri::command]
pub async fn modbus_rtu_delete_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    client
        .delete_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn modbus_rtu_start_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    client
        .start_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn modbus_rtu_stop_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    client
        .stop_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn modbus_rtu_upsert_point_table(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<ModbusPointDto>,
    replace: bool,
) -> Result<(), String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    client
        .upsert_point_table(
            conn_name,
            points.into_iter().map(|point| point.to_proto()).collect(),
            replace,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn modbus_rtu_get_point_table(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<ModbusPointTableDto, String> {
    let client = ModbusRtuClient::new(&state.conn_manager);
    let table = client
        .get_point_table(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(table.into())
}
