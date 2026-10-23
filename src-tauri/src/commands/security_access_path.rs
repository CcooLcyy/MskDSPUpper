//! 仅应用固定的 101/108 纵密维护通路，当前运行态有效。
use super::lower_update::{
    execute_root_ssh_command, parse_upload_account, shell_quote, LowerUpdateSshAuthDto,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::time::Duration;
use zeroize::Zeroize;

const TARGET_IP: &str = "11.22.33.44";
const SCRIPT: &str = include_str!("security_access_path.sh");
const TIMEOUT: Duration = Duration::from_secs(60);
static APPLY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PHASES: [(&str, &str, &str); 5] = [
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

fn command() -> String {
    // 前端不能传入脚本、接口、目标、端口或任意参数。
    // 复用现有 root SSH 辅助函数引用命令，并经标准输入传递 sudo 凭据。
    format!(
        "bash --noprofile --norc -c {}",
        shell_quote(&SCRIPT.replace("\r\n", "\n"))
    )
}

fn parse_result(exit_code: Option<u32>, output: &str) -> AccessPathResult {
    let mut states = ["unsupported"; 5];
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
                states[index] = if parts[2] == "success" {
                    "success"
                } else {
                    "failed"
                };
            }
        } else if parts[1] == "result" {
            success = parts[2] == "success";
        } else if parts[1] == "rollback" && matches!(parts[2], "success" | "failed" | "unchanged") {
            rollback = match parts[2] {
                "success" => "success",
                "failed" => "failed",
                _ => "unchanged",
            };
        }
    }
    let applied = exit_code == Some(0) && success && states.iter().all(|state| *state == "success");
    let message = if applied {
        "纵密维护通路已应用，仅当前运行态有效；重启后需重新应用。请继续检查直连，再登录纵密；配置完成不代表纵密已经可达。"
    } else {
        match rollback {
            "unchanged" => "前置检查未通过，本次未开始修改网络。请检查接口已启动、固定地址／路由冲突、权限及依赖。",
            "success" => "配置未完成，已尽力回退本次记录的变更；不能保证还原内核转发参数切换引发的所有副作用，请核对 DSP 当前网络。",
            "failed" => "配置未完成，且部分回退失败，DSP 可能保留部分配置；请检查当前网络后再重试。",
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
    let Ok(_guard) = APPLY_LOCK.try_lock() else {
        return Ok(unavailable(
            "已有纵密维护通路配置正在执行，请等待其返回结果",
        ));
    };
    let result = tokio::time::timeout(
        TIMEOUT,
        execute_root_ssh_command(&target, &request.auth, &request.sudo_password, &command()),
    )
    .await;
    Ok(match result {
        Ok(Ok(output)) => parse_result(output.exit_code, &output.stdout),
        Ok(Err(_)) => unavailable("SSH 或 sudo 执行未成功返回，未确认远端操作是否开始或停止，DSP 可能保留部分配置；请核对连接凭据与当前网络"),
        Err(_) => unavailable("等待配置结果超时；这不代表远端操作已停止或撤销，DSP 可能已应用部分配置。请核对当前网络后再重试"),
    })
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
    fn command_only_contains_reviewed_fixed_script_without_persistence() {
        assert!(command().starts_with("bash --noprofile --norc -c '"));
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
    }
}
