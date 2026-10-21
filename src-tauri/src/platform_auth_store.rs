//! 平台登录设置仅保存标识信息，密码由 Windows 凭据管理器保存。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PlatformLoginSettings {
    pub grpc_endpoint: String,
    pub username: String,
    pub auto_login: bool,
    pub remember_password: bool,
}

impl Default for PlatformLoginSettings {
    fn default() -> Self {
        Self {
            grpc_endpoint: crate::platform_software::DEFAULT_ENDPOINT.to_owned(),
            username: String::new(),
            auto_login: false,
            remember_password: false,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoredSettings {
    #[serde(flatten)]
    pub settings: PlatformLoginSettings,
    pub instance_id: String,
}

impl StoredSettings {
    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => {
                let mut value: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| "平台登录设置损坏，请检查设置文件".to_string())?;
                value.settings.grpc_endpoint =
                    crate::platform_software::validate_endpoint(&value.settings.grpc_endpoint)?;
                value.settings.username = value.settings.username.trim().to_ascii_lowercase();
                // 兼容旧版自动登录配置，自动登录始终包含记住密码。
                value.settings.remember_password |= value.settings.auto_login;
                if value.instance_id.is_empty() {
                    value.instance_id = instance_id(path);
                }
                Ok(value)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                settings: PlatformLoginSettings::default(),
                instance_id: instance_id(path),
            }),
            Err(_) => Err("读取平台登录设置失败".to_string()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|_| "创建平台登录设置目录失败")?;
        }
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "编码平台登录设置失败")?;
        // 同目录临时文件先完整落盘，再原子替换；中途失败保留原文件。
        use std::sync::atomic::{AtomicU64, Ordering};
        static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let temporary = path.with_extension(format!(
            "tmp.{}.{}",
            std::process::id(),
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            atomic_replace(&temporary, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|_| "保存平台登录设置失败".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // 两个路径均来自有效的系统路径，宽字符串以 NUL 结尾并存活到调用结束。
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn instance_id(path: &Path) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let material = format!(
        "{:?}:{:?}:{}:{}",
        path,
        std::time::SystemTime::now(),
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    format!("upper-{:x}", Sha256::digest(material.as_bytes()))
}

pub(super) trait CredentialStore: Send + Sync {
    fn load(&self, endpoint: &str, username: &str) -> Result<Option<String>, String>;
    fn save(&self, endpoint: &str, username: &str, password: &str) -> Result<(), String>;
    fn delete(&self, endpoint: &str, username: &str) -> Result<(), String>;
}

pub(super) struct WindowsCredentials;

fn entry(endpoint: &str, username: &str) -> Result<keyring::Entry, String> {
    let target = format!("{:x}", Sha256::digest(format!("{endpoint}\n{username}")));
    keyring::Entry::new("com.mskdsp.upper:platform", &target)
        .map_err(|_| "访问 Windows 平台凭据失败".to_string())
}

impl CredentialStore for WindowsCredentials {
    fn load(&self, endpoint: &str, username: &str) -> Result<Option<String>, String> {
        match entry(endpoint, username)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("读取 Windows 平台凭据失败".to_string()),
        }
    }
    fn save(&self, endpoint: &str, username: &str, password: &str) -> Result<(), String> {
        entry(endpoint, username)?
            .set_password(password)
            .map_err(|_| "保存 Windows 平台凭据失败".to_string())
    }
    fn delete(&self, endpoint: &str, username: &str) -> Result<(), String> {
        if username.is_empty() {
            return Ok(());
        }
        match entry(endpoint, username)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("清除 Windows 平台凭据失败".to_string()),
        }
    }
}
