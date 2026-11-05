//! 只读正式安装脚本的静态业务地址，不运行脚本，也不等待 PPP 就绪。
use super::{
    credential_target, execute_user_ssh_command, parse_upload_account, shell_quote,
    LowerUpdateSshAuthDto, LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT,
    VERTICAL_SECURITY_INSTALL_PATH, VERTICAL_SECURITY_MAX_SCRIPT_BYTES,
    VERTICAL_SECURITY_SERVICE_PATH,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerticalSecurityNetworkRequestDto {
    pub upload_account: String,
    pub auth: LowerUpdateSshAuthDto,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerticalSecurityNetworkAddressesDto {
    pub device: String,
    pub local_rtu_address: String,
    pub local_security_address: String,
    pub local_gateway_address: String,
    pub remote_rtu_address: String,
    pub remote_security_address: String,
    pub remote_gateway_address: String,
}

#[derive(Debug, Serialize)]
pub struct VerticalSecurityNetworkResultDto {
    pub upload_account: String,
    pub fingerprint: String,
    pub addresses: VerticalSecurityNetworkAddressesDto,
}

const KEYS: [&str; 7] = [
    "TARGET_DEVICE",
    "LOCAL_RTU_ADDRESS",
    "LOCAL_SECURITY_ADDRESS",
    "LOCAL_GATEWAY_ADDRESS",
    "REMOTE_RTU_ADDRESS",
    "REMOTE_SECURITY_ADDRESS",
    "REMOTE_GATEWAY_ADDRESS",
];

fn read_command() -> String {
    // 十六进制传输保留原始字节，避免通用SSH输出的有损UTF-8转换掩盖坏文件。
    // 仅固定路径和固定长度进入命令；不调用脚本、不读取运行结果、不提权或写文件。
    format!(
        "set -e; test -f {unit}; test -r {unit}; test -f {script}; test -r {script}; LC_ALL=C od -An -v -tx1 -N {limit} {script}",
        unit = shell_quote(VERTICAL_SECURITY_SERVICE_PATH),
        script = shell_quote(VERTICAL_SECURITY_INSTALL_PATH),
        limit = VERTICAL_SECURITY_MAX_SCRIPT_BYTES + 1,
    )
}

fn decode_script(output: &str) -> Result<Vec<u8>, String> {
    let invalid = || "DSP 已安装纵密脚本的读取结果无效，请核对 DSP 网络配置".to_string();
    if output.len() > (VERTICAL_SECURITY_MAX_SCRIPT_BYTES + 1) * 4 + 1024 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    for value in output.split_ascii_whitespace() {
        if value.len() != 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        bytes.push(u8::from_str_radix(value, 16).map_err(|_| invalid())?);
        if bytes.len() > VERTICAL_SECURITY_MAX_SCRIPT_BYTES {
            return Err("DSP 已安装纵密脚本超出允许大小，无法读取业务地址".into());
        }
    }
    if bytes.is_empty() {
        return Err(invalid());
    }
    Ok(bytes)
}

fn parse_addresses(bytes: &[u8]) -> Result<VerticalSecurityNetworkAddressesDto, String> {
    let invalid = || "DSP 已安装纵密脚本格式不受支持，请先完成 DSP 网络配置".to_string();
    if bytes.is_empty() || bytes.len() > VERTICAL_SECURITY_MAX_SCRIPT_BYTES || bytes.contains(&0) {
        return Err(invalid());
    }
    let script = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut lines = script.lines();
    if lines.next() != Some("#!/usr/bin/env bash") || lines.next() != Some("set -Eeuo pipefail") {
        return Err(invalid());
    }
    let lines: Vec<&str> = lines.collect();
    let start = lines.iter().position(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .ok_or_else(invalid)?;
    let mut values: [Option<String>; 7] = Default::default();
    for (line_index, line) in lines.iter().enumerate() {
        let Some(declaration) = line.trim_start().strip_prefix("readonly") else { continue; };
        if !declaration.starts_with(char::is_whitespace) { continue; }
        let declaration = declaration.trim_start();
        for (index, key) in KEYS.iter().enumerate() {
            let Some(tail) = declaration.strip_prefix(*key) else { continue; };
            if !tail.is_empty() && !tail.starts_with('=') && !tail.starts_with(char::is_whitespace) {
                continue;
            }
            // 七个常量必须位于生成器头部且顺序连续，不能从函数、注释或后续正文拼出地址。
            if values[index].is_some() || line_index != start + index { return Err(invalid()); }
            // 只接受生成器的单引号字面量，禁止变量、命令替换、尾随命令及其他Shell格式。
            let prefix = format!("readonly {key}='");
            let value = line.strip_prefix(prefix.as_str()).and_then(|value| value.strip_suffix('\''))
                .ok_or_else(invalid)?;
            let valid = if index == 0 {
                value == "MskDSP"
            } else {
                value.parse::<std::net::Ipv4Addr>().is_ok()
            };
            if !valid { return Err(invalid()); }
            values[index] = Some(value.into());
        }
    }
    if values.iter().any(Option::is_none) { return Err(invalid()); }
    let [device, local_rtu_address, local_security_address, local_gateway_address,
        remote_rtu_address, remote_security_address, remote_gateway_address] =
        values.map(|value| value.unwrap_or_default());
    Ok(VerticalSecurityNetworkAddressesDto {
        device, local_rtu_address, local_security_address, local_gateway_address,
        remote_rtu_address, remote_security_address, remote_gateway_address,
    })
}

pub(super) async fn read(
    request: VerticalSecurityNetworkRequestDto,
) -> Result<VerticalSecurityNetworkResultDto, String> {
    let target = parse_upload_account(&request.upload_account)?;
    let output = tokio::time::timeout(
        LOWER_UPDATE_RUNTIME_QUERY_TIMEOUT,
        execute_user_ssh_command(&target, &request.auth, &read_command()),
    ).await
        .map_err(|_| "读取 DSP 网络配置超时，请检查 SSH 连接".to_string())?
        .map_err(|_| "读取 DSP 网络配置失败，请检查 SSH 连接和读取权限".to_string())?;
    if output.exit_code != Some(0) {
        // 不把远端stdout/stderr写入错误或日志，其中可能包含脚本正文和非预期数据。
        return Err("未找到可读取的已安装纵密脚本及服务，请先完成 DSP 网络配置".into());
    }
    let bytes = decode_script(&output.stdout)?;
    let addresses = parse_addresses(&bytes)?;
    let fingerprint = format!("{:x}", Sha256::digest(&bytes));
    tracing::info!("已只读获取 DSP 正式安装的纵密业务地址，不要求 PPP 就绪");
    Ok(VerticalSecurityNetworkResultDto {
        upload_account: credential_target(&target), fingerprint, addresses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generated_fixture() -> String {
        // 直接取当前TS生成器模板，保留正式生成格式及PPP等待逻辑，防止前后端契约漂移。
        let source = include_str!("../../../src/utils/vertical-security-script.ts").replace("\r\n", "\n");
        let template = source.split_once("  return `#!/usr/bin/env bash\n").unwrap().1
            .split_once("\n`;\n}").unwrap().0;
        let mut script = format!("#!/usr/bin/env bash\n{template}\n");
        for (name, value) in [
            ("device", "MskDSP"),
            ("localRtuAddress", "30.19.80.177"),
            ("localSecurityAddress", "30.19.80.189"),
            ("localGatewayAddress", "30.19.80.190"),
            ("remoteRtuAddress", "30.19.0.1"),
            ("remoteSecurityAddress", "30.19.0.250"),
            ("remoteGatewayAddress", "30.19.0.254"),
        ] {
            script = script.replace(&format!("${{shellQuote({name})}}"), &format!("'{value}'"));
        }
        script
    }

    #[test]
    fn reads_generator_addresses_without_ppp_or_runtime_saved_configuration() {
        let script = generated_fixture();
        assert!(script.contains("wait_for_ppp0_ipv4"));
        let addresses = parse_addresses(script.as_bytes()).unwrap();
        assert_eq!(addresses.device, "MskDSP");
        assert_eq!(addresses.local_rtu_address, "30.19.80.177");
        assert_eq!(addresses.remote_gateway_address, "30.19.0.254");
        let json = serde_json::to_value(addresses).unwrap();
        assert_eq!(json["localSecurityAddress"], "30.19.80.189");
        assert_eq!(json["remoteSecurityAddress"], "30.19.0.250");
        assert!(json.get("local_security_address").is_none());
    }

    #[test]
    fn rejects_missing_duplicate_and_nonliteral_address_constants() {
        let script = generated_fixture();
        for replacement in [
            "", "readonly LOCAL_RTU_ADDRESS='30.19.80.177'\nreadonly LOCAL_RTU_ADDRESS='30.19.80.178'",
            "readonly LOCAL_RTU_ADDRESS='$VALUE'", "readonly LOCAL_RTU_ADDRESS='$(touch /tmp/bad)'",
            "readonly LOCAL_RTU_ADDRESS=$(echo 30.19.80.177)", "readonly LOCAL_RTU_ADDRESS=\"30.19.80.177\"",
            "readonly LOCAL_RTU_ADDRESS='30.19.80.177'; touch /tmp/bad",
            "readonly LOCAL_RTU_ADDRESS='256.0.0.1'", "readonly LOCAL_RTU_ADDRESS='030.19.80.177'",
            " readonly LOCAL_RTU_ADDRESS='30.19.80.177'", "readonly LOCAL_RTU_ADDRESS = '30.19.80.177'",
        ] {
            let modified = script.replace("readonly LOCAL_RTU_ADDRESS='30.19.80.177'", replacement);
            assert!(parse_addresses(modified.as_bytes()).is_err(), "必须拒绝不受支持的常量格式");
        }
        assert!(parse_addresses(script.replace("TARGET_DEVICE='MskDSP'", "TARGET_DEVICE='other'").as_bytes()).is_err());
        assert!(parse_addresses(script.replace("readonly TARGET_DEVICE=", "echo unexpected\nreadonly TARGET_DEVICE=").as_bytes()).is_err());
        let misplaced = script.replace("readonly LOCAL_RTU_ADDRESS='30.19.80.177'\n", "")
            + "\nreadonly LOCAL_RTU_ADDRESS='30.19.80.177'\n";
        assert!(parse_addresses(misplaced.as_bytes()).is_err());
    }

    #[test]
    fn rejects_invalid_encoding_oversized_and_truncated_reads() {
        let mut invalid = generated_fixture().into_bytes();
        invalid.push(0xff);
        assert!(parse_addresses(&invalid).is_err());
        invalid.pop(); invalid.push(0);
        assert!(parse_addresses(&invalid).is_err());
        assert!(parse_addresses(&vec![b' '; VERTICAL_SECURITY_MAX_SCRIPT_BYTES + 1]).is_err());
        for output in ["", "zz", "000", "00 unexpected"] {
            assert!(decode_script(output).is_err());
        }
        assert_eq!(decode_script("23 21 2f\n62 69 6e\n").unwrap(), b"#!/bin");
        assert!(decode_script(&"00 ".repeat(VERTICAL_SECURITY_MAX_SCRIPT_BYTES + 1)).is_err());
    }

    #[test]
    fn fixed_read_command_never_runs_or_changes_installed_configuration() {
        let command = read_command();
        assert!(command.contains("test -f '/etc/systemd/system/mskdsp-vertical-security.service'"));
        assert!(command.contains("od -An -v -tx1 -N 1048577 '/usr/local/libexec/mskdsp-vertical-security'"));
        for forbidden in ["sudo", "source ", "bash ", "systemctl", "ppp0", "vertical-security.conf", ">", "chmod", "install ", "rm ", "mv "] {
            assert!(!command.contains(forbidden), "读取不得执行配置、等待PPP或写设备");
        }
        let target = parse_upload_account("  megsky@192.168.1.219:10022  ").unwrap();
        assert_eq!(credential_target(&target), "megsky@192.168.1.219:10022");
    }
}
