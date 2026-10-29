//! 纵密公开证书本地文件与当前 DSP 的 SIM 地址辅助操作。
use crate::state::AppState;
use serde::Serialize;
use std::path::Path;

#[path = "security_admin_file_io.rs"]
mod file_io;
pub(super) use file_io::matches_sim_target;

#[derive(Serialize)]
pub struct CertificateFile {
    name: String,
    data: Vec<u8>,
}

#[tauri::command]
pub fn read_vertical_security_certificate_file(path: String) -> Result<CertificateFile, String> {
    let result = file_io::read_certificate(Path::new(&path));
    tracing::info!(success = result.is_ok(), "纵密公开证书本地读取完成");
    result.map(|(name, data)| CertificateFile { name, data })
}

#[tauri::command]
pub fn save_vertical_security_file(path: String, data: Vec<u8>) -> Result<String, String> {
    let result = file_io::save_file(Path::new(&path), &data);
    tracing::info!(
        success = result.is_ok(),
        bytes = data.len(),
        "纵密证书或申请文件本地保存完成"
    );
    result.map(|_| path)
}

#[tauri::command]
pub async fn get_vertical_security_sim_ip(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let text = super::lower_update::query_saved_ppp_address(&state).await?;
    let address = text.as_deref().and_then(file_io::parse_ppp_ipv4);
    tracing::info!(
        available = address.is_some(),
        "当前 DSP 的 SIM 卡地址只读查询完成"
    );
    Ok(address)
}
