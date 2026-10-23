//! 提交独立宿主机更新任务；传输失败时保留任务结果未知的语义。
#[cfg(test)]
use super::lower_update::complete_without_waiting_for_disconnect;
use super::lower_update::{
    execute_root_ssh_command_observed, is_safe_file_name, normalize_image_id,
    normalize_install_dir, remote_package_path, resolve_recovery_target, resolve_update_target,
    shell_quote, LowerUpdateRemoteTargetDto, LowerUpdateRuntimeInfoRequestDto,
    LowerUpdateSshAuthDto, UpdateSshObserver,
};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::time::Duration;
use tauri::State;

const HELPER: &[u8] = include_bytes!("lower_update_task.py");
const MAX_LOG_BYTES: usize = 32 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(45);
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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
    #[serde(default)]
    pub recovery_direct_account: Option<String>,
    pub operation_id: String,
}

#[derive(Deserialize)]
pub struct CloseLowerUpdateTaskRequest {
    pub upload_account: String,
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
    #[serde(default)]
    pub remote_target: Option<LowerUpdateRemoteTargetDto>,
    #[serde(default)]
    pub recovery_direct_account: Option<String>,
    pub operation_id: String,
    pub package_sha256: String,
    pub expected_image_id: String,
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

fn helper_payload() -> Result<String, String> {
    let mut compressor = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    compressor
        .write_all(HELPER)
        .map_err(|_| "无法编码更新助手".to_string())?;
    let compressed = compressor
        .finish()
        .map_err(|_| "无法编码更新助手".to_string())?;
    Ok(compressed.iter().map(|b| format!("{b:02x}")).collect())
}

/// 纯查询与预检只在内存执行随应用分发的可信源码，不安装或调和任务。
fn readonly_command(action: &str, operation: Option<&str>) -> Result<String, String> {
    let action = serde_json::to_string(action).map_err(|_| "无法编码只读命令")?;
    let operation = operation
        .map(|value| serde_json::to_string(value).unwrap())
        .unwrap_or("None".into());
    embedded_command(&format!("namespace['readonly_main']({action},{operation})"))
}

fn embedded_command(entry: &str) -> Result<String, String> {
    let payload = helper_payload()?;
    let source = format!(
        r#"import sys,zlib
if sys.version_info < (3,9):
    sys.exit('独立更新任务需要 Python 3.9 或更高版本')
namespace={{'__name__':'mskdsp_readonly','__file__':'<可信嵌入助手>'}}
exec(compile(zlib.decompress(bytes.fromhex('{payload}')),'<可信嵌入助手>','exec'),namespace)
sys.exit({entry})
"#
    );
    Ok(format!("exec python3 -B -c {}", shell_quote(&source)))
}

fn close_command(operation: &str, digest: &str, expected: &str) -> Result<String, String> {
    embedded_command(&format!(
        "namespace['close_main']({},{},{})",
        serde_json::to_string(operation).map_err(|_| "无法编码关闭任务编号")?,
        serde_json::to_string(digest).map_err(|_| "无法编码关闭任务摘要")?,
        serde_json::to_string(expected).map_err(|_| "无法编码关闭任务镜像")?
    ))
}

/// 按内容摘要命名并安装到 root 独占目录，禁止以 root 执行普通用户可写脚本。
fn helper_command(arguments: &[&str]) -> Result<String, String> {
    let digest = format!("{:x}", Sha256::digest(HELPER));
    let payload = helper_payload()?;
    let path = format!("/usr/local/libexec/mskdsp-update/lower_update_task-{digest}.py");
    let body = format!(
        r#"import os,stat,hashlib,tempfile,zlib,sys
if sys.version_info < (3,9): raise RuntimeError('独立更新任务需要 Python 3.9 或更高版本')
data=zlib.decompress(bytes.fromhex('{payload}'))
namespace={{'__name__':'mskdsp_bootstrap','__file__':'<可信嵌入助手>'}}
exec(compile(data,'<可信嵌入助手>','exec'),namespace)
namespace['preflight_environment']()
root='/usr/local/libexec/mskdsp-update'
for parent in ['/','/usr','/usr/local','/usr/local/libexec',root]:
    try: os.mkdir(parent,0o700)
    except FileExistsError: pass
    info=os.lstat(parent)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('更新助手目录不属于 root 独占目录: '+parent)
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
    // 仅此 bootstrap 失败可以证明从未执行持久任务助手；SSH 超时与断线不能标记拒绝。
    let bootstrap = format!("try:\n{}\nexcept Exception as error:\n    import sys\n    print('LOWER_UPDATE_TASK_REJECTED: '+str(error),file=sys.stderr)\n    sys.exit(1)\n",
        body.lines().map(|line| format!("    {line}")).collect::<Vec<_>>().join("\n"));
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

#[cfg(test)]
fn parse_status(value: &str, operation_id: &str) -> Result<LowerUpdateTaskStatus, String> {
    parse_status_observed(value, operation_id, None)
}

fn parse_status_observed(
    value: &str,
    operation_id: &str,
    observer: Option<&UpdateSshObserver>,
) -> Result<LowerUpdateTaskStatus, String> {
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
    // 完整秘密必须在裁剪前匹配，避免跨裁剪边界留下认证信息后缀。
    if let Some(observer) = observer {
        status.log_tail = observer.redact(&status.log_tail);
        status.message = observer.redact(&status.message);
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

fn task_observer(
    operation_id: &str,
    action: &str,
    remote: Option<&LowerUpdateRemoteTargetDto>,
    auth: &LowerUpdateSshAuthDto,
    sudo_password: &str,
) -> UpdateSshObserver {
    let password = match auth {
        LowerUpdateSshAuthDto::Password { password } => password.as_str(),
        _ => "",
    };
    UpdateSshObserver::new(
        operation_id,
        action,
        remote
            .map(|target| target.device_id.as_str())
            .unwrap_or("直连设备"),
        &[password, sudo_password],
    )
}

/// 时限覆盖目标解析和全部 SSH 等待；失败只结束本地观测，不改变宿主机任务。
async fn with_update_deadline<T>(
    observer: &UpdateSshObserver,
    budget: Duration,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let result = tokio::time::timeout(budget, future)
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "通信总时限 {} 秒已超时，结果暂时未知；保留原任务，请核验连接后查询，不要重新安装",
                budget.as_secs()
            ))
        });
    result.map_err(|error| observer.failure(&error))
}

async fn invoke_helper(
    state: &AppState,
    upload_account: &str,
    auth: &LowerUpdateSshAuthDto,
    sudo_password: &str,
    remote: Option<&LowerUpdateRemoteTargetDto>,
    recovery_direct_account: Option<&str>,
    operation_id: &str,
    arguments: &[&str],
) -> Result<LowerUpdateTaskStatus, String> {
    let query = arguments.first() == Some(&"query");
    let observer = task_observer(
        operation_id,
        if query {
            "更新任务查询"
        } else {
            "更新任务提交"
        },
        remote,
        auth,
        sudo_password,
    );
    with_update_deadline(
        &observer,
        if query { QUERY_TIMEOUT } else { SUBMIT_TIMEOUT },
        async {
            observer.stage("目标解析");
            let target = if query {
                resolve_recovery_target(
                    state,
                    upload_account,
                    remote,
                    auth,
                    recovery_direct_account,
                )
                .await?
            } else {
                if recovery_direct_account.is_some() {
                    return Err("普通更新提交不支持恢复直连地址".into());
                }
                resolve_update_target(state, upload_account, remote, auth).await?
            };
            observer.stage("命令编码");
            let command = if query {
                readonly_command("query", Some(operation_id))?
            } else {
                helper_command(arguments)?
            };
            let output = execute_root_ssh_command_observed(
                &target,
                auth,
                sudo_password,
                &command,
                &observer,
            )
            .await?;
            observer.stage("响应解析");
            if output.exit_code != Some(0) {
                let detail = observer
                    .redact(&output.stderr)
                    .chars()
                    .take(2048)
                    .collect::<String>();
                for marker in [
                    "LOWER_UPDATE_TASK_REJECTED:",
                    "LOWER_UPDATE_TASK_NOT_FOUND:",
                ] {
                    if let Some(start) = detail.find(marker) {
                        return Err(detail[start..].to_string());
                    }
                }
                return Err(format!(
                    "宿主机更新任务接口未确认成功，请查询原任务：{detail}"
                ));
            }
            let status = parse_status_observed(&output.stdout, operation_id, Some(&observer))?;
            observer.stage("观测完成");
            Ok(status)
        },
    )
    .await
}

#[tauri::command]
pub async fn preflight_lower_update_task(
    state: State<'_, AppState>,
    request: LowerUpdateRuntimeInfoRequestDto,
) -> Result<(), String> {
    let observer = task_observer(
        "",
        "更新环境预检",
        request.remote_target.as_ref(),
        &request.auth,
        &request.sudo_password,
    );
    with_update_deadline(&observer, PREFLIGHT_TIMEOUT, async {
        observer.stage("请求校验");
        if request.recovery_direct_account.is_some() {
            return Err(
                "更新上传前预检不支持恢复直连地址；该地址仅用于查询、运行镜像核验和结束原记录"
                    .into(),
            );
        }
        observer.stage("目标解析");
        let target = resolve_update_target(
            &state,
            &request.upload_account,
            request.remote_target.as_ref(),
            &request.auth,
        )
        .await?;
        observer.stage("命令编码");
        let command = readonly_command("preflight", None)?;
        let output = execute_root_ssh_command_observed(
            &target,
            &request.auth,
            &request.sudo_password,
            &command,
            &observer,
        )
        .await?;
        observer.stage("响应解析");
        if output.exit_code != Some(0) {
            let detail = observer
                .redact(&output.stderr)
                .chars()
                .take(2048)
                .collect::<String>();
            return Err(format!("更新环境预检失败，未上传安装包：{detail}"));
        }
        let response: serde_json::Value =
            serde_json::from_str(output.stdout.trim()).map_err(|_| "更新环境预检未返回有效确认")?;
        if response.get("ok").and_then(|value| value.as_bool()) != Some(true) {
            return Err("宿主机未确认更新环境预检通过".into());
        }
        observer.stage("观测完成");
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn close_lower_update_task(
    state: State<'_, AppState>,
    request: CloseLowerUpdateTaskRequest,
) -> Result<(), String> {
    let observer = task_observer(
        &request.operation_id,
        "结束更新记录",
        request.remote_target.as_ref(),
        &request.auth,
        &request.sudo_password,
    );
    with_update_deadline(&observer, CLOSE_TIMEOUT, async {
        observer.stage("请求校验");
        validate_operation_id(&request.operation_id)?;
        validate_digest(&request.package_sha256)?;
        let expected =
            normalize_image_id(&request.expected_image_id).ok_or("原任务期望镜像 ID 不合法")?;
        observer.stage("目标解析");
        let target = resolve_recovery_target(
            &state,
            &request.upload_account,
            request.remote_target.as_ref(),
            &request.auth,
            request.recovery_direct_account.as_deref(),
        )
        .await?;
        observer.stage("命令编码");
        let command = close_command(
            &request.operation_id,
            &request.package_sha256.to_ascii_lowercase(),
            &expected,
        )?;
        let output = execute_root_ssh_command_observed(
            &target,
            &request.auth,
            &request.sudo_password,
            &command,
            &observer,
        )
        .await?;
        observer.stage("响应解析");
        if output.exit_code != Some(0) {
            let detail = observer
                .redact(&output.stderr)
                .chars()
                .take(2048)
                .collect::<String>();
            return Err(format!("无法结束原任务，本地记录仍需保留：{detail}"));
        }
        let response: serde_json::Value = serde_json::from_str(output.stdout.trim())
            .map_err(|_| "关闭任务未返回有效确认，本地记录仍需保留")?;
        if response.get("ok").and_then(|value| value.as_bool()) != Some(true) {
            return Err("宿主机未确认原任务关闭，本地记录仍需保留".into());
        }
        observer.stage("观测完成");
        Ok(())
    })
    .await
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
        None,
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
        request.recovery_direct_account.as_deref(),
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

#[cfg(test)]
#[path = "lower_update_task_recovery_tests.rs"]
mod recovery_tests;
