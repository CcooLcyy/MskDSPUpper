use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::dlt645::Dlt645Client;
use crate::proto::dlt645_proto::{
    Block, BlockItem, LinkConfig, LinkInfo, MqttConfig as ProtoMqttConfig, Point, PointTable,
    UpdateConfigResponse,
};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645MqttConfigDto {
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
pub struct Dlt645LinkConfigDto {
    pub conn_name: String,
    pub protocol_variant: i32,
    pub meter_addr: String,
    pub device_no: String,
    pub transport_type: i32,
    pub comm_mode: i32,
    pub poll_interval_ms: u32,
    pub poll_item_interval_ms: u32,
    pub request_timeout_ms: u32,
    pub serial_port: String,
    pub serial_baud_rate: u32,
    pub serial_data_bits: u32,
    pub serial_parity: i32,
    pub serial_stop_bits: i32,
    pub serial_byte_timeout_ms: u32,
    pub serial_frame_timeout_ms: u32,
    pub serial_est_size: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645LinkInfoDto {
    pub config: Option<Dlt645LinkConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645PointDto {
    pub tag: String,
    pub di: String,
    pub data_len: u32,
    pub data_type: i32,
    pub access: i32,
    pub scale: f64,
    pub offset: f64,
    pub deadband: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645BlockItemDto {
    pub tag: String,
    pub data_len: u32,
    pub data_type: i32,
    pub access: i32,
    pub scale: f64,
    pub offset: f64,
    pub deadband: f64,
    pub trim_right_space: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645BlockDto {
    pub block_di: String,
    pub block_data_len: u32,
    pub items: Vec<Dlt645BlockItemDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645PointTableDto {
    pub conn_name: String,
    pub points: Vec<Dlt645PointDto>,
    pub blocks: Vec<Dlt645BlockDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645UpdateConfigResponseDto {
    pub ok: bool,
    pub message: String,
}

impl From<ProtoMqttConfig> for Dlt645MqttConfigDto {
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

impl From<LinkConfig> for Dlt645LinkConfigDto {
    fn from(config: LinkConfig) -> Self {
        Self {
            conn_name: config.conn_name,
            protocol_variant: config.protocol_variant,
            meter_addr: config.meter_addr,
            device_no: config.device_no,
            transport_type: config.transport_type,
            comm_mode: config.comm_mode,
            poll_interval_ms: config.poll_interval_ms,
            poll_item_interval_ms: config.poll_item_interval_ms,
            request_timeout_ms: config.request_timeout_ms,
            serial_port: config.serial_port,
            serial_baud_rate: config.serial_baud_rate,
            serial_data_bits: config.serial_data_bits,
            serial_parity: config.serial_parity,
            serial_stop_bits: config.serial_stop_bits,
            serial_byte_timeout_ms: config.serial_byte_timeout_ms,
            serial_frame_timeout_ms: config.serial_frame_timeout_ms,
            serial_est_size: config.serial_est_size,
        }
    }
}

impl From<LinkInfo> for Dlt645LinkInfoDto {
    fn from(link: LinkInfo) -> Self {
        Self {
            config: link.config.map(|config| config.into()),
            conn_id: link.conn_id,
            state: link.state,
            last_error: link.last_error,
        }
    }
}

impl From<Point> for Dlt645PointDto {
    fn from(point: Point) -> Self {
        Self {
            tag: point.tag,
            di: point.di,
            data_len: point.data_len,
            data_type: point.r#type,
            access: point.access,
            scale: point.scale,
            offset: point.offset,
            deadband: point.deadband,
        }
    }
}

impl From<BlockItem> for Dlt645BlockItemDto {
    fn from(item: BlockItem) -> Self {
        Self {
            tag: item.tag,
            data_len: item.data_len,
            data_type: item.r#type,
            access: item.access,
            scale: item.scale,
            offset: item.offset,
            deadband: item.deadband,
            trim_right_space: item.trim_right_space,
        }
    }
}

impl From<Block> for Dlt645BlockDto {
    fn from(block: Block) -> Self {
        Self {
            block_di: block.block_di,
            block_data_len: block.block_data_len,
            items: block.items.into_iter().map(|item| item.into()).collect(),
        }
    }
}

impl From<PointTable> for Dlt645PointTableDto {
    fn from(table: PointTable) -> Self {
        Self {
            conn_name: table.conn_name,
            points: table.points.into_iter().map(|point| point.into()).collect(),
            blocks: table.blocks.into_iter().map(|block| block.into()).collect(),
        }
    }
}

impl From<UpdateConfigResponse> for Dlt645UpdateConfigResponseDto {
    fn from(resp: UpdateConfigResponse) -> Self {
        Self {
            ok: resp.ok,
            message: resp.message,
        }
    }
}

impl Dlt645MqttConfigDto {
    fn to_proto(&self) -> ProtoMqttConfig {
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

impl Dlt645LinkConfigDto {
    fn to_proto(&self) -> LinkConfig {
        LinkConfig {
            conn_name: self.conn_name.clone(),
            protocol_variant: self.protocol_variant,
            meter_addr: self.meter_addr.clone(),
            device_no: self.device_no.clone(),
            transport_type: self.transport_type,
            comm_mode: self.comm_mode,
            poll_interval_ms: self.poll_interval_ms,
            request_timeout_ms: self.request_timeout_ms,
            serial_port: self.serial_port.clone(),
            serial_baud_rate: self.serial_baud_rate,
            serial_data_bits: self.serial_data_bits,
            serial_parity: self.serial_parity,
            serial_stop_bits: self.serial_stop_bits,
            serial_byte_timeout_ms: self.serial_byte_timeout_ms,
            serial_frame_timeout_ms: self.serial_frame_timeout_ms,
            serial_est_size: self.serial_est_size,
            poll_item_interval_ms: self.poll_item_interval_ms,
        }
    }
}

impl Dlt645PointDto {
    fn to_proto(&self) -> Point {
        Point {
            tag: self.tag.clone(),
            di: self.di.clone(),
            data_len: self.data_len,
            r#type: self.data_type,
            access: self.access,
            scale: self.scale,
            offset: self.offset,
            deadband: self.deadband,
        }
    }
}

impl Dlt645BlockItemDto {
    fn to_proto(&self) -> BlockItem {
        BlockItem {
            tag: self.tag.clone(),
            data_len: self.data_len,
            r#type: self.data_type,
            access: self.access,
            scale: self.scale,
            offset: self.offset,
            deadband: self.deadband,
            trim_right_space: self.trim_right_space,
        }
    }
}

impl Dlt645BlockDto {
    fn to_proto(&self) -> Block {
        Block {
            block_di: self.block_di.clone(),
            block_data_len: self.block_data_len,
            items: self.items.iter().map(|item| item.to_proto()).collect(),
        }
    }
}

#[tauri::command]
pub async fn dlt645_update_config(
    state: State<'_, AppState>,
    mqtt: Dlt645MqttConfigDto,
) -> Result<Dlt645UpdateConfigResponseDto, String> {
    let client = Dlt645Client::new(&state.conn_manager);
    let resp = client
        .update_config(mqtt.to_proto())
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp.into())
}

#[tauri::command]
pub async fn dlt645_upsert_link(
    state: State<'_, AppState>,
    config: Dlt645LinkConfigDto,
    create_only: bool,
) -> Result<Dlt645LinkInfoDto, String> {
    let client = Dlt645Client::new(&state.conn_manager);
    let link = client
        .upsert_link(config.to_proto(), create_only)
        .await
        .map_err(|e| e.to_string())?;
    Ok(link.into())
}

#[tauri::command]
pub async fn dlt645_get_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<Dlt645LinkInfoDto, String> {
    let client = Dlt645Client::new(&state.conn_manager);
    let link = client
        .get_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(link.into())
}

#[tauri::command]
pub async fn dlt645_list_links(
    state: State<'_, AppState>,
) -> Result<Vec<Dlt645LinkInfoDto>, String> {
    let client = Dlt645Client::new(&state.conn_manager);
    let links = client.list_links().await.map_err(|e| e.to_string())?;
    Ok(links.into_iter().map(|link| link.into()).collect())
}

#[tauri::command]
pub async fn dlt645_delete_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    let client = Dlt645Client::new(&state.conn_manager);
    client
        .delete_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dlt645_start_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    let client = Dlt645Client::new(&state.conn_manager);
    client
        .start_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dlt645_stop_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    let client = Dlt645Client::new(&state.conn_manager);
    client
        .stop_link(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dlt645_upsert_point_table(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<Dlt645PointDto>,
    blocks: Vec<Dlt645BlockDto>,
    replace: bool,
) -> Result<(), String> {
    let client = Dlt645Client::new(&state.conn_manager);
    client
        .upsert_point_table(
            conn_name,
            points.into_iter().map(|point| point.to_proto()).collect(),
            replace,
            blocks.into_iter().map(|block| block.to_proto()).collect(),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dlt645_get_point_table(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<Dlt645PointTableDto, String> {
    let client = Dlt645Client::new(&state.conn_manager);
    let table = client
        .get_point_table(conn_name)
        .await
        .map_err(|e| e.to_string())?;
    Ok(table.into())
}
