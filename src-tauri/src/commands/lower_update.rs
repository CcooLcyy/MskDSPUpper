use std::{
    ffi::OsString,
    fs as std_fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
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
const LOWER_UPDATE_PRECHECK_TIMEOUT: Duration = Duration::from_secs(30);
const LOWER_UPDATE_SSH_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOWER_UPDATE_UPLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);
const LOWER_UPDATE_UPLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const LOWER_UPDATE_INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
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
static LOWER_UPDATE_CACHE_LOCK: Mutex<()> = Mutex::const_new(());

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

#[derive(Debug, Default, Serialize, Clone, PartialEq, Eq)]
pub struct LowerUpdateCacheCleanupResultDto {
    pub removed_files: u64,
    pub reclaimed_bytes: u64,
}

#[derive(Serialize, Deserialize)]
pub struct LowerUpdateUploadRequestDto {
    pub package_name: String,
    pub package_path: String,
    pub package_size: u64,
    pub upload_account: String,
    pub install_dir: String,
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
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
    pub sudo_password: String,
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
    pub sudo_password: String,
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
        inactivity_timeout: Some(LOWER_UPDATE_SSH_INACTIVITY_TIMEOUT),
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
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 上传通道失败: {e}"))?;
    channel
        .exec(true, remote_command)
        .await
        .map_err(|e| format!("执行 SSH 上传命令失败: {e}"))?;

    let (mut reader, writer) = channel.split();
    let transfer_result = async {
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
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;

        loop {
            let read_bytes = file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("读取上位机更新包失败: {e}"))?;
            if read_bytes == 0 {
                break;
            }

            let send = writer.data_bytes(buffer[..read_bytes].to_vec());
            tokio::pin!(send);
            let stall = tokio::time::sleep(LOWER_UPDATE_UPLOAD_STALL_TIMEOUT);
            tokio::pin!(stall);
            loop {
                tokio::select! {
                    result = &mut send => {
                        result.map_err(|e| format!("SSH 写入更新包失败: {e}"))?;
                        break;
                    }
                    message = reader.wait() => {
                        match message {
                            Some(russh::ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                            Some(russh::ChannelMsg::ExtendedData { data, ext }) if ext == 1 => stderr.extend_from_slice(&data),
                            Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                                exit_code = Some(exit_status);
                                return Err(format_upload_remote_error(exit_code, &stdout, &stderr, uploaded_bytes));
                            }
                            Some(russh::ChannelMsg::Close) | None => {
                                return Err(format!("上传下位机更新包失败: 远端 SSH 通道提前关闭，已发送 {} 字节", uploaded_bytes));
                            }
                            Some(_) => {}
                        }
                    }
                    _ = &mut stall => {
                        return Err(format!("上传下位机更新包失败: {} 秒无上传进度，已发送 {} 字节", LOWER_UPDATE_UPLOAD_STALL_TIMEOUT.as_secs(), uploaded_bytes));
                    }
                }
            }

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

        tokio::time::timeout(LOWER_UPDATE_UPLOAD_STALL_TIMEOUT, writer.eof())
            .await
            .map_err(|_| "结束 SSH 上传输入流超时".to_string())?
            .map_err(|e| format!("结束 SSH 上传输入流失败: {e}"))?;

        loop {
            let message = tokio::time::timeout(LOWER_UPDATE_UPLOAD_STALL_TIMEOUT, reader.wait())
                .await
                .map_err(|_| "等待 SSH 上传结果超时".to_string())?;
            match message {
                Some(russh::ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                Some(russh::ChannelMsg::ExtendedData { data, ext }) if ext == 1 => stderr.extend_from_slice(&data),
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status);
                    break;
                }
                Some(russh::ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        if exit_code != Some(0) {
            return Err(format_upload_remote_error(exit_code, &stdout, &stderr, uploaded_bytes));
        }
        emit_upload_progress(
            app_handle,
            package_name,
            remote_path,
            uploaded_bytes,
            total_bytes,
            "finished",
        );
        Ok(uploaded_bytes)
    }
    .await;
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    transfer_result
}

fn format_upload_remote_error(
    exit_code: Option<u32>,
    stdout: &[u8],
    stderr: &[u8],
    uploaded_bytes: u64,
) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        "远端命令未返回错误详情"
    };
    format!(
        "上传下位机更新包失败: 远端命令退出码 {}，已发送 {} 字节: {detail}",
        exit_code.map_or_else(|| "未知".to_string(), |code| code.to_string()),
        uploaded_bytes,
    )
}

async fn execute_password_ssh_command(
    target: &LowerUpdateUploadTarget,
    password: &str,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<RemoteCommandOutput, String> {
    let session = connect_password_ssh(target, password).await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 命令通道失败: {e}"))?;
    channel
        .exec(true, remote_command)
        .await
        .map_err(|e| format!("执行 SSH 命令失败: {e}"))?;

    if let Some(stdin) = stdin {
        channel
            .data_bytes(stdin.to_vec())
            .await
            .map_err(|e| format!("发送远端命令输入失败: {e}"))?;
        channel
            .eof()
            .await
            .map_err(|e| format!("结束远端命令输入失败: {e}"))?;
    }

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
    stdin: Option<&[u8]>,
) -> Result<RemoteCommandOutput, String> {
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
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 SSH 命令失败，请确认上位机已安装 OpenSSH 客户端: {e}"))?;

    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "创建 SSH 命令输入流失败".to_string())?;
    if let Some(stdin) = stdin {
        child_stdin
            .write_all(stdin)
            .await
            .map_err(|e| format!("发送远端命令输入失败: {e}"))?;
    }
    child_stdin
        .shutdown()
        .await
        .map_err(|e| format!("结束远端命令输入失败: {e}"))?;
    drop(child_stdin);

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("等待 SSH 命令结果失败: {e}"))?;

    Ok(RemoteCommandOutput {
        exit_code: output.status.code().map(|value| value as u32),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

async fn execute_user_ssh_command(
    target: &LowerUpdateUploadTarget,
    auth: &LowerUpdateSshAuthDto,
    remote_command: &str,
) -> Result<RemoteCommandOutput, String> {
    match auth {
        LowerUpdateSshAuthDto::Password { password } => {
            execute_password_ssh_command(target, password, remote_command, None).await
        }
        LowerUpdateSshAuthDto::Certificate => {
            execute_certificate_ssh_command(target, remote_command, None).await
        }
    }
}

async fn execute_root_ssh_command(
    target: &LowerUpdateUploadTarget,
    auth: &LowerUpdateSshAuthDto,
    sudo_password: &str,
    command: &str,
) -> Result<RemoteCommandOutput, String> {
    let sudo_stdin = sudo_password_stdin(sudo_password)?;
    let remote_command = build_password_root_shell_command(command);
    match auth {
        LowerUpdateSshAuthDto::Password { password } => {
            execute_password_ssh_command(target, password, &remote_command, Some(&sudo_stdin)).await
        }
        LowerUpdateSshAuthDto::Certificate => {
            execute_certificate_ssh_command(target, &remote_command, Some(&sudo_stdin)).await
        }
    }
}

fn format_remote_command_error(context: &str, output: &RemoteCommandOutput) -> String {
    let stderr = output.stderr.trim();
    let stdout = output.stdout.trim();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "远端命令未返回错误详情"
    };
    format!(
        "{context}: 退出码 {}: {detail}",
        output
            .exit_code
            .map_or_else(|| "未知".to_string(), |code| code.to_string())
    )
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

fn ssh_credential_entry(target_name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("mskdsp-lower-update:ssh", target_name)
        .map_err(|e| format!("创建 SSH 凭据项失败: {e}"))
}

#[cfg(target_os = "windows")]
fn migrate_legacy_ssh_password(target_name: &str) -> Result<Option<String>, String> {
    let legacy = keyring::Entry::new_with_target("mskdsp-lower-update", "ssh", target_name)
        .map_err(|e| format!("创建旧版 SSH 凭据项失败: {e}"))?;
    let password = match legacy.get_password() {
        Ok(password) => password,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("读取旧版 SSH 密码失败: {error}")),
    };
    let attributes = legacy
        .get_attributes()
        .map_err(|error| format!("读取旧版 SSH 凭据属性失败: {error}"))?;
    if attributes.get("username").map(String::as_str) != Some(target_name) {
        return Ok(None);
    }
    ssh_credential_entry(target_name)?
        .set_password(&password)
        .map_err(|error| format!("迁移 SSH 密码失败: {error}"))?;
    let _ = legacy.delete_credential();
    Ok(Some(password))
}

#[cfg(target_os = "windows")]
fn delete_legacy_ssh_password_if_matching(target_name: &str) -> Result<(), String> {
    let legacy = keyring::Entry::new_with_target("mskdsp-lower-update", "ssh", target_name)
        .map_err(|e| format!("创建旧版 SSH 凭据项失败: {e}"))?;
    let attributes = match legacy.get_attributes() {
        Ok(attributes) => attributes,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(error) => return Err(format!("读取旧版 SSH 凭据属性失败: {error}")),
    };
    if attributes.get("username").map(String::as_str) == Some(target_name) {
        match legacy.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("清除旧版 SSH 密码失败: {error}")),
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn migrate_legacy_ssh_password(_target_name: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn delete_legacy_ssh_password_if_matching(_target_name: &str) -> Result<(), String> {
    Ok(())
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
    ssh_credential_entry(&target_name)?
        .set_password(password)
        .map_err(|e| format!("保存 SSH 密码失败: {e}"))
}

#[tauri::command]
pub fn get_lower_update_password(upload_account: String) -> Result<Option<String>, String> {
    let target = parse_upload_account(&upload_account)?;
    let target_name = credential_target(&target);
    match ssh_credential_entry(&target_name)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => migrate_legacy_ssh_password(&target_name),
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
    match ssh_credential_entry(&target_name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            delete_legacy_ssh_password_if_matching(&target_name)
        }
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

fn build_password_root_shell_command(command: &str) -> String {
    format!("sudo -S -p '' -- sh -c {}", shell_quote(command))
}

fn sudo_password_stdin(password: &str) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        return Err("sudo 密码不能为空".into());
    }
    if password.contains(['\r', '\n']) {
        return Err("sudo 密码不能包含换行".into());
    }
    let mut input = password.as_bytes().to_vec();
    input.push(b'\n');
    Ok(input)
}

fn build_user_upload_command(install_dir: &str, package_name: &str) -> String {
    let remote_path = remote_package_path(install_dir, package_name);
    let remote_tmp_path = format!("{remote_path}.uploading");
    format!(
        "set -e; tmp={tmp}; cleanup() {{ rm -f -- \"$tmp\"; }}; trap cleanup EXIT HUP INT TERM; mkdir -p {dir}; rm -f -- \"$tmp\"; cat > \"$tmp\"; chmod +x -- \"$tmp\"; mv -f -- \"$tmp\" {path}; trap - EXIT HUP INT TERM",
        dir = shell_quote(install_dir),
        tmp = shell_quote(&remote_tmp_path),
        path = shell_quote(&remote_path),
    )
}

fn build_upload_preflight_command(install_dir: &str) -> String {
    format!(
        "set -e; mkdir -p {dir}; test -w {dir}; df -Pk {dir} | awk 'NR == 2 {{ print \"__MSKDSP_AVAILABLE_KIB__=\" $4 }}'",
        dir = shell_quote(install_dir),
    )
}

fn parse_available_bytes(output: &str) -> Result<u64, String> {
    let value = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("__MSKDSP_AVAILABLE_KIB__="))
        .ok_or_else(|| "预检未返回磁盘可用空间".to_string())?;
    let kib = value
        .trim()
        .parse::<u64>()
        .map_err(|_| "预检返回的磁盘可用空间格式不合法".to_string())?;
    kib.checked_mul(1024)
        .ok_or_else(|| "预检返回的磁盘可用空间超出范围".to_string())
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

fn cache_dir(cache_root: &Path, manifest: &LowerUpdateManifestDto) -> PathBuf {
    cache_root.join(&manifest.channel).join(&manifest.platform)
}

fn is_partial_download(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "download")
}

fn ensure_cache_root(cache_root: &Path) -> io::Result<()> {
    match std_fs::symlink_metadata(cache_root) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("缓存根路径不是普通目录: {}", cache_root.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => std_fs::create_dir_all(cache_root),
        Err(error) => Err(error),
    }
}

fn ensure_cache_subdirectory(path: &Path) -> io::Result<()> {
    match std_fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("缓存子路径不是普通目录: {}", path.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => std_fs::create_dir(path),
        Err(error) => Err(error),
    }
}

fn ensure_download_cache_dir(output_dir: &Path) -> io::Result<()> {
    let platform_parent = output_dir
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缓存平台目录缺少父目录"))?;
    let cache_root = platform_parent
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缓存通道目录缺少父目录"))?;
    ensure_cache_root(cache_root)?;
    ensure_cache_subdirectory(platform_parent)?;
    ensure_cache_subdirectory(output_dir)
}

fn record_removed_file(
    path: &Path,
    metadata: &std_fs::Metadata,
    result: &mut LowerUpdateCacheCleanupResultDto,
) -> io::Result<()> {
    std_fs::remove_file(path)?;
    result.removed_files = result.removed_files.saturating_add(1);
    result.reclaimed_bytes = result.reclaimed_bytes.saturating_add(metadata.len());
    Ok(())
}

fn remove_path(path: &Path, result: &mut LowerUpdateCacheCleanupResultDto) -> io::Result<()> {
    let metadata = std_fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() {
        for entry in std_fs::read_dir(path)? {
            remove_path(&entry?.path(), result)?;
        }
        std_fs::remove_dir(path)
    } else {
        record_removed_file(path, &metadata, result)
    }
}

fn clear_cache_root_contents(cache_root: &Path) -> io::Result<LowerUpdateCacheCleanupResultDto> {
    ensure_cache_root(cache_root)?;
    let mut result = LowerUpdateCacheCleanupResultDto::default();
    for entry in std_fs::read_dir(cache_root)? {
        remove_path(&entry?.path(), &mut result)?;
    }
    std_fs::create_dir_all(cache_root)?;
    Ok(result)
}

fn remove_partial_downloads_recursively(
    directory: &Path,
    result: &mut LowerUpdateCacheCleanupResultDto,
) -> io::Result<()> {
    for entry in std_fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = std_fs::symlink_metadata(&path)?;
        if metadata.file_type().is_dir() {
            remove_partial_downloads_recursively(&path, result)?;
        } else if is_partial_download(&path) {
            record_removed_file(&path, &metadata, result)?;
        }
    }
    Ok(())
}

fn regular_files(directory: &Path) -> io::Result<Vec<(PathBuf, SystemTime, OsString)>> {
    let mut files = Vec::new();
    for entry in std_fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = std_fs::symlink_metadata(&path)?;
        if metadata.file_type().is_file() {
            files.push((path, metadata.modified()?, entry.file_name()));
        }
    }
    Ok(files)
}

fn retain_only_regular_file(
    directory: &Path,
    keep_path: &Path,
    result: &mut LowerUpdateCacheCleanupResultDto,
) -> io::Result<()> {
    for (path, _, _) in regular_files(directory)? {
        if path != keep_path {
            let metadata = std_fs::symlink_metadata(&path)?;
            record_removed_file(&path, &metadata, result)?;
        }
    }
    Ok(())
}

fn retain_latest_regular_file(
    directory: &Path,
    result: &mut LowerUpdateCacheCleanupResultDto,
) -> io::Result<()> {
    let files = regular_files(directory)?;
    let latest = files
        .iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| left.2.cmp(&right.2)))
        .map(|(path, _, _)| path.clone());
    if let Some(latest) = latest {
        retain_only_regular_file(directory, &latest, result)?;
    }
    Ok(())
}

fn cleanup_cache_startup_in(cache_root: &Path) -> io::Result<LowerUpdateCacheCleanupResultDto> {
    ensure_cache_root(cache_root)?;
    let mut result = LowerUpdateCacheCleanupResultDto::default();
    remove_partial_downloads_recursively(cache_root, &mut result)?;

    for channel_entry in std_fs::read_dir(cache_root)? {
        let channel_entry = channel_entry?;
        if !channel_entry.file_type()?.is_dir() {
            continue;
        }
        for platform_entry in std_fs::read_dir(channel_entry.path())? {
            let platform_entry = platform_entry?;
            if platform_entry.file_type()?.is_dir() {
                retain_latest_regular_file(&platform_entry.path(), &mut result)?;
            }
        }
    }
    Ok(result)
}

async fn run_blocking_cache_cleanup<F>(
    operation: F,
) -> Result<LowerUpdateCacheCleanupResultDto, String>
where
    F: FnOnce() -> io::Result<LowerUpdateCacheCleanupResultDto> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("执行下位机更新缓存清理任务失败: {error}"))?
        .map_err(|error| format!("清理下位机更新缓存失败: {error}"))
}

pub async fn cleanup_lower_update_cache_startup(
    cache_root: &Path,
) -> Result<LowerUpdateCacheCleanupResultDto, String> {
    let _guard = LOWER_UPDATE_CACHE_LOCK.lock().await;
    let cache_root = cache_root.to_path_buf();
    run_blocking_cache_cleanup(move || cleanup_cache_startup_in(&cache_root)).await
}

#[tauri::command]
pub async fn clear_lower_update_cache(
    state: State<'_, AppState>,
) -> Result<LowerUpdateCacheCleanupResultDto, String> {
    let _guard = LOWER_UPDATE_CACHE_LOCK.lock().await;
    let cache_root = state.runtime_paths.lower_update_dir();
    let result = run_blocking_cache_cleanup(move || clear_cache_root_contents(&cache_root)).await?;
    tracing::info!(
        operation = "cache_clear",
        removed_files = result.removed_files,
        reclaimed_bytes = result.reclaimed_bytes,
        "下位机更新缓存已清理"
    );
    Ok(result)
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
        let output = tokio::time::timeout(
            LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT,
            execute_root_ssh_command(
                &target,
                &request.auth,
                &request.sudo_password,
                LOWER_UPDATE_RUNTIME_QUERY_COMMAND,
            ),
        )
        .await
        .map_err(|_| "查询下位机运行镜像超时".to_string())??;

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
    state: State<'_, AppState>,
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
        let channel = normalize_channel(&manifest.channel)?;
        validate_manifest(&manifest, &channel)?;
        let _guard = LOWER_UPDATE_CACHE_LOCK.lock().await;

        let output_dir = cache_dir(&state.runtime_paths.lower_update_dir(), &manifest);
        let cleanup_dir = output_dir.clone();
        run_blocking_cache_cleanup(move || {
            ensure_download_cache_dir(&cleanup_dir)?;
            let mut result = LowerUpdateCacheCleanupResultDto::default();
            remove_partial_downloads_recursively(&cleanup_dir, &mut result)?;
            Ok(result)
        })
        .await?;
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
                let cleanup_dir = output_dir.clone();
                let keep_path = output_path.clone();
                run_blocking_cache_cleanup(move || {
                    let mut result = LowerUpdateCacheCleanupResultDto::default();
                    retain_only_regular_file(&cleanup_dir, &keep_path, &mut result)?;
                    Ok(result)
                })
                .await?;
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
        let cleanup_dir = output_dir.clone();
        let keep_path = output_path.clone();
        run_blocking_cache_cleanup(move || {
            let mut result = LowerUpdateCacheCleanupResultDto::default();
            retain_only_regular_file(&cleanup_dir, &keep_path, &mut result)?;
            Ok(result)
        })
        .await?;
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

    tracing::info!(
        operation = "upload_preflight",
        target = %log_detail(&request.upload_account),
        remote_path = %remote_path,
        package_bytes = total_bytes,
        "开始下位机更新上传预检"
    );
    let preflight_command = build_upload_preflight_command(&install_dir);
    let preflight = tokio::time::timeout(
        LOWER_UPDATE_PRECHECK_TIMEOUT,
        execute_user_ssh_command(&target, &request.auth, &preflight_command),
    )
    .await
    .map_err(|_| "上传前检查目录超时".to_string())??;
    if preflight.exit_code != Some(0) {
        return Err(format_remote_command_error(
            "上传前检查目录失败",
            &preflight,
        ));
    }
    let available_bytes = parse_available_bytes(&preflight.stdout)?;
    if available_bytes < total_bytes {
        return Err(format!(
            "下位机磁盘空间不足: 需要 {} 字节，可用 {} 字节",
            total_bytes, available_bytes
        ));
    }

    let sudo_check = tokio::time::timeout(
        LOWER_UPDATE_PRECHECK_TIMEOUT,
        execute_root_ssh_command(&target, &request.auth, &request.sudo_password, "true"),
    )
    .await
    .map_err(|_| "下位机 sudo 预检超时".to_string())??;
    if sudo_check.exit_code != Some(0) {
        return Err(format_remote_command_error(
            "下位机 sudo 预检失败",
            &sudo_check,
        ));
    }
    tracing::info!(
        operation = "upload_preflight",
        target = %log_detail(&request.upload_account),
        remote_path = %remote_path,
        available_bytes,
        "下位机更新上传预检完成"
    );

    let remote_command = build_user_upload_command(&install_dir, &request.package_name);

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

        let write_result = tokio::time::timeout(
            LOWER_UPDATE_UPLOAD_STALL_TIMEOUT,
            child_stdin.write_all(&buffer[..read_bytes]),
        )
        .await;
        if let Err(error) = write_result
            .map_err(|_| "上传下位机更新包失败: SSH 写入 60 秒无进度".to_string())
            .and_then(|result| result.map_err(|error| error.to_string()))
        {
            let _ = child.kill().await;
            return Err(format!("上传下位机更新包失败，SSH 写入中断: {error}"));
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

    let output = tokio::time::timeout(
        LOWER_UPDATE_INSTALL_TIMEOUT,
        execute_root_ssh_command(
            &target,
            &request.auth,
            &request.sudo_password,
            &install_command,
        ),
    )
    .await
    .map_err(|_| "下位机更新安装整体超时".to_string())??;

    let success = output.exit_code == Some(0);
    let exit_code = output.exit_code.map(|value| value as i32);
    let stdout = output.stdout;
    let stderr = output.stderr;

    Ok(LowerUpdateInstallResultDto {
        package_name: request.package_name,
        remote_path,
        command: build_password_root_shell_command(&install_command),
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
    let result = tokio::time::timeout(
        LOWER_UPDATE_UPLOAD_TOTAL_TIMEOUT,
        upload_lower_update_package_inner(app_handle, request),
    )
    .await
    .map_err(|_| {
        format!(
            "上传下位机更新包整体超时: {} 秒",
            LOWER_UPDATE_UPLOAD_TOTAL_TIMEOUT.as_secs()
        )
    })
    .and_then(|result| result);
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
        build_password_root_shell_command, build_user_upload_command, cleanup_cache_startup_in,
        clear_cache_root_contents, format_upload_remote_error, parse_available_bytes,
        parse_runtime_query_output, parse_upload_account, sudo_password_stdin,
        LOWER_UPDATE_CONTAINER_NAME,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "mskdsp-lower-update-test-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("应能创建测试目录");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_regular_ssh_account_for_lower_update() {
        let target = parse_upload_account("megsky@192.168.1.219:10022")
            .expect("应接受可通过 sudo 提权的普通下位机 SSH 账号");

        assert_eq!(target.user, "megsky");
        assert_eq!(target.host, "192.168.1.219");
        assert_eq!(target.port, 10022);
    }

    #[test]
    fn wraps_remote_command_in_password_root_shell_without_exposing_password() {
        let command = build_password_root_shell_command("printf '%s\\n' 'ready'");

        assert_eq!(
            command,
            "sudo -S -p '' -- sh -c 'printf '\\''%s\\n'\\'' '\\''ready'\\'''"
        );
        assert!(!command.contains("sudo-secret"));
        assert_eq!(
            sudo_password_stdin("sudo-secret").expect("应接受单行 sudo 密码"),
            b"sudo-secret\n"
        );
    }

    #[test]
    fn rejects_multiline_sudo_password() {
        let error = sudo_password_stdin("first\nsecond").expect_err("应拒绝多行 sudo 密码");

        assert!(error.contains("换行"));
    }

    #[test]
    fn builds_user_upload_command_without_sudo_and_cleans_partial_file() {
        let command = build_user_upload_command("/home/megsky", "mskdsp-package");

        assert!(!command.contains("sudo"));
        assert!(command.contains("mskdsp-package.uploading"));
        assert!(command.contains("trap"));
        assert!(command.contains("cat >"));
        assert!(command.contains("chmod +x"));
    }

    #[test]
    fn parses_preflight_available_space_in_bytes() {
        let available =
            parse_available_bytes("__MSKDSP_AVAILABLE_KIB__=153600\n").expect("应解析预检可用空间");

        assert_eq!(available, 153600 * 1024);
    }

    #[test]
    fn rejects_invalid_preflight_available_space() {
        let error = parse_available_bytes("unexpected\n").expect_err("应拒绝无效预检输出");

        assert!(error.contains("可用空间"));
    }

    #[test]
    fn reports_remote_upload_error_without_password_data() {
        let error =
            format_upload_remote_error(Some(1), b"", b"sudo: a password is required\n", 1024);

        assert!(error.contains("退出码 1"));
        assert!(error.contains("已发送 1024 字节"));
        assert!(!error.contains("sudo-secret"));
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

    #[test]
    fn startup_cleanup_removes_partial_files_and_keeps_latest_package() {
        let temp = TestDirectory::new();
        let platform_dir = temp.path().join("stable/linux-arm64");
        let nested_dir = platform_dir.join("nested");
        fs::create_dir_all(&nested_dir).expect("应能创建缓存目录");
        fs::write(platform_dir.join("a-old-package"), b"old").expect("应能写入旧包");
        fs::write(platform_dir.join("z-latest-package"), b"latest").expect("应能写入新包");
        fs::write(platform_dir.join("package.download"), b"partial").expect("应能写入临时包");
        fs::write(nested_dir.join("nested.download"), b"nested").expect("应能写入嵌套临时包");

        let result = cleanup_cache_startup_in(temp.path()).expect("启动清理应成功");

        assert!(!platform_dir.join("a-old-package").exists());
        assert!(platform_dir.join("z-latest-package").is_file());
        assert!(!platform_dir.join("package.download").exists());
        assert!(!nested_dir.join("nested.download").exists());
        assert_eq!(result.removed_files, 3);
        assert_eq!(result.reclaimed_bytes, 3 + 7 + 6);
    }

    #[test]
    fn manual_cleanup_only_removes_cache_root_contents_and_recreates_root() {
        let temp = TestDirectory::new();
        let cache_root = temp.path().join("lower-update");
        let sibling = temp.path().join("keep.txt");
        fs::create_dir_all(cache_root.join("stable/linux-arm64")).expect("应能创建缓存目录");
        fs::write(cache_root.join("stable/linux-arm64/package"), b"package")
            .expect("应能写入缓存包");
        fs::write(&sibling, b"keep").expect("应能写入同级文件");

        let result = clear_cache_root_contents(&cache_root).expect("手动清理应成功");

        assert!(cache_root.is_dir());
        assert_eq!(
            fs::read_dir(&cache_root)
                .expect("应能读取缓存根目录")
                .count(),
            0
        );
        assert!(sibling.is_file());
        assert_eq!(result.removed_files, 1);
        assert_eq!(result.reclaimed_bytes, 7);
    }
}
