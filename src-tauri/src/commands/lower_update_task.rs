//! 提交独立宿主机更新任务；传输失败时保留任务结果未知的语义。
use super::lower_update::{
    execute_root_ssh_command, is_safe_file_name, normalize_image_id, normalize_install_dir,
    remote_package_path, resolve_update_target, shell_quote, LowerUpdateRemoteTargetDto,
    LowerUpdateSshAuthDto,
};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::time::Duration;
use tauri::State;

const HELPER: &[u8] = include_bytes!("lower_update_task.py");
const MAX_LOG_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
pub struct SubmitLowerUpdateTaskRequest {
    pub upload_account: String,
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
    #[serde(default)]
    pub remote_target: Option<LowerUpdateRemoteTargetDto>,
    pub install_dir: String,
    pub package_name: String,
    pub operation_id: String,
    pub package_sha256: String,
    pub expected_image_id: String,
}

#[derive(Deserialize)]
pub struct GetLowerUpdateTaskRequest {
    pub upload_account: String,
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
    #[serde(default)]
    pub remote_target: Option<LowerUpdateRemoteTargetDto>,
    pub operation_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LowerUpdateTaskStatus {
    pub operation_id: String,
    pub phase: String,
    pub message: String,
    pub expected_image_id: String,
    pub actual_image_id: Option<String>,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub log_tail: String,
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err("更新任务编号必须为 UUID".into());
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("更新包 SHA256 不合法".into());
    }
    Ok(())
}

/// 按内容摘要命名并安装到 root 独占目录，禁止以 root 执行普通用户可写脚本。
fn helper_command(arguments: &[&str]) -> Result<String, String> {
    let digest = format!("{:x}", Sha256::digest(HELPER));
    let mut compressor = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    compressor
        .write_all(HELPER)
        .map_err(|_| "无法编码更新助手".to_string())?;
    let compressed = compressor
        .finish()
        .map_err(|_| "无法编码更新助手".to_string())?;
    let payload: String = compressed.iter().map(|b| format!("{b:02x}")).collect();
    let path = format!("/usr/local/libexec/mskdsp-update/lower_update_task-{digest}.py");
    let bootstrap = format!(
        r#"import os,stat,hashlib,tempfile,zlib
data=zlib.decompress(bytes.fromhex('{payload}'))
root='/usr/local/libexec/mskdsp-update'
for parent in ['/usr','/usr/local','/usr/local/libexec',root]:
    try: os.mkdir(parent,0o700)
    except FileExistsError: pass
    info=os.lstat(parent)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('更新助手目录不属于 root 独占目录')
path='{path}'
if os.path.lexists(path):
    info=os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('更新助手文件属主或权限无效')
    with open(path,'rb') as source: existing=source.read()
    if hashlib.sha256(existing).hexdigest() != '{digest}':
        raise RuntimeError('更新助手文件摘要不一致')
else:
    fd,tmp=tempfile.mkstemp(prefix='.helper-',dir=root)
    try:
        with os.fdopen(fd,'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(),0o500)
        os.replace(tmp,path)
    finally:
        if os.path.lexists(tmp): os.unlink(tmp)
"#
    );
    let args = arguments
        .iter()
        .map(|value| shell_quote(value))
        .collect::<Vec<_>>()
        .join(" ");
    let command = format!(
        "set -e; python3 -c {}; exec python3 {} {}",
        shell_quote(&bootstrap),
        shell_quote(&path),
        args
    );
    if command.len() > 60 * 1024 {
        return Err("更新助手传输命令过长，已停止任务提交".into());
    }
    Ok(command)
}

fn parse_status(value: &str, operation_id: &str) -> Result<LowerUpdateTaskStatus, String> {
    if value.len() > 256 * 1024 {
        return Err("更新任务响应过大".into());
    }
    let mut status: LowerUpdateTaskStatus = serde_json::from_str(value.trim())
        .map_err(|_| "宿主机更新任务未返回有效 JSON 状态".to_string())?;
    if status.operation_id != operation_id {
        return Err("宿主机返回的更新任务编号不匹配".into());
    }
    if ![
        "accepted",
        "preparing",
        "installing",
        "verifying",
        "succeeded",
        "rolling_back",
        "rolled_back",
        "rollback_failed",
        "failed",
    ]
    .contains(&status.phase.as_str())
    {
        return Err("宿主机返回未知更新阶段".into());
    }
    if status.log_tail.len() > MAX_LOG_BYTES {
        let mut begin = status.log_tail.len() - MAX_LOG_BYTES;
        while !status.log_tail.is_char_boundary(begin) {
            begin += 1;
        }
        status.log_tail = status.log_tail[begin..].to_string();
    }
    Ok(status)
}

async fn invoke_helper(
    state: &AppState,
    upload_account: &str,
    auth: &LowerUpdateSshAuthDto,
    sudo_password: &str,
    remote: Option<&LowerUpdateRemoteTargetDto>,
    operation_id: &str,
    arguments: &[&str],
) -> Result<LowerUpdateTaskStatus, String> {
    let target = resolve_update_target(state, upload_account, remote, auth).await?;
    let command = helper_command(arguments)?;
    // 提交前复制并校验大包可能较慢；查询保持较短的观测超时。
    let timeout = if arguments.first() == Some(&"submit") {
        600
    } else {
        90
    };
    let output = tokio::time::timeout(
        Duration::from_secs(timeout),
        execute_root_ssh_command(&target, auth, sudo_password, &command),
    )
    .await
    .map_err(|_| {
        "更新任务观测超时，结果暂时未知；请恢复连接后查询原任务，不要重新安装".to_string()
    })??;
    if output.exit_code != Some(0) {
        // 返回错误和日志尾部不得携带认证秘密。
        let mut detail = output.stderr.chars().take(2048).collect::<String>();
        for secret in [
            sudo_password,
            match auth {
                LowerUpdateSshAuthDto::Password { password } => password,
                _ => "",
            },
        ] {
            if !secret.is_empty() {
                detail = detail.replace(secret, "[已隐藏]");
            }
        }
        return Err(format!(
            "宿主机更新任务接口未确认成功，请查询原任务：{detail}"
        ));
    }
    let mut status = parse_status(&output.stdout, operation_id)?;
    for secret in [
        sudo_password,
        match auth {
            LowerUpdateSshAuthDto::Password { password } => password,
            _ => "",
        },
    ] {
        if !secret.is_empty() {
            status.log_tail = status.log_tail.replace(secret, "[已隐藏]");
            status.message = status.message.replace(secret, "[已隐藏]");
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn submit_lower_update_task(
    state: State<'_, AppState>,
    request: SubmitLowerUpdateTaskRequest,
) -> Result<LowerUpdateTaskStatus, String> {
    let device_id = request
        .remote_target
        .as_ref()
        .map(|target| target.device_id.as_str())
        .unwrap_or("直连设备");
    validate_operation_id(&request.operation_id)?;
    tracing::info!(operation_id = %request.operation_id, device_id, "开始提交宿主机独立更新任务");
    validate_digest(&request.package_sha256)?;
    let package_sha256 = request.package_sha256.to_ascii_lowercase();
    if !is_safe_file_name(&request.package_name) {
        return Err("更新包名称不合法".into());
    }
    let image = normalize_image_id(&request.expected_image_id).ok_or("期望镜像 ID 不合法")?;
    if crate::update_policy::is_stable_client(env!("CARGO_PKG_VERSION")) {
        super::lower_update::find_verified_stable_package(
            &state.runtime_paths.lower_update_dir(),
            &request.package_name,
            Some(&image),
            None,
            None,
            Some(&package_sha256),
        )
        .await?;
    }
    let directory = normalize_install_dir(&request.install_dir)?;
    let path = remote_package_path(&directory, &request.package_name);
    let status = invoke_helper(
        &state,
        &request.upload_account,
        &request.auth,
        &request.sudo_password,
        request.remote_target.as_ref(),
        &request.operation_id,
        &[
            "submit",
            "--operation-id",
            &request.operation_id,
            "--package-path",
            &path,
            "--package-sha256",
            &package_sha256,
            "--expected-image-id",
            &image,
        ],
    )
    .await.inspect_err(|_| {
        tracing::warn!(operation_id = %request.operation_id, device_id, "更新任务提交未获得确认，必须继续查询原任务");
    })?;
    if normalize_image_id(&status.expected_image_id).as_deref() != Some(image.as_str()) {
        tracing::warn!(operation_id = %request.operation_id, device_id, "宿主机任务镜像身份不一致，已停止处理");
        return Err("宿主机更新任务期望镜像不匹配，请核验原任务".into());
    }
    tracing::info!(operation_id = %status.operation_id, device_id, phase = %status.phase, exit_code = ?status.exit_code, "宿主机更新任务已受理");
    Ok(status)
}

#[tauri::command]
pub async fn get_lower_update_task(
    state: State<'_, AppState>,
    request: GetLowerUpdateTaskRequest,
) -> Result<LowerUpdateTaskStatus, String> {
    validate_operation_id(&request.operation_id)?;
    let device_id = request
        .remote_target
        .as_ref()
        .map(|target| target.device_id.as_str())
        .unwrap_or("直连设备");
    tracing::debug!(operation_id = %request.operation_id, device_id, "开始查询原宿主机更新任务");
    let result = invoke_helper(
        &state,
        &request.upload_account,
        &request.auth,
        &request.sudo_password,
        request.remote_target.as_ref(),
        &request.operation_id,
        &["query", "--operation-id", &request.operation_id],
    )
    .await;
    match &result {
        Ok(status) => {
            tracing::debug!(operation_id = %status.operation_id, device_id, phase = %status.phase, exit_code = ?status.exit_code, "已读取宿主机更新任务状态")
        }
        Err(_) => {
            tracing::debug!(operation_id = %request.operation_id, device_id, "暂未确认宿主机任务状态，保留原任务身份")
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "f727e860-5923-4a50-8e2a-c4e114530bbb";
    #[test]
    fn task_submission_rejects_shell_injection_and_invalid_hash() {
        assert!(validate_operation_id(ID).is_ok());
        for id in [
            "new",
            "../task",
            "task; rm",
            "f727e860-5923-4a50-8e2a-c4e114530bbz",
            "F727e860-5923-4a50-8e2a-c4e114530bbb",
        ] {
            assert!(validate_operation_id(id).is_err());
        }
        assert!(validate_digest(&"a".repeat(64)).is_ok());
        assert!(validate_digest("bad").is_err());
    }
    #[test]
    fn task_status_is_bound_to_original_operation_and_phase() {
        let make = |id: &str, phase: &str| {
            serde_json::json!({"operation_id":id,"phase":phase,"message":"",
            "expected_image_id":"sha256:abc", "log_tail":""})
            .to_string()
        };
        assert!(parse_status(&make(ID, "accepted"), ID).is_ok());
        assert!(parse_status(&make("other", "accepted"), ID).is_err());
        assert!(parse_status(&make(ID, "unknown"), ID).is_err());
        assert_eq!(
            parse_status(&make(ID, "rolled_back"), ID).unwrap().phase,
            "rolled_back"
        );
        let output = serde_json::json!({"operation_id":ID,"phase":"verifying","message":"",
            "expected_image_id":"sha256:abc", "log_tail":"日志".repeat(MAX_LOG_BYTES)})
        .to_string();
        let status = parse_status(&output, ID).unwrap();
        assert!(status.log_tail.len() <= MAX_LOG_BYTES);
        assert!(status.log_tail.ends_with("日志"));
    }
    #[test]
    fn helper_is_content_addressed_and_never_executed_from_upload_directory() {
        let command = helper_command(&["query", "--operation-id", ID]).unwrap();
        assert!(command.contains("/usr/local/libexec/mskdsp-update/lower_update_task-"));
        assert!(command.contains("os.lstat(parent)"));
        assert!(command.contains("info.st_mode & 0o022"));
        assert!(command.contains("os.fchmod(output.fileno(),0o500)"));
    }
}
