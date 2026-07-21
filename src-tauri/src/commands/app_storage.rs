use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::{runtime_paths::RuntimePathsDto, state::AppState};

const SETTINGS_SCHEMA_VERSION: u32 = 1;
pub const MANAGER_ADDR_KEY: &str = "mskdsp_manager_addr";
pub const MODBUS_MQTT_KEY: &str = "protocol.modbus_rtu.mqtt";
pub const DLT645_MQTT_KEY: &str = "protocol.dlt645.mqtt";

#[derive(Debug, Deserialize, Serialize)]
struct SettingsDocument {
    schema_version: u32,
    settings: BTreeMap<String, Value>,
}

impl Default for SettingsDocument {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: BTreeMap::new(),
        }
    }
}

pub struct AppSettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AppSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn load(&self) -> Result<BTreeMap<String, Value>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "上位机设置文件锁已损坏".to_string())?;
        let mut document = read_settings_document(&self.path)?;
        hydrate_mqtt_passwords(&mut document.settings);
        Ok(document.settings)
    }

    pub fn save_setting(&self, key: String, value: Value) -> Result<(), String> {
        validate_setting_key(&key)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "上位机设置文件锁已损坏".to_string())?;
        let mut document = read_settings_document(&self.path)?;
        let value = sanitize_setting_for_disk(&key, value)?;
        document.settings.insert(key, value);
        write_settings_document(&self.path, &document)
    }

    pub fn migrate_legacy(
        &self,
        legacy: BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "上位机设置文件锁已损坏".to_string())?;
        let mut document = read_settings_document(&self.path)?;
        let mut changed = false;
        for (key, value) in legacy {
            validate_setting_key(&key)?;
            if document.settings.contains_key(&key) {
                continue;
            }
            let value = sanitize_setting_for_disk(&key, value)?;
            document.settings.insert(key, value);
            changed = true;
        }
        if changed {
            write_settings_document(&self.path, &document)?;
        }
        hydrate_mqtt_passwords(&mut document.settings);
        Ok(document.settings)
    }
}

fn validate_setting_key(key: &str) -> Result<(), String> {
    match key {
        MANAGER_ADDR_KEY | MODBUS_MQTT_KEY | DLT645_MQTT_KEY => Ok(()),
        _ => Err(format!("不支持的上位机设置项: {key}")),
    }
}

fn read_settings_document(path: &Path) -> Result<SettingsDocument, String> {
    if !path.exists() {
        let backup = backup_path(path);
        if backup.exists() {
            return read_settings_document_from(&backup);
        }
        return Ok(SettingsDocument::default());
    }
    read_settings_document_from(path)
}

fn read_settings_document_from(path: &Path) -> Result<SettingsDocument, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("读取上位机设置失败: path={}, error={error}", path.display()))?;
    let document: SettingsDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析上位机设置失败: path={}, error={error}", path.display()))?;
    if document.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(format!(
            "不支持的上位机设置版本: expected={SETTINGS_SCHEMA_VERSION}, actual={}",
            document.schema_version
        ));
    }
    Ok(document)
}

fn write_settings_document(path: &Path, document: &SettingsDocument) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建上位机设置目录失败: path={}, error={error}",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("序列化上位机设置失败: {error}"))?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("json.tmp-{}-{unique}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| {
            format!(
                "创建上位机设置临时文件失败: path={}, error={error}",
                temporary.display()
            )
        })?;
    file.write_all(&bytes).map_err(|error| {
        format!(
            "写入上位机设置临时文件失败: path={}, error={error}",
            temporary.display()
        )
    })?;
    file.write_all(b"\n").map_err(|error| {
        format!(
            "写入上位机设置换行失败: path={}, error={error}",
            temporary.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "刷新上位机设置临时文件失败: path={}, error={error}",
            temporary.display()
        )
    })?;
    drop(file);

    if let Err(error) = atomic_replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "替换上位机设置失败: path={}, error={error}",
            path.display()
        ));
    }
    Ok(())
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

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn sanitize_setting_for_disk(key: &str, mut value: Value) -> Result<Value, String> {
    if !matches!(key, MODBUS_MQTT_KEY | DLT645_MQTT_KEY) {
        return Ok(value);
    }
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("MQTT 设置必须是对象: key={key}"))?;
    let password = object
        .get("password")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("MQTT 设置缺少 password 字段: key={key}"))?
        .to_string();

    #[cfg(not(target_os = "windows"))]
    {
        let _ = password;
        return Ok(value);
    }

    #[cfg(target_os = "windows")]
    {
        store_mqtt_password(key, &password)?;
        object.insert("password".to_string(), Value::String(String::new()));
        Ok(value)
    }
}

fn hydrate_mqtt_passwords(settings: &mut BTreeMap<String, Value>) {
    for key in [MODBUS_MQTT_KEY, DLT645_MQTT_KEY] {
        let Some(value) = settings.get_mut(key) else {
            continue;
        };
        let Some(object) = value.as_object_mut() else {
            continue;
        };
        match load_mqtt_password(key) {
            Ok(Some(password)) => {
                object.insert("password".to_string(), Value::String(password));
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(setting_key = key, %error, "读取 MQTT 凭据失败"),
        }
    }
}

#[cfg(target_os = "windows")]
fn credential_entry(key: &str) -> Result<keyring::Entry, String> {
    let user = match key {
        MODBUS_MQTT_KEY => "modbus-rtu",
        DLT645_MQTT_KEY => "dlt645",
        _ => return Err(format!("不支持的 MQTT 凭据项: {key}")),
    };
    keyring::Entry::new("com.mskdsp.upper:mqtt", user)
        .map_err(|error| format!("创建 MQTT 凭据项失败: {error}"))
}

#[cfg(target_os = "windows")]
fn store_mqtt_password(key: &str, password: &str) -> Result<(), String> {
    let entry = credential_entry(key)?;
    if password.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("清除 MQTT 密码失败: {error}")),
        };
    }
    entry
        .set_password(password)
        .map_err(|error| format!("保存 MQTT 密码失败: {error}"))
}

#[cfg(target_os = "windows")]
fn load_mqtt_password(key: &str) -> Result<Option<String>, String> {
    match credential_entry(key)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取 MQTT 密码失败: {error}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn load_mqtt_password(_key: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub fn load_app_settings(state: State<'_, AppState>) -> Result<BTreeMap<String, Value>, String> {
    state.settings_store.load()
}

#[tauri::command]
pub fn save_app_setting(
    key: String,
    value: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.settings_store.save_setting(key, value)
}

#[tauri::command]
pub fn migrate_legacy_app_settings(
    legacy: BTreeMap<String, Value>,
    state: State<'_, AppState>,
) -> Result<BTreeMap<String, Value>, String> {
    state.settings_store.migrate_legacy(legacy)
}

#[tauri::command]
pub fn get_runtime_paths(state: State<'_, AppState>) -> RuntimePathsDto {
    state.runtime_paths.to_dto()
}

#[tauri::command]
pub fn open_runtime_directory(kind: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = match kind.as_str() {
        "data" => state.runtime_paths.data_dir(),
        "cache" => state.runtime_paths.cache_dir(),
        "logs" => state.runtime_paths.log_dir(),
        _ => return Err(format!("不支持的运行目录类型: {kind}")),
    };
    fs::create_dir_all(path)
        .map_err(|error| format!("创建运行目录失败: path={}, error={error}", path.display()))?;
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("打开运行目录失败: path={}, error={error}", path.display()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{read_settings_document, AppSettingsStore, MANAGER_ADDR_KEY};

    fn temp_settings_path(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mskdsp-upper-settings-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.join("settings.json")
    }

    #[test]
    fn writes_versioned_settings_and_reloads_them() {
        let path = temp_settings_path("roundtrip");
        let store = AppSettingsStore::new(path.clone());
        store
            .save_setting(MANAGER_ADDR_KEY.to_string(), json!("192.168.1.8:17000"))
            .unwrap();

        let settings = store.load().unwrap();
        assert_eq!(
            settings.get(MANAGER_ADDR_KEY),
            Some(&json!("192.168.1.8:17000"))
        );
        let document = read_settings_document(&path).unwrap();
        assert_eq!(document.schema_version, 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn rejects_unknown_setting_keys() {
        let path = temp_settings_path("unknown-key");
        let store = AppSettingsStore::new(path.clone());
        let error = store
            .save_setting("unknown".to_string(), json!(true))
            .unwrap_err();
        assert!(error.contains("不支持"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn legacy_migration_only_fills_missing_settings() {
        let path = temp_settings_path("legacy");
        let store = AppSettingsStore::new(path.clone());
        store
            .save_setting(MANAGER_ADDR_KEY.to_string(), json!("192.168.1.8:17000"))
            .unwrap();
        let migrated = store
            .migrate_legacy(std::collections::BTreeMap::from([(
                MANAGER_ADDR_KEY.to_string(),
                json!("10.0.0.5:17000"),
            )]))
            .unwrap();

        assert_eq!(
            migrated.get(MANAGER_ADDR_KEY),
            Some(&json!("192.168.1.8:17000"))
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
