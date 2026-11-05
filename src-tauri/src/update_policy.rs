//! 更新权限按当前上位机版本和平台发布通道判断，目标版本串不代表发布通道。

pub fn is_stable_client(version: &str) -> bool {
    !version.contains("-ci.") && !version.contains("-beta.")
}

pub fn validate_update_channel(client_version: &str, target_channel: &str) -> Result<(), String> {
    if !matches!(target_channel, "stable" | "ci") {
        tracing::warn!(target_channel, "拒绝已退役或未知的更新通道");
        return Err("更新通道仅支持 stable 或 ci，Beta 通道已退役".into());
    }
    if is_stable_client(client_version) && target_channel != "stable" {
        tracing::warn!(
            client_version,
            target_channel,
            "Stable 上位机拒绝非 Stable 通道更新"
        );
        return Err("Stable 上位机只能下载和安装 Stable 通道的上位机及下位机版本".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_beta_and_ci_versions_are_unrestricted() {
        for version in ["0.8.0-beta.1", "0.8.0-ci.123+sha.abcdef0"] {
            assert!(!is_stable_client(version));
            for channel in ["stable", "ci"] {
                assert!(validate_update_channel(version, channel).is_ok());
            }
            assert!(validate_update_channel(version, "beta").is_err());
            assert!(validate_update_channel(version, "unknown").is_err());
        }
    }

    #[test]
    fn stable_and_unknown_versions_only_allow_stable_channel() {
        for version in ["0.8.0", "0.8.0+sha.abcdef0", "0.8.0-rc.1", "", "unknown"] {
            assert!(is_stable_client(version));
            assert!(validate_update_channel(version, "stable").is_ok());
            for channel in ["beta", "ci", "", "unknown", "Stable"] {
                assert!(validate_update_channel(version, channel).is_err());
            }
        }
    }
}
