//! 纵密访问检查探测固定目标；远程通道仅供内部探测并在结束时释放。
use super::security_login::{
    probe_management_connection, probe_management_connection_via, ManagementError,
    SecurityLoginManager,
};
use crate::remote_access::{self, RemoteConnection, RemoteDevice};
use crate::state::AppState;
use serde::{Deserialize, Serialize};

const TARGET_IP: &str = "11.22.33.44";
const REMOTE_REASON: &str = "通过平台探测所选DSP的纵密管理服务；平台在线不代表纵密可达";

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
    checked_at_ms: u64,
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
        state: "failed",
        session_id: None,
        checked_at_ms: checked_at_ms(),
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
                "ICMP 往返响应",
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
            step(
                "management-tcp",
                "管理端口 TCP 8888",
                "unsupported",
                "尚未检查管理端口",
            ),
            step(
                "management-tls",
                "管理连接 TLS",
                "unsupported",
                "尚未检查证书握手",
            ),
        ],
    }
}

fn checked_at_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn apply_management_result(
    mut result: AccessResult,
    outcome: Result<(), ManagementError>,
) -> AccessResult {
    match outcome {
        Ok(()) => {
            result.state = "ready";
            result.steps[3] = step(
                "management-tcp",
                "管理端口 TCP 8888",
                "success",
                "纵密管理端口接受连接",
            );
            result.steps[4] = step(
                "management-tls",
                "管理连接 TLS",
                "success",
                "已按当前登录证书配置完成 TLS 握手，未发送账号，探测连接已释放",
            );
        }
        Err(error) => {
            tracing::warn!(
                code = error.code,
                tcp_connected = error.tcp_connected,
                "纵密管理连接检查失败，未发送账号"
            );
            if error.tcp_connected {
                result.steps[3] = step(
                    "management-tcp",
                    "管理端口 TCP 8888",
                    "success",
                    "纵密管理端口接受连接",
                );
            }
            let index = if error.step_index == 0 { 3 } else { 4 };
            let name = if index == 3 {
                "管理端口 TCP 8888"
            } else {
                "管理连接 TLS"
            };
            result.steps[index] = step(
                if index == 3 {
                    "management-tcp"
                } else {
                    "management-tls"
                },
                name,
                "failed",
                &error.message,
            );
        }
    }
    result.checked_at_ms = checked_at_ms();
    result
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
        checked_at_ms: checked_at_ms(),
        steps: vec![
            step("computer-network", "电脑网络", state, reason),
            step("target-route", "纵密访问路径", "unsupported", reason),
            step("round-trip", "ICMP 往返响应", "unsupported", reason),
            step("management-tcp", "管理端口 TCP 8888", "unsupported", reason),
            step("management-tls", "管理连接 TLS", "unsupported", reason),
        ],
    }
}

#[tauri::command]
pub fn get_vertical_security_access_capabilities() -> AccessCapabilities {
    AccessCapabilities {
        remote_ip_available: true,
        remote_ip_reason: REMOTE_REASON,
    }
}

#[tauri::command]
pub async fn check_vertical_security_access(
    state: tauri::State<'_, AppState>,
    request: AccessRequest,
) -> Result<AccessResult, String> {
    if matches!(request.mode, AccessMode::Remote) {
        return Ok(check_remote_access(&state, request.device_id).await);
    }
    check_access(&state.security_login, request).await
}

fn validate_remote_device(device: &RemoteDevice) -> Result<(), &'static str> {
    if !device.online {
        return Err("所选DSP当前离线");
    }
    if !device.allow_ssh {
        return Err("所选DSP未授权SSH维护访问");
    }
    if !device
        .services
        .iter()
        .any(|service| service == "vertical-security")
    {
        return Err("所选DSP未提供纵密管理服务，请检查下位机版本和平台维护能力配置");
    }
    Ok(())
}

fn remote_result(device_id: Option<String>) -> AccessResult {
    AccessResult {
        mode: AccessMode::Remote,
        target_ip: TARGET_IP,
        device_id,
        state: "failed",
        session_id: None,
        checked_at_ms: checked_at_ms(),
        steps: vec![
            step(
                "platform-device",
                "平台设备",
                "success",
                "所选DSP已在线并获维护服务授权",
            ),
            step(
                "remote-channel",
                "远程管理通道",
                "unsupported",
                "尚未取得下位机固定目标连接就绪确认",
            ),
            step(
                "management-tcp",
                "管理端口 TCP 8888",
                "unsupported",
                "尚未检查管理端口",
            ),
            step(
                "management-tls",
                "管理连接 TLS",
                "unsupported",
                "尚未检查证书握手",
            ),
        ],
    }
}

fn remote_management_result(
    mut result: AccessResult,
    outcome: Result<(), ManagementError>,
) -> AccessResult {
    let tcp_connected = outcome
        .as_ref()
        .map_or_else(|error| error.tcp_connected, |_| true);
    if tcp_connected {
        result.steps[1] = step(
            "remote-channel",
            "远程管理通道",
            "success",
            "平台及下位机已确认固定纵密目标TCP连接就绪",
        );
        result.steps[2] = step(
            "management-tcp",
            "管理端口 TCP 8888",
            "success",
            "纵密管理端口接受连接",
        );
    }
    match outcome {
        Ok(()) => {
            result.state = "ready";
            result.steps[3] = step(
                "management-tls",
                "管理连接 TLS",
                "success",
                "已完成证书握手；未发送账号，探测连接已释放",
            );
        }
        Err(error) => {
            tracing::warn!(
                code = error.code,
                tcp_connected,
                "纵密远程管理连接检查失败，未发送账号"
            );
            if error.step_index == 1 {
                result.steps[3] = step("management-tls", "管理连接 TLS", "failed", &error.message);
            } else {
                result.steps[1] = step("remote-channel", "远程管理通道", "failed", "远程通道未取得固定目标TCP就绪确认，请检查平台连接、授权及DSP到纵密管理端口的访问");
            }
        }
    }
    result.checked_at_ms = checked_at_ms();
    result
}

fn prepare_remote_connection(
    auth: std::sync::Arc<crate::platform_auth::PlatformAuthManager>,
    endpoint: &str,
    generation: u64,
    device: RemoteDevice,
) -> Result<std::sync::Arc<RemoteConnection>, &'static str> {
    if !auth.remote_generation_valid(generation) {
        return Err("平台登录已切换，请刷新所选设备后重新检查");
    }
    let connection =
        RemoteConnection::new(device, auth.clone()).map_err(|_| "平台登录已失效，请重新登录")?;
    if connection.endpoint != endpoint || !auth.remote_generation_valid(generation) {
        connection.cancel();
        return Err("平台登录已切换，请刷新所选设备后重新检查");
    }
    Ok(connection)
}

async fn check_remote_access(state: &AppState, device_id: Option<String>) -> AccessResult {
    let mut result = remote_result(device_id.clone());
    let preparation = async {
        let (endpoint, _, generation) = state
            .platform_auth
            .remote_credentials()
            .map_err(|_| "平台登录已失效，请重新登录")?;
        let id = device_id
            .as_deref()
            .filter(|id| !id.trim().is_empty() && id.len() <= 256)
            .ok_or("请选择平台DSP设备")?;
        let device = remote_access::list_devices(&state.platform_auth)
            .await
            .map_err(|_| "无法读取当前平台设备及授权，请检查平台登录和网络")?
            .into_iter()
            .find(|device| device.device_id == id)
            .ok_or("所选DSP不可访问或已撤权")?;
        validate_remote_device(&device)?;
        prepare_remote_connection(state.platform_auth.clone(), &endpoint, generation, device)
    }
    .await;
    let connection = match preparation {
        Ok(connection) => connection,
        Err(message) => {
            result.steps[0] = step("platform-device", "平台设备", "failed", message);
            tracing::warn!(reason = message, "纵密远程设备前置检查失败");
            return result;
        }
    };
    // 包括请求取消和未来分支在内，均主动清理内部探测连接。
    struct ProbeGuard(std::sync::Arc<RemoteConnection>);
    impl Drop for ProbeGuard {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }
    let _guard = ProbeGuard(connection.clone());
    tracing::info!(
        device_id = connection.device.device_id,
        "开始纵密远程只读检查"
    );
    let outcome = tokio::select! {
        biased;
        _ = remote_access::wait_canceled(connection.subscribe()) => {
            result.steps[0] = step("platform-device", "平台设备", "failed", "平台登录或远程连接已改变，请重新检查");
            return result;
        }
        outcome = probe_management_connection_via(&state.security_login, Some(&connection)) => outcome,
    };
    if !connection.active() {
        result.steps[0] = step(
            "platform-device",
            "平台设备",
            "failed",
            "平台登录或远程连接已改变，请重新检查",
        );
        return result;
    }
    remote_management_result(result, outcome)
}

async fn check_access(
    _manager: &SecurityLoginManager,
    request: AccessRequest,
) -> Result<AccessResult, String> {
    if matches!(request.mode, AccessMode::Remote) {
        tracing::warn!("纵密远程检查必须提供平台状态");
        return Ok(unavailable_result(
            request.mode,
            request.device_id,
            "unsupported",
            "远程检查需要当前平台登录状态",
        ));
    }
    tracing::info!("开始纵密直连只读检查，目标固定为 11.22.33.44");
    #[cfg(windows)]
    {
        match read_windows_snapshot().await {
            Ok(snapshot) => {
                let mut result = evaluate_snapshot(snapshot);
                if result.steps[..2].iter().all(|step| step.state == "success") {
                    result = apply_management_result(
                        result,
                        probe_management_connection(_manager).await,
                    );
                }
                result.checked_at_ms = checked_at_ms();
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

    // 列表请求期间退出平台后，迟到的同名设备记录不能创建新平台连接。
    #[tokio::test]
    async fn security_access_remote_stale_device_list_cannot_cross_platform_generation() {
        let auth = std::sync::Arc::new(crate::platform_auth::PlatformAuthManager::test_session(
            "http://127.0.0.1:1".into(),
        ));
        let (endpoint, _, generation) = auth.remote_credentials().unwrap();
        let device = RemoteDevice {
            device_id: "same-id".into(),
            display_name: "旧平台设备".into(),
            online: true,
            allow_grpc: true,
            allow_ssh: true,
            services: vec!["vertical-security".into()],
            agent_version: "test".into(),
        };
        assert!(prepare_remote_connection(
            auth.clone(),
            "http://127.0.0.1:2",
            generation,
            device.clone()
        )
        .is_err());
        auth.logout().await.unwrap();
        assert!(prepare_remote_connection(auth, &endpoint, generation, device).is_err());
    }

    // 远程检测必须同时具有在线设备、SSH维护权限和专用服务。
    #[test]
    fn security_access_remote_requires_fixed_service_and_maintenance_permission() {
        let mut device = crate::remote_access::RemoteDevice {
            device_id: "field".into(),
            display_name: "现场".into(),
            online: true,
            allow_grpc: true,
            allow_ssh: true,
            services: vec!["vertical-security".into()],
            agent_version: "test".into(),
        };
        assert!(validate_remote_device(&device).is_ok());
        device.allow_ssh = false;
        assert!(validate_remote_device(&device).is_err());
        device.allow_ssh = true;
        device.services = vec!["ssh".into()];
        assert!(validate_remote_device(&device).is_err());
        device.services.push("vertical-security".into());
        device.online = false;
        assert!(validate_remote_device(&device).is_err());
    }

    // TLS失败只有在远端实际TCP已就绪时才可报告远程通道与端口通过。
    #[test]
    fn security_access_remote_tls_failure_keeps_real_tcp_evidence() {
        let result = remote_management_result(
            remote_result(Some("field".into())),
            Err(ManagementError {
                tcp_connected: true,
                step_index: 1,
                code: "tls_timeout",
                message: "证书握手超时".into(),
            }),
        );
        assert_eq!(result.steps[1].state, "success");
        assert_eq!(result.steps[2].state, "success");
        assert_eq!(result.steps[3].state, "failed");
        assert_eq!(result.state, "failed");
        assert!(result.session_id.is_none());
    }

    // ping 成功只代表网络诊断通过，不能独立判定管理连接可用。
    #[test]
    fn security_access_ping_alone_never_reports_ready() {
        let result = evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, true));
        assert_ne!(result.state, "ready");
    }

    // 管理端口拒绝与超时均不得因为 ping 成功误报可用。
    #[test]
    fn security_access_tcp_failure_blocks_success_and_skips_tls() {
        for message in ["纵密管理端口 8888 拒绝连接", "连接纵密管理服务超时"] {
            let result = apply_management_result(
                evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, true)),
                Err(ManagementError {
                    tcp_connected: false,
                    step_index: 0,
                    code: "connection_failed",
                    message: message.into(),
                }),
            );
            assert_eq!(result.state, "failed");
            assert_eq!(result.steps[3].state, "failed");
            assert_eq!(result.steps[3].message, message);
            assert_eq!(result.steps[4].state, "unsupported");
            assert!(result.checked_at_ms > 0);
            assert!(result.session_id.is_none());
        }
    }

    // TLS 错误保留已验证的 TCP 成功，整体仍失败。
    #[test]
    fn security_access_tls_failure_keeps_tcp_diagnostic() {
        let result = apply_management_result(
            evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, true)),
            Err(ManagementError {
                tcp_connected: true,
                step_index: 1,
                code: "tls_timeout",
                message: "等待纵密证书握手超时".into(),
            }),
        );
        assert_eq!(result.state, "failed");
        assert_eq!(result.steps[3].state, "success");
        assert_eq!(result.steps[4].state, "failed");
        assert!(result.steps[4].message.contains("超时"));
    }

    // ICMP 可被装置禁用，TCP 与 TLS 成功才是管理连接的通过依据。
    #[test]
    fn security_access_tls_success_can_override_icmp_failure() {
        let result = apply_management_result(
            evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, false)),
            Ok(()),
        );
        assert_eq!(result.state, "ready");
        assert_eq!(result.steps[2].state, "failed");
        assert_eq!(result.steps[3].state, "success");
        assert_eq!(result.steps[4].state, "success");
        assert!(result.session_id.is_none());
    }

    // 证书配置前置失败时不能声称已经探测过 TCP。
    #[test]
    fn security_access_profile_failure_does_not_claim_tcp_success() {
        let result = apply_management_result(
            evaluate_snapshot(snapshot("11.22.33.41", 24, true, 7, true)),
            Err(ManagementError {
                tcp_connected: false,
                step_index: 1,
                code: "certificate_expired",
                message: "证书已过期".into(),
            }),
        );
        assert_eq!(result.state, "failed");
        assert_eq!(result.steps[3].state, "unsupported");
        assert_eq!(result.steps[4].state, "failed");
    }

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
        assert_eq!(result.state, "failed");
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
        let result = check_access(
            &SecurityLoginManager::default(),
            AccessRequest {
                mode: AccessMode::Remote,
                device_id: Some("device-1".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, "unsupported");
        assert_eq!(result.device_id.as_deref(), Some("device-1"));
        assert!(result.session_id.is_none());
        assert!(result.steps.iter().all(|step| step.state == "unsupported"));
        // 桌面版本现在支持远程内部检查；脱离平台状态的私有直连入口仍不能伪造成功。
        assert!(get_vertical_security_access_capabilities().remote_ip_available);
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
