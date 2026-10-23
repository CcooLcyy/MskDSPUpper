use serde::Serialize;

pub(super) const PROBE_COMMAND: &str = concat!(
    "set -e; os=$(uname -s); architecture=$(uname -m); ",
    "printf '__MSKDSP_OS__=%s\\n__MSKDSP_ARCH__=%s\\n' \"$os\" \"$architecture\""
);

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LowerUpdateArchitectureDto {
    pub os: String,
    pub architecture: String,
    pub platform: String,
}

pub(super) fn parse_probe_output(output: &str) -> Result<LowerUpdateArchitectureDto, String> {
    fn field(output: &str, prefix: &str) -> Result<String, String> {
        let mut values = output
            .lines()
            .map(str::trim)
            .filter_map(|line| line.strip_prefix(prefix));
        let value = values
            .next()
            .filter(|value| !value.is_empty())
            .ok_or("设备架构检测结果缺失，已停止下发")?;
        if values.next().is_some()
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err("设备架构检测结果格式不合法，已停止下发".into());
        }
        Ok(value.into())
    }
    let os = field(output, "__MSKDSP_OS__=")?;
    let architecture = field(output, "__MSKDSP_ARCH__=")?;
    if os != "Linux" {
        return Err(format!("不支持目标设备系统 {os}，仅支持 Linux，已停止下发"));
    }
    let platform = match architecture.as_str() {
        "aarch64" | "arm64" => "linux-arm64",
        "x86_64" | "amd64" => "linux-x64",
        _ => return Err(format!("不支持目标设备架构 {architecture}，已停止下发")),
    };
    Ok(LowerUpdateArchitectureDto {
        os,
        architecture,
        platform: platform.into(),
    })
}

fn platform_label(platform: &str) -> Result<&str, String> {
    match platform {
        "linux-arm64" => Ok("ARM64"),
        "linux-x64" => Ok("x64"),
        _ => Err("下位机更新架构不支持，已停止下发".into()),
    }
}

pub(super) fn verify_platforms(device: &str, package: &str) -> Result<(), String> {
    let device_label = platform_label(device)?;
    let package_label = platform_label(package)?;
    if device != package {
        return Err(format!(
            "目标设备为 {device_label}，安装包为 {package_label}，已停止下发。请选择匹配的安装包"
        ));
    }
    Ok(())
}

pub(super) async fn inspect_upload_platform(
    path: std::path::PathBuf,
    requested: String,
) -> Result<String, String> {
    let expected = platform_label(&requested)?.to_owned();
    let info =
        tokio::task::spawn_blocking(move || super::lower_update_local::inspect_package(&path))
            .await
            .map_err(|error| format!("读取安装包架构任务失败，已停止下发: {error}"))??;
    if info.platform != requested {
        return Err(format!(
            "所选架构为 {expected}，安装包真实架构为 {}，已停止下发。请选择匹配的安装包",
            platform_label(&info.platform)?
        ));
    }
    Ok(info.platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 验证设备架构别名统一到安装包平台，同时保留原始检测结果。
    #[test]
    fn normalizes_supported_device_architectures() {
        for (machine, platform) in [
            ("aarch64", "linux-arm64"),
            ("arm64", "linux-arm64"),
            ("x86_64", "linux-x64"),
            ("amd64", "linux-x64"),
        ] {
            let result =
                parse_probe_output(&format!("__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__={machine}\n"))
                    .unwrap();
            assert_eq!(result.platform, platform);
            assert_eq!(result.os, "Linux");
            assert_eq!(result.architecture, machine);
        }
    }

    // 验证不能用不支持的系统或 CPU 架构继续下发。
    #[test]
    fn rejects_unsupported_systems_and_architectures() {
        for output in [
            "__MSKDSP_OS__=Darwin\n__MSKDSP_ARCH__=arm64\n",
            "__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__=armv7l\n",
            "__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__=i686\n",
        ] {
            assert!(parse_probe_output(output).unwrap_err().contains("不支持"));
        }
    }

    // 验证探测缺失、重复或异常字段不能被当作成功结果。
    #[test]
    fn rejects_missing_duplicate_and_malformed_output() {
        for output in [
            "",
            "Linux\nx86_64\n",
            "__MSKDSP_ARCH__=x86_64\n",
            "__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__=\n",
            "__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__=x86_64\n__MSKDSP_ARCH__=aarch64\n",
            "__MSKDSP_OS__=Linux\n__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__=x86_64\n",
            "__MSKDSP_OS__=Linux\n__MSKDSP_ARCH__=x86_64 extra\n",
        ] {
            assert!(parse_probe_output(output).is_err(), "{output:?}");
        }
        // SSH 登录提示可以存在，但不得代替带标记的检测结果。
        assert!(parse_probe_output(
            "登录成功\r\n__MSKDSP_OS__=Linux\r\n__MSKDSP_ARCH__=x86_64\r\n"
        )
        .is_ok());
    }

    // 验证只有双方平台均受支持且完全一致才允许继续，并给出明确不匹配信息。
    #[test]
    fn blocks_mismatched_or_unknown_package_platforms() {
        for platform in ["linux-arm64", "linux-x64"] {
            verify_platforms(platform, platform).unwrap();
        }
        let error = verify_platforms("linux-arm64", "linux-x64").unwrap_err();
        assert!(error.contains("ARM64") && error.contains("x64") && error.contains("停止"));
        assert!(verify_platforms("linux-x64", "linux-arm64").is_err());
        assert!(verify_platforms("linux-x64", "linux-amd64").is_err());
        assert!(verify_platforms("", "").is_err());
    }

    // 验证系统探测无 sudo 或目录创建等写入动作，任一 uname 失败立即退出。
    #[test]
    fn probe_is_read_only_and_requires_both_commands() {
        assert!(PROBE_COMMAND.starts_with("set -e;"));
        assert!(PROBE_COMMAND.contains("uname -s"));
        assert!(PROBE_COMMAND.contains("uname -m"));
        assert!(!PROBE_COMMAND.contains("sudo"));
        assert!(!PROBE_COMMAND.contains("mkdir"));
    }

    // 验证上传检查读取包内真实平台，不能用伪装包名或篡改请求绕过。
    #[tokio::test]
    async fn inspects_actual_package_instead_of_file_name() {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        for (arch, platform) in [("amd64", "linux-x64"), ("arm64", "linux-arm64")] {
            let config = format!("{{\"architecture\":\"{arch}\",\"os\":\"linux\"}}").into_bytes();
            let hash = format!("{:x}", Sha256::digest(&config));
            let manifest = serde_json::to_vec(&serde_json::json!([
                { "Config": format!("{hash}.json"), "RepoTags": ["mskdsp:v1.2.3"], "Layers": [] }
            ]))
            .unwrap();
            let mut archive = tar::Builder::new(Vec::new());
            for (name, contents) in [
                ("manifest.json".into(), manifest),
                (format!("{hash}.json"), config),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(contents.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                archive
                    .append_data(&mut header, name, contents.as_slice())
                    .unwrap();
            }
            let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gzip.write_all(&archive.into_inner().unwrap()).unwrap();
            let mut package = b"#!/usr/bin/env bash\nexit 0\n__ARCHIVE_BELOW__\n".to_vec();
            package.extend(gzip.finish().unwrap());
            let path = std::env::temp_dir().join(format!(
                "mskdsp-architecture-{}-{arch}-misleading-linux-arm64",
                std::process::id()
            ));
            std::fs::write(&path, package).unwrap();
            let accepted = inspect_upload_platform(path.clone(), platform.into()).await;
            let rejected = inspect_upload_platform(
                path.clone(),
                if arch == "amd64" {
                    "linux-arm64"
                } else {
                    "linux-x64"
                }
                .into(),
            )
            .await;
            let unknown = inspect_upload_platform(path.clone(), "linux-amd64".into()).await;
            std::fs::remove_file(path).unwrap();
            assert_eq!(accepted.unwrap(), platform);
            assert!(rejected.unwrap_err().contains("所选架构"));
            assert!(unknown.is_err());
        }
    }

    // 验证损坏或缺失的本地包不能继续上传。
    #[tokio::test]
    async fn refuses_unreadable_package_before_upload() {
        let path = std::env::temp_dir().join(format!(
            "mskdsp-architecture-missing-{}",
            std::process::id()
        ));
        assert!(inspect_upload_platform(path, "linux-x64".into())
            .await
            .is_err());
    }
}
