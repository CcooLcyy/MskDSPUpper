//! 纵密证书本地文件边界与 PPP 地址解析，不依赖桌面运行时。
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

pub(super) const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

fn extension_allowed(path: &Path, csr: bool) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(s.to_ascii_lowercase().as_str(), "pem" | "cer" | "crt")
            || (csr && s.eq_ignore_ascii_case("csr"))
    })
}

pub(super) fn read_certificate(path: &Path) -> Result<(String, Vec<u8>), String> {
    if !extension_allowed(path, false) {
        return Err("请选择 cer、crt 或 pem 证书文件".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取所选证书文件信息")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
        return Err("证书必须为非空普通文件且不超过 4 MiB".into());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("证书文件名编码无效")?
        .to_string();
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法打开所选证书文件")?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| "读取证书文件失败")?;
    if data.is_empty() || data.len() as u64 > MAX_FILE_BYTES {
        return Err("证书文件为空或超过 4 MiB".into());
    }
    let text = String::from_utf8_lossy(&data).to_ascii_uppercase();
    if text.contains("PRIVATE KEY") || text.contains("CERTIFICATE REQUEST") {
        return Err("所选文件包含私钥或证书申请，请选择签发后的公开证书".into());
    }
    Ok((name, data))
}

pub(super) fn save_file(path: &Path, data: &[u8]) -> Result<(), String> {
    if !extension_allowed(path, true) || data.is_empty() || data.len() as u64 > MAX_FILE_BYTES {
        return Err("仅可保存非空且不超过 4 MiB 的 csr、cer、crt 或 pem 文件".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("保存目标必须为普通文件，不能为目录或符号链接".into())
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("无法检查保存目标".into())
        }
        _ => {}
    }
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("tmp-{}-{unique}", std::process::id()));
    let operation = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建导出临时文件")?;
        file.write_all(data).map_err(|_| "写入导出文件失败")?;
        file.sync_all().map_err(|_| "刷新导出文件失败")?;
        drop(file);
        atomic_replace(&temporary, path).map_err(|_| "替换导出文件失败，原文件已保留")?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    operation
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // 同目录文件以系统原子替换方式覆盖，失败时不会先删除旧文件。
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn parse_ppp_ipv4(text: &str) -> Option<String> {
    let ip = text.trim().parse::<std::net::Ipv4Addr>().ok()?;
    if ip.octets()[0] == 0
        || ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.octets()[0] >= 240
    {
        return None;
    }
    Some(ip.to_string())
}

pub(crate) fn matches_sim_target(current_host: &str, saved_host: &str, remote: bool) -> bool {
    !remote && !current_host.is_empty() && current_host.eq_ignore_ascii_case(saved_host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mskdsp-admin-files-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // 正常证书按原字节读取，私钥和申请文件不能冒充导入证书。
    #[test]
    fn reads_certificate_and_rejects_private_or_request_files() {
        let dir = Directory::new();
        let path = dir.0.join("station.pem");
        let cert = b"-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
        fs::write(&path, cert).unwrap();
        assert_eq!(
            read_certificate(&path).unwrap(),
            ("station.pem".into(), cert.to_vec())
        );
        for bytes in [
            b"-----BEGIN PRIVATE KEY-----".as_slice(),
            b"-----BEGIN CERTIFICATE REQUEST-----".as_slice(),
            b"-----BEGIN NEW CERTIFICATE REQUEST-----".as_slice(),
            b"-----BEGIN EC PRIVATE KEY-----".as_slice(),
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(read_certificate(&path).is_err());
        }
    }

    // 空文件、目录、超限文件及不支持扩展名不允许导入。
    #[test]
    fn rejects_invalid_file_boundaries() {
        let dir = Directory::new();
        assert!(read_certificate(&dir.0).is_err());
        let path = dir.0.join("empty.cer");
        fs::write(&path, []).unwrap();
        assert!(read_certificate(&path).is_err());
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(read_certificate(&path).is_err());
        let other = dir.0.join("secret.txt");
        fs::write(&other, b"fixture").unwrap();
        assert!(read_certificate(&other).is_err());
    }

    // 覆盖保存保持原字节，验证失败不能损坏已存在的文件。
    #[test]
    fn saves_atomically_and_preserves_existing_on_invalid_input() {
        let dir = Directory::new();
        let path = dir.0.join("10.1.2.3_SM2.csr");
        save_file(&path, b"first").unwrap();
        save_file(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(save_file(&path, &[]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(save_file(&dir.0.join("other.txt"), b"fixture").is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    // 仅接受单个可用的 PPP IPv4，拒绝多地址及错误输出。
    #[test]
    fn parses_only_single_usable_ppp_address() {
        assert_eq!(parse_ppp_ipv4("10.20.30.40\n"), Some("10.20.30.40".into()));
        for text in [
            "",
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "224.1.2.3",
            "255.255.255.255",
            "169.254.1.2",
            "::1",
            "10.1.2.3\n10.2.3.4",
            "error 10.1.2.3",
        ] {
            assert_eq!(parse_ppp_ipv4(text), None, "{text}");
        }
    }

    // 仅当前直连主机可以复用 SSH 凭据，远程和其他设备不得触发查询。
    #[test]
    fn sim_query_requires_matching_direct_target() {
        assert!(matches_sim_target("192.168.1.219", "192.168.1.219", false));
        assert!(matches_sim_target("DSP.local", "dsp.local", false));
        assert!(!matches_sim_target("192.168.1.219", "192.168.1.220", false));
        assert!(!matches_sim_target("192.168.1.219", "192.168.1.219", true));
        assert!(!matches_sim_target("", "", false));
    }
}
