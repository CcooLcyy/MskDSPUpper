use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

#[derive(Deserialize)]
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
    let mut session = connect_password_ssh(target, password).await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 上传通道失败: {e}"))?;
    channel
        .exec(true, remote_command)
        .await
        .map_err(|e| format!("执行 SSH 上传命令失败: {e}"))?;

    emit_upload_progress(app_handle, package_name, remote_path, 0, total_bytes, "started");
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
            .data_bytes(&buffer[..read_bytes])
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

    let mut exit_code = None;
    while let Some(message) = channel.wait().await {
        if let russh::ChannelMsg::ExitStatus { exit_status } = message {
            exit_code = Some(exit_status);
        }
    }
    if exit_code != Some(0) {
        return Err(format!(
            "上传下位机更新包失败: 远端命令退出码 {}",
            exit_code.map_or_else(|| "未知".to_string(), |code| code.to_string())
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
    let mut session = connect_password_ssh(target, password).await?;
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
    Ok((exit_code == Some(0), exit_code_i32, String::from_utf8_lossy(&stdout).into_owned(), String::from_utf8_lossy(&stderr).into_owned()))
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
        || host.chars().any(|ch| ch.is_ascii_whitespace() || matches!(ch, '/' | '\\' | '@' | ':'))
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
        Err(error) => Err(format!("读取已保存 SSH 密码失败: {error}")),
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
        Err(error) => Err(format!("清除已保存 SSH 密码失败: {error}")),
    }
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

fn build_install_command(install_dir: &str, package_name: &str) -> String {
    let package_path = format!("./{package_name}");
    format!(
        "set -e; cd {}; chmod +x {}; {} start",
        shell_quote(install_dir),
        shell_quote(&package_path),
        shell_quote(&package_path)
    )
}

fn validate_manifest(manifest: &LowerUpdateManifestDto, requested_channel: &str) -> Result<(), String> {
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
        return Err(format!(
            "下位机更新清单平台不支持: {}",
            manifest.platform
        ));
    }
    if manifest.version.trim().is_empty() {
        return Err("下位机更新清单缺少版本号".into());
    }
    if manifest.package_version.trim().is_empty() {
        return Err("下位机更新清单缺少安装包版本".into());
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
        tracing::warn!(%error, "发送下位机更新下载进度失败");
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
        tracing::warn!(%error, "发送下位机更新上传进度失败");
    }
}

#[tauri::command]
pub async fn check_lower_update(
    channel: String,
    base_url: Option<String>,
) -> Result<LowerUpdateManifestDto, String> {
    let channel = normalize_channel(&channel)?;
    let base_url = normalize_base_url(base_url)?;
    let latest_url = build_latest_url(&base_url, &channel);
    tracing::info!(%latest_url, "开始获取下位机更新清单");

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
    tracing::info!(
        channel = %manifest.channel,
        version = %manifest.version,
        package = %manifest.asset.name,
        "下位机更新清单获取完成"
    );

    Ok(manifest)
}

#[tauri::command]
pub async fn download_lower_update(
    app_handle: AppHandle,
    manifest: LowerUpdateManifestDto,
) -> Result<LowerUpdateDownloadResultDto, String> {
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

        fs::remove_file(&output_path)
            .await
            .map_err(|e| format!("移除旧的下位机更新包失败: {e}"))?;
    } else if output_path.exists() {
        return Err("下位机更新缓存路径已存在但不是文件".into());
    }

    tracing::info!(
        url = %manifest.asset.url,
        package = %manifest.asset.name,
        "开始下载下位机更新包"
    );

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
    tracing::info!(
        path = %output_path.display(),
        sha256 = %actual_sha256,
        "下位机更新包下载并校验完成"
    );

    Ok(LowerUpdateDownloadResultDto {
        package_name: manifest.asset.name,
        package_path: output_path.to_string_lossy().into_owned(),
        downloaded_bytes,
        sha256: actual_sha256,
    })
}

#[tauri::command]
pub async fn upload_lower_update_package(
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

    let remote_command = format!(
        "set -e; mkdir -p {}; tmp={}; cat > \"$tmp\"; mv -f \"$tmp\" {}; chmod +x {}",
        shell_quote(&install_dir),
        shell_quote(&remote_tmp_path),
        shell_quote(&remote_path),
        shell_quote(&remote_path)
    );

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
    tracing::info!(
        package = %request.package_name,
        local_path = %package_path.display(),
        remote = %remote_target,
        remote_path = %remote_path,
        "开始上传下位机更新包"
    );

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
    tracing::info!(
        package = %request.package_name,
        remote_path = %remote_path,
        uploaded_bytes,
        "下位机更新包上传完成"
    );

    Ok(LowerUpdateUploadResultDto {
        package_name: request.package_name,
        remote_path,
        uploaded_bytes,
    })
}

#[tauri::command]
pub async fn install_lower_update_package(
    request: LowerUpdateInstallRequestDto,
) -> Result<LowerUpdateInstallResultDto, String> {
    if !is_safe_file_name(&request.package_name) {
        return Err("下位机更新包名称不能包含路径分隔符".into());
    }

    let target = parse_upload_account(&request.upload_account)?;
    let install_dir = normalize_install_dir(&request.install_dir)?;
    let remote_path = remote_package_path(&install_dir, &request.package_name);
    let remote_command = build_install_command(&install_dir, &request.package_name);

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

    tracing::info!(
        package = %request.package_name,
        remote = %remote_target,
        remote_path = %remote_path,
        "开始执行下位机更新安装命令"
    );

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
        .map_err(|e| format!("执行下位机更新安装命令失败，请确认上位机已安装 OpenSSH 客户端: {e}"))?;

    let success = output.status.success();
    let exit_code = output.status.code();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if success {
        tracing::info!(
            package = %request.package_name,
            remote_path = %remote_path,
            "下位机更新安装命令执行完成"
        );
    } else {
        tracing::warn!(
            package = %request.package_name,
            remote_path = %remote_path,
            ?exit_code,
            stderr = %stderr.trim(),
            "下位机更新安装命令执行失败"
        );
    }

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
