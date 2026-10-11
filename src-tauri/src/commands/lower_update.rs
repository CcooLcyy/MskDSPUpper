use std::{
    ffi::OsString,
    fs as std_fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use super::lower_update_runtime;
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

/// 普通设置只包含连接选项；严格拒绝密码或其他未允许的字段。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LowerUpdateConnectionSettingsDto {
    pub upload_account: String,
    pub install_dir: String,
    pub auth_method: String,
    pub reuse_ssh_password_for_sudo: bool,
    pub remember_password: bool,
}

impl LowerUpdateConnectionSettingsDto {
    pub(crate) fn normalize(mut self) -> Result<Self, String> {
        self.upload_account = credential_target(&parse_upload_account(&self.upload_account)?);
        self.install_dir = normalize_install_dir(&self.install_dir)?;
        match self.auth_method.as_str() {
            "password" => {}
            "certificate" => self.reuse_ssh_password_for_sudo = false,
            _ => return Err("下位机更新 SSH 认证方式不合法".into()),
        }
        Ok(self)
    }
}

pub(crate) const LOWER_UPDATE_CONNECTION_HISTORY_LIMIT: usize = 20;

/// 输入历史必须有界；按原顺序保留首次出现的目标，凭据目标忽略 ASCII 大小写。
pub(crate) fn normalize_connection_history(
    history: Vec<LowerUpdateConnectionSettingsDto>,
) -> Result<Vec<LowerUpdateConnectionSettingsDto>, String> {
    if history.len() > LOWER_UPDATE_CONNECTION_HISTORY_LIMIT {
        return Err("下位机更新连接历史最多保存 20 条".into());
    }
    let mut normalized: Vec<LowerUpdateConnectionSettingsDto> = Vec::new();
    for settings in history {
        let settings = settings.normalize()?;
        if !normalized.iter().any(|item| {
            item.upload_account
                .eq_ignore_ascii_case(&settings.upload_account)
        }) {
            normalized.push(settings);
        }
    }
    Ok(normalized)
}

fn saved_connection_history(
    saved: &std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<Vec<LowerUpdateConnectionSettingsDto>, String> {
    use super::app_storage::{LOWER_UPDATE_CONNECTION_HISTORY_KEY, LOWER_UPDATE_CONNECTION_KEY};
    let mut history = if let Some(value) = saved.get(LOWER_UPDATE_CONNECTION_HISTORY_KEY) {
        let history = serde_json::from_value(value.clone())
            .map_err(|_| "已保存的下位机更新连接历史格式不合法".to_string())?;
        normalize_connection_history(history)?
    } else {
        Vec::new()
    };
    // 旧版本仅保存最近一次成功目标，首次保存历史时将其纳入。
    if let Some(value) = saved.get(LOWER_UPDATE_CONNECTION_KEY) {
        let previous: LowerUpdateConnectionSettingsDto = serde_json::from_value(value.clone())
            .map_err(|_| "已保存的下位机更新连接设置格式不合法".to_string())?;
        let previous = previous.normalize()?;
        if history.len() < LOWER_UPDATE_CONNECTION_HISTORY_LIMIT
            && !history.iter().any(|item| {
                item.upload_account
                    .eq_ignore_ascii_case(&previous.upload_account)
            })
        {
            history.push(previous);
        }
    }
    Ok(history)
}

#[derive(Serialize)]
pub struct LowerUpdateCredentialsDto {
    pub ssh_password: Option<String>,
    pub sudo_password: Option<String>,
}

const DEFAULT_LOWER_UPDATE_BASE_URL: &str =
    "https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-lower";
const DEFAULT_LOWER_UPDATE_X64_BASE_URL: &str =
    "https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-lower-x64";
const LOWER_UPDATE_PLATFORM: &str = "linux-arm64";
const LOWER_UPDATE_X64_PLATFORM: &str = "linux-x64";
const LOWER_UPDATE_PRODUCT: &str = "mskdsp-lower";
const LOWER_UPDATE_SCHEMA_VERSION: u32 = 1;
const LOWER_UPDATE_CACHE_METADATA_SCHEMA_VERSION: u32 = 1;
const LOWER_UPDATE_CACHE_METADATA_FILE_NAME: &str = ".mskdsp-cache.json";
const LOWER_UPDATE_CONTAINER_NAME: &str = "mskdsp";
const LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const LOWER_UPDATE_PRECHECK_TIMEOUT: Duration = Duration::from_secs(30);
const LOWER_UPDATE_SSH_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOWER_UPDATE_UPLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);
const LOWER_UPDATE_UPLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const LOWER_UPDATE_INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const LOWER_UPDATE_PACKAGE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const LOWER_UPDATE_PACKAGE_CLEANUP_SCRIPT: &str = include_str!("lower_update_cleanup.py");
const VERTICAL_SECURITY_SCRIPT_NAME: &str = "mskdsp-vertical-security.sh";
const VERTICAL_SECURITY_INSTALL_PATH: &str = "/usr/local/libexec/mskdsp-vertical-security";
const VERTICAL_SECURITY_SERVICE_NAME: &str = "mskdsp-vertical-security.service";
const VERTICAL_SECURITY_SERVICE_PATH: &str = "/etc/systemd/system/mskdsp-vertical-security.service";
const VERTICAL_SECURITY_MAX_SCRIPT_BYTES: usize = 1024 * 1024;
const LOWER_UPDATE_RUNTIME_QUERY_COMMAND: &str = lower_update_runtime::PROBE_COMMAND;
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
    pub task_id: String,
    pub channel: String,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerUpdateCacheMetadataDto {
    pub schema_version: u32,
    pub downloaded_at: u64,
    pub manifest: LowerUpdateManifestDto,
}

#[derive(Debug, Serialize, Clone)]
pub struct LowerUpdateCachedPackageDto {
    pub downloaded_at: u64,
    pub manifest: LowerUpdateManifestDto,
    pub package_path: String,
    pub package_size: u64,
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
    pub package_sha256: String,
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
    pub expected_image_id: String,
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
    pub already_current: bool,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct LowerUpdatePackageCleanupResultDto {
    pub remote_path: String,
    pub removed_files: u64,
    pub reclaimed_bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LowerUpdatePackageCleanupStats {
    removed_files: u64,
    reclaimed_bytes: u64,
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
    // 保留同次查询对应的不可变原始引用，供清理脚本再次核对，不进入公开 JSON。
    #[serde(skip_serializing)]
    pub raw_image_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct VerticalSecurityDeployRequestDto {
    pub script_content: String,
    pub upload_account: String,
    pub install_dir: String,
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct VerticalSecurityDeployResultDto {
    pub remote_path: String,
    pub service_name: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[derive(Serialize, Deserialize)]
pub struct VerticalSecurityStatusRequestDto {
    pub upload_account: String,
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct VerticalSecurityStepResultDto {
    pub step_id: String,
    pub name: String,
    pub state: String,
    pub message: String,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct VerticalSecurityStatusResultDto {
    pub service_name: String,
    pub active_state: String,
    pub sub_state: String,
    pub result: String,
    pub exit_code: Option<i32>,
    pub restart_count: u32,
    pub steps: Vec<VerticalSecurityStepResultDto>,
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

async fn execute_user_ssh_command_with_stdin(
    target: &LowerUpdateUploadTarget,
    auth: &LowerUpdateSshAuthDto,
    remote_command: &str,
    stdin: &[u8],
) -> Result<RemoteCommandOutput, String> {
    match auth {
        LowerUpdateSshAuthDto::Password { password } => {
            execute_password_ssh_command(target, password, remote_command, Some(stdin)).await
        }
        LowerUpdateSshAuthDto::Certificate => {
            execute_certificate_ssh_command(target, remote_command, Some(stdin)).await
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

async fn query_lower_update_runtime_info(
    target: &LowerUpdateUploadTarget,
    auth: &LowerUpdateSshAuthDto,
    sudo_password: &str,
) -> Result<LowerUpdateRuntimeInfoDto, String> {
    tokio::time::timeout(LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT, async {
        let output = execute_root_ssh_command(
            target,
            auth,
            sudo_password,
            LOWER_UPDATE_RUNTIME_QUERY_COMMAND,
        )
        .await?;
        if output.exit_code != Some(0) {
            return Err(format_remote_command_error("查询下位机运行镜像失败", &output));
        }
        let (state, inspection) = lower_update_runtime::split_probe_output(&output.stdout);
        let mut runtime = parse_runtime_query_output(state)?;
        let Some(raw_image_id) = runtime.image_id.clone() else {
            return Ok(runtime);
        };
        if !lower_update_runtime::requires_config_resolution(&raw_image_id, inspection)? {
            return Ok(runtime);
        }
        if let Some(config_digest) = lower_update_runtime::cached_config_digest(&raw_image_id).await {
            tracing::debug!(%raw_image_id, %config_digest, "命中已验证的运行镜像配置摘要映射");
            runtime.image_id = Some(config_digest);
            return Ok(runtime);
        }
        let started_at = Instant::now();
        tracing::info!(%raw_image_id, "解析 containerd 运行镜像的配置摘要");
        let command = format!(
            "python3 -c {} {}",
            shell_quote(lower_update_runtime::CONFIG_DIGEST_SCRIPT),
            shell_quote(&raw_image_id),
        );
        let resolved = execute_root_ssh_command(target, auth, sudo_password, &command).await?;
        if resolved.exit_code != Some(0) {
            return Err(format_remote_command_error("解析运行镜像配置摘要失败", &resolved));
        }
        let config_digest = normalize_image_id(resolved.stdout.trim())
            .ok_or_else(|| "运行镜像配置摘要解析结果不合法".to_string())?;
        lower_update_runtime::cache_verified_config_digest(
            raw_image_id.clone(),
            config_digest.clone(),
        )
        .await;
        tracing::info!(
            %raw_image_id,
            %config_digest,
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "已验证运行镜像引用与配置摘要关联"
        );
        let current = execute_root_ssh_command(
            target,
            auth,
            sudo_password,
            LOWER_UPDATE_RUNTIME_QUERY_COMMAND,
        )
        .await?;
        if current.exit_code != Some(0) {
            return Err(format_remote_command_error("重新确认运行容器状态失败", &current));
        }
        let (state, _) = lower_update_runtime::split_probe_output(&current.stdout);
        let mut current_runtime = parse_runtime_query_output(state)?;
        if current_runtime.image_id.as_deref() != Some(raw_image_id.as_str()) {
            return Err("查询期间容器运行镜像发生变化，请重新确认".into());
        }
        current_runtime.image_id = Some(config_digest);
        Ok(current_runtime)
    })
    .await
    .map_err(|_| "查询下位机运行镜像超时".to_string())?
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
        "stable" | "beta" | "ci" => Ok(trimmed.to_string()),
        _ => Err("下位机更新通道只能是 stable、beta 或 ci".into()),
    }
}

fn normalize_platform(platform: Option<&str>) -> Result<&str, String> {
    match platform {
        None | Some(LOWER_UPDATE_PLATFORM) => Ok(LOWER_UPDATE_PLATFORM),
        Some(LOWER_UPDATE_X64_PLATFORM) => Ok(LOWER_UPDATE_X64_PLATFORM),
        Some(value) => Err(format!(
            "下位机更新平台不支持: {value}，只能是 linux-arm64 或 linux-x64"
        )),
    }
}

fn validate_platform_channel(platform: &str, channel: &str) -> Result<(), String> {
    normalize_platform(Some(platform))?;
    normalize_channel(channel)?;
    if platform == LOWER_UPDATE_X64_PLATFORM && channel != "ci" {
        return Err("下位机 x64 更新仅支持 ci 通道".into());
    }
    Ok(())
}

fn default_base_url(platform: &str) -> &'static str {
    if platform == LOWER_UPDATE_X64_PLATFORM {
        DEFAULT_LOWER_UPDATE_X64_BASE_URL
    } else {
        DEFAULT_LOWER_UPDATE_BASE_URL
    }
}

fn normalize_base_url(base_url: Option<String>, platform: &str) -> Result<String, String> {
    normalize_platform(Some(platform))?;
    let raw = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_base_url(platform));
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
            raw_image_id: None,
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
        image_id: Some(image_id.clone()),
        raw_image_id: Some(image_id),
    })
}

fn should_skip_install(
    expected_image_id: &str,
    runtime: &LowerUpdateRuntimeInfoDto,
) -> Result<bool, String> {
    let expected = normalize_image_id(expected_image_id)
        .ok_or_else(|| "下位机安装请求缺少有效的期望镜像 ID".to_string())?;

    if !runtime.exists || !runtime.running {
        return Ok(false);
    }

    let actual = runtime
        .image_id
        .as_deref()
        .and_then(normalize_image_id)
        .ok_or_else(|| "目标机运行容器未返回有效的镜像 ID".to_string())?;
    Ok(expected == actual)
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

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CredentialKind {
    Ssh,
    Sudo,
}

impl CredentialKind {
    fn label(self) -> &'static str {
        match self {
            Self::Ssh => "SSH",
            Self::Sudo => "sudo",
        }
    }
}

trait LowerUpdateCredentialStore {
    fn load(&mut self, kind: CredentialKind, target: &str) -> Result<Option<String>, String>;
    fn save(&mut self, kind: CredentialKind, target: &str, password: &str) -> Result<(), String>;
    fn delete(&mut self, kind: CredentialKind, target: &str) -> Result<(), String>;
    fn migrate_legacy(&mut self, target: &str) -> Result<Option<String>, String>;
    fn delete_legacy(&mut self, target: &str) -> Result<(), String>;
}

struct WindowsLowerUpdateCredentialStore;
static LOWER_UPDATE_CREDENTIAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lower_update_credential_entry(
    kind: CredentialKind,
    target: &str,
) -> Result<keyring::Entry, String> {
    match kind {
        CredentialKind::Ssh => ssh_credential_entry(target),
        CredentialKind::Sudo => keyring::Entry::new("mskdsp-lower-update:sudo", target)
            .map_err(|error| format!("创建 sudo 凭据项失败: {error}")),
    }
}

impl LowerUpdateCredentialStore for WindowsLowerUpdateCredentialStore {
    fn load(&mut self, kind: CredentialKind, target: &str) -> Result<Option<String>, String> {
        match lower_update_credential_entry(kind, target)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取已保存 {} 密码失败: {error}", kind.label())),
        }
    }

    fn save(&mut self, kind: CredentialKind, target: &str, password: &str) -> Result<(), String> {
        lower_update_credential_entry(kind, target)?
            .set_password(password)
            .map_err(|error| format!("保存 {} 密码失败: {error}", kind.label()))
    }

    fn delete(&mut self, kind: CredentialKind, target: &str) -> Result<(), String> {
        match lower_update_credential_entry(kind, target)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("清除已保存 {} 密码失败: {error}", kind.label())),
        }
    }

    fn migrate_legacy(&mut self, target: &str) -> Result<Option<String>, String> {
        migrate_legacy_ssh_password(target)
    }

    fn delete_legacy(&mut self, target: &str) -> Result<(), String> {
        delete_legacy_ssh_password_if_matching(target)
    }
}

fn load_ssh_password_with_store(
    store: &mut impl LowerUpdateCredentialStore,
    target: &str,
) -> Result<Option<String>, String> {
    match store.load(CredentialKind::Ssh, target)? {
        Some(password) => Ok(Some(password)),
        None => store.migrate_legacy(target),
    }
}

fn get_lower_update_credentials_with_store(
    store: &mut impl LowerUpdateCredentialStore,
    upload_account: &str,
) -> Result<LowerUpdateCredentialsDto, String> {
    let target = credential_target(&parse_upload_account(upload_account)?);
    Ok(LowerUpdateCredentialsDto {
        ssh_password: load_ssh_password_with_store(store, &target)?,
        sudo_password: store.load(CredentialKind::Sudo, &target)?,
    })
}

fn clear_lower_update_credentials_with_store(
    store: &mut impl LowerUpdateCredentialStore,
    target: &str,
) -> Result<(), String> {
    // 一项清除失败时仍尝试清除其余项，避免旧凭据在下次读取时迁移回来。
    let results = [
        store.delete(CredentialKind::Ssh, target),
        store.delete(CredentialKind::Sudo, target),
        store.delete_legacy(target),
    ];
    let errors: Vec<_> = results.into_iter().filter_map(Result::err).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

fn clear_lower_update_connection_with_store(
    settings_store: &super::app_storage::AppSettingsStore,
    store: &mut impl LowerUpdateCredentialStore,
    upload_account: &str,
) -> Result<(), String> {
    let target = credential_target(&parse_upload_account(upload_account)?);
    clear_lower_update_credentials_with_store(store, &target)?;
    settings_store.update_settings(|saved| {
        use super::app_storage::{
            LOWER_UPDATE_CONNECTION_HISTORY_KEY, LOWER_UPDATE_CONNECTION_KEY,
        };
        let mut changes = std::collections::BTreeMap::new();
        if let Some(value) = saved.get(LOWER_UPDATE_CONNECTION_KEY) {
            let settings: LowerUpdateConnectionSettingsDto = serde_json::from_value(value.clone())
                .map_err(|_| "已保存的下位机更新连接设置格式不合法".to_string())?;
            let mut settings = settings.normalize()?;
            if settings.upload_account.eq_ignore_ascii_case(&target) && settings.remember_password {
                settings.remember_password = false;
                changes.insert(
                    LOWER_UPDATE_CONNECTION_KEY.into(),
                    serde_json::to_value(settings)
                        .map_err(|_| "序列化下位机更新连接设置失败".to_string())?,
                );
            }
        }
        if saved.contains_key(LOWER_UPDATE_CONNECTION_HISTORY_KEY) {
            let mut history = saved_connection_history(saved)?;
            let mut changed = false;
            for settings in &mut history {
                if settings.upload_account.eq_ignore_ascii_case(&target)
                    && settings.remember_password
                {
                    settings.remember_password = false;
                    changed = true;
                }
            }
            if changed {
                changes.insert(
                    LOWER_UPDATE_CONNECTION_HISTORY_KEY.into(),
                    serde_json::to_value(history)
                        .map_err(|_| "序列化下位机更新连接历史失败".to_string())?,
                );
            }
        }
        Ok(changes)
    })
}

fn save_lower_update_connection_with_store(
    settings_store: &super::app_storage::AppSettingsStore,
    store: &mut impl LowerUpdateCredentialStore,
    settings: LowerUpdateConnectionSettingsDto,
    auth: &LowerUpdateSshAuthDto,
    sudo_password: &str,
) -> Result<(), String> {
    let settings = settings.normalize()?;
    if settings.auth_method != auth_method(auth) {
        return Err("下位机更新连接设置与实际 SSH 认证方式不匹配".into());
    }
    if settings.remember_password {
        if matches!(auth, LowerUpdateSshAuthDto::Password { password } if password.is_empty()) {
            return Err("SSH 密码不能为空".into());
        }
        match auth {
            LowerUpdateSshAuthDto::Password { password } => {
                store.save(CredentialKind::Ssh, &settings.upload_account, password)?;
            }
            LowerUpdateSshAuthDto::Certificate => {
                store.delete(CredentialKind::Ssh, &settings.upload_account)?;
            }
        }
        store.delete_legacy(&settings.upload_account)?;
        if settings.reuse_ssh_password_for_sudo || sudo_password.is_empty() {
            store.delete(CredentialKind::Sudo, &settings.upload_account)?;
        } else {
            store.save(
                CredentialKind::Sudo,
                &settings.upload_account,
                sudo_password,
            )?;
        }
    } else {
        clear_lower_update_credentials_with_store(store, &settings.upload_account)?;
    }
    settings_store.update_settings(|saved| {
        use super::app_storage::{
            LOWER_UPDATE_CONNECTION_HISTORY_KEY, LOWER_UPDATE_CONNECTION_KEY,
        };
        let mut history = saved_connection_history(saved)?;
        history.retain(|item| {
            !item
                .upload_account
                .eq_ignore_ascii_case(&settings.upload_account)
        });
        history.insert(0, settings.clone());
        history.truncate(LOWER_UPDATE_CONNECTION_HISTORY_LIMIT);
        Ok(std::collections::BTreeMap::from([
            (
                LOWER_UPDATE_CONNECTION_KEY.into(),
                serde_json::to_value(&settings)
                    .map_err(|_| "序列化下位机更新连接设置失败".to_string())?,
            ),
            (
                LOWER_UPDATE_CONNECTION_HISTORY_KEY.into(),
                serde_json::to_value(history)
                    .map_err(|_| "序列化下位机更新连接历史失败".to_string())?,
            ),
        ]))
    })
}

#[tauri::command]
pub fn get_lower_update_credentials(
    upload_account: String,
) -> Result<LowerUpdateCredentialsDto, String> {
    let _guard = LOWER_UPDATE_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "下位机更新凭据锁已损坏".to_string())?;
    let result = get_lower_update_credentials_with_store(
        &mut WindowsLowerUpdateCredentialStore,
        &upload_account,
    );
    if result.is_err() {
        tracing::warn!(target = %log_detail(&upload_account), "读取下位机更新凭据失败");
    }
    result
}

#[tauri::command]
pub fn save_lower_update_connection(
    settings: LowerUpdateConnectionSettingsDto,
    auth: LowerUpdateSshAuthDto,
    sudo_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _guard = LOWER_UPDATE_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "下位机更新凭据锁已损坏".to_string())?;
    let target = log_detail(&settings.upload_account);
    let result = save_lower_update_connection_with_store(
        &state.settings_store,
        &mut WindowsLowerUpdateCredentialStore,
        settings,
        &auth,
        &sudo_password,
    );
    if result.is_ok() {
        tracing::info!(target = %target, "已保存下位机更新连接信息");
    } else {
        tracing::warn!(target = %target, "保存下位机更新连接信息失败");
    }
    result
}

#[tauri::command]
pub fn clear_lower_update_credentials(
    upload_account: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _guard = LOWER_UPDATE_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "下位机更新凭据锁已损坏".to_string())?;
    let target = credential_target(&parse_upload_account(&upload_account)?);
    let result = clear_lower_update_connection_with_store(
        &state.settings_store,
        &mut WindowsLowerUpdateCredentialStore,
        &target,
    );
    if result.is_ok() {
        tracing::info!(target = %log_detail(&target), "已清除下位机更新保存的密码");
    } else {
        tracing::warn!(target = %log_detail(&target), "清除下位机更新保存的密码失败");
    }
    result
}

#[cfg(any(target_os = "windows", test))]
fn legacy_ssh_target_matches(username: Option<&str>, target_name: &str) -> bool {
    username.is_some_and(|username| username.eq_ignore_ascii_case(target_name))
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
    if !legacy_ssh_target_matches(attributes.get("username").map(String::as_str), target_name) {
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
    if legacy_ssh_target_matches(attributes.get("username").map(String::as_str), target_name) {
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

#[tauri::command]
pub fn get_lower_update_password(upload_account: String) -> Result<Option<String>, String> {
    let _guard = LOWER_UPDATE_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "下位机更新凭据锁已损坏".to_string())?;
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
    let _guard = LOWER_UPDATE_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "下位机更新凭据锁已损坏".to_string())?;
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

fn build_vertical_security_upload_command(install_dir: &str) -> String {
    build_user_upload_command(install_dir, VERTICAL_SECURITY_SCRIPT_NAME)
}

fn build_vertical_security_install_command(remote_path: &str) -> String {
    let script_path = shell_quote(remote_path);
    let script_install_path = shell_quote(VERTICAL_SECURITY_INSTALL_PATH);
    let service_name = shell_quote(VERTICAL_SECURITY_SERVICE_NAME);
    let service_path = shell_quote(VERTICAL_SECURITY_SERVICE_PATH);
    format!(
        "set -e; \
if ! command -v systemctl >/dev/null 2>&1; then \
  printf '%s\\n' '设备未检测到 systemctl，无法安装纵密开机自启服务' >&2; exit 127; \
fi; \
if systemctl cat {service_name} >/dev/null 2>&1; then \
  printf '%s\\n' '检测到已有纵密开机自启服务，将更新配置'; \
else \
  printf '%s\\n' '未检测到纵密开机自启服务，将创建服务'; \
fi; \
test -f {script_path}; \
install -d -m 0755 /usr/local/libexec /etc/systemd/system; \
script_tmp=/usr/local/libexec/.mskdsp-vertical-security.tmp.$$; \
service_tmp=/etc/systemd/system/.mskdsp-vertical-security.service.tmp.$$; \
cleanup() {{ rm -f -- \"$script_tmp\" \"$service_tmp\"; }}; \
trap cleanup EXIT HUP INT TERM; \
bash -n {script_path}; \
install -m 0755 {script_path} \"$script_tmp\"; \
mv -f -- \"$script_tmp\" {script_install_path}; \
cat > \"$service_tmp\" <<'EOF'\n[Unit]\nDescription=MskDSP 纵密配置\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nExecStart=/usr/local/libexec/mskdsp-vertical-security\nRemainAfterExit=yes\nTimeoutStartSec=30s\nRestart=on-failure\nRestartSec=10s\n\n[Install]\nWantedBy=multi-user.target\nEOF\ninstall -m 0644 \"$service_tmp\" {service_path}; \
rm -f -- \"$service_tmp\"; \
trap - EXIT HUP INT TERM; \
systemctl daemon-reload; \
systemctl enable {service_name}; \
systemctl is-enabled --quiet {service_name}; \
rm -f -- /run/mskdsp-vertical-security/steps.log /run/mskdsp-vertical-security/current; \
systemctl restart --no-block {service_name}; \
service_state=\"$(systemctl show --property=ActiveState --value {service_name})\"; \
case \"$service_state\" in \
  active|activating) printf '%s\\n' \"纵密服务已提交启动，当前状态：$service_state\" ;; \
  *) printf '%s\\n' \"纵密服务启动失败，当前状态：$service_state\" >&2; exit 1 ;; \
esac",
        script_path = script_path,
        script_install_path = script_install_path,
        service_name = service_name,
        service_path = service_path,
    )
}

fn build_vertical_security_status_command() -> String {
    let service_name = shell_quote(VERTICAL_SECURITY_SERVICE_NAME);
    "set -e; \
printf '%s\\n' \"__MSKDSP_ACTIVE_STATE__=$(systemctl show --property=ActiveState --value ".to_string()
        + &service_name
        + ")\"; \
printf '%s\\n' \"__MSKDSP_SUB_STATE__=$(systemctl show --property=SubState --value "
        + &service_name
        + ")\"; \
printf '%s\\n' \"__MSKDSP_RESULT__=$(systemctl show --property=Result --value "
        + &service_name
        + ")\"; \
printf '%s\\n' \"__MSKDSP_EXIT_CODE__=$(systemctl show --property=ExecMainStatus --value "
        + &service_name
        + ")\"; \
printf '%s\\n' \"__MSKDSP_RESTART_COUNT__=$(systemctl show --property=NRestarts --value "
        + &service_name
        + ")\"; \
printf '%s\\n' '__MSKDSP_STEPS_BEGIN__'; \
if test -r /run/mskdsp-vertical-security/steps.log; then cat /run/mskdsp-vertical-security/steps.log; fi"
}

fn parse_vertical_security_status_output(
    stdout: &str,
) -> Result<(String, String, String, Option<i32>, u32, Vec<VerticalSecurityStepResultDto>), String> {
    let mut active_state = String::new();
    let mut sub_state = String::new();
    let mut result = String::new();
    let mut exit_code = None;
    let mut restart_count = 0;
    let mut latest_steps = std::collections::BTreeMap::<String, VerticalSecurityStepResultDto>::new();
    let mut reading_steps = false;

    for line in stdout.lines() {
        if line == "__MSKDSP_STEPS_BEGIN__" {
            reading_steps = true;
            continue;
        }
        if !reading_steps {
            if let Some(value) = line.strip_prefix("__MSKDSP_ACTIVE_STATE__=") {
                active_state = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("__MSKDSP_SUB_STATE__=") {
                sub_state = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("__MSKDSP_RESULT__=") {
                result = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("__MSKDSP_EXIT_CODE__=") {
                exit_code = value.trim().parse::<i32>().ok();
            } else if let Some(value) = line.strip_prefix("__MSKDSP_RESTART_COUNT__=") {
                restart_count = value.trim().parse::<u32>().unwrap_or(0);
            }
            continue;
        }

        let fields: Vec<&str> = line.splitn(5, '\t').collect();
        if fields.len() != 5 {
            continue;
        }
        let Ok(updated_at) = fields[0].trim().parse::<u64>() else {
            continue;
        };
        let state = fields[3].trim();
        if !matches!(state, "running" | "waiting" | "success" | "failed") {
            continue;
        }
        latest_steps.insert(
            fields[1].to_string(),
            VerticalSecurityStepResultDto {
                step_id: fields[1].to_string(),
                name: fields[2].to_string(),
                state: state.to_string(),
                message: fields[4].to_string(),
                updated_at,
            },
        );
    }

    if active_state.is_empty() {
        return Err("远端未返回纵密服务 ActiveState".to_string());
    }
    Ok((
        active_state,
        sub_state,
        result,
        exit_code,
        restart_count,
        latest_steps.into_values().collect(),
    ))
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
    requested_platform: &str,
) -> Result<(), String> {
    normalize_platform(Some(requested_platform))?;
    normalize_platform(Some(&manifest.platform))?;
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
    if manifest.platform != requested_platform {
        return Err(format!(
            "下位机更新清单平台不匹配: 期望 {requested_platform}，实际 {}",
            manifest.platform
        ));
    }
    validate_platform_channel(requested_platform, requested_channel)?;
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
    if manifest.asset.name == LOWER_UPDATE_CACHE_METADATA_FILE_NAME
        || manifest.asset.name.starts_with(".mskdsp-cache.json.tmp-")
    {
        return Err("下位机更新清单安装包名称与缓存元数据保留名称冲突".into());
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

fn cache_metadata_path(directory: &Path) -> PathBuf {
    directory.join(LOWER_UPDATE_CACHE_METADATA_FILE_NAME)
}

fn unix_timestamp_now() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn persist_cache_metadata(
    directory: &Path,
    manifest: &LowerUpdateManifestDto,
) -> Result<(), String> {
    let metadata = LowerUpdateCacheMetadataDto {
        schema_version: LOWER_UPDATE_CACHE_METADATA_SCHEMA_VERSION,
        downloaded_at: unix_timestamp_now(),
        manifest: manifest.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("序列化下位机更新缓存清单失败: {error}"))?;
    let metadata_path = cache_metadata_path(directory);
    let temporary_path = directory.join(format!(
        ".mskdsp-cache.json.tmp-{}-{}",
        std::process::id(),
        unix_timestamp_now()
    ));
    fs::write(&temporary_path, bytes)
        .await
        .map_err(|error| format!("写入下位机更新缓存清单失败: {error}"))?;
    let replace_result = tokio::task::spawn_blocking({
        let temporary_path = temporary_path.clone();
        let metadata_path = metadata_path.clone();
        move || replace_cache_metadata_file(&temporary_path, &metadata_path)
    })
    .await
    .map_err(|error| format!("替换下位机更新缓存清单任务失败: {error}"))?;
    if let Err(error) = replace_result {
        let _ = fs::remove_file(&temporary_path).await;
        return Err(format!("保存下位机更新缓存清单失败: {error}"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_cache_metadata_file(source: &Path, destination: &Path) -> io::Result<()> {
    std_fs::rename(source, destination)
}

#[cfg(not(target_os = "windows"))]
fn replace_downloaded_package(source: &Path, destination: &Path) -> io::Result<()> {
    std_fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_cache_metadata_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn replace_downloaded_package(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

async fn load_cached_package(
    directory: &Path,
    requested_channel: Option<&str>,
    requested_platform: &str,
) -> Result<Option<LowerUpdateCachedPackageDto>, String> {
    let metadata_path = cache_metadata_path(directory);
    let metadata_bytes = match fs::read(&metadata_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取下位机更新缓存清单失败: {error}")),
    };
    let metadata = serde_json::from_slice::<LowerUpdateCacheMetadataDto>(&metadata_bytes)
        .map_err(|error| format!("解析下位机更新缓存清单失败: {error}"))?;
    if metadata.schema_version != LOWER_UPDATE_CACHE_METADATA_SCHEMA_VERSION {
        return Err(format!(
            "下位机更新缓存清单版本不支持: {}",
            metadata.schema_version
        ));
    }
    let channel = normalize_channel(&metadata.manifest.channel)?;
    if requested_channel.is_some_and(|requested| requested != channel) {
        return Ok(None);
    }
    validate_manifest(&metadata.manifest, &channel, requested_platform)?;
    if metadata
        .manifest
        .image_id
        .as_deref()
        .and_then(normalize_image_id)
        .is_none()
    {
        return Err("下位机更新缓存清单缺少有效镜像 ID".into());
    }

    let package_path = directory.join(&metadata.manifest.asset.name);
    let package_metadata = fs::metadata(&package_path)
        .await
        .map_err(|error| format!("读取下位机更新缓存包失败: {error}"))?;
    if !package_metadata.is_file() {
        return Err("下位机更新缓存包不是普通文件".into());
    }
    if package_metadata.len() != metadata.manifest.asset.size {
        return Err(format!(
            "下位机更新缓存包大小不匹配: 期望 {} 字节，实际 {} 字节",
            metadata.manifest.asset.size,
            package_metadata.len()
        ));
    }
    let sha256 = compute_sha256(&package_path).await?;
    if !sha256.eq_ignore_ascii_case(&metadata.manifest.asset.sha256) {
        return Err(format!(
            "下位机更新缓存包校验失败: 期望 {}，实际 {}",
            metadata.manifest.asset.sha256, sha256
        ));
    }

    Ok(Some(LowerUpdateCachedPackageDto {
        downloaded_at: metadata.downloaded_at,
        manifest: metadata.manifest,
        package_path: package_path.to_string_lossy().into_owned(),
        package_size: package_metadata.len(),
        sha256,
    }))
}

fn is_partial_download(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "download")
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".mskdsp-cache.json.tmp-"))
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

fn is_cache_metadata_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == LOWER_UPDATE_CACHE_METADATA_FILE_NAME)
}

fn metadata_matches_package(directory: &Path, package_path: &Path) -> bool {
    let metadata_path = cache_metadata_path(directory);
    let Ok(bytes) = std_fs::read(metadata_path) else {
        return false;
    };
    let Ok(metadata) = serde_json::from_slice::<LowerUpdateCacheMetadataDto>(&bytes) else {
        return false;
    };
    metadata.schema_version == LOWER_UPDATE_CACHE_METADATA_SCHEMA_VERSION
        && !metadata.manifest.asset.name.trim().is_empty()
        && directory.join(metadata.manifest.asset.name) == package_path
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
        .filter(|(path, _, _)| !is_cache_metadata_file(path))
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| left.2.cmp(&right.2)))
        .map(|(path, _, _)| path.clone());
    if let Some(latest) = latest {
        let keep_metadata = metadata_matches_package(directory, &latest);
        for (path, _, _) in regular_files(directory)? {
            if path == latest || (keep_metadata && is_cache_metadata_file(&path)) {
                continue;
            }
            let metadata = std_fs::symlink_metadata(&path)?;
            record_removed_file(&path, &metadata, result)?;
        }
    } else {
        for (path, _, _) in files {
            let metadata = std_fs::symlink_metadata(&path)?;
            record_removed_file(&path, &metadata, result)?;
        }
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

#[tauri::command]
pub async fn list_cached_lower_updates(
    state: State<'_, AppState>,
    channel: Option<String>,
    platform: Option<String>,
) -> Result<Vec<LowerUpdateCachedPackageDto>, String> {
    let requested_channel = channel.as_deref().map(normalize_channel).transpose()?;
    let platform = normalize_platform(platform.as_deref())?;
    let _guard = LOWER_UPDATE_CACHE_LOCK.lock().await;
    let cache_root = state.runtime_paths.lower_update_dir();
    list_cached_lower_updates_in(&cache_root, requested_channel.as_deref(), platform).await
}

async fn list_cached_lower_updates_in(
    cache_root: &Path,
    requested_channel: Option<&str>,
    platform: &str,
) -> Result<Vec<LowerUpdateCachedPackageDto>, String> {
    normalize_platform(Some(platform))?;
    if let Some(channel) = requested_channel {
        validate_platform_channel(platform, channel)?;
    }
    let mut cached = Vec::new();

    for candidate_channel in ["stable", "beta", "ci"] {
        if requested_channel
            .as_deref()
            .is_some_and(|requested| requested != candidate_channel)
        {
            continue;
        }
        if validate_platform_channel(platform, candidate_channel).is_err() {
            continue;
        }
        let directory = cache_root.join(candidate_channel).join(platform);
        if !directory.is_dir() {
            continue;
        }
        match load_cached_package(&directory, Some(candidate_channel), platform).await {
            Ok(Some(package)) => cached.push(package),
            Ok(None) => {}
            Err(error) => tracing::warn!(
                operation = "cache_list",
                channel = candidate_channel,
                platform,
                error = %log_detail(&error),
                "忽略无效的下位机更新缓存"
            ),
        }
    }

    cached.sort_by(|left, right| right.downloaded_at.cmp(&left.downloaded_at));
    tracing::info!(
        operation = "cache_list",
        count = cached.len(),
        channel = ?requested_channel,
        platform,
        "下位机更新缓存查询完成"
    );
    Ok(cached)
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
    task_id: &str,
    downloaded_bytes: u64,
    total_bytes: u64,
    stage: &str,
) {
    let payload = LowerUpdateDownloadProgressDto {
        task_id: task_id.to_string(),
        channel: manifest.channel.clone(),
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
    platform: Option<String>,
) -> Result<LowerUpdateManifestDto, String> {
    let started_at = Instant::now();
    let log_base_url = base_url.as_deref().map(log_url).unwrap_or_else(|| {
        default_base_url(platform.as_deref().unwrap_or(LOWER_UPDATE_PLATFORM)).to_string()
    });
    tracing::info!(
        operation = "check",
        channel = %log_detail(&channel),
        platform = %log_detail(platform.as_deref().unwrap_or(LOWER_UPDATE_PLATFORM)),
        base_url = %log_base_url,
        "开始获取下位机更新清单"
    );

    let result = async {
        let channel = normalize_channel(&channel)?;
        let platform = normalize_platform(platform.as_deref())?;
        validate_platform_channel(platform, &channel)?;
        let base_url = normalize_base_url(base_url, platform)?;
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
        validate_manifest(&manifest, &channel, platform)?;
        Ok(manifest)
    }
    .await;

    match result {
        Ok(manifest) => {
            tracing::info!(
                operation = "check",
                channel = %manifest.channel,
                platform = %manifest.platform,
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
        query_lower_update_runtime_info(&target, &request.auth, &request.sudo_password).await
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
    task_id: String,
) -> Result<LowerUpdateDownloadResultDto, String> {
    let started_at = Instant::now();
    let package_name = manifest.asset.name.clone();
    tracing::info!(
        operation = "download",
        package = %package_name,
        platform = %log_detail(&manifest.platform),
        task_id = %task_id,
        url = %log_url(&manifest.asset.url),
        "收到下位机更新包下载请求"
    );
    let result = async {
        let channel = normalize_channel(&manifest.channel)?;
        validate_manifest(&manifest, &channel, &manifest.platform)?;
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
            let existing_size = fs::metadata(&output_path)
                .await
                .map_err(|error| format!("读取上位机缓存包信息失败: {error}"))?
                .len();
            let existing_sha256 = compute_sha256(&output_path).await?;
            if existing_size == manifest.asset.size
                && existing_sha256.eq_ignore_ascii_case(&manifest.asset.sha256)
            {
                tracing::info!(
                    operation = "download",
                    package = %manifest.asset.name,
                    task_id = %task_id,
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
                persist_cache_metadata(&output_dir, &manifest).await?;
                emit_download_progress(
                    &app_handle,
                    &manifest,
                    &task_id,
                    manifest.asset.size,
                    manifest.asset.size,
                    "finished",
                );
                return Ok(LowerUpdateDownloadResultDto {
                    package_name: manifest.asset.name,
                    package_path: output_path.to_string_lossy().into_owned(),
                    downloaded_bytes: existing_size,
                    sha256: existing_sha256,
                });
            }

            tracing::warn!(
                operation = "download",
                package = %manifest.asset.name,
                cache_path = %output_path.display(),
                "下位机更新包缓存与当前清单不匹配，将下载新版本并在校验通过后替换"
            );
        } else if output_path.exists() {
            return Err("下位机更新缓存路径已存在但不是文件".into());
        }

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|e| format!("创建下位机更新下载客户端失败: {e}"))?;
        tracing::info!(
            operation = "download",
            package = %manifest.asset.name,
            task_id = %task_id,
            url = %log_url(&manifest.asset.url),
            "开始下载下位机更新包"
        );
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
        emit_download_progress(&app_handle, &manifest, &task_id, 0, total_bytes, "started");

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
                &task_id,
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
            &task_id,
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

        let package_source = partial_path.clone();
        let package_destination = output_path.clone();
        tokio::task::spawn_blocking(move || {
            replace_downloaded_package(&package_source, &package_destination)
        })
        .await
        .map_err(|e| format!("替换下位机更新包任务失败: {e}"))?
        .map_err(|e| format!("保存下位机更新包失败: {e}"))?;
        let cleanup_dir = output_dir.clone();
        let keep_path = output_path.clone();
        run_blocking_cache_cleanup(move || {
            let mut result = LowerUpdateCacheCleanupResultDto::default();
            retain_only_regular_file(&cleanup_dir, &keep_path, &mut result)?;
            Ok(result)
        })
        .await?;
        persist_cache_metadata(&output_dir, &manifest).await?;
        emit_download_progress(
            &app_handle,
            &manifest,
            &task_id,
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
                task_id = %task_id,
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
                task_id = %task_id,
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
    if !is_sha256(&request.package_sha256) {
        return Err("上位机更新包缺少有效 SHA256".into());
    }
    let actual_sha256 = compute_sha256(&package_path).await?;
    if !actual_sha256.eq_ignore_ascii_case(&request.package_sha256) {
        return Err(format!(
            "上位机更新包校验失败: 期望 {}，实际 {}",
            request.package_sha256, actual_sha256
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

    let runtime =
        query_lower_update_runtime_info(&target, &request.auth, &request.sudo_password).await?;
    if should_skip_install(&request.expected_image_id, &runtime)? {
        tracing::info!(
            operation = "install_preflight",
            target = %log_detail(&request.upload_account),
            package = %log_detail(&request.package_name),
            expected_image_id = %request.expected_image_id,
            actual_image_id = ?runtime.image_id,
            "目标机已运行待安装构建，跳过重复安装"
        );
        return Ok(LowerUpdateInstallResultDto {
            package_name: request.package_name,
            remote_path,
            command: "未执行安装命令，目标机已运行待安装构建".to_string(),
            already_current: true,
            success: true,
            exit_code: Some(0),
            stdout: "目标机已运行待安装构建，已跳过重复安装\n".to_string(),
            stderr: String::new(),
        });
    }

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
        already_current: false,
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
pub async fn deploy_vertical_security_script(
    request: VerticalSecurityDeployRequestDto,
) -> Result<VerticalSecurityDeployResultDto, String> {
    let started_at = Instant::now();
    if request.script_content.trim().is_empty() {
        return Err("纵密配置脚本内容不能为空".into());
    }
    if request.script_content.as_bytes().len() > VERTICAL_SECURITY_MAX_SCRIPT_BYTES {
        return Err(format!(
            "纵密配置脚本不能超过 {} 字节",
            VERTICAL_SECURITY_MAX_SCRIPT_BYTES
        ));
    }
    if request.script_content.contains('\0') {
        return Err("纵密配置脚本不能包含 NUL 字符".into());
    }

    let target = parse_upload_account(&request.upload_account)?;
    let install_dir = normalize_install_dir(&request.install_dir)?;
    let remote_path = remote_package_path(&install_dir, VERTICAL_SECURITY_SCRIPT_NAME);
    let upload_command = build_vertical_security_upload_command(&install_dir);

    tracing::info!(
        operation = "vertical_security_deploy",
        target = %log_detail(&request.upload_account),
        remote_path = %remote_path,
        service = VERTICAL_SECURITY_SERVICE_NAME,
        "开始部署纵密配置脚本"
    );

    let preflight = tokio::time::timeout(
        LOWER_UPDATE_PRECHECK_TIMEOUT,
        execute_user_ssh_command(
            &target,
            &request.auth,
            &build_upload_preflight_command(&install_dir),
        ),
    )
    .await
    .map_err(|_| "上传纵密配置脚本前检查目录超时".to_string())??;
    if preflight.exit_code != Some(0) {
        return Err(format_remote_command_error(
            "上传纵密配置脚本前检查目录失败",
            &preflight,
        ));
    }
    let available_bytes = parse_available_bytes(&preflight.stdout)?;
    if available_bytes < request.script_content.as_bytes().len() as u64 {
        return Err(format!(
            "下位机磁盘空间不足: 需要 {} 字节，可用 {} 字节",
            request.script_content.as_bytes().len(),
            available_bytes
        ));
    }

    let upload = tokio::time::timeout(
        LOWER_UPDATE_INSTALL_TIMEOUT,
        execute_user_ssh_command_with_stdin(
            &target,
            &request.auth,
            &upload_command,
            request.script_content.as_bytes(),
        ),
    )
    .await
    .map_err(|_| "上传纵密配置脚本整体超时".to_string())??;
    if upload.exit_code != Some(0) {
        return Err(format_remote_command_error("上传纵密配置脚本失败", &upload));
    }

    let install_command = build_vertical_security_install_command(&remote_path);
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
    .map_err(|_| "安装纵密配置 systemd 服务整体超时".to_string())??;

    let result = VerticalSecurityDeployResultDto {
        remote_path,
        service_name: VERTICAL_SECURITY_SERVICE_NAME.to_string(),
        exit_code: output.exit_code.map(|code| code as i32),
        stdout: output.stdout,
        stderr: output.stderr,
        success: output.exit_code == Some(0),
    };

    if result.success {
        tracing::info!(
            operation = "vertical_security_deploy",
            target = %log_detail(&request.upload_account),
            service = %result.service_name,
            exit_code = ?result.exit_code,
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "纵密配置脚本部署完成"
        );
    } else {
        tracing::warn!(
            operation = "vertical_security_deploy",
            target = %log_detail(&request.upload_account),
            service = %result.service_name,
            exit_code = ?result.exit_code,
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "纵密配置 systemd 服务执行失败"
        );
    }

    Ok(result)
}

#[tauri::command]
pub async fn get_vertical_security_status(
    request: VerticalSecurityStatusRequestDto,
) -> Result<VerticalSecurityStatusResultDto, String> {
    let target = parse_upload_account(&request.upload_account)?;
    let output = tokio::time::timeout(
        LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT,
        execute_root_ssh_command(
            &target,
            &request.auth,
            &request.sudo_password,
            &build_vertical_security_status_command(),
        ),
    )
    .await
    .map_err(|_| "查询纵密服务状态超时".to_string())??;

    if output.exit_code != Some(0) {
        return Err(format_remote_command_error("查询纵密服务状态失败", &output));
    }

    let (active_state, sub_state, result, exit_code, restart_count, steps) =
        parse_vertical_security_status_output(&output.stdout)?;
    Ok(VerticalSecurityStatusResultDto {
        service_name: VERTICAL_SECURITY_SERVICE_NAME.to_string(),
        active_state,
        sub_state,
        result,
        exit_code,
        restart_count,
        steps,
    })
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
        expected_image_id = %log_detail(&request.expected_image_id),
        remote_path = ?remote_path,
        "开始执行下位机更新安装"
    );
    let expected_image_id = request.expected_image_id.clone();
    let result = install_lower_update_package_inner(request).await;
    match result {
        Ok(result) => {
            if result.already_current {
                tracing::info!(
                    operation = "install",
                    auth_method,
                    target = %target,
                    package = %result.package_name,
                    remote_path = %result.remote_path,
                    expected_image_id = %log_detail(&expected_image_id),
                    elapsed_ms = started_at.elapsed().as_millis() as u64,
                    "目标机已是最新构建，跳过下位机更新安装"
                );
            } else if result.success {
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

fn normalize_package_cleanup_dir(
    install_dir: &str,
    package_name: &str,
) -> Result<String, String> {
    if !is_safe_file_name(package_name) {
        return Err("当前安装包名称不能包含路径分隔符".into());
    }
    let install_dir = normalize_install_dir(install_dir)?;
    if install_dir
        .split('/')
        .all(|part| part.is_empty() || part == ".")
    {
        return Err("禁止清理根目录中的安装包".into());
    }
    Ok(install_dir)
}

fn build_package_cleanup_command(
    install_dir: &str,
    package_name: &str,
    expected_image_id: &str,
) -> Result<String, String> {
    let install_dir = normalize_package_cleanup_dir(install_dir, package_name)?;
    let image_id = normalize_image_id(expected_image_id)
        .ok_or_else(|| "清理请求缺少有效的期望镜像 ID".to_string())?;
    Ok(format!(
        "python3 -c {} {} {} {}",
        shell_quote(LOWER_UPDATE_PACKAGE_CLEANUP_SCRIPT),
        shell_quote(&install_dir),
        shell_quote(package_name),
        shell_quote(&image_id),
    ))
}

fn parse_package_cleanup_output(
    stdout: &str,
    remote_path: String,
) -> Result<LowerUpdatePackageCleanupResultDto, String> {
    let stats: LowerUpdatePackageCleanupStats = serde_json::from_str(stdout.trim())
        .map_err(|_| "解析下位机历史安装包清理统计失败".to_string())?;
    Ok(LowerUpdatePackageCleanupResultDto {
        remote_path,
        removed_files: stats.removed_files,
        reclaimed_bytes: stats.reclaimed_bytes,
    })
}

fn verified_package_cleanup_raw_image(
    expected_image_id: &str,
    runtime: &LowerUpdateRuntimeInfoDto,
) -> Result<String, String> {
    if !should_skip_install(expected_image_id, runtime)? {
        return Err("下位机未运行期望镜像，禁止清理历史安装包".into());
    }
    runtime
        .raw_image_id
        .as_deref()
        .and_then(normalize_image_id)
        .ok_or_else(|| "下位机未返回有效的原始镜像引用，禁止清理历史安装包".to_string())
}

async fn cleanup_lower_update_packages_inner(
    request: LowerUpdateInstallRequestDto,
) -> Result<LowerUpdatePackageCleanupResultDto, String> {
    let target = parse_upload_account(&request.upload_account)?;
    let install_dir = normalize_package_cleanup_dir(&request.install_dir, &request.package_name)?;
    let expected_image_id = normalize_image_id(&request.expected_image_id)
        .ok_or_else(|| "清理请求缺少有效的期望镜像 ID".to_string())?;
    let remote_path = remote_package_path(&install_dir, &request.package_name);
    tokio::time::timeout(LOWER_UPDATE_PACKAGE_CLEANUP_TIMEOUT, async {
        let runtime =
            query_lower_update_runtime_info(&target, &request.auth, &request.sudo_password).await?;
        let raw_image_id = verified_package_cleanup_raw_image(&expected_image_id, &runtime)?;
        let cleanup_command =
            build_package_cleanup_command(&install_dir, &request.package_name, &raw_image_id)?;
        let output = execute_root_ssh_command(
            &target,
            &request.auth,
            &request.sudo_password,
            &cleanup_command,
        )
        .await?;
        if output.exit_code != Some(0) {
            return Err(format_remote_command_error(
                "清理下位机历史安装包失败",
                &output,
            ));
        }
        parse_package_cleanup_output(&output.stdout, remote_path)
    })
    .await
    .map_err(|_| "清理下位机历史安装包超时".to_string())?
}

#[tauri::command]
pub async fn cleanup_lower_update_packages(
    request: LowerUpdateInstallRequestDto,
) -> Result<LowerUpdatePackageCleanupResultDto, String> {
    let started_at = Instant::now();
    let target = log_detail(&request.upload_account);
    let package = log_detail(&request.package_name);
    let auth_method = auth_method(&request.auth);
    tracing::info!(
        operation = "package_cleanup",
        auth_method,
        target = %target,
        package = %package,
        "开始校验运行镜像并清理下位机历史安装包"
    );
    let result = cleanup_lower_update_packages_inner(request).await;
    match &result {
        Ok(result) => tracing::info!(
            operation = "package_cleanup",
            auth_method,
            target = %target,
            package = %package,
            remote_path = %log_detail(&result.remote_path),
            removed_files = result.removed_files,
            reclaimed_bytes = result.reclaimed_bytes,
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "下位机历史安装包清理完成，已保留当前安装包"
        ),
        Err(error) => tracing::warn!(
            operation = "package_cleanup",
            auth_method,
            target = %target,
            package = %package,
            error = %log_detail(error),
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "下位机历史安装包清理失败"
        ),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::LowerUpdateCredentialStore;
    use super::{
        build_password_root_shell_command, build_user_upload_command,
        build_vertical_security_install_command, build_vertical_security_upload_command,
        build_vertical_security_status_command, parse_vertical_security_status_output,
        cache_metadata_path, cleanup_cache_startup_in, clear_cache_root_contents, compute_sha256,
        format_upload_remote_error, load_cached_package, parse_available_bytes,
        parse_runtime_query_output, parse_upload_account, persist_cache_metadata,
        should_skip_install, sudo_password_stdin, LowerUpdateAssetDto, LowerUpdateChecksumDto,
        LowerUpdateManifestDto, LowerUpdateRuntimeInfoDto, LowerUpdateSourceDto,
        LOWER_UPDATE_CONTAINER_NAME, VERTICAL_SECURITY_SCRIPT_NAME,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    // 旧凭据归属沿用 Windows 目标匹配规则，缺少归属或其他目标不能迁移、删除。
    #[test]
    fn legacy_ssh_ownership_matches_case_variants_but_rejects_other_targets() {
        let target = "megsky@device:10022";
        assert!(super::legacy_ssh_target_matches(
            Some("megsky@DEVICE:10022"),
            target
        ));
        for username in [
            None,
            Some(""),
            Some("megsky@other:10022"),
            Some("megsky@device:22"),
            Some("other@device:10022"),
        ] {
            assert!(!super::legacy_ssh_target_matches(username, target));
        }
    }

    #[derive(Default)]
    struct FakeCredentials {
        // Windows 凭据目标不区分大小写；保持与实际存储的索引语义一致。
        values: std::collections::BTreeMap<(super::CredentialKind, String), String>,
        legacy: std::collections::BTreeMap<String, String>,
        fail_save: bool,
        fail_ssh_delete: bool,
    }

    impl super::LowerUpdateCredentialStore for FakeCredentials {
        fn load(
            &mut self,
            kind: super::CredentialKind,
            target: &str,
        ) -> Result<Option<String>, String> {
            Ok(self.values.get(&(kind, target.to_ascii_lowercase())).cloned())
        }
        fn save(
            &mut self,
            kind: super::CredentialKind,
            target: &str,
            password: &str,
        ) -> Result<(), String> {
            if self.fail_save {
                return Err("模拟凭据存储失败".into());
            }
            self.values
                .insert((kind, target.to_ascii_lowercase()), password.into());
            Ok(())
        }
        fn delete(&mut self, kind: super::CredentialKind, target: &str) -> Result<(), String> {
            if self.fail_ssh_delete && kind == super::CredentialKind::Ssh {
                return Err("模拟 SSH 清除失败".into());
            }
            self.values.remove(&(kind, target.to_ascii_lowercase()));
            Ok(())
        }
        fn migrate_legacy(&mut self, target: &str) -> Result<Option<String>, String> {
            let password = self.legacy.remove(&target.to_ascii_lowercase());
            if let Some(password) = &password {
                self.save(super::CredentialKind::Ssh, target, password)?;
            }
            Ok(password)
        }
        fn delete_legacy(&mut self, target: &str) -> Result<(), String> {
            self.legacy.remove(&target.to_ascii_lowercase());
            Ok(())
        }
    }

    fn connection_settings() -> super::LowerUpdateConnectionSettingsDto {
        super::LowerUpdateConnectionSettingsDto {
            upload_account: "megsky@device:10022".into(),
            install_dir: "/home/megsky/".into(),
            auth_method: "password".into(),
            reuse_ssh_password_for_sudo: false,
            remember_password: true,
        }
    }

    // 旧最近设置在已有空历史或缺失对应历史时仍补入末尾，已满 20 条时保持容量。
    #[test]
    fn history_merges_missing_legacy_connection_without_exceeding_capacity() {
        use super::super::app_storage::{
            LOWER_UPDATE_CONNECTION_HISTORY_KEY, LOWER_UPDATE_CONNECTION_KEY,
        };
        let legacy = connection_settings();
        let mut saved = std::collections::BTreeMap::from([
            (
                LOWER_UPDATE_CONNECTION_KEY.into(),
                serde_json::to_value(&legacy).unwrap(),
            ),
            (
                LOWER_UPDATE_CONNECTION_HISTORY_KEY.into(),
                serde_json::json!([]),
            ),
        ]);
        assert_eq!(
            super::saved_connection_history(&saved).unwrap()[0].upload_account,
            legacy.upload_account
        );
        let mut other = connection_settings();
        other.upload_account = "user@other:22".into();
        saved.insert(
            LOWER_UPDATE_CONNECTION_HISTORY_KEY.into(),
            serde_json::to_value(vec![other]).unwrap(),
        );
        let history = super::saved_connection_history(&saved).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].upload_account, legacy.upload_account);
        let full: Vec<_> = (0..20)
            .map(|index| {
                let mut settings = connection_settings();
                settings.upload_account = format!("user@device{index}:22");
                settings
            })
            .collect();
        saved.insert(
            LOWER_UPDATE_CONNECTION_HISTORY_KEY.into(),
            serde_json::to_value(full).unwrap(),
        );
        assert_eq!(super::saved_connection_history(&saved).unwrap().len(), 20);
    }

    // 成功目标置顶，忽略凭据目标大小写去重，历史最多保留 20 条。
    #[test]
    fn keeps_recent_connection_history_and_migrates_previous_success() {
        use super::super::app_storage::LOWER_UPDATE_CONNECTION_KEY;
        use super::LowerUpdateSshAuthDto;
        let temp = TestDirectory::new();
        let store =
            crate::commands::app_storage::AppSettingsStore::new(temp.path().join("settings.json"));
        let mut credentials = FakeCredentials::default();
        let auth = LowerUpdateSshAuthDto::Password {
            password: "ssh-secret".into(),
        };
        let key = "mskdsp_lower_update_connection_history";
        store
            .save_setting(
                LOWER_UPDATE_CONNECTION_KEY.into(),
                serde_json::to_value(connection_settings()).unwrap(),
            )
            .unwrap();
        for index in 0..21 {
            let mut settings = connection_settings();
            settings.upload_account = format!("user@device{index}:22");
            super::save_lower_update_connection_with_store(
                &store,
                &mut credentials,
                settings,
                &auth,
                "",
            )
            .unwrap();
            if index == 0 {
                assert_eq!(
                    store.load().unwrap()[key][1]["upload_account"],
                    "megsky@device:10022"
                );
            }
        }
        let saved = store.load().unwrap();
        assert_eq!(saved[key].as_array().unwrap().len(), 20);
        assert_eq!(saved[key][0]["upload_account"], "user@device20:22");
        assert_eq!(saved[key][19]["upload_account"], "user@device1:22");
        let mut revisited = connection_settings();
        revisited.upload_account = " user@DEVICE5:022 ".into();
        revisited.install_dir = "/home/revisited".into();
        super::save_lower_update_connection_with_store(
            &store,
            &mut credentials,
            revisited,
            &auth,
            "",
        )
        .unwrap();
        let saved = store.load().unwrap();
        let history = saved[key].as_array().unwrap();
        assert_eq!(history.len(), 20);
        assert_eq!(history[0]["upload_account"], "user@DEVICE5:22");
        assert_eq!(history[0]["install_dir"], "/home/revisited");
        assert_eq!(history[0], saved[LOWER_UPDATE_CONNECTION_KEY]);
        assert_eq!(
            history
                .iter()
                .filter(|item| item["upload_account"]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("user@device5:22"))
                .count(),
            1
        );
        assert!(!fs::read_to_string(temp.path().join("settings.json"))
            .unwrap()
            .contains("ssh-secret"));
    }

    // 清除非最近目标只关闭该历史项记住密码，不改变历史顺序及最近目标。
    #[test]
    fn clearing_history_target_preserves_order_and_other_recent_settings() {
        use super::super::app_storage::LOWER_UPDATE_CONNECTION_KEY;
        use super::LowerUpdateSshAuthDto;
        let temp = TestDirectory::new();
        let store =
            crate::commands::app_storage::AppSettingsStore::new(temp.path().join("settings.json"));
        let mut credentials = FakeCredentials::default();
        let auth = LowerUpdateSshAuthDto::Password {
            password: "ssh-secret".into(),
        };
        let key = "mskdsp_lower_update_connection_history";
        super::save_lower_update_connection_with_store(
            &store,
            &mut credentials,
            connection_settings(),
            &auth,
            "",
        )
        .unwrap();
        let mut other = connection_settings();
        other.upload_account = "user@other:22".into();
        super::save_lower_update_connection_with_store(&store, &mut credentials, other, &auth, "")
            .unwrap();
        let before = store.load().unwrap();
        super::clear_lower_update_connection_with_store(
            &store,
            &mut credentials,
            "megsky@DEVICE:010022",
        )
        .unwrap();
        let saved = store.load().unwrap();
        assert_eq!(
            saved[LOWER_UPDATE_CONNECTION_KEY],
            before[LOWER_UPDATE_CONNECTION_KEY]
        );
        assert_eq!(saved[key][0], before[key][0]);
        assert_eq!(
            saved[key][1]["upload_account"],
            before[key][1]["upload_account"]
        );
        assert_eq!(saved[key][1]["remember_password"], false);
    }

    // 凭据按目标和用途隔离，证书和复用模式不保留多余密码。
    #[test]
    fn saves_credentials_separately_and_clears_only_matching_target() {
        use super::{CredentialKind, LowerUpdateSshAuthDto};
        let temp = TestDirectory::new();
        let settings_store =
            crate::commands::app_storage::AppSettingsStore::new(temp.path().join("settings.json"));
        let mut credentials = FakeCredentials::default();
        let mut settings = connection_settings();
        let auth = LowerUpdateSshAuthDto::Password {
            password: "ssh-secret".into(),
        };
        super::save_lower_update_connection_with_store(
            &settings_store,
            &mut credentials,
            settings.clone(),
            &auth,
            "sudo-secret",
        )
        .unwrap();
        let loaded =
            super::get_lower_update_credentials_with_store(&mut credentials, "megsky@device:10022")
                .unwrap();
        assert_eq!(loaded.ssh_password.as_deref(), Some("ssh-secret"));
        assert_eq!(loaded.sudo_password.as_deref(), Some("sudo-secret"));
        credentials
            .save(CredentialKind::Ssh, "megsky@other:10022", "other-secret")
            .unwrap();
        settings.reuse_ssh_password_for_sudo = true;
        super::save_lower_update_connection_with_store(
            &settings_store,
            &mut credentials,
            settings.clone(),
            &auth,
            "ssh-secret",
        )
        .unwrap();
        assert!(credentials
            .load(CredentialKind::Sudo, "megsky@device:10022")
            .unwrap()
            .is_none());
        settings.auth_method = "certificate".into();
        settings.reuse_ssh_password_for_sudo = true;
        super::save_lower_update_connection_with_store(
            &settings_store,
            &mut credentials,
            settings.clone(),
            &LowerUpdateSshAuthDto::Certificate,
            "sudo-secret",
        )
        .unwrap();
        assert!(credentials
            .load(CredentialKind::Ssh, "megsky@device:10022")
            .unwrap()
            .is_none());
        assert_eq!(
            credentials
                .load(CredentialKind::Sudo, "megsky@device:10022")
                .unwrap()
                .as_deref(),
            Some("sudo-secret")
        );
        assert_eq!(
            settings_store.load().unwrap()[super::super::app_storage::LOWER_UPDATE_CONNECTION_KEY]
                ["reuse_ssh_password_for_sudo"],
            false
        );
        credentials
            .legacy
            .insert("megsky@device:10022".into(), "old-secret".into());
        settings.remember_password = false;
        super::save_lower_update_connection_with_store(
            &settings_store,
            &mut credentials,
            settings,
            &LowerUpdateSshAuthDto::Certificate,
            "sudo-secret",
        )
        .unwrap();
        let loaded =
            super::get_lower_update_credentials_with_store(&mut credentials, "megsky@device:10022")
                .unwrap();
        assert!(loaded.ssh_password.is_none() && loaded.sudo_password.is_none());
        assert_eq!(
            credentials
                .load(CredentialKind::Ssh, "megsky@other:10022")
                .unwrap()
                .as_deref(),
            Some("other-secret")
        );
        let disk = fs::read_to_string(temp.path().join("settings.json")).unwrap();
        assert!(!disk.contains("secret"));
    }

    // 验证设置或存储失败不能覆盖已成功的连接配置。
    #[test]
    fn rejects_auth_mismatch_and_preserves_settings_on_credential_failure() {
        use super::LowerUpdateSshAuthDto;
        let temp = TestDirectory::new();
        let store =
            crate::commands::app_storage::AppSettingsStore::new(temp.path().join("settings.json"));
        let mut credentials = FakeCredentials::default();
        assert!(super::save_lower_update_connection_with_store(
            &store,
            &mut credentials,
            connection_settings(),
            &LowerUpdateSshAuthDto::Certificate,
            ""
        )
        .is_err());
        assert!(credentials.values.is_empty());
        assert!(store.load().unwrap().is_empty());
        let auth = LowerUpdateSshAuthDto::Password {
            password: "secret".into(),
        };
        super::save_lower_update_connection_with_store(
            &store,
            &mut credentials,
            connection_settings(),
            &auth,
            "",
        )
        .unwrap();
        let previous = store.load().unwrap();
        credentials.fail_save = true;
        let mut changed = connection_settings();
        changed.install_dir = "/home/changed".into();
        assert!(super::save_lower_update_connection_with_store(
            &store,
            &mut credentials,
            changed,
            &auth,
            ""
        )
        .is_err());
        assert_eq!(store.load().unwrap(), previous);
    }

    // 清除入口只关闭已成功且匹配目标的记住密码开关。
    #[test]
    fn clears_matching_credentials_and_disables_remember_without_creating_settings() {
        use super::{CredentialKind, LowerUpdateSshAuthDto};
        let temp = TestDirectory::new();
        let store =
            crate::commands::app_storage::AppSettingsStore::new(temp.path().join("settings.json"));
        let mut credentials = FakeCredentials::default();
        super::clear_lower_update_connection_with_store(
            &store,
            &mut credentials,
            "megsky@other:10022",
        )
        .unwrap();
        assert!(store.load().unwrap().is_empty());
        let auth = LowerUpdateSshAuthDto::Password {
            password: "ssh-secret".into(),
        };
        super::save_lower_update_connection_with_store(
            &store,
            &mut credentials,
            connection_settings(),
            &auth,
            "sudo-secret",
        )
        .unwrap();
        super::clear_lower_update_connection_with_store(
            &store,
            &mut credentials,
            "megsky@other:10022",
        )
        .unwrap();
        assert_eq!(
            store.load().unwrap()[super::super::app_storage::LOWER_UPDATE_CONNECTION_KEY]
                ["remember_password"],
            true
        );
        credentials
            .legacy
            .insert("megsky@device:10022".into(), "legacy-secret".into());
        credentials
            .legacy
            .insert("megsky@other:10022".into(), "other-legacy-secret".into());
        super::clear_lower_update_connection_with_store(
            &store,
            &mut credentials,
            " megsky@DEVICE:010022 ",
        )
        .unwrap();
        assert_eq!(
            store.load().unwrap()[super::super::app_storage::LOWER_UPDATE_CONNECTION_KEY]
                ["remember_password"],
            false
        );
        assert!(credentials
            .load(CredentialKind::Ssh, "megsky@device:10022")
            .unwrap()
            .is_none());
        assert!(credentials
            .load(CredentialKind::Sudo, "megsky@device:10022")
            .unwrap()
            .is_none());
        assert_eq!(
            credentials
                .legacy
                .get("megsky@other:10022")
                .map(String::as_str),
            Some("other-legacy-secret")
        );
    }

    // 一项清除失败仍尝试另外两项，错误必须传回界面。
    #[test]
    fn attempts_all_credential_deletions_even_when_one_fails() {
        use super::CredentialKind;
        let mut credentials = FakeCredentials::default();
        credentials
            .save(CredentialKind::Ssh, "megsky@device:10022", "ssh-secret")
            .unwrap();
        credentials
            .save(CredentialKind::Sudo, "megsky@device:10022", "sudo-secret")
            .unwrap();
        credentials
            .legacy
            .insert("megsky@device:10022".into(), "legacy-secret".into());
        credentials.fail_ssh_delete = true;
        assert!(super::clear_lower_update_credentials_with_store(
            &mut credentials,
            "megsky@device:10022"
        )
        .is_err());
        assert!(credentials
            .load(CredentialKind::Sudo, "megsky@device:10022")
            .unwrap()
            .is_none());
        assert!(credentials.legacy.is_empty());
    }

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

    fn test_manifest(
        package_name: &str,
        package_size: u64,
        sha256: String,
    ) -> LowerUpdateManifestDto {
        LowerUpdateManifestDto {
            schema_version: 1,
            product: "mskdsp-lower".to_string(),
            channel: "stable".to_string(),
            platform: "linux-arm64".to_string(),
            version: "1.2.3".to_string(),
            package_version: "1.2.3".to_string(),
            image_id: Some(format!("sha256:{}", "a".repeat(64))),
            published_at: "2026-08-06T00:00:00Z".to_string(),
            source: LowerUpdateSourceDto {
                repository: "https://example.com/mskdsp".to_string(),
                source_ref: "main".to_string(),
                sha: "a".repeat(40),
            },
            asset: LowerUpdateAssetDto {
                name: package_name.to_string(),
                url: format!("https://example.com/{package_name}"),
                sha256,
                size: package_size,
            },
            checksum: LowerUpdateChecksumDto {
                name: "SHA256SUMS".to_string(),
                url: "https://example.com/SHA256SUMS".to_string(),
            },
        }
    }

    // 验证旧调用默认 ARM64，并拒绝未知或可穿越目录的平台参数。
    #[test]
    fn defaults_to_arm64_and_accepts_only_supported_platforms() {
        assert_eq!(super::normalize_platform(None).unwrap(), "linux-arm64");
        assert_eq!(
            super::normalize_platform(Some("linux-arm64")).unwrap(),
            "linux-arm64"
        );
        assert_eq!(
            super::normalize_platform(Some("linux-x64")).unwrap(),
            "linux-x64"
        );
        for platform in ["", "linux-amd64", "linux-arm", "../linux-x64"] {
            assert!(super::normalize_platform(Some(platform))
                .unwrap_err()
                .contains("平台"));
        }
    }

    // 验证 ARM64 支持三个通道，x64 仅允许已有发布链的 CI 通道。
    #[test]
    fn allows_all_arm64_channels_and_only_x64_ci() {
        for channel in ["stable", "beta", "ci"] {
            assert!(super::validate_platform_channel("linux-arm64", channel).is_ok());
        }
        assert!(super::validate_platform_channel("linux-x64", "ci").is_ok());
        for channel in ["stable", "beta"] {
            assert!(super::validate_platform_channel("linux-x64", channel)
                .unwrap_err()
                .contains("仅支持 ci"));
        }
        assert!(super::validate_platform_channel("linux-amd64", "ci").is_err());
    }

    // 验证两种架构的默认更新源独立，同时保留显式覆盖更新源的能力。
    #[test]
    fn uses_separate_platform_sources_and_preserves_explicit_override() {
        assert!(super::normalize_base_url(None, "linux-arm64")
            .unwrap()
            .ends_with("/mskdsp-lower"));
        assert!(super::normalize_base_url(None, "linux-x64")
            .unwrap()
            .ends_with("/mskdsp-lower-x64"));
        assert!(super::normalize_base_url(Some("  ".into()), "linux-x64")
            .unwrap()
            .ends_with("/mskdsp-lower-x64"));
        assert_eq!(
            super::normalize_base_url(Some(" https://example.com/custom/ ".into()), "linux-x64")
                .unwrap(),
            "https://example.com/custom"
        );
    }

    // 验证清单必须匹配所请求的架构和通道，并拒绝不支持的组合。
    #[test]
    fn validates_manifest_against_requested_platform_and_channel() {
        let mut manifest = test_manifest("package", 16, "a".repeat(64));
        assert!(super::validate_manifest(&manifest, "stable", "linux-arm64").is_ok());
        assert!(super::validate_manifest(&manifest, "stable", "linux-x64").is_err());
        manifest.platform = "linux-x64".into();
        manifest.channel = "ci".into();
        assert!(super::validate_manifest(&manifest, "ci", "linux-x64").is_ok());
        assert!(super::validate_manifest(&manifest, "ci", "linux-arm64")
            .unwrap_err()
            .contains("平台不匹配"));
        manifest.channel = "stable".into();
        assert!(super::validate_manifest(&manifest, "stable", "linux-x64")
            .unwrap_err()
            .contains("仅支持 ci"));
        manifest.platform = "../linux-arm64".into();
        assert!(super::validate_manifest(&manifest, "stable", "../linux-arm64").is_err());
    }

    // 验证两种架构即使包名相同，也只返回所选架构的校验通过缓存。
    #[tokio::test]
    async fn lists_only_selected_platform_even_when_package_names_match() {
        let temp = TestDirectory::new();
        for platform in ["linux-arm64", "linux-x64"] {
            let directory = temp.path().join("ci").join(platform);
            fs::create_dir_all(&directory).unwrap();
            let package_path = directory.join("same-package");
            fs::write(&package_path, platform.as_bytes()).unwrap();
            let sha256 = compute_sha256(&package_path).await.unwrap();
            let mut manifest = test_manifest("same-package", platform.len() as u64, sha256);
            manifest.channel = "ci".into();
            manifest.platform = platform.into();
            persist_cache_metadata(&directory, &manifest).await.unwrap();
        }
        for platform in ["linux-arm64", "linux-x64"] {
            let cached = super::list_cached_lower_updates_in(temp.path(), None, platform)
                .await
                .unwrap();
            assert_eq!(cached.len(), 1);
            assert_eq!(cached[0].manifest.platform, platform);
            assert!(cached[0].package_path.contains(platform));
        }
        assert!(
            super::list_cached_lower_updates_in(temp.path(), Some("stable"), "linux-x64")
                .await
                .unwrap_err()
                .contains("仅支持 ci")
        );
    }

    // 验证缓存清单架构或通道与目录不符时，不得恢复成可下发缓存。
    #[tokio::test]
    async fn refuses_cached_metadata_for_another_platform_or_directory_channel() {
        let temp = TestDirectory::new();
        let directory = temp.path().join("ci/linux-x64");
        fs::create_dir_all(&directory).unwrap();
        let package_path = directory.join("package");
        fs::write(&package_path, b"verified-package").unwrap();
        let sha256 = compute_sha256(&package_path).await.unwrap();
        let mut manifest = test_manifest("package", 16, sha256);
        manifest.channel = "ci".into();
        persist_cache_metadata(&directory, &manifest).await.unwrap();
        assert!(load_cached_package(&directory, Some("ci"), "linux-x64")
            .await
            .unwrap_err()
            .contains("平台不匹配"));
        assert!(
            super::list_cached_lower_updates_in(temp.path(), None, "linux-x64")
                .await
                .unwrap()
                .is_empty()
        );

        manifest.platform = "linux-x64".into();
        manifest.channel = "beta".into();
        persist_cache_metadata(&directory, &manifest).await.unwrap();
        assert!(
            super::list_cached_lower_updates_in(temp.path(), None, "linux-x64")
                .await
                .unwrap()
                .is_empty()
        );
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

    // 验证清理命令拒绝根目录、路径穿越包名和无效镜像 ID。
    #[test]
    fn rejects_unsafe_package_cleanup_request() {
        let image_id = format!("sha256:{}", "a".repeat(64));
        for directory in ["/", "////", "/./", "/././"] {
            let error = super::build_package_cleanup_command(
                directory,
                "mskdsp-v0.3.0-linux-arm64",
                &image_id,
            )
            .expect_err("应拒绝根目录及其等价写法");
            assert!(error.contains("根目录"));
        }
        assert!(super::build_package_cleanup_command(
            "/home/megsky",
            "../mskdsp-v0.3.0-linux-arm64",
            &image_id,
        )
        .is_err());
        assert!(super::build_package_cleanup_command(
            "/home/megsky",
            "mskdsp-v0.3.0-linux-arm64",
            "sha256:bad",
        )
        .is_err());
    }

    // 验证清理脚本与参数正确引用，运行镜像校验留在远端删除脚本内执行。
    #[test]
    fn builds_cleanup_command_with_quoted_script_and_arguments() {
        let command = super::build_package_cleanup_command(
            "/home/megsky'folder/",
            "mskdsp-v0.3.0-linux-arm64",
            &format!("sha256:{}", "A".repeat(64)),
        )
        .expect("应正确引用安装目录");
        assert!(command.starts_with("python3 -c '"));
        assert!(command.contains("'/home/megsky'\\''folder'"));
        assert!(command.ends_with(&format!("'sha256:{}'", "a".repeat(64))));
        assert!(command.contains("--type=container"));
        assert!(command.contains("_assert_current_unchanged"));
    }

    // 验证 containerd 原始引用不同于配置摘要时，已验证配置匹配仍可清理并锁定原始引用。
    #[test]
    fn accepts_cleanup_with_verified_config_and_distinct_raw_reference() {
        let expected = format!("sha256:{}", "a".repeat(64));
        let mut verified = parse_runtime_query_output(&format!("true sha256:{}", "B".repeat(64)))
            .expect("应保留查询的原始镜像引用");
        verified.image_id = Some(expected.clone());
        assert_eq!(
            super::verified_package_cleanup_raw_image(&expected, &verified)
                .expect("应接受已验证的 containerd 镜像配置摘要"),
            format!("sha256:{}", "b".repeat(64)),
        );
    }

    // 验证经典 Docker 的原始引用就是配置摘要时，继续允许清理。
    #[test]
    fn accepts_cleanup_with_classic_docker_config_reference() {
        let expected = format!("sha256:{}", "a".repeat(64));
        let runtime = LowerUpdateRuntimeInfoDto {
            container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
            exists: true,
            running: true,
            image_id: Some(expected.clone()),
            raw_image_id: Some(expected.clone()),
        };
        assert_eq!(
            super::verified_package_cleanup_raw_image(&expected, &runtime)
                .expect("应接受经典 Docker 的运行镜像引用"),
            expected,
        );
    }

    // 验证原始快照缺失、停止或无有效摘要，以及配置确认不匹配时均拒绝清理。
    #[test]
    fn rejects_cleanup_without_running_raw_snapshot_and_verified_config() {
        let expected = format!("sha256:{}", "a".repeat(64));
        let runtime = LowerUpdateRuntimeInfoDto {
            container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
            exists: true,
            running: true,
            image_id: Some(expected.clone()),
            raw_image_id: Some(expected.clone()),
        };
        let invalid = [
            LowerUpdateRuntimeInfoDto { exists: false, ..runtime.clone() },
            LowerUpdateRuntimeInfoDto { running: false, ..runtime.clone() },
            LowerUpdateRuntimeInfoDto { image_id: None, ..runtime.clone() },
            LowerUpdateRuntimeInfoDto { image_id: Some("sha256:bad".into()), ..runtime.clone() },
            LowerUpdateRuntimeInfoDto { raw_image_id: None, ..runtime.clone() },
            LowerUpdateRuntimeInfoDto { raw_image_id: Some("sha256:bad".into()), ..runtime.clone() },
        ];
        for verified in invalid.iter().chain(std::iter::once(&LowerUpdateRuntimeInfoDto {
            image_id: Some(format!("sha256:{}", "b".repeat(64))),
            ..runtime.clone()
        })) {
            assert!(super::verified_package_cleanup_raw_image(&expected, verified).is_err());
        }
    }

    // 验证原始运行引用仅用于内部清理校验，不改变公开运行状态 JSON。
    #[test]
    fn keeps_cleanup_raw_runtime_reference_out_of_public_json() {
        let runtime = parse_runtime_query_output(&format!("true sha256:{}", "a".repeat(64)))
            .expect("应能解析运行镜像");
        assert_eq!(runtime.raw_image_id, runtime.image_id);
        let serialized = serde_json::to_value(&runtime).expect("应能序列化公开运行状态");
        assert!(serialized.get("raw_image_id").is_none());
        assert!(serialized.get("image_id").is_some());
        let missing = parse_runtime_query_output("__MSKDSP_CONTAINER_MISSING__")
            .expect("应能解析容器缺失");
        assert!(missing.raw_image_id.is_none());
    }

    // 验证清理返回零数量也是成功，并拒绝缺字段、负数、非 JSON 或多余输出。
    #[test]
    fn parses_package_cleanup_stats_and_rejects_malformed_output() {
        let remote_path = "/home/megsky/mskdsp-v0.3.0-linux-arm64".to_string();
        for (stdout, count, bytes) in [
            ("{\"removed_files\":2,\"reclaimed_bytes\":4096}\n", 2, 4096),
            ("{\"removed_files\":0,\"reclaimed_bytes\":0}", 0, 0),
        ] {
            let result = super::parse_package_cleanup_output(stdout, remote_path.clone())
                .expect("应接受合法的清理统计");
            assert_eq!(result.remote_path, remote_path);
            assert_eq!(result.removed_files, count);
            assert_eq!(result.reclaimed_bytes, bytes);
        }
        for stdout in [
            "",
            "{\"removed_files\":1}",
            "{\"removed_files\":-1,\"reclaimed_bytes\":1}",
            "{\"removed_files\":1,\"reclaimed_bytes\":1,\"other\":true}",
            "warning\n{\"removed_files\":1,\"reclaimed_bytes\":1}",
        ] {
            assert!(super::parse_package_cleanup_output(stdout, remote_path.clone()).is_err());
        }
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
    fn builds_vertical_security_upload_command_with_fixed_script_name() {
        let command = build_vertical_security_upload_command("/tmp/mskdsp");

        assert!(command.contains(VERTICAL_SECURITY_SCRIPT_NAME));
        assert!(command.contains("cat >"));
        assert!(command.contains("trap"));
        assert!(!command.contains("sudo"));
    }

    #[test]
    fn builds_vertical_security_install_command_with_systemd_lifecycle_checks() {
        let command = build_vertical_security_install_command(
            "/tmp/mskdsp/mskdsp-vertical-security.sh",
        );

        assert!(command.contains("command -v systemctl"));
        assert!(command.contains("bash -n"));
        assert!(command.contains("/usr/local/libexec/mskdsp-vertical-security"));
        assert!(command.contains("/etc/systemd/system/mskdsp-vertical-security.service"));
        assert!(command.contains("Description=MskDSP 纵密配置"));
        assert!(command.contains("StartLimitIntervalSec=0"));
        assert!(command.contains("Type=exec"));
        assert!(!command.contains("Type=oneshot"));
        assert!(command.contains("TimeoutStartSec=30s"));
        assert!(command.contains("Restart=on-failure"));
        assert!(command.contains("RestartSec=10s"));
        assert!(command.contains("systemctl cat"));
        assert!(command.contains("systemctl daemon-reload"));
        assert!(command.contains("systemctl enable"));
        assert!(command.contains("systemctl is-enabled --quiet"));
        assert!(command.contains("systemctl restart --no-block"));
        assert!(command.contains("systemctl show --property=ActiveState --value"));
        assert!(command.contains("rm -f -- /run/mskdsp-vertical-security/steps.log"));
        assert!(!command.contains("sudo-secret"));
    }

    #[test]
    fn parses_latest_status_for_each_vertical_security_step() {
        let output = concat!(
            "__MSKDSP_ACTIVE_STATE__=activating\n",
            "__MSKDSP_SUB_STATE__=start\n",
            "__MSKDSP_RESULT__=success\n",
            "__MSKDSP_EXIT_CODE__=0\n",
            "__MSKDSP_RESTART_COUNT__=2\n",
            "__MSKDSP_STEPS_BEGIN__\n",
            "100\tprecheck\t系统预检查\trunning\t正在检查\n",
            "101\tprecheck\t系统预检查\tsuccess\t检查完成\n",
            "102\tppp0_wait\tPPP 链路\twaiting\t等待 ppp0 IPv4 地址\n",
        );
        let (active, sub, result, exit_code, restarts, steps) =
            parse_vertical_security_status_output(output).expect("应解析纵密步骤状态");

        assert_eq!(active, "activating");
        assert_eq!(sub, "start");
        assert_eq!(result, "success");
        assert_eq!(exit_code, Some(0));
        assert_eq!(restarts, 2);
        assert_eq!(steps.len(), 2);
        assert_eq!(
            steps.iter().find(|step| step.step_id == "ppp0_wait").map(|step| step.state.as_str()),
            Some("waiting")
        );
        assert_eq!(
            steps.iter().find(|step| step.step_id == "precheck").map(|step| step.state.as_str()),
            Some("success")
        );
    }

    #[test]
    fn builds_vertical_security_status_command_with_step_log_markers() {
        let command = build_vertical_security_status_command();

        assert!(command.contains("systemctl show --property=ActiveState --value"));
        assert!(command.contains("__MSKDSP_STEPS_BEGIN__"));
        assert!(command.contains("/run/mskdsp-vertical-security/steps.log"));
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

    // 验证目标机已运行相同镜像时安装前置检查会短路。
    #[test]
    fn skips_install_when_running_image_matches_expected_image() {
        let runtime = LowerUpdateRuntimeInfoDto {
            container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
            exists: true,
            running: true,
            image_id: Some(format!("sha256:{}", "A".repeat(64))),
            raw_image_id: Some(format!("sha256:{}", "A".repeat(64))),
        };

        assert!(
            should_skip_install(&format!("sha256:{}", "a".repeat(64)), &runtime)
                .expect("相同镜像应允许跳过安装")
        );
    }

    // 验证目标机运行不同镜像时不能短路安装。
    #[test]
    fn continues_install_when_running_image_differs() {
        let runtime = LowerUpdateRuntimeInfoDto {
            container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
            exists: true,
            running: true,
            image_id: Some(format!("sha256:{}", "b".repeat(64))),
            raw_image_id: Some(format!("sha256:{}", "b".repeat(64))),
        };

        assert!(
            !should_skip_install(&format!("sha256:{}", "a".repeat(64)), &runtime)
                .expect("不同镜像应继续安装")
        );
    }

    // 验证安装请求缺少合法期望镜像时会被拒绝。
    #[test]
    fn rejects_invalid_expected_image_for_install_preflight() {
        let runtime = LowerUpdateRuntimeInfoDto {
            container_name: LOWER_UPDATE_CONTAINER_NAME.to_string(),
            exists: true,
            running: true,
            image_id: Some(format!("sha256:{}", "a".repeat(64))),
            raw_image_id: Some(format!("sha256:{}", "a".repeat(64))),
        };

        let error = should_skip_install("-", &runtime).expect_err("无效期望镜像应被拒绝");
        assert!(error.contains("期望镜像"));
    }

    #[test]
    fn rejects_extra_runtime_query_fields() {
        let error =
            parse_runtime_query_output(&format!("true sha256:{} unexpected\n", "c".repeat(64)))
                .expect_err("应拒绝包含额外字段的 Docker 查询结果");

        assert!(error.contains("格式不合法"));
    }

    // 验证下载完成后会持久化完整清单，并且重启后只能恢复重新校验通过的缓存包。
    #[tokio::test]
    async fn persists_and_loads_verified_cache_metadata_as_one_unit() {
        let temp = TestDirectory::new();
        let platform_dir = temp.path().join("stable/linux-arm64");
        fs::create_dir_all(&platform_dir).expect("应能创建缓存目录");
        let package_path = platform_dir.join("mskdsp-lower.tar");
        fs::write(&package_path, b"verified-package").expect("应能写入缓存包");
        let sha256 = compute_sha256(&package_path)
            .await
            .expect("应能计算缓存包 SHA256");
        let manifest = test_manifest("mskdsp-lower.tar", 16, sha256.clone());

        persist_cache_metadata(&platform_dir, &manifest)
            .await
            .expect("应能写入缓存元数据");

        let metadata_bytes =
            fs::read(cache_metadata_path(&platform_dir)).expect("应能读取缓存元数据");
        let metadata: super::LowerUpdateCacheMetadataDto =
            serde_json::from_slice(&metadata_bytes).expect("缓存元数据应为有效 JSON");
        assert_eq!(metadata.schema_version, 1);
        assert_eq!(metadata.manifest.asset.name, "mskdsp-lower.tar");

        let cached = load_cached_package(&platform_dir, Some("stable"), "linux-arm64")
            .await
            .expect("读取缓存包不应失败")
            .expect("应恢复已下载缓存包");
        assert_eq!(cached.manifest.image_id, manifest.image_id);
        assert_eq!(
            cached.package_path,
            package_path.to_string_lossy().into_owned()
        );
        assert_eq!(cached.package_size, 16);
        assert_eq!(cached.sha256, sha256);
    }

    // 验证缓存包内容被篡改后不会恢复为可下发缓存。
    #[tokio::test]
    async fn rejects_cached_package_when_checksum_no_longer_matches_metadata() {
        let temp = TestDirectory::new();
        let platform_dir = temp.path().join("stable/linux-arm64");
        fs::create_dir_all(&platform_dir).expect("应能创建缓存目录");
        let package_path = platform_dir.join("mskdsp-lower.tar");
        fs::write(&package_path, b"original-package").expect("应能写入缓存包");
        let sha256 = compute_sha256(&package_path)
            .await
            .expect("应能计算缓存包 SHA256");
        let manifest = test_manifest("mskdsp-lower.tar", 16, sha256);
        persist_cache_metadata(&platform_dir, &manifest)
            .await
            .expect("应能写入缓存元数据");
        fs::write(&package_path, b"tampered-package").expect("应能篡改测试缓存包");

        let error = load_cached_package(&platform_dir, Some("stable"), "linux-arm64")
            .await
            .expect_err("篡改缓存包不应恢复");
        assert!(error.contains("大小不匹配") || error.contains("校验失败"));
    }

    // 验证没有合法镜像 ID 的旧缓存不能恢复为可下发版本。
    #[tokio::test]
    async fn rejects_cached_metadata_without_image_id() {
        let temp = TestDirectory::new();
        let platform_dir = temp.path().join("stable/linux-arm64");
        fs::create_dir_all(&platform_dir).expect("应能创建缓存目录");
        let package_path = platform_dir.join("mskdsp-lower.tar");
        fs::write(&package_path, b"verified-package").expect("应能写入缓存包");
        let sha256 = compute_sha256(&package_path)
            .await
            .expect("应能计算缓存包 SHA256");
        let mut manifest = test_manifest("mskdsp-lower.tar", 16, sha256);
        manifest.image_id = None;
        persist_cache_metadata(&platform_dir, &manifest)
            .await
            .expect("应能写入缓存元数据");

        let error = load_cached_package(&platform_dir, Some("stable"), "linux-arm64")
            .await
            .expect_err("缺少镜像 ID 的缓存不应恢复");
        assert!(error.contains("镜像 ID"));
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

    // 验证启动清理以“安装包 + 元数据”为整体保留最新缓存单元。
    #[test]
    fn startup_cleanup_keeps_metadata_with_latest_package_and_removes_old_package() {
        let temp = TestDirectory::new();
        let platform_dir = temp.path().join("stable/linux-arm64");
        fs::create_dir_all(&platform_dir).expect("应能创建缓存目录");
        fs::write(platform_dir.join("a-old-package"), b"old").expect("应能写入旧包");
        let latest_path = platform_dir.join("z-latest-package");
        fs::write(&latest_path, b"latest").expect("应能写入新包");
        let metadata = super::LowerUpdateCacheMetadataDto {
            schema_version: 1,
            downloaded_at: 1,
            manifest: test_manifest("z-latest-package", 6, "a".repeat(64)),
        };
        fs::write(
            cache_metadata_path(&platform_dir),
            serde_json::to_vec(&metadata).expect("应能序列化缓存元数据"),
        )
        .expect("应能写入缓存元数据");

        let result = cleanup_cache_startup_in(temp.path()).expect("启动清理应成功");

        assert!(!platform_dir.join("a-old-package").exists());
        assert!(latest_path.is_file());
        assert!(cache_metadata_path(&platform_dir).is_file());
        assert_eq!(result.removed_files, 1);
    }

    #[test]
    fn manual_cleanup_only_removes_cache_root_contents_and_recreates_root() {
        let temp = TestDirectory::new();
        let cache_root = temp.path().join("lower-update");
        let sibling = temp.path().join("keep.txt");
        fs::create_dir_all(cache_root.join("stable/linux-arm64")).expect("应能创建缓存目录");
        fs::write(cache_root.join("stable/linux-arm64/package"), b"package")
            .expect("应能写入缓存包");
        fs::write(
            cache_root.join("stable/linux-arm64/.mskdsp-cache.json"),
            b"metadata",
        )
        .expect("应能写入缓存元数据");
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
        assert_eq!(result.removed_files, 2);
        assert_eq!(result.reclaimed_bytes, 7 + 8);
    }
}
