use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::module_manager::ModuleManagerClient;
use crate::state::AppState;

const UNCONTROLLED_MODULE_NAMES: &[&str] = &["ConfigPusher"];

// ── 序列化类型（前端 ↔ Rust） ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleVersionDto {
    pub major: String,
    pub minor: String,
    pub patch: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleDependencyDto {
    pub module_name: String,
    pub version_range: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleInfoDto {
    pub module_name: String,
    pub version: Option<ModuleVersionDto>,
    pub lib_name: String,
    pub dependencies: Vec<ModuleDependencyDto>,
    pub manifest_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleRunningInfoDto {
    pub module_name: String,
    pub version: Option<ModuleVersionDto>,
    pub lib_name: String,
    pub inner_grpc_server: String,
    pub outer_grpc_server: String,
}

// ── Proto → DTO 转换 ──

impl From<crate::proto::module_manager_proto::ModuleVersion> for ModuleVersionDto {
    fn from(v: crate::proto::module_manager_proto::ModuleVersion) -> Self {
        Self {
            major: v.major,
            minor: v.minor,
            patch: v.patch,
            version: v.version,
        }
    }
}

impl From<crate::proto::module_manager_proto::ModuleDependency> for ModuleDependencyDto {
    fn from(d: crate::proto::module_manager_proto::ModuleDependency) -> Self {
        Self {
            module_name: d.module_name,
            version_range: d.version_range,
        }
    }
}

impl From<crate::proto::module_manager_proto::ModuleInfo> for ModuleInfoDto {
    fn from(m: crate::proto::module_manager_proto::ModuleInfo) -> Self {
        Self {
            module_name: m.module_name,
            version: m.version.map(|v| v.into()),
            lib_name: m.lib_name,
            dependencies: m.dependencies.into_iter().map(|d| d.into()).collect(),
            manifest_error: m.manifest_error,
        }
    }
}

impl From<crate::proto::module_manager_proto::ModuleRunningInfo> for ModuleRunningInfoDto {
    fn from(m: crate::proto::module_manager_proto::ModuleRunningInfo) -> Self {
        Self {
            module_name: m.module_name,
            version: m.version.map(|v| v.into()),
            lib_name: m.lib_name,
            inner_grpc_server: m.inner_grpc_server,
            outer_grpc_server: m.outer_grpc_server,
        }
    }
}

// ── DTO → Proto 转换（用于 StartModule/StopModule） ──

impl ModuleInfoDto {
    fn to_proto(&self) -> crate::proto::module_manager_proto::ModuleInfo {
        crate::proto::module_manager_proto::ModuleInfo {
            module_name: self.module_name.clone(),
            version: self.version.as_ref().map(|v| {
                crate::proto::module_manager_proto::ModuleVersion {
                    major: v.major.clone(),
                    minor: v.minor.clone(),
                    patch: v.patch.clone(),
                    version: v.version.clone(),
                }
            }),
            lib_name: self.lib_name.clone(),
            dependencies: self
                .dependencies
                .iter()
                .map(|d| crate::proto::module_manager_proto::ModuleDependency {
                    module_name: d.module_name.clone(),
                    version_range: d.version_range.clone(),
                })
                .collect(),
            manifest_error: self.manifest_error.clone(),
        }
    }
}

fn is_upper_controlled_module_name(module_name: &str) -> bool {
    !UNCONTROLLED_MODULE_NAMES
        .iter()
        .any(|ignored| module_name.eq_ignore_ascii_case(ignored))
}

fn reject_uncontrolled_module(module_name: &str) -> Result<(), String> {
    if is_upper_controlled_module_name(module_name) {
        Ok(())
    } else {
        Err(format!(
            "Module {module_name} is not controlled by this upper app"
        ))
    }
}

fn validate_manager_addr(addr: &str) -> Result<String, String> {
    let trimmed = addr.trim();
    if trimmed.is_empty() {
        return Err("请输入 ModuleManager 地址".into());
    }

    let Some((host_raw, port_raw)) = trimmed.rsplit_once(':') else {
        return Err("地址格式应为 host:port".into());
    };

    let host = host_raw.trim();
    let port_text = port_raw.trim();

    if !is_valid_host(host) {
        return Err("请输入合法的 IPv4 地址或主机名".into());
    }

    let port: u16 = port_text
        .parse()
        .map_err(|_| String::from("端口必须是 1-65535 的整数"))?;

    if port == 0 {
        return Err("端口范围必须在 1-65535 之间".into());
    }

    Ok(format!("{host}:{port}"))
}

fn is_valid_host(host: &str) -> bool {
    if host.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        return is_valid_ipv4(host);
    }

    is_valid_hostname(host)
}

fn is_valid_ipv4(host: &str) -> bool {
    let segments: Vec<&str> = host.split('.').collect();
    if segments.len() != 4 {
        return false;
    }

    segments.iter().all(|segment| {
        !segment.is_empty()
            && segment.len() <= 3
            && segment.chars().all(|ch| ch.is_ascii_digit())
            && segment.parse::<u8>().is_ok()
    })
}

fn is_valid_hostname(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.starts_with('.') || host.ends_with('.') {
        return false;
    }

    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })
}

// ── Tauri Commands ──

/// 设置 ModuleManager 连接地址
#[tauri::command]
pub async fn set_manager_addr(state: State<'_, AppState>, addr: String) -> Result<(), String> {
    let normalized_addr = validate_manager_addr(&addr)?;
    state.protocol_shadow.stop();
    state.conn_manager.set_manager_addr(normalized_addr);
    state.conn_manager.clear_channels();
    Ok(())
}

/// 获取可用模块列表
#[tauri::command]
pub async fn get_module_info(state: State<'_, AppState>) -> Result<Vec<ModuleInfoDto>, String> {
    let client = ModuleManagerClient::new(&state.conn_manager);
    let infos = client.get_module_info().await.map_err(|e| e.to_string())?;
    Ok(infos
        .into_iter()
        .map(ModuleInfoDto::from)
        .filter(|m| is_upper_controlled_module_name(&m.module_name))
        .collect())
}

/// 获取运行中模块信息（同时刷新地址缓存）
#[tauri::command]
pub async fn get_running_module_info(
    state: State<'_, AppState>,
) -> Result<Vec<ModuleRunningInfoDto>, String> {
    let client = ModuleManagerClient::new(&state.conn_manager);
    let infos = client
        .get_running_module_info()
        .await
        .map_err(|e| e.to_string())?;
    Ok(infos
        .into_iter()
        .map(ModuleRunningInfoDto::from)
        .filter(|m| is_upper_controlled_module_name(&m.module_name))
        .collect())
}

/// 启动模块
#[tauri::command]
pub async fn start_module(
    state: State<'_, AppState>,
    module_info: ModuleInfoDto,
) -> Result<(), String> {
    reject_uncontrolled_module(&module_info.module_name)?;

    let client = ModuleManagerClient::new(&state.conn_manager);
    client
        .start_module(module_info.to_proto())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 停止模块
#[tauri::command]
pub async fn stop_module(
    state: State<'_, AppState>,
    module_info: ModuleInfoDto,
) -> Result<(), String> {
    reject_uncontrolled_module(&module_info.module_name)?;

    let client = ModuleManagerClient::new(&state.conn_manager);
    client
        .stop_module(module_info.to_proto())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        is_upper_controlled_module_name, reject_uncontrolled_module, validate_manager_addr,
    };

    #[test]
    fn config_pusher_is_not_upper_controlled() {
        assert!(!is_upper_controlled_module_name("ConfigPusher"));
        assert!(!is_upper_controlled_module_name("configpusher"));
        assert!(is_upper_controlled_module_name("ModbusRTU"));
        assert!(reject_uncontrolled_module("ConfigPusher").is_err());
    }

    #[test]
    fn validate_manager_addr_accepts_ipv4_and_hostname() {
        assert_eq!(
            validate_manager_addr("127.0.0.1:17000").unwrap(),
            "127.0.0.1:17000"
        );
        assert_eq!(
            validate_manager_addr("  localhost : 17000 ").unwrap(),
            "localhost:17000"
        );
        assert_eq!(
            validate_manager_addr("module-manager.local:17000").unwrap(),
            "module-manager.local:17000"
        );
    }

    #[test]
    fn validate_manager_addr_rejects_bad_ip_and_port() {
        assert!(validate_manager_addr("999.0.0.1:17000").is_err());
        assert!(validate_manager_addr("127.0.0.1:not-a-port").is_err());
        assert!(validate_manager_addr("127.0.0.1:0").is_err());
        assert!(validate_manager_addr("127.0.0.1:70000").is_err());
        assert!(validate_manager_addr("module_manager:17000").is_err());
        assert!(validate_manager_addr("127.0.0.1").is_err());
    }
}
