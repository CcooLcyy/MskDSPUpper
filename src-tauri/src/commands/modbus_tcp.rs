use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::modbus_rtu::{ModbusPointDto, ModbusReadPlanDto};
use crate::grpc::modbus_tcp::ModbusTcpClient;
use crate::proto::modbus_tcp_proto::{LinkConfig, LinkInfo, PointTable, TcpConfig};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusTcpConfigDto {
    pub host: String,
    pub port: u32,
    pub unit_id: u32,
    pub connect_timeout_ms: u32,
    pub request_timeout_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusTcpLinkConfigDto {
    pub conn_name: String,
    pub tcp: Option<ModbusTcpConfigDto>,
    pub poll_interval_ms: u32,
    pub address_base: i32,
    pub read_plan: Option<ModbusReadPlanDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusTcpLinkInfoDto {
    pub config: Option<ModbusTcpLinkConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusTcpPointTableDto {
    pub conn_name: String,
    pub points: Vec<ModbusPointDto>,
}

impl From<TcpConfig> for ModbusTcpConfigDto {
    fn from(config: TcpConfig) -> Self {
        Self {
            host: config.host,
            port: config.port,
            unit_id: config.unit_id,
            connect_timeout_ms: config.connect_timeout_ms,
            request_timeout_ms: config.request_timeout_ms,
        }
    }
}

impl ModbusTcpConfigDto {
    pub(crate) fn to_proto(&self) -> TcpConfig {
        TcpConfig {
            host: self.host.clone(),
            port: self.port,
            unit_id: self.unit_id,
            connect_timeout_ms: self.connect_timeout_ms,
            request_timeout_ms: self.request_timeout_ms,
        }
    }
}

impl From<LinkConfig> for ModbusTcpLinkConfigDto {
    fn from(config: LinkConfig) -> Self {
        Self {
            conn_name: config.conn_name,
            tcp: config.tcp.map(Into::into),
            poll_interval_ms: config.poll_interval_ms,
            address_base: config.address_base,
            read_plan: config.read_plan.map(Into::into),
        }
    }
}

impl ModbusTcpLinkConfigDto {
    pub(crate) fn to_proto(&self) -> LinkConfig {
        LinkConfig {
            conn_name: self.conn_name.clone(),
            tcp: self.tcp.as_ref().map(ModbusTcpConfigDto::to_proto),
            poll_interval_ms: self.poll_interval_ms,
            address_base: self.address_base,
            read_plan: self.read_plan.as_ref().map(ModbusReadPlanDto::to_proto),
        }
    }
}

impl From<LinkInfo> for ModbusTcpLinkInfoDto {
    fn from(link: LinkInfo) -> Self {
        Self {
            config: link.config.map(Into::into),
            conn_id: link.conn_id,
            state: link.state,
            last_error: link.last_error,
        }
    }
}

impl From<PointTable> for ModbusTcpPointTableDto {
    fn from(table: PointTable) -> Self {
        Self {
            conn_name: table.conn_name,
            points: table.points.into_iter().map(Into::into).collect(),
        }
    }
}

#[tauri::command]
pub async fn modbus_tcp_upsert_link(
    state: State<'_, AppState>,
    config: ModbusTcpLinkConfigDto,
    create_only: bool,
) -> Result<ModbusTcpLinkInfoDto, String> {
    let conn_name = config.conn_name.clone();
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, create_only, "开始保存协议连接配置");
    let client = ModbusTcpClient::new(&state.conn_manager);
    let link = client
        .upsert_link(config.to_proto(), create_only)
        .await
        .map_err(|error| {
            tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "保存协议连接配置失败");
            error.to_string()
        })?;
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "保存协议连接配置完成");
    Ok(link.into())
}

#[tauri::command]
pub async fn modbus_tcp_rename_link(
    state: State<'_, AppState>,
    old_conn_name: String,
    new_conn_name: String,
) -> Result<ModbusTcpLinkInfoDto, String> {
    tracing::info!(protocol = "ModbusTCP", old_conn_name = %old_conn_name, new_conn_name = %new_conn_name, "开始重命名协议连接");
    let client = ModbusTcpClient::new(&state.conn_manager);
    let link = client
        .rename_link(old_conn_name.clone(), new_conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "ModbusTCP", old_conn_name = %old_conn_name, new_conn_name = %new_conn_name, error = %error, "重命名协议连接失败");
            error.to_string()
        })?;
    tracing::info!(protocol = "ModbusTCP", old_conn_name = %old_conn_name, new_conn_name = %new_conn_name, "重命名协议连接完成");
    Ok(link.into())
}

#[tauri::command]
pub async fn modbus_tcp_get_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<ModbusTcpLinkInfoDto, String> {
    let client = ModbusTcpClient::new(&state.conn_manager);
    client
        .get_link(conn_name.clone())
        .await
        .map(Into::into)
        .map_err(|error| {
            tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "获取协议连接失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn modbus_tcp_list_links(
    state: State<'_, AppState>,
) -> Result<Vec<ModbusTcpLinkInfoDto>, String> {
    let client = ModbusTcpClient::new(&state.conn_manager);
    let links = client.list_links().await.map_err(|error| {
        tracing::error!(protocol = "ModbusTCP", error = %error, "获取协议连接列表失败");
        error.to_string()
    })?;
    tracing::info!(
        protocol = "ModbusTCP",
        link_count = links.len(),
        "获取协议连接列表完成"
    );
    Ok(links.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn modbus_tcp_delete_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "开始删除协议连接");
    let client = ModbusTcpClient::new(&state.conn_manager);
    client.delete_link(conn_name.clone()).await.map_err(|error| {
        tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "删除协议连接失败");
        error.to_string()
    })?;
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "删除协议连接完成");
    Ok(())
}

#[tauri::command]
pub async fn modbus_tcp_start_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "开始启动连接功能");
    let client = ModbusTcpClient::new(&state.conn_manager);
    client.start_link(conn_name.clone()).await.map_err(|error| {
        tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "启动连接功能失败");
        error.to_string()
    })?;
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "启动连接功能完成");
    Ok(())
}

#[tauri::command]
pub async fn modbus_tcp_stop_link(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "开始停止连接功能");
    let client = ModbusTcpClient::new(&state.conn_manager);
    client.stop_link(conn_name.clone()).await.map_err(|error| {
        tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "停止连接功能失败");
        error.to_string()
    })?;
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "停止连接功能完成");
    Ok(())
}

#[tauri::command]
pub async fn modbus_tcp_upsert_point_table(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<ModbusPointDto>,
    replace: bool,
) -> Result<(), String> {
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, point_count = points.len(), replace, "开始保存协议点表");
    let client = ModbusTcpClient::new(&state.conn_manager);
    client
        .upsert_point_table(
            conn_name.clone(),
            points.iter().map(ModbusPointDto::to_proto).collect(),
            replace,
        )
        .await
        .map_err(|error| {
            tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "保存协议点表失败");
            error.to_string()
        })?;
    tracing::info!(protocol = "ModbusTCP", conn_name = %conn_name, "保存协议点表完成");
    Ok(())
}

#[tauri::command]
pub async fn modbus_tcp_get_point_table(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<ModbusTcpPointTableDto, String> {
    let client = ModbusTcpClient::new(&state.conn_manager);
    let table = client
        .get_point_table(conn_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(protocol = "ModbusTCP", conn_name = %conn_name, error = %error, "获取协议点表失败");
            error.to_string()
        })?;
    Ok(table.into())
}
