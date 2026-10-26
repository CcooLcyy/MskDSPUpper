//! 独立配置固定 101/108 纵密维护通路，并由专属服务在重启后恢复。
use super::lower_update::{
    execute_root_ssh_command, parse_upload_account, shell_quote, LowerUpdateSshAuthDto,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::io::Write;
use std::time::Duration;
use zeroize::Zeroize;

const TARGET_IP: &str = "11.22.33.44";
const SCRIPT: &str = include_str!("security_access_path.sh");
const INSTALLER: &str = include_str!("security_access_path_install.sh");
const TIMEOUT: Duration = Duration::from_secs(60);
static APPLY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PHASES: [(&str, &str, &str); 6] = [
    (
        "preflight",
        "前置检查",
        "固定接口、地址、路由、权限与依赖检查完成",
    ),
    ("addresses", "维护地址", "101/108 口的固定维护地址已配置"),
    ("routes", "维护路由", "电脑网段与纵密目标的固定路由已配置"),
    (
        "forwarding",
        "转发与回程",
        "目标限定的转发、SNAT 与连接跟踪回程规则已配置",
    ),
    (
        "verification",
        "DSP 路由检查",
        "DSP 到目标的实际路由出口为 108 口；尚未验证电脑可达或纵密登录",
    ),
    (
        "persistence",
        "开机恢复",
        "独立维护脚本与开机恢复服务已安装、启用，并保留原服务运行状态",
    ),
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessPathRequest {
    pub upload_account: String,
    #[serde(deserialize_with = "deserialize_auth")]
    pub auth: LowerUpdateSshAuthDto,
    pub sudo_password: String,
}

fn deserialize_auth<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<LowerUpdateSshAuthDto, D::Error> {
    #[derive(Deserialize)]
    #[serde(tag = "method", rename_all = "lowercase", deny_unknown_fields)]
    enum StrictAuth {
        Password { password: String },
        Certificate,
    }
    Ok(match StrictAuth::deserialize(deserializer)? {
        StrictAuth::Password { password } => LowerUpdateSshAuthDto::Password { password },
        StrictAuth::Certificate => LowerUpdateSshAuthDto::Certificate,
    })
}

impl Drop for AccessPathRequest {
    fn drop(&mut self) {
        self.sudo_password.zeroize();
        if let LowerUpdateSshAuthDto::Password { password } = &mut self.auth {
            password.zeroize();
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AccessPathStep {
    id: &'static str,
    name: &'static str,
    state: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct AccessPathResult {
    target_ip: &'static str,
    applied: bool,
    exit_code: Option<i32>,
    message: String,
    steps: Vec<AccessPathStep>,
}

fn unavailable(message: &str) -> AccessPathResult {
    AccessPathResult {
        target_ip: TARGET_IP,
        applied: false,
        exit_code: None,
        message: message.into(),
        steps: PHASES
            .iter()
            .map(|(id, name, _)| AccessPathStep {
                id,
                name,
                state: "unsupported",
                message: "未取得该阶段的确认结果".into(),
            })
            .collect(),
    }
}

fn installer_script() -> String {
    INSTALLER.replace("\r\n", "\n").replace(
        "__MSKDSP_RUNTIME_PAYLOAD__",
        SCRIPT.replace("\r\n", "\n").trim_end_matches('\n'),
    )
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        result.push(TABLE[a >> 2] as char);
        result.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        result.push(if chunk.len() > 1 {
            TABLE[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            TABLE[c & 63] as char
        } else {
            '='
        });
    }
    result
}

fn command() -> Result<String, String> {
    // 前端不能传入脚本、接口、目标、端口或任意参数。
    // 复用现有 root SSH 辅助函数引用命令，并经标准输入传递 sudo 凭据。
    // 压缩后以 ASCII 传输，避免多层 SSH 引号和 Windows 命令长度限制。
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(installer_script().as_bytes())
        .map_err(|_| "准备固定维护脚本失败".to_string())?;
    let encoded = encode_base64(
        &encoder
            .finish()
            .map_err(|_| "准备固定维护脚本失败".to_string())?,
    );
    let bootstrap = format!(
        "set -euo pipefail; for tool in base64 gzip bash; do command -v \"$tool\" >/dev/null; done; printf '%s' '{encoded}' | base64 -d | gzip -d | bash --noprofile --norc -s"
    );
    Ok(format!(
        "bash --noprofile --norc -c {}",
        shell_quote(&bootstrap)
    ))
}

fn parse_result(exit_code: Option<u32>, output: &str) -> AccessPathResult {
    let mut states = ["unsupported"; PHASES.len()];
    let mut success_counts = [0; PHASES.len()];
    let mut result_count = 0;
    let mut has_failure = false;
    let mut success = false;
    let mut rollback = "unknown";
    // 仅解析固定阶段白名单，不返回原始输出、SSH/sudo 诊断或凭据。
    for line in output.lines() {
        let parts: Vec<_> = line.trim_end_matches('\r').split('|').collect();
        if parts.len() != 3 || parts[0] != "MSKDSP_PATH" {
            continue;
        }
        if let Some(index) = PHASES.iter().position(|(id, _, _)| *id == parts[1]) {
            if matches!(parts[2], "success" | "failed") {
                if parts[2] == "success" {
                    success_counts[index] += 1;
                }
                if parts[2] == "failed" {
                    has_failure = true;
                    states[index] = "failed";
                } else if states[index] != "failed" {
                    states[index] = "success";
                }
            }
        } else if parts[1] == "result" {
            result_count += 1;
            success = parts[2] == "success";
            if !success {
                has_failure = true;
            }
        } else if parts[1] == "rollback"
            && matches!(
                parts[2],
                "success" | "failed" | "unchanged" | "partial" | "retained"
            )
        {
            has_failure = true;
            rollback = match parts[2] {
                "success" => "success",
                "failed" => "failed",
                "partial" => "partial",
                "retained" => "retained",
                _ => "unchanged",
            };
        }
    }
    let applied = exit_code == Some(0)
        && success
        && !has_failure
        && result_count == 1
        && states.iter().all(|state| *state == "success")
        && success_counts.iter().all(|count| *count == 1);
    let message = if applied {
        "纵密维护通路与独立开机恢复已应用。请继续检查直连，再登录纵密；配置完成不代表纵密已经可达。"
    } else {
        match rollback {
            "unchanged" => "本次未开始修改网络或服务。请检查接口已启动、固定地址／路由冲突、权限、依赖及持久化目录。",
            "success" => "配置未完成，已尽力回退本次记录的变更；不能保证还原内核转发参数切换引发的所有副作用，请核对 DSP 当前网络。",
            "failed" => "配置未完成，且部分回退失败，DSP 可能保留部分配置；请检查当前网络后再重试。",
            "partial" => "配置未完成，已回退本次记录的维护变更；共享 IPv4 转发保留开启，不能保证恢复全部内核副作用，请核对 DSP 当前网络。",
            "retained" => "维护通路与开机恢复配置已更新，但事务文件清理失败，尚未确认完整完成；已保留当前配置，请核对 DSP 状态后重试。",
            _ => "未取得完整配置结果，DSP 可能已应用部分配置；不能确认远端操作已经停止，请检查当前网络。",
        }
    };
    AccessPathResult {
        target_ip: TARGET_IP,
        applied,
        exit_code: exit_code.and_then(|code| i32::try_from(code).ok()),
        message: message.into(),
        steps: PHASES
            .iter()
            .enumerate()
            .map(|(index, (id, name, description))| AccessPathStep {
                id,
                name,
                state: states[index],
                message: match states[index] {
                    "success" if applied => (*description).into(),
                    "success" => {
                        "该阶段曾执行完成；后续失败，已尝试回退本次变更，请以当前网络为准".into()
                    }
                    "failed" => "该阶段失败；请结合总体结果核对当前网络".into(),
                    _ => "未取得该阶段的确认结果".into(),
                },
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn configure_vertical_security_access_path(
    request: AccessPathRequest,
) -> Result<AccessPathResult, String> {
    let target = parse_upload_account(&request.upload_account)?;
    let command = command()?;
    let Ok(_guard) = APPLY_LOCK.try_lock() else {
        return Ok(unavailable(
            "已有纵密维护通路配置正在执行，请等待其返回结果",
        ));
    };
    tracing::info!(
        operation = "vertical_security_access_path",
        phase = "start",
        "开始配置纵密维护通路与开机恢复"
    );
    let result = tokio::time::timeout(
        TIMEOUT,
        execute_root_ssh_command(&target, &request.auth, &request.sudo_password, &command),
    )
    .await;
    let result = match result {
        Ok(Ok(output)) => parse_result(output.exit_code, &output.stdout),
        Ok(Err(_)) => unavailable("SSH 或 sudo 执行未成功返回，未确认远端操作是否开始或停止，DSP 可能保留部分配置；请核对连接凭据与当前网络"),
        Err(_) => unavailable("等待配置结果超时；这不代表远端操作已停止或撤销，DSP 可能已应用部分配置。请核对当前网络后再重试"),
    };
    tracing::info!(
        operation = "vertical_security_access_path",
        phase = "finish",
        applied = result.applied,
        exit_code = ?result.exit_code,
        "纵密维护通路配置请求结束"
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_request() -> serde_json::Value {
        json!({"upload_account":"fixture@192.0.2.5:22", "auth":{"method":"password","password":"fixture"}, "sudo_password":"fixture"})
    }

    #[test]
    fn request_rejects_arbitrary_scope_and_unknown_auth() {
        assert!(serde_json::from_value::<AccessPathRequest>(valid_request()).is_ok());
        for field in ["script", "target_ip", "port", "interface", "remote_target"] {
            let mut value = valid_request();
            value[field] = json!("forbidden");
            assert!(
                serde_json::from_value::<AccessPathRequest>(value).is_err(),
                "{field}"
            );
        }
        let mut value = valid_request();
        value["auth"]["command"] = json!("forbidden");
        assert!(serde_json::from_value::<AccessPathRequest>(value).is_err());
    }

    #[test]
    fn successful_result_requires_exit_code_and_every_fixed_phase() {
        let stages = PHASES
            .iter()
            .map(|(id, _, _)| format!("MSKDSP_PATH|{id}|success\n"))
            .collect::<String>();
        let complete = format!("{stages}MSKDSP_PATH|result|success\n");
        assert!(parse_result(Some(0), &complete).applied);
        assert!(!parse_result(Some(1), &complete).applied);
        assert!(!parse_result(None, &complete).applied);
        assert!(!parse_result(Some(0), "MSKDSP_PATH|result|success").applied);
        assert!(!parse_result(Some(0), &stages).applied);
    }

    #[test]
    fn arbitrary_remote_output_and_secrets_are_not_returned() {
        let value = parse_result(Some(1), "fixture-secret\nMSKDSP_PATH|preflight|failed\nMSKDSP_PATH|rollback|unchanged\nMSKDSP_PATH|unknown|fixture-secret\n");
        let output = serde_json::to_string(&value).unwrap();
        assert!(!output.contains("fixture-secret"));
        assert!(!value.applied);
        assert_eq!(value.steps[0].state, "failed");
        assert!(value.message.contains("未开始修改"));
    }

    #[test]
    fn partial_failure_and_timeout_are_not_claimed_stopped() {
        let partial = parse_result(
            Some(1),
            "MSKDSP_PATH|rollback|failed\nMSKDSP_PATH|result|failed\n",
        );
        assert!(partial.message.contains("部分回退失败"));
        let missing = parse_result(None, "");
        assert!(missing.message.contains("不能确认远端操作已经停止"));
        assert!(!missing.applied);
    }

    #[test]
    fn command_only_contains_reviewed_fixed_script_with_independent_persistence() {
        let command = command().unwrap();
        assert!(command.starts_with("bash --noprofile --norc -c '"));
        assert!(command.is_ascii());
        assert!(command.len() < 20_000);
        assert!(command.contains("pipefail"));
        assert!(command.contains("base64 -d | gzip -d | bash --noprofile --norc -s"));
        for forbidden in [
            "eth0.107",
            "ppp0",
            "DNAT",
            "systemctl",
            "ip address flush",
            "iptables -F",
            " route replace",
            " route add default",
            "--dport",
            "--sport",
            "-m comment",
        ] {
            assert!(!SCRIPT.contains(forbidden), "{forbidden}");
        }
        assert!(SCRIPT.contains("-s 11.22.33.0/24 -d 11.22.33.44/32"));
        assert!(SCRIPT.contains("--ctstate ESTABLISHED,RELATED"));
        assert!(
            SCRIPT.find("emit preflight success").unwrap() < SCRIPT.find("ip address add").unwrap()
        );
        let installer = installer_script();
        assert!(!installer.contains("__MSKDSP_RUNTIME_PAYLOAD__"));
        assert!(installer.contains("systemctl enable"));
        assert!(!installer.contains("systemctl restart"));
        assert!(!installer.contains("systemctl stop"));
        assert!(!SCRIPT.contains("net.ipv4.ip_forward=0"));
        assert!(installer.contains("emit persistence success"));
    }

    #[test]
    fn missing_or_duplicate_persistence_cannot_report_applied() {
        let stages = PHASES
            .iter()
            .map(|(id, _, _)| format!("MSKDSP_PATH|{id}|success\n"))
            .collect::<String>();
        let complete = format!("{stages}MSKDSP_PATH|result|success\n");
        let missing = complete.replace("MSKDSP_PATH|persistence|success\n", "");
        assert!(!parse_result(Some(0), &missing).applied);
        assert!(
            !parse_result(
                Some(0),
                &format!("MSKDSP_PATH|persistence|success\n{complete}")
            )
            .applied
        );
        assert!(!parse_result(Some(0), &format!("{complete}MSKDSP_PATH|result|success\n")).applied);
        let failed_then_success = format!("MSKDSP_PATH|persistence|failed\n{complete}");
        assert!(!parse_result(Some(0), &failed_then_success).applied);
        assert_eq!(
            parse_result(Some(0), &failed_then_success).steps[5].state,
            "failed"
        );
        let partial = parse_result(Some(1), "MSKDSP_PATH|persistence|failed\nMSKDSP_PATH|rollback|partial\nMSKDSP_PATH|result|failed\n");
        assert!(partial.message.contains("共享 IPv4 转发保留开启"));
    }

    #[test]
    fn fixed_script_transport_handles_base64_padding() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode_base64(input.as_bytes()), expected);
        }
    }
}
