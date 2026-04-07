use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::module_manager::ModuleManagerClient;
use crate::state::AppState;

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

// ── Tauri Commands ──

/// 设置 ModuleManager 连接地址
#[tauri::command]
pub async fn set_manager_addr(state: State<'_, AppState>, addr: String) -> Result<(), String> {
    state.conn_manager.set_manager_addr(addr);
    state.conn_manager.clear_channels();
    Ok(())
}

/// 获取可用模块列表
#[tauri::command]
pub async fn get_module_info(state: State<'_, AppState>) -> Result<Vec<ModuleInfoDto>, String> {
    let client = ModuleManagerClient::new(&state.conn_manager);
    let infos = client.get_module_info().await.map_err(|e| e.to_string())?;
    Ok(infos.into_iter().map(|m| m.into()).collect())
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
    Ok(infos.into_iter().map(|m| m.into()).collect())
}

/// 启动模块
#[tauri::command]
pub async fn start_module(
    state: State<'_, AppState>,
    module_info: ModuleInfoDto,
) -> Result<(), String> {
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
    let client = ModuleManagerClient::new(&state.conn_manager);
    client
        .stop_module(module_info.to_proto())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
