//! 纵密访问检查只读本机网络并探测固定目标，不创建网络通道。
use serde::{Deserialize, Serialize};

const TARGET_IP: &str = "11.22.33.44";
const REMOTE_REASON: &str =
    "远程网络通道待接入，请等待后续网络通道方案；平台在线或 SSH 可达不代表纵密可访问";

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    Direct,
    Remote,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRequest {
    pub mode: AccessMode,
    pub device_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AccessCapabilities {
    pub remote_ip_available: bool,
    pub remote_ip_reason: &'static str,
}

#[derive(Debug, Serialize)]
pub struct AccessStep {
    id: &'static str,
    name: &'static str,
    state: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct AccessResult {
    mode: AccessMode,
    target_ip: &'static str,
    device_id: Option<String>,
    state: &'static str,
    session_id: Option<String>,
    steps: Vec<AccessStep>,
}

#[derive(Debug, Deserialize)]
struct InterfaceAddress {
    address: String,
    prefix_length: u8,
    interface_index: u32,
    up: bool,
}

#[derive(Debug, Deserialize)]
struct NetworkSnapshot {
    addresses: Vec<InterfaceAddress>,
    route_interface_index: Option<u32>,
    route_source_address: Option<String>,
    ping_success: bool,
}

fn step(id: &'static str, name: &'static str, state: &'static str, message: &str) -> AccessStep {
    AccessStep {
        id,
        name,
        state,
        message: message.into(),
    }
}

fn usable_address(address: &InterfaceAddress) -> bool {
    let Ok(ip) = address.address.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let octets = ip.octets();
    address.up
        && address.prefix_length == 24
        && octets[..3] == [11, 22, 33]
        && ![0, 1, 2, 44, 255].contains(&octets[3])
}

fn evaluate_snapshot(snapshot: NetworkSnapshot) -> AccessResult {
    let network_ok = snapshot.addresses.iter().any(usable_address);
    let route_ok = snapshot.addresses.iter().any(|address| {
        usable_address(address)
            && Some(address.interface_index) == snapshot.route_interface_index
            && Some(address.address.as_str()) == snapshot.route_source_address.as_deref()
    });
    let response_ok = network_ok && route_ok && snapshot.ping_success;
    AccessResult {
        mode: AccessMode::Direct,
        target_ip: TARGET_IP,
        device_id: None,
        state: if response_ok { "ready" } else { "failed" },
        session_id: None,
        steps: vec![
            step(
                "computer-network",
                "电脑网络",
                if network_ok { "success" } else { "failed" },
                if network_ok {
                    "存在已启用且地址可用的 11.22.33.0/24 网卡，请确认网线连接 DSP 101 口"
                } else {
                    "需要已启用的 11.22.33.0/24 网卡，电脑地址不可使用 .0、.1、.2、.44 或 .255"
                },
            ),
            step(
                "target-route",
                "纵密访问路径",
                if !network_ok {
                    "unsupported"
                } else if route_ok {
                    "success"
                } else {
                    "failed"
                },
                if !network_ok {
                    "电脑网络未通过，未继续判定目标路由"
                } else if route_ok {
                    "固定目标的最佳路由和源地址均匹配维护网卡；该检查不能确认 DSP 内部 108 口状态"
                } else {
                    "固定目标的最佳路由或源地址未匹配维护网卡，请检查本机路由冲突"
                },
            ),
            step(
                "round-trip",
                "往返连接",
                if !network_ok || !route_ok {
                    "unsupported"
                } else if response_ok {
                    "success"
                } else {
                    "failed"
                },
                if !network_ok || !route_ok {
                    "前置检查未通过，未执行目标 ICMP 检查"
                } else if response_ok {
                    "固定目标响应本次 ICMP 检查；不代表所有协议、端口或专用配置软件均已联调"
                } else {
                    "固定目标未响应本次 ICMP 检查；不能据此认定业务不可用，目标可能禁用 ICMP"
                },
            ),
        ],
    }
}

fn unavailable_result(
    mode: AccessMode,
    device_id: Option<String>,
    state: &'static str,
    reason: &str,
) -> AccessResult {
    AccessResult {
        mode,
        target_ip: TARGET_IP,
        device_id,
        state,
        session_id: None,
        steps: vec![
            step("computer-network", "电脑网络", state, reason),
            step("target-route", "纵密访问路径", "unsupported", reason),
            step("round-trip", "往返连接", "unsupported", reason),
        ],
    }
}

#[tauri::command]
pub fn get_vertical_security_access_capabilities() -> AccessCapabilities {
    AccessCapabilities {
        remote_ip_available: false,
        remote_ip_reason: REMOTE_REASON,
    }
}

#[tauri::command]
pub async fn check_vertical_security_access(
    request: AccessRequest,
) -> Result<AccessResult, String> {
    if matches!(request.mode, AccessMode::Remote) {
        tracing::info!("纵密远程访问检查：网络通道尚未接入");
        return Ok(unavailable_result(
            request.mode,
            request.device_id,
            "unsupported",
            REMOTE_REASON,
        ));
    }
    tracing::info!("开始纵密直连只读检查，目标固定为 11.22.33.44");
    #[cfg(windows)]
    {
        match read_windows_snapshot().await {
            Ok(snapshot) => {
                let result = evaluate_snapshot(snapshot);
                tracing::info!(state = result.state, "纵密直连检查完成");
                Ok(result)
            }
            Err(reason) => {
                tracing::warn!("纵密直连检查未完成：{}", reason);
                Ok(unavailable_result(
                    AccessMode::Direct,
                    None,
                    "failed",
                    &reason,
                ))
            }
        }
    }
    #[cfg(not(windows))]
    {
        Ok(unavailable_result(
            AccessMode::Direct,
            None,
            "unsupported",
            "当前系统不支持本机直连检查，请使用 Windows 桌面上位机",
        ))
    }
}

#[cfg(windows)]
async fn read_windows_snapshot() -> Result<NetworkSnapshot, String> {
    use std::{process::Stdio, time::Duration};
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("security_access_probe.ps1"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(12), command.output())
        .await
        .map_err(|_| "本机网络检查超时，子进程已取消".to_string())?
        .map_err(|_| "无法运行 Windows 本机网络检查".to_string())?;
    if !output.status.success() {
        return Err("无法读取本机网络快照，请检查 Windows 网络查询组件".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "本机网络检查返回格式不正确".into())
}

#[tauri::command]
pub async fn close_vertical_security_access(session_id: String) -> Result<(), String> {
    tracing::warn!("纵密访问清理请求被拒绝：当前未创建持久网络通道");
    if session_id.trim().is_empty() {
        return Err("会话标识不能为空".into());
    }
    Err("未知纵密访问会话；本轮未创建需要清理的网络通道".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(
        address: &str,
        prefix: u8,
        up: bool,
        route_index: u32,
        ping: bool,
    ) -> NetworkSnapshot {
        serde_json::from_value(serde_json::json!({
            "addresses": [{"address": address, "prefix_length": prefix, "interface_index": 7, "up": up}],
            "route_interface_index": route_index,
            "route_source_address": address,
            "ping_success": ping
        })).unwrap()
    }

    #[test]
    fn security_access_valid_direct_response_is_qualified() {
        let result = evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, true));
        assert_eq!(result.state, "ready");
        assert!(result.session_id.is_none());
        assert!(result.steps[2].message.contains("不代表所有协议"));
    }

    #[test]
    fn security_access_reserved_or_wrong_network_is_rejected() {
        for address in [
            "11.22.33.0",
            "11.22.33.1",
            "11.22.33.2",
            "11.22.33.44",
            "11.22.33.255",
            "192.168.1.41",
        ] {
            assert_eq!(
                evaluate_snapshot(snapshot(address, 24, true, 7, true)).steps[0].state,
                "failed",
                "{address}"
            );
        }
        assert_eq!(
            evaluate_snapshot(snapshot("11.22.33.41", 16, true, 7, true)).state,
            "failed"
        );
        assert_eq!(
            evaluate_snapshot(snapshot("11.22.33.41", 24, false, 7, true)).state,
            "failed"
        );
    }

    #[test]
    fn security_access_wrong_route_is_rejected_even_with_ping_response() {
        let result = evaluate_snapshot(snapshot("11.22.33.41", 24, true, 9, true));
        assert_eq!(result.state, "failed");
        assert_eq!(result.steps[1].state, "failed");
        assert_eq!(result.steps[2].state, "unsupported");
    }

    #[test]
    fn security_access_wrong_selected_source_is_rejected() {
        let mut input = snapshot("11.22.33.41", 24, true, 7, true);
        input.route_source_address = Some("192.168.1.41".into());
        assert_eq!(evaluate_snapshot(input).steps[1].state, "failed");
    }

    #[test]
    fn security_access_missing_route_or_network_never_reports_ready() {
        let mut input = snapshot("11.22.33.41", 24, true, 7, true);
        input.route_interface_index = None;
        input.route_source_address = None;
        assert_eq!(evaluate_snapshot(input).steps[1].state, "failed");
        let mut input = snapshot("11.22.33.41", 24, true, 7, true);
        input.addresses.clear();
        assert_eq!(evaluate_snapshot(input).steps[0].state, "failed");
    }

    #[test]
    fn security_access_ping_failure_does_not_claim_all_business_unavailable() {
        let result = evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, false));
        assert_eq!(result.state, "failed");
        assert!(result.steps[2].message.contains("不能据此认定业务不可用"));
    }

    #[tokio::test]
    async fn security_access_remote_has_no_session_or_success() {
        let result = check_vertical_security_access(AccessRequest {
            mode: AccessMode::Remote,
            device_id: Some("device-1".into()),
        })
        .await
        .unwrap();
        assert_eq!(result.state, "unsupported");
        assert_eq!(result.device_id.as_deref(), Some("device-1"));
        assert!(result.session_id.is_none());
        assert!(result.steps.iter().all(|step| step.state == "unsupported"));
        assert!(!get_vertical_security_access_capabilities().remote_ip_available);
        assert!(close_vertical_security_access("unknown".into())
            .await
            .is_err());
    }

    #[test]
    fn security_access_request_does_not_allow_target_or_commands() {
        for extra in ["target_ip", "port", "command"] {
            let input = serde_json::json!({"mode":"direct", (extra):"arbitrary"});
            assert!(serde_json::from_value::<AccessRequest>(input).is_err());
        }
    }
}
