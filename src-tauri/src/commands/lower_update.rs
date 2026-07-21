use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

#[derive(Serialize, Deserialize)]
#[serde(tag = "method")]
pub enum LowerUpdateSshAuthDto {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "certificate")]
    Certificate,
}

const DEFAULT_LOWER_UPDATE_BASE_URL: &str = "https://update.clsclear.top/mskdsp-lower";
const LOWER_UPDATE_PLATFORM: &str = "linux-arm64";
const LOWER_UPDATE_PRODUCT: &str = "mskdsp-lower";
const LOWER_UPDATE_SCHEMA_VERSION: u32 = 1;
const LOWER_UPDATE_CONTAINER_NAME: &str = "mskdsp";
const LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const LOWER_UPDATE_RUNTIME_QUERY_COMMAND: &str = concat!(
    "set -e; ",
    "if ! command -v docker >/dev/null 2>&1; then ",
    "printf '%s\\n' '__MSKDSP_DOCKER_UNAVAILABLE__' >&2; exit 127; fi; ",
    "RESULT=\"$(docker inspect --type=container --format ",
    "'{{.State.Running}} {{.Image}}' mskdsp 2>&1)\" || { ",
    "case \"$RESULT\" in ",
    "*\"No such container\"*|*\"No such object\"*) ",
    "printf '%s\\n' '__MSKDSP_CONTAINER_MISSING__'; exit 0 ;; ",
    "*) printf '%s\\n' \"$RESULT\" >&2; exit 1 ;; esac; }; ",
    "printf '%s\\n' \"$RESULT\""
);
pub const LOWER_UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "lower-update-download-progress";
pub const LOWER_UPDATE_UPLOAD_PROGRESS_EVENT: &str = "lower-update-upload-progress";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerUpdateSourceDto {
    pub repository: String,
    #[serde(rename = "ref")]
    pub source_ref: String,
    pub sha: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerUpdateAssetDto {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerUpdateChecksumDto {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerUpdateManifestDto {
    pub schema_version: u32,
    pub product: String,
    pub channel: String,
    pub platform: String,
    pub version: String,
    pub package_version: String,
    #[serde(default)]
    pub image_id: Option<String>,
    pub published_at: String,
    pub source: LowerUpdateSourceDto,
    pub asset: LowerUpdateAssetDto,
    pub checksum: LowerUpdateChecksumDto,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateDownloadProgressDto {
    pub package_name: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u8,
    pub stage: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateDownloadResultDto {
    pub package_name: String,
    pub package_path: String,
    pub downloaded_bytes: u64,
    pub sha256: String,
}

#[derive(Serialize, Deserialize)]
pub struct LowerUpdateUploadRequestDto {
    pub package_name: String,
    pub package_path: String,
    pub package_size: u64,
    pub upload_account: String,
    pub install_dir: String,
    pub auth: LowerUpdateSshAuthDto,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateUploadProgressDto {
    pub package_name: String,
    pub remote_path: String,
    pub uploaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u8,
    pub stage: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateUploadResultDto {
    pub package_name: String,
    pub remote_path: String,
    pub uploaded_bytes: u64,
}

#[derive(Serialize, Deserialize)]
pub struct LowerUpdateInstallRequestDto {
    pub package_name: String,
    pub upload_account: String,
    pub install_dir: String,
    pub auth: LowerUpdateSshAuthDto,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateInstallResultDto {
    pub package_name: String,
    pub remote_path: String,
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Deserialize)]
pub struct LowerUpdateRuntimeInfoRequestDto {
    pub upload_account: String,
    pub auth: LowerUpdateSshAuthDto,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateRuntimeInfoDto {
    pub container_name: String,
    pub exists: bool,
    pub running: bool,
    pub image_id: Option<String>,
}

struct RemoteCommandOutput {
    exit_code: Option<u32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone)]
struct LowerUpdateUploadTarget {
    user: String,
    host: String,
    port: u16,
}

struct PasswordSshHandler {
    host: String,
    port: u16,
}

impl russh::client::Handler for PasswordSshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                russh::keys::known_hosts::learn_known_hosts(
                    &self.host,
                    self.port,
                    server_public_key,
                )
                .map_err(russh::Error::from)?;
                Ok(true)
            }
            Err(error) => Err(error.into()),
        }
    }
}

async fn connect_password_ssh(
    target: &LowerUpdateUploadTarget,
    password: &str,
) -> Result<russh::client::Handle<PasswordSshHandler>, String> {
    if password.is_empty() {
        return Err("SSH 密码不能为空".into());
    }
    let config = russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    };
    let mut session = russh::client::connect(
        Arc::new(config),
        (target.host.as_str(), target.port),
        PasswordSshHandler {
            host: target.host.clone(),
            port: target.port,
        },
    )
    .await
    .map_err(|e| format!("SSH 密码连接失败: {e}"))?;
    let auth = session
        .authenticate_password(target.user.clone(), password.to_string())
        .await
        .map_err(|e| format!("SSH 密码认证失败: {e}"))?;
    if !auth.success() {
        return Err("SSH 用户名或密码错误，或下位机未启用密码认证".into());
    }
    if let Err(error) = save_password(target, password) {
        tracing::warn!(%error, "保存下位机 SSH 密码失败，将继续本次更新");
    }
    Ok(session)
}

async fn upload_with_password_ssh(
    app_handle: &AppHandle,
    target: &LowerUpdateUploadTarget,
    password: &str,
    package_name: &str,
    package_path: &Path,
    remote_path: &str,
    remote_command: &str,
) -> Result<u64, String> {
    let metadata = fs::metadata(package_path)
        .await
        .map_err(|e| format!("读取上位机更新包失败: {e}"))?;
    let total_bytes = metadata.len();
    let mut file = fs::File::open(package_path)
        .await
        .map_err(|e| format!("打开上位机更新包失败: {e}"))?;
    let session = connect_password_ssh(target, password).await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 上传通道失败: {e}"))?;
    channel
        .exec(true, remote_command)
        .await
        .map_err(|e| format!("执行 SSH 上传命令失败: {e}"))?;

    emit_upload_progress(
        app_handle,
        package_name,
        remote_path,
        0,
        total_bytes,
        "started",
    );
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut uploaded_bytes = 0_u64;
    loop {
        let read_bytes = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取上位机更新包失败: {e}"))?;
        if read_bytes == 0 {
            break;
        }
        channel
            .data_bytes(buffer[..read_bytes].to_vec())
            .await
            .map_err(|e| format!("SSH 写入更新包失败: {e}"))?;
        uploaded_bytes = uploaded_bytes.saturating_add(read_bytes as u64);
        emit_upload_progress(
            app_handle,
            package_name,
            remote_path,
            uploaded_bytes,
            total_bytes,
            "uploading",
        );
    }
    channel
        .eof()
        .await
        .map_err(|e| format!("结束 SSH 上传输入流失败: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            russh::ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                stderr.extend_from_slice(&data)
            }
            russh::ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            _ => {}
        }
    }
    if exit_code != Some(0) {
        let stderr = String::from_utf8_lossy(&stderr);
        let stdout = String::from_utf8_lossy(&stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "远端命令未返回错误详情"
        };
        return Err(format!(
            "上传下位机更新包失败: 远端命令退出码 {}: {detail}",
            exit_code.map_or_else(|| "未知".to_string(), |code| code.to_string()),
        ));
    }
    emit_upload_progress(
        app_handle,
        package_name,
        remote_path,
        uploaded_bytes,
        total_bytes,
        "finished",
    );
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    Ok(uploaded_bytes)
}

async fn install_with_password_ssh(
    target: &LowerUpdateUploadTarget,
    password: &str,
    remote_command: &str,
) -> Result<(bool, Option<i32>, String, String), String> {
    let session = connect_password_ssh(target, password).await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 安装通道失败: {e}"))?;
    channel
        .exec(true, remote_command)
        .await
        .map_err(|e| format!("执行 SSH 安装命令失败: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            russh::ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                stderr.extend_from_slice(&data)
            }
            russh::ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            _ => {}
        }
    }
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    let exit_code_i32 = exit_code.map(|value| value as i32);
    Ok((
        exit_code == Some(0),
        exit_code_i32,
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

async fn execute_password_ssh_command(
    target: &LowerUpdateUploadTarget,
    password: &str,
    remote_command: &str,
) -> Result<RemoteCommandOutput, String> {
    let session = connect_password_ssh(target, password).await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 查询通道失败: {e}"))?;
    channel
        .exec(true, remote_command)
        .await
        .map_err(|e| format!("执行 SSH 查询命令失败: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            russh::ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                stderr.extend_from_slice(&data)
            }
            russh::ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            _ => {}
        }
    }
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    Ok(RemoteCommandOutput {
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

async fn execute_certificate_ssh_command(
    target: &LowerUpdateUploadTarget,
    remote_command: &str,
) -> Result<RemoteCommandOutput, String> {
    let remote_target = format!("{}@{}", target.user, target.host);
    let output = Command::new("ssh")
        .arg("-T")
        .arg("-p")
        .arg(target.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg(remote_target)
        .arg(remote_command)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("启动 SSH 查询失败，请确认上位机已安装 OpenSSH 客户端: {e}"))?;

    Ok(RemoteCommandOutput {
        exit_code: output.status.code().map(|value| value as u32),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn normalize_channel(channel: &str) -> Result<String, String> {
    let trimmed = channel.trim();
    match trimmed {
        "stable" | "beta" | "nightly" | "ci" => Ok(trimmed.to_string()),
        _ => Err("下位机更新通道只能是 stable、beta、nightly 或 ci".into()),
    }
}

fn normalize_base_url(base_url: Option<String>) -> Result<String, String> {
    let raw = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_LOWER_UPDATE_BASE_URL);
    let parsed = reqwest::Url::parse(raw).map_err(|e| format!("下位机更新源地址不合法: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(raw.trim_end_matches('/').to_string()),
        _ => Err("下位机更新源地址必须使用 http 或 https".into()),
    }
}

fn build_latest_url(base_url: &str, channel: &str) -> String {
    format!("{base_url}/{channel}/latest.json")
}

fn is_http_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_image_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (algorithm, digest) = trimmed.split_once(':')?;
    if algorithm != "sha256"
        || digest.len() != 64
        || !digest.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return None;
    }
    Some(format!("sha256:{}", digest.to_ascii_lowercase()))
}

fn parse_runtime_query_output(stdout: &str) -> Result<LowerUpdateRuntimeInfoDto, String> {
    let output = stdout.trim();
    if output == "__MSKDSP_CONTAINER_MISSING__" {
        return Ok(LowerUpdateRuntimeInfoDto {
            container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
            exists: false,
            running: false,
            image_id: None,
        });
    }

    let mut fields = output.split_whitespace();
    let running = match fields.next() {
        Some("true") => true,
        Some("false") => false,
        _ => return Err("解析下位机 Docker 容器状态失败".into()),
    };
    let image_id = fields
        .next()
        .and_then(normalize_image_id)
        .ok_or_else(|| "解析下位机 Docker 镜像 ID 失败".to_string())?;
    if fields.next().is_some() {
        return Err("下位机 Docker 容器查询结果格式不合法".into());
    }

    Ok(LowerUpdateRuntimeInfoDto {
        container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
        exists: true,
        running,
        image_id: Some(image_id),
    })
}

fn is_safe_file_name(value: &str) -> bool {
    !value.trim().is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
}

fn is_safe_ssh_user(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn parse_upload_account(value: &str) -> Result<LowerUpdateUploadTarget, String> {
    let trimmed = value.trim();
    let (user, host_port) = trimmed
        .split_once('@')
        .ok_or_else(|| "上传账号格式应为 user@host:port".to_string())?;
    if !is_safe_ssh_user(user) {
        return Err("上传账号中的用户名不合法".into());
    }

    let (host, port_text) = host_port
        .rsplit_once(':')
        .ok_or_else(|| "上传账号格式应为 user@host:port".to_string())?;
    if host.trim().is_empty()
        || host
            .chars()
            .any(|ch| ch.is_ascii_whitespace() || matches!(ch, '/' | '\\' | '@' | ':'))
    {
        return Err("上传账号中的主机地址不合法".into());
    }

    let port = port_text
        .parse::<u16>()
        .map_err(|_| "上传账号中的端口不合法".to_string())?;
    if port == 0 {
        return Err("上传账号中的端口不能为 0".into());
    }

    Ok(LowerUpdateUploadTarget {
        user: user.to_string(),
        host: host.to_string(),
        port,
    })
}

fn credential_target(target: &LowerUpdateUploadTarget) -> String {
    format!("{}@{}:{}", target.user, target.host, target.port)
}

fn auth_method(auth: &LowerUpdateSshAuthDto) -> &'static str {
    match auth {
        LowerUpdateSshAuthDto::Password { .. } => "password",
        LowerUpdateSshAuthDto::Certificate => "certificate",
    }
}

fn log_url(value: &str) -> String {
    reqwest::Url::parse(value)
        .map(|mut url| {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        })
        .unwrap_or_else(|_| log_detail(value))
}

fn log_detail(value: &str) -> String {
    const MAX_LOG_DETAIL_CHARS: usize = 512;
    let trimmed = value.trim();
    let mut detail = String::new();
    for ch in trimmed.chars().take(MAX_LOG_DETAIL_CHARS) {
        match ch {
            '\n' => detail.push_str("\\n"),
            '\r' => detail.push_str("\\r"),
            '\t' => detail.push_str("\\t"),
            ch if ch.is_control() => detail.push_str(&format!("\\u{{{:04x}}}", ch as u32)),
            ch => detail.push(ch),
        }
    }
    if trimmed.chars().nth(MAX_LOG_DETAIL_CHARS).is_some() {
        detail.push_str("...");
    }
    detail
}

fn save_password(target: &LowerUpdateUploadTarget, password: &str) -> Result<(), String> {
    let target_name = credential_target(target);
    let entry = keyring::Entry::new_with_target("mskdsp-lower-update", "ssh", &target_name)
        .map_err(|e| format!("创建 SSH 凭据项失败: {e}"))?;
    entry
        .set_password(password)
        .map_err(|e| format!("保存 SSH 密码失败: {e}"))
}

#[tauri::command]
pub fn get_lower_update_password(upload_account: String) -> Result<Option<String>, String> {
    let target = parse_upload_account(&upload_account)?;
    let target_name = credential_target(&target);
    let entry = keyring::Entry::new_with_target("mskdsp-lower-update", "ssh", &target_name)
        .map_err(|e| format!("创建 SSH 凭据项失败: {e}"))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => {
            tracing::warn!(
                operation = "credential_read",
                target = %log_detail(&upload_account),
                error = %log_detail(&error.to_string()),
                "读取已保存 SSH 密码失败"
            );
            Err(format!("读取已保存 SSH 密码失败: {error}"))
        }
    }
}

#[tauri::command]
pub fn clear_lower_update_password(upload_account: String) -> Result<(), String> {
    let target = parse_upload_account(&upload_account)?;
    let target_name = credential_target(&target);
    let entry = keyring::Entry::new_with_target("mskdsp-lower-update", "ssh", &target_name)
        .map_err(|e| format!("创建 SSH 凭据项失败: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => {
            tracing::warn!(
                operation = "credential_clear",
                target = %log_detail(&upload_account),
                error = %log_detail(&error.to_string()),
                "清除已保存 SSH 密码失败"
            );
            Err(format!("清除已保存 SSH 密码失败: {error}"))
        }
    }
}

fn log_progress_emit_error(operation: &str, stage: &str, error: &str) {
    if stage == "downloading" || stage == "uploading" {
        return;
    }
    tracing::warn!(operation, stage, error = %log_detail(error), "发送下位机更新进度失败");
}

fn normalize_install_dir(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("请输入安装目录".into());
    }
    if !trimmed.starts_with('/') || trimmed.chars().any(char::is_whitespace) {
        return Err("安装目录必须是 Linux 绝对路径且不能包含空白字符".into());
    }
    if trimmed.contains("..") {
        return Err("安装目录不能包含 ..".into());
    }

    let normalized = trimmed.trim_end_matches('/');
    Ok(if normalized.is_empty() {
        "/".to_string()
    } else {
        normalized.to_string()
    })
}

fn remote_package_path(install_dir: &str, package_name: &str) -> String {
    if install_dir == "/" {
        format!("/{package_name}")
    } else {
        format!("{install_dir}/{package_name}")
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn build_root_shell_command(command: &str) -> String {
    format!("sudo -n -- sh -c {}", shell_quote(command))
}

fn build_install_command(install_dir: &str, package_name: &str) -> String {
    let package_path = format!("./{package_name}");
    format!(
        "set -e; cd {}; chmod +x {}; {} start",
        shell_quote(install_dir),
        shell_quote(&package_path),
        shell_quote(&package_path)
    )
}

fn validate_manifest(
    manifest: &LowerUpdateManifestDto,
    requested_channel: &str,
) -> Result<(), String> {
    if manifest.schema_version != LOWER_UPDATE_SCHEMA_VERSION {
        return Err(format!(
            "下位机更新清单版本不支持: {}",
            manifest.schema_version
        ));
    }
    if manifest.product != LOWER_UPDATE_PRODUCT {
        return Err(format!("下位机更新清单产品不匹配: {}", manifest.product));
    }
    if manifest.channel != requested_channel {
        return Err(format!(
            "下位机更新清单通道不匹配: 期望 {requested_channel}，实际 {}",
            manifest.channel
        ));
    }
    if manifest.platform != LOWER_UPDATE_PLATFORM {
        return Err(format!("下位机更新清单平台不支持: {}", manifest.platform));
    }
    if manifest.version.trim().is_empty() {
        return Err("下位机更新清单缺少版本号".into());
    }
    if manifest.package_version.trim().is_empty() {
        return Err("下位机更新清单缺少安装包版本".into());
    }
    if let Some(image_id) = manifest.image_id.as_deref() {
        if normalize_image_id(image_id).is_none() {
            return Err("下位机更新清单 Docker 镜像 ID 不合法".into());
        }
    }
    if manifest.asset.name.trim().is_empty() {
        return Err("下位机更新清单缺少安装包名称".into());
    }
    if !is_safe_file_name(&manifest.asset.name) {
        return Err("下位机更新清单安装包名称不能包含路径分隔符".into());
    }
    if !is_http_url(&manifest.asset.url) {
        return Err("下位机更新清单安装包地址不合法".into());
    }
    if !is_sha256(&manifest.asset.sha256) {
        return Err("下位机更新清单安装包 SHA256 不合法".into());
    }
    if manifest.asset.size == 0 {
        return Err("下位机更新清单安装包大小不能为 0".into());
    }
    if manifest.checksum.name.trim().is_empty() {
        return Err("下位机更新清单缺少校验文件名称".into());
    }
    if !is_safe_file_name(&manifest.checksum.name) {
        return Err("下位机更新清单校验文件名称不能包含路径分隔符".into());
    }
    if !is_http_url(&manifest.checksum.url) {
        return Err("下位机更新清单校验文件地址不合法".into());
    }
    Ok(())
}

fn cache_dir(app_handle: &AppHandle, manifest: &LowerUpdateManifestDto) -> Result<PathBuf, String> {
    let app_cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取上位机缓存目录失败: {e}"))?;
    Ok(app_cache_dir
        .join("lower-update")
        .join(&manifest.channel)
        .join(&manifest.platform))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{:02x}", *byte));
    }
    output
}

async fn compute_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .await
        .map_err(|e| format!("打开下载文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];

    loop {
        let read_bytes = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取下载文件失败: {e}"))?;
        if read_bytes == 0 {
            break;
        }
        hasher.update(&buffer[..read_bytes]);
    }

    Ok(bytes_to_hex(&hasher.finalize()))
}

fn progress_percent(downloaded_bytes: u64, total_bytes: u64) -> u8 {
    if total_bytes == 0 {
        return 0;
    }

    let percent = downloaded_bytes.saturating_mul(100) / total_bytes;
    percent.min(100) as u8
}

fn emit_download_progress(
    app_handle: &AppHandle,
    manifest: &LowerUpdateManifestDto,
    downloaded_bytes: u64,
    total_bytes: u64,
    stage: &str,
) {
    let payload = LowerUpdateDownloadProgressDto {
        package_name: manifest.asset.name.clone(),
        downloaded_bytes,
        total_bytes,
        percent: progress_percent(downloaded_bytes, total_bytes),
        stage: stage.to_string(),
    };

    if let Err(error) = app_handle.emit(LOWER_UPDATE_DOWNLOAD_PROGRESS_EVENT, payload) {
        log_progress_emit_error("download", stage, &error.to_string());
    }
}

fn emit_upload_progress(
    app_handle: &AppHandle,
    package_name: &str,
    remote_path: &str,
    uploaded_bytes: u64,
    total_bytes: u64,
    stage: &str,
) {
    let payload = LowerUpdateUploadProgressDto {
        package_name: package_name.to_string(),
        remote_path: remote_path.to_string(),
        uploaded_bytes,
        total_bytes,
        percent: progress_percent(uploaded_bytes, total_bytes),
        stage: stage.to_string(),
    };

    if let Err(error) = app_handle.emit(LOWER_UPDATE_UPLOAD_PROGRESS_EVENT, payload) {
        log_progress_emit_error("upload", stage, &error.to_string());
    }
}

#[tauri::command]
pub async fn check_lower_update(
    channel: String,
    base_url: Option<String>,
) -> Result<LowerUpdateManifestDto, String> {
    let started_at = Instant::now();
    let log_base_url = base_url
        .as_deref()
        .map(log_url)
        .unwrap_or_else(|| DEFAULT_LOWER_UPDATE_BASE_URL.to_string());
    tracing::info!(
        operation = "check",
        channel = %log_detail(&channel),
        base_url = %log_base_url,
        "开始获取下位机更新清单"
    );

    let result = async {
        let channel = normalize_channel(&channel)?;
        let base_url = normalize_base_url(base_url)?;
        let latest_url = build_latest_url(&base_url, &channel);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("创建下位机更新请求客户端失败: {e}"))?;

        let response = client
            .get(&latest_url)
            .send()
            .await
            .map_err(|e| format!("获取下位机更新清单失败: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("获取下位机更新清单失败: HTTP {status}"));
        }

        let manifest = response
            .json::<LowerUpdateManifestDto>()
            .await
            .map_err(|e| format!("解析下位机更新清单失败: {e}"))?;
        validate_manifest(&manifest, &channel)?;
        Ok(manifest)
    }
    .await;

    match result {
        Ok(manifest) => {
            tracing::info!(
                operation = "check",
                channel = %manifest.channel,
                version = %manifest.version,
                package = %manifest.asset.name,
                image_id = ?manifest.image_id,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                "下位机更新清单获取完成"
            );
            Ok(manifest)
        }
        Err(error) => {
            let detail = log_detail(&error);
            tracing::warn!(
                operation = "check",
                channel = %log_detail(&channel),
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                error = %detail,
                "获取下位机更新清单失败"
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn get_lower_update_runtime_info(
    request: LowerUpdateRuntimeInfoRequestDto,
) -> Result<LowerUpdateRuntimeInfoDto, String> {
    let started_at = Instant::now();
    let auth_method = auth_method(&request.auth);
    tracing::info!(
        operation = "runtime",
        auth_method,
        target = %log_detail(&request.upload_account),
        container = LOWER_UPDATE_CONTAINER_NAME,
        "开始查询下位机运行镜像"
    );

    let result = async {
        let target = parse_upload_account(&request.upload_account)?;
        let remote_command = build_root_shell_command(LOWER_UPDATE_RUNTIME_QUERY_COMMAND);
        let output = match &request.auth {
            LowerUpdateSshAuthDto::Password { password } => tokio::time::timeout(
                LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT,
                execute_password_ssh_command(&target, password, &remote_command),
            )
            .await
            .map_err(|_| "查询下位机运行镜像超时".to_string())??,
            LowerUpdateSshAuthDto::Certificate => tokio::time::timeout(
                LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT,
                execute_certificate_ssh_command(&target, &remote_command),
            )
            .await
            .map_err(|_| "查询下位机运行镜像超时".to_string())??,
        };

        if output.exit_code != Some(0) {
            let stderr = output.stderr.trim();
            let stdout = output.stdout.trim();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            let detail = if detail.is_empty() {
                "SSH 查询命令未返回错误详情"
            } else {
                detail
            };
            return Err(format!(
                "查询下位机运行镜像失败: 退出码 {}: {detail}",
                output
                    .exit_code
                    .map_or_else(|| "未知".to_string(), |code| code.to_string())
            ));
        }

        parse_runtime_query_output(&output.stdout)
    }
    .await;

    match result {
        Ok(runtime) => {
            tracing::info!(
                operation = "runtime",
                auth_method,
                target = %log_detail(&request.upload_account),
                container = %runtime.container_name,
                exists = runtime.exists,
                running = runtime.running,
                image_id = ?runtime.image_id,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                "下位机运行镜像查询完成"
            );
            Ok(runtime)
        }
        Err(error) => {
            let detail = log_detail(&error);
            tracing::warn!(
                operation = "runtime",
                auth_method,
                target = %log_detail(&request.upload_account),
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                error = %detail,
                "查询下位机运行镜像失败"
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn download_lower_update(
    app_handle: AppHandle,
    manifest: LowerUpdateManifestDto,
) -> Result<LowerUpdateDownloadResultDto, String> {
    let started_at = Instant::now();
    let package_name = manifest.asset.name.clone();
    tracing::info!(
        operation = "download",
        package = %package_name,
        url = %log_url(&manifest.asset.url),
        "开始下载下位机更新包"
    );
    let result = async {
        validate_manifest(&manifest, &manifest.channel)?;

        let output_dir = cache_dir(&app_handle, &manifest)?;
        fs::create_dir_all(&output_dir)
            .await
            .map_err(|e| format!("创建下位机更新缓存目录失败: {e}"))?;
        let output_path = output_dir.join(&manifest.asset.name);
        let partial_path = output_dir.join(format!("{}.download", manifest.asset.name));

        if output_path.is_file() {
            let existing_sha256 = compute_sha256(&output_path).await?;
            if existing_sha256.eq_ignore_ascii_case(&manifest.asset.sha256) {
                tracing::info!(
                    operation = "download",
                    package = %manifest.asset.name,
                    cache_path = %output_path.display(),
                    "下位机更新包缓存命中"
                );
                emit_download_progress(
                    &app_handle,
                    &manifest,
                    manifest.asset.size,
                    manifest.asset.size,
                    "finished",
                );
                return Ok(LowerUpdateDownloadResultDto {
                    package_name: manifest.asset.name,
                    package_path: output_path.to_string_lossy().into_owned(),
                    downloaded_bytes: manifest.asset.size,
                    sha256: existing_sha256,
                });
            }

            tracing::error!(
                operation = "download",
                package = %manifest.asset.name,
                cache_path = %output_path.display(),
                "下位机更新包缓存校验失效，将重新下载"
            );
            fs::remove_file(&output_path)
                .await
                .map_err(|e| format!("移除旧的下位机更新包失败: {e}"))?;
        } else if output_path.exists() {
            return Err("下位机更新缓存路径已存在但不是文件".into());
        }

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|e| format!("创建下位机更新下载客户端失败: {e}"))?;
        let mut response = client
            .get(&manifest.asset.url)
            .send()
            .await
            .map_err(|e| format!("下载下位机更新包失败: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("下载下位机更新包失败: HTTP {status}"));
        }

        let total_bytes = response.content_length().unwrap_or(manifest.asset.size);
        emit_download_progress(&app_handle, &manifest, 0, total_bytes, "started");

        let mut file = fs::File::create(&partial_path)
            .await
            .map_err(|e| format!("创建下位机更新临时文件失败: {e}"))?;
        let mut downloaded_bytes = 0_u64;

        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("读取下位机更新下载数据失败: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入下位机更新文件失败: {e}"))?;
            downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
            emit_download_progress(
                &app_handle,
                &manifest,
                downloaded_bytes,
                total_bytes,
                "downloading",
            );
        }

        file.flush()
            .await
            .map_err(|e| format!("刷新下位机更新文件失败: {e}"))?;
        drop(file);

        if downloaded_bytes != manifest.asset.size {
            let _ = fs::remove_file(&partial_path).await;
            return Err(format!(
                "下位机更新包大小不匹配: 期望 {} 字节，实际 {} 字节",
                manifest.asset.size, downloaded_bytes
            ));
        }

        emit_download_progress(
            &app_handle,
            &manifest,
            downloaded_bytes,
            total_bytes,
            "verifying",
        );
        let actual_sha256 = compute_sha256(&partial_path).await?;
        if !actual_sha256.eq_ignore_ascii_case(&manifest.asset.sha256) {
            let _ = fs::remove_file(&partial_path).await;
            return Err(format!(
                "下位机更新包校验失败: 期望 {}，实际 {}",
                manifest.asset.sha256, actual_sha256
            ));
        }

        fs::rename(&partial_path, &output_path)
            .await
            .map_err(|e| format!("保存下位机更新包失败: {e}"))?;
        emit_download_progress(
            &app_handle,
            &manifest,
            downloaded_bytes,
            total_bytes,
            "finished",
        );
        Ok(LowerUpdateDownloadResultDto {
            package_name: manifest.asset.name,
            package_path: output_path.to_string_lossy().into_owned(),
            downloaded_bytes,
            sha256: actual_sha256,
        })
    }
    .await;

    match result {
        Ok(result) => {
            tracing::info!(
                operation = "download",
                package = %package_name,
                path = %result.package_path,
                sha256 = %result.sha256,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                "下位机更新包下载并校验完成"
            );
            Ok(result)
        }
        Err(error) => {
            let detail = log_detail(&error);
            tracing::warn!(
                operation = "download",
                package = %package_name,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                error = %detail,
                "下位机更新包下载流程失败"
            );
            Err(error)
        }
    }
}

async fn upload_lower_update_package_inner(
    app_handle: AppHandle,
    request: LowerUpdateUploadRequestDto,
) -> Result<LowerUpdateUploadResultDto, String> {
    if !is_safe_file_name(&request.package_name) {
        return Err("下位机更新包名称不能包含路径分隔符".into());
    }

    let target = parse_upload_account(&request.upload_account)?;
    let install_dir = normalize_install_dir(&request.install_dir)?;
    let remote_path = remote_package_path(&install_dir, &request.package_name);
    let remote_tmp_path = format!("{remote_path}.uploading");
    let package_path = PathBuf::from(request.package_path.trim());
    let metadata = fs::metadata(&package_path)
        .await
        .map_err(|e| format!("读取上位机更新包失败: {e}"))?;
    if !metadata.is_file() {
        return Err("上位机更新包路径不是文件".into());
    }

    let total_bytes = metadata.len();
    if request.package_size != 0 && total_bytes != request.package_size {
        return Err(format!(
            "上位机更新包大小不匹配: 期望 {} 字节，实际 {} 字节",
            request.package_size, total_bytes
        ));
    }
    let mut file = fs::File::open(&package_path)
        .await
        .map_err(|e| format!("打开上位机更新包失败: {e}"))?;

    let upload_command = format!(
        "set -e; mkdir -p {}; tmp={}; cat > \"$tmp\"; mv -f \"$tmp\" {}; chmod +x {}",
        shell_quote(&install_dir),
        shell_quote(&remote_tmp_path),
        shell_quote(&remote_path),
        shell_quote(&remote_path)
    );
    let remote_command = build_root_shell_command(&upload_command);

    if let LowerUpdateSshAuthDto::Password { password } = &request.auth {
        let uploaded_bytes = upload_with_password_ssh(
            &app_handle,
            &target,
            password,
            &request.package_name,
            &package_path,
            &remote_path,
            &remote_command,
        )
        .await?;
        return Ok(LowerUpdateUploadResultDto {
            package_name: request.package_name,
            remote_path,
            uploaded_bytes,
        });
    }

    let remote_target = format!("{}@{}", target.user, target.host);

    let mut child = Command::new("ssh")
        .arg("-T")
        .arg("-p")
        .arg(target.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg(remote_target)
        .arg(remote_command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 ssh 上传失败，请确认上位机已安装 OpenSSH 客户端: {e}"))?;

    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "创建 ssh 上传输入流失败".to_string())?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut uploaded_bytes = 0_u64;

    emit_upload_progress(
        &app_handle,
        &request.package_name,
        &remote_path,
        0,
        total_bytes,
        "started",
    );

    loop {
        let read_bytes = match file.read(&mut buffer).await {
            Ok(value) => value,
            Err(error) => {
                let _ = child.kill().await;
                return Err(format!("读取上位机更新包失败: {error}"));
            }
        };
        if read_bytes == 0 {
            break;
        }

        if let Err(error) = child_stdin.write_all(&buffer[..read_bytes]).await {
            let _ = child.kill().await;
            return Err(format!(
                "上传下位机更新包失败，SSH 写入中断: {error}。请确认 SSH 密钥或配置可免交互登录"
            ));
        }

        uploaded_bytes = uploaded_bytes.saturating_add(read_bytes as u64);
        emit_upload_progress(
            &app_handle,
            &request.package_name,
            &remote_path,
            uploaded_bytes,
            total_bytes,
            "uploading",
        );
    }

    if uploaded_bytes != total_bytes {
        let _ = child.kill().await;
        return Err(format!(
            "上传下位机更新包失败: 期望上传 {} 字节，实际读取 {} 字节",
            total_bytes, uploaded_bytes
        ));
    }

    if let Err(error) = child_stdin.shutdown().await {
        let _ = child.kill().await;
        return Err(format!("结束 SSH 上传输入流失败: {error}"));
    }
    drop(child_stdin);

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("等待 SSH 上传结果失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = stderr.trim();
        let fallback = stdout.trim();
        let message = if !detail.is_empty() {
            detail
        } else if !fallback.is_empty() {
            fallback
        } else {
            "ssh 未返回错误详情"
        };
        return Err(format!("上传下位机更新包失败: {message}"));
    }

    emit_upload_progress(
        &app_handle,
        &request.package_name,
        &remote_path,
        uploaded_bytes,
        total_bytes,
        "finished",
    );
    Ok(LowerUpdateUploadResultDto {
        package_name: request.package_name,
        remote_path,
        uploaded_bytes,
    })
}

async fn install_lower_update_package_inner(
    request: LowerUpdateInstallRequestDto,
) -> Result<LowerUpdateInstallResultDto, String> {
    if !is_safe_file_name(&request.package_name) {
        return Err("下位机更新包名称不能包含路径分隔符".into());
    }

    let target = parse_upload_account(&request.upload_account)?;
    let install_dir = normalize_install_dir(&request.install_dir)?;
    let remote_path = remote_package_path(&install_dir, &request.package_name);
    let install_command = build_install_command(&install_dir, &request.package_name);
    let remote_command = build_root_shell_command(&install_command);

    if let LowerUpdateSshAuthDto::Password { password } = &request.auth {
        let (success, exit_code, stdout, stderr) =
            install_with_password_ssh(&target, password, &remote_command).await?;
        return Ok(LowerUpdateInstallResultDto {
            package_name: request.package_name,
            remote_path,
            command: remote_command,
            success,
            exit_code,
            stdout,
            stderr,
        });
    }

    let remote_target = format!("{}@{}", target.user, target.host);

    let output = Command::new("ssh")
        .arg("-T")
        .arg("-p")
        .arg(target.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg(remote_target)
        .arg(&remote_command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            format!("执行下位机更新安装命令失败，请确认上位机已安装 OpenSSH 客户端: {e}")
        })?;

    let success = output.status.success();
    let exit_code = output.status.code();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    Ok(LowerUpdateInstallResultDto {
        package_name: request.package_name,
        remote_path,
        command: remote_command,
        success,
        exit_code,
        stdout,
        stderr,
    })
}

#[tauri::command]
pub async fn upload_lower_update_package(
    app_handle: AppHandle,
    request: LowerUpdateUploadRequestDto,
) -> Result<LowerUpdateUploadResultDto, String> {
    let started_at = Instant::now();
    let auth_method = auth_method(&request.auth);
    let target = request.upload_account.clone();
    let package = request.package_name.clone();
    let remote_path = if is_safe_file_name(&request.package_name) {
        normalize_install_dir(&request.install_dir)
            .ok()
            .map(|dir| remote_package_path(&dir, &request.package_name))
    } else {
        None
    };
    tracing::info!(
        operation = "upload",
        auth_method,
        target = %target,
        package = %package,
        remote_path = ?remote_path,
        "开始上传下位机更新包"
    );
    let result = upload_lower_update_package_inner(app_handle, request).await;
    match result {
        Ok(result) => {
            tracing::info!(
                operation = "upload",
                auth_method,
                target = %target,
                package = %result.package_name,
                remote_path = %result.remote_path,
                uploaded_bytes = result.uploaded_bytes,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                "下位机更新包上传完成"
            );
            Ok(result)
        }
        Err(error) => {
            let detail = log_detail(&error);
            tracing::error!(
                operation = "upload",
                auth_method,
                target = %log_detail(&target),
                package = %log_detail(&package),
                remote_path = ?remote_path,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                error = %detail,
                "下位机更新包上传失败"
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn install_lower_update_package(
    request: LowerUpdateInstallRequestDto,
) -> Result<LowerUpdateInstallResultDto, String> {
    let started_at = Instant::now();
    let auth_method = auth_method(&request.auth);
    let target = request.upload_account.clone();
    let package = request.package_name.clone();
    let remote_path = if is_safe_file_name(&request.package_name) {
        normalize_install_dir(&request.install_dir)
            .ok()
            .map(|dir| remote_package_path(&dir, &request.package_name))
    } else {
        None
    };
    tracing::info!(
        operation = "install",
        auth_method,
        target = %target,
        package = %package,
        remote_path = ?remote_path,
        "开始执行下位机更新安装"
    );
    let result = install_lower_update_package_inner(request).await;
    match result {
        Ok(result) => {
            if result.success {
                tracing::info!(
                    operation = "install",
                    auth_method,
                    target = %target,
                    package = %result.package_name,
                    remote_path = %result.remote_path,
                    exit_code = ?result.exit_code,
                    elapsed_ms = started_at.elapsed().as_millis() as u64,
                    "下位机更新安装完成"
                );
            } else {
                tracing::warn!(
                    operation = "install",
                    auth_method,
                    target = %target,
                    package = %result.package_name,
                    remote_path = %result.remote_path,
                    exit_code = ?result.exit_code,
                    stderr = %log_detail(&result.stderr),
                    elapsed_ms = started_at.elapsed().as_millis() as u64,
                    "下位机更新安装失败"
                );
            }
            Ok(result)
        }
        Err(error) => {
            let detail = log_detail(&error);
            tracing::error!(
                operation = "install",
                auth_method,
                target = %log_detail(&target),
                package = %log_detail(&package),
                remote_path = ?remote_path,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                error = %detail,
                "下位机更新安装失败"
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_root_shell_command, parse_runtime_query_output, parse_upload_account,
        LOWER_UPDATE_CONTAINER_NAME,
    };

    #[test]
    fn accepts_regular_ssh_account_for_lower_update() {
        let target = parse_upload_account("megsky@192.168.1.219:10022")
            .expect("应接受可通过 sudo 提权的普通下位机 SSH 账号");

        assert_eq!(target.user, "megsky");
        assert_eq!(target.host, "192.168.1.219");
        assert_eq!(target.port, 10022);
    }

    #[test]
    fn wraps_remote_command_in_non_interactive_root_shell() {
        let command = build_root_shell_command("printf '%s\\n' 'ready'");

        assert_eq!(
            command,
            "sudo -n -- sh -c 'printf '\\''%s\\n'\\'' '\\''ready'\\'''"
        );
    }

    #[test]
    fn parses_running_container_image_id() {
        let uppercase_digest = "A".repeat(64);
        let runtime = parse_runtime_query_output(&format!("true sha256:{uppercase_digest}\n"))
            .expect("应能解析有效的 Docker 查询结果");

        assert_eq!(runtime.container_name, LOWER_UPDATE_CONTAINER_NAME);
        assert!(runtime.exists);
        assert!(runtime.running);
        assert_eq!(runtime.image_id, Some(format!("sha256:{}", "a".repeat(64))));
    }

    #[test]
    fn parses_missing_container_sentinel() {
        let runtime = parse_runtime_query_output("__MSKDSP_CONTAINER_MISSING__\n")
            .expect("应能解析容器不存在标记");

        assert!(!runtime.exists);
        assert!(!runtime.running);
        assert_eq!(runtime.image_id, None);
    }

    #[test]
    fn parses_stopped_container_image_id() {
        let runtime = parse_runtime_query_output(&format!("false sha256:{}\n", "b".repeat(64)))
            .expect("应能解析已停止容器的 Docker 查询结果");

        assert!(runtime.exists);
        assert!(!runtime.running);
        assert_eq!(runtime.image_id, Some(format!("sha256:{}", "b".repeat(64))));
    }

    #[test]
    fn rejects_invalid_runtime_image_id() {
        let error = parse_runtime_query_output("true sha256:invalid\n")
            .expect_err("应拒绝无效的 Docker 镜像 ID");

        assert!(error.contains("镜像 ID"));
    }

    #[test]
    fn rejects_extra_runtime_query_fields() {
        let error =
            parse_runtime_query_output(&format!("true sha256:{} unexpected\n", "c".repeat(64)))
                .expect_err("应拒绝包含额外字段的 Docker 查询结果");

        assert!(error.contains("格式不合法"));
    }
}
