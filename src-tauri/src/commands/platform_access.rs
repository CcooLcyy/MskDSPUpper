//! 出厂接入配置只经现场管理连接读写；令牌不回传、不记录请求正文。
use crate::{
    grpc::connection::ConnectionManager,
    proto::module_manager_proto::{
        module_manage_client::ModuleManageClient, Empty, OrdinaryNetworkConfig,
        PlatformAccessStatus, SetPlatformAccessConfigRequest,
    },
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;
use tonic::Code;

const PLATFORM_TARGET: &str = "60.208.15.90:50000";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Serialize)]
pub struct PlatformAccessError {
    pub kind: &'static str,
    pub message: String,
}
impl PlatformAccessError {
    fn new(kind: &'static str, message: &str) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    fn changed() -> Self {
        Self::new(
            "connection_changed",
            "现场连接已切换，请重新读取当前下位机配置",
        )
    }
    fn invalid() -> Self {
        Self::new(
            "invalid",
            "平台接入或普通外网配置不合法，请检查设备 ID、令牌、SSH 端口、网口、同网段 IPv4 网关和 DNS",
        )
    }
}
fn rpc_error(status: tonic::Status) -> PlatformAccessError {
    // 不回显服务器请求正文或任意调试详情，避免错误链带出只写令牌。
    match status.code() {
        Code::Unimplemented => PlatformAccessError::new(
            "unsupported",
            "当前下位机版本不支持平台接入配置，请先升级下位机",
        ),
        Code::Aborted => PlatformAccessError::new(
            "revision_conflict",
            "下位机配置已被其他操作修改，请重新读取后再保存",
        ),
        Code::InvalidArgument => PlatformAccessError::invalid(),
        Code::FailedPrecondition => PlatformAccessError::new(
            "network_apply_failed",
            "设备普通外网出口网络应用失败，请重新读取设备状态并检查网络运行环境",
        ),
        Code::Internal | Code::DataLoss => PlatformAccessError::new(
            "persist_failed",
            "下位机读取或持久保存配置失败，请检查配置文件和磁盘状态",
        ),
        Code::DeadlineExceeded => PlatformAccessError::new(
            "timeout",
            "下位机配置请求超时，请检查现场连接并重新读取结果",
        ),
        Code::Unavailable => PlatformAccessError::new(
            "unavailable",
            "无法访问下位机平台接入控制器，请检查连接和下位机版本",
        ),
        _ => PlatformAccessError::new(
            "request_failed",
            "下位机拒绝了配置请求，请检查现场连接后重新读取",
        ),
    }
}

#[derive(Serialize)]
pub struct PlatformAccessDto {
    enabled: bool,
    platform_target: &'static str,
    device_id: String,
    token_configured: bool,
    ssh_enabled: bool,
    ssh_port: u32,
    revision: String,
    online: bool,
    last_error: String,
    connection_generation: String,
    manager_address: String,
    network_config: Option<OrdinaryNetworkDto>,
    network_applied: bool,
    network_error: String,
    network_source_address: String,
    // 使用本次下位机响应的架构，不能从上位机本机或连接地址推断。
    device_architecture: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrdinaryNetworkDto {
    interface_name: String,
    gateway: String,
    dns_servers: Vec<String>,
}
impl OrdinaryNetworkDto {
    fn into_proto(self) -> Result<OrdinaryNetworkConfig, PlatformAccessError> {
        let valid_ip = |value: &str| {
            value.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| {
                !ip.is_unspecified()
                    && !ip.is_loopback()
                    && !ip.is_multicast()
                    && !ip.is_broadcast()
                    && ip.octets()[0] < 224
            })
        };
        let valid = if self.interface_name.is_empty() {
            self.gateway.is_empty() && self.dns_servers.is_empty()
        } else {
            (101..=108).any(|port| self.interface_name == format!("eth0.{port}"))
                && valid_ip(&self.gateway)
                && self.dns_servers.len() <= 8
                && self.dns_servers.iter().all(|ip| valid_ip(ip))
        };
        if !valid {
            return Err(PlatformAccessError::new(
                "invalid",
                "普通外网出口网口、IPv4 网关或 DNS 配置不合法",
            ));
        }
        Ok(OrdinaryNetworkConfig {
            interface_name: self.interface_name,
            gateway: self.gateway,
            dns_servers: self.dns_servers,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlatformAccessWriteDto {
    expected_revision: String,
    enabled: bool,
    device_id: String,
    device_token: String,
    ssh_enabled: bool,
    ssh_port: u32,
    clear_device_token: bool,
    connection_generation: String,
    manager_address: String,
    network_config: Option<OrdinaryNetworkDto>,
}
struct DirectContext {
    generation: u64,
    address: String,
}
impl DirectContext {
    fn capture(conn: &ConnectionManager) -> Result<Self, PlatformAccessError> {
        if conn.is_remote() {
            return Err(PlatformAccessError::new(
                "direct_only",
                "请返回现场直连后配置设备平台接入",
            ));
        }
        Ok(Self {
            generation: conn.runtime_generation(),
            address: conn.manager_addr(),
        })
    }
    fn verify(&self, conn: &ConnectionManager) -> Result<(), PlatformAccessError> {
        if conn.is_remote()
            || self.generation != conn.runtime_generation()
            || self.address != conn.manager_addr()
        {
            return Err(PlatformAccessError::changed());
        }
        Ok(())
    }
    fn response(
        &self,
        response: PlatformAccessStatus,
    ) -> Result<PlatformAccessDto, PlatformAccessError> {
        if response.platform_target != PLATFORM_TARGET {
            return Err(PlatformAccessError::new(
                "unsupported",
                "下位机返回的平台接入协议不兼容，请升级下位机",
            ));
        }
        Ok(PlatformAccessDto {
            enabled: response.enabled,
            platform_target: PLATFORM_TARGET,
            device_id: response.device_id,
            token_configured: response.token_configured,
            ssh_enabled: response.ssh_enabled,
            ssh_port: response.ssh_port,
            revision: response.revision.to_string(),
            online: response.online,
            last_error: response.last_error,
            connection_generation: self.generation.to_string(),
            manager_address: self.address.clone(),
            network_config: response.network_config.map(|network| OrdinaryNetworkDto {
                interface_name: network.interface_name,
                gateway: network.gateway,
                dns_servers: network.dns_servers,
            }),
            network_applied: response.network_applied,
            network_error: response.network_error,
            network_source_address: response.network_source_address,
            device_architecture: response.device_architecture,
        })
    }
}
fn decimal(value: &str) -> Result<u64, PlatformAccessError> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PlatformAccessError::invalid());
    }
    value.parse().map_err(|_| PlatformAccessError::invalid())
}
impl PlatformAccessWriteDto {
    fn into_proto(self) -> Result<SetPlatformAccessConfigRequest, PlatformAccessError> {
        let id = self.device_id.trim();
        if id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || (self.enabled && id.is_empty())
            || self.device_token.len() > 4096
            || !self
                .device_token
                .bytes()
                .all(|b| (0x21..=0x7e).contains(&b))
            || (self.clear_device_token && (!self.device_token.is_empty() || self.enabled))
            || self.ssh_port > 65535
        {
            return Err(PlatformAccessError::invalid());
        }
        Ok(SetPlatformAccessConfigRequest {
            expected_revision: decimal(&self.expected_revision)?,
            enabled: self.enabled,
            device_id: id.into(),
            device_token: self.device_token,
            ssh_enabled: self.ssh_enabled,
            ssh_port: if self.ssh_port == 0 {
                22
            } else {
                self.ssh_port
            },
            clear_device_token: self.clear_device_token,
            network_config: self
                .network_config
                .map(OrdinaryNetworkDto::into_proto)
                .transpose()?,
        })
    }
}

pub(crate) async fn read(
    conn: &ConnectionManager,
) -> Result<PlatformAccessDto, PlatformAccessError> {
    read_before(conn, tokio::time::Instant::now() + REQUEST_TIMEOUT).await
}

async fn channel_before(
    conn: &ConnectionManager,
    context: &DirectContext,
    deadline: tokio::time::Instant,
) -> Result<tonic::transport::Channel, PlatformAccessError> {
    let result = tokio::time::timeout_at(deadline, conn.get_channel(&context.address)).await;
    context.verify(conn)?;
    result
        .map_err(|_| rpc_error(tonic::Status::deadline_exceeded("")))?
        .map_err(|_| {
            PlatformAccessError::new(
                "unavailable",
                "无法连接现场下位机，请先检查 ModuleManager 地址",
            )
        })
}

async fn read_before(
    conn: &ConnectionManager,
    deadline: tokio::time::Instant,
) -> Result<PlatformAccessDto, PlatformAccessError> {
    let context = DirectContext::capture(conn)?;
    let channel = channel_before(conn, &context, deadline).await?;
    let result = tokio::time::timeout_at(
        deadline,
        ModuleManageClient::new(channel).get_platform_access_config(Empty {}),
    )
    .await;
    context.verify(conn)?;
    let response = result
        .map_err(|_| rpc_error(tonic::Status::deadline_exceeded("")))?
        .map_err(rpc_error)?
        .into_inner();
    context.response(response)
}
pub(crate) async fn write(
    conn: &ConnectionManager,
    request: PlatformAccessWriteDto,
) -> Result<PlatformAccessDto, PlatformAccessError> {
    let deadline = tokio::time::Instant::now() + WRITE_TIMEOUT;
    let context = DirectContext::capture(conn)?;
    if decimal(&request.connection_generation)? != context.generation
        || request.manager_address != context.address
    {
        return Err(PlatformAccessError::changed());
    }
    let request = request.into_proto()?;
    let writes_network = request.network_config.is_some();
    if writes_network {
        let current = read_before(conn, deadline).await?;
        context.verify(conn)?;
        if current.network_config.is_none() {
            return Err(PlatformAccessError::new(
                "unsupported",
                "当前下位机不支持普通外网出口配置，请升级下位机；已有平台设置仍可单独保存",
            ));
        }
    }
    let channel = channel_before(conn, &context, deadline).await?;
    let result = tokio::time::timeout_at(
        deadline,
        ModuleManageClient::new(channel).set_platform_access_config(request),
    )
    .await;
    context.verify(conn)?;
    let response = result
        .map_err(|_| rpc_error(tonic::Status::deadline_exceeded("")))?
        .map_err(rpc_error)?
        .into_inner();
    let response = context.response(response)?;
    if writes_network && response.network_config.is_none() {
        return Err(PlatformAccessError::new(
            "unsupported",
            "下位机未确认普通外网出口配置，请升级下位机并重新读取",
        ));
    }
    if writes_network && (!response.network_applied || !response.network_error.is_empty()) {
        return Err(rpc_error(tonic::Status::failed_precondition("")));
    }
    tracing::info!(
        revision = response.revision,
        device_id = response.device_id,
        enabled = response.enabled,
        device_architecture = response.device_architecture,
        network_applied = response.network_applied,
        network_configured = response
            .network_config
            .as_ref()
            .is_some_and(|network| !network.interface_name.is_empty()),
        "下位机平台接入与普通外网配置请求完成"
    );
    Ok(response)
}
#[tauri::command]
pub async fn get_lower_platform_access_config(
    state: State<'_, AppState>,
) -> Result<PlatformAccessDto, PlatformAccessError> {
    read(&state.conn_manager).await
}
#[tauri::command]
pub async fn set_lower_platform_access_config(
    state: State<'_, AppState>,
    request: PlatformAccessWriteDto,
) -> Result<PlatformAccessDto, PlatformAccessError> {
    write(&state.conn_manager, request).await
}

#[cfg(test)]
#[path = "platform_access_tests.rs"]
mod tests;
