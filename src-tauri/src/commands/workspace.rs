//! 离线工作区（`.mskwsp`）的纯文件读写命令。
//!
//! 本模块只负责把工作区文本写到磁盘、从磁盘读回，以及列出/删除工作区文件，
//! **不解析工作区内容**，也不依赖 `AppState`、gRPC 连接或任何下位机状态，
//! 因此上位机在完全离线（未连接下位机）时也能正常工作。
//!
//! 备份文件命名规则（覆盖保存时生效）：
//! 旧文件被复制为 `<文件名主干>.json.bak`，即 `demo.mskwsp` 的备份是
//! `demo.json.bak`（`Path::with_extension("json.bak")` 会整体替换原扩展名）。
//! 该规则与 `commands::app_storage` 中的 `backup_path` 完全一致。

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

/// 工作区文件扩展名（不含点）。
const WORKSPACE_EXTENSION: &str = "mskwsp";
/// 备份文件扩展名；`Path::with_extension` 会用整体替换原扩展名。
const WORKSPACE_BACKUP_EXTENSION: &str = "json.bak";
/// UTF-8 BOM 字符，读取时统一剥离。
const UTF8_BOM: char = '\u{feff}';
/// 原子写入用临时文件名的固定片段，列表时用于排除残留临时文件。
const TEMPORARY_MARKER: &str = ".tmp-";

/// 工作区文件摘要，供离线工作区列表使用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSummaryDto {
    /// 工作区文件完整路径。
    pub file_path: String,
    /// 文件名（含扩展名）。
    pub file_name: String,
    /// 文件字节数。
    pub size_bytes: u64,
    /// 最后修改时间（Unix 毫秒）；无法读取时为 0。
    pub updated_at_ms: u64,
}

/// 校验并规范工作区路径：拒绝空路径与目录路径，缺扩展名时补 `.mskwsp`。
fn ensure_workspace_path(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("工作区文件路径不能为空".to_string());
    }

    let raw = PathBuf::from(trimmed);
    if trimmed.ends_with('/') || trimmed.ends_with('\\') || raw.is_dir() {
        return Err(format!("工作区文件路径指向目录而不是文件: {trimmed}"));
    }

    let mut path = raw;
    if path.extension().is_none() {
        path.set_extension(WORKSPACE_EXTENSION);
    }

    Ok(path)
}

/// 备份文件路径：`<文件名主干>.json.bak`（如 `demo.mskwsp` → `demo.json.bak`）。
fn backup_path(path: &Path) -> PathBuf {
    path.with_extension(WORKSPACE_BACKUP_EXTENSION)
}

/// 判断目录项是否为工作区文件：扩展名为 `mskwsp`（忽略大小写），排除隐藏文件与临时文件。
fn is_workspace_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if name.starts_with('.') || name.contains(TEMPORARY_MARKER) {
        return false;
    }

    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some(extension) if extension.eq_ignore_ascii_case(WORKSPACE_EXTENSION)
    )
}

/// 文件最后修改时间（Unix 毫秒）；元数据不可用时返回 0。
fn modified_at_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 去掉可能的 UTF-8 BOM；非 UTF-8 文本返回中文错误。
fn decode_workspace_text(bytes: &[u8], path: &Path) -> Result<String, String> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|error| {
        format!(
            "工作区文件不是合法的 UTF-8 文本: path={}, error={error}",
            path.display()
        )
    })?;

    Ok(text.strip_prefix(UTF8_BOM).unwrap_or(&text).to_string())
}

/// 原子写入工作区文本：同目录临时文件 → `sync_all` → 原子替换（替换前备份旧文件）。
///
/// 写入内容与传入的 `content` 完全一致（不额外追加换行），保证「保存后能原样读回」。
fn write_workspace_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "创建工作区目录失败: path={}, error={error}",
                    parent.display()
                )
            })?;
        }
    }

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!(
        "{WORKSPACE_EXTENSION}{TEMPORARY_MARKER}{}-{unique}",
        std::process::id()
    ));

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| {
            format!(
                "创建工作区临时文件失败: path={}, error={error}",
                temporary.display()
            )
        })?;
    file.write_all(content.as_bytes()).map_err(|error| {
        format!(
            "写入工作区临时文件失败: path={}, error={error}",
            temporary.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "刷新工作区临时文件失败: path={}, error={error}",
            temporary.display()
        )
    })?;
    drop(file);

    // 替换前备份上一版：备份失败则中止，避免在无备份的情况下覆盖用户数据。
    if path.is_file() {
        let backup = backup_path(path);
        fs::copy(path, &backup).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!(
                "备份工作区文件失败: path={}, backup={}, error={error}",
                path.display(),
                backup.display()
            )
        })?;
        tracing::info!(backup = %backup.display(), "已备份上一版工作区文件");
    }

    if let Err(error) = atomic_replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "替换工作区文件失败: path={}, error={error}",
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

/// 删除文件；文件本就不存在时视为成功（幂等）。
fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "删除工作区文件失败: path={}, error={error}",
            path.display()
        )),
    }
}

/// 列出目录下所有工作区文件，按最后修改时间倒序返回。
///
/// 目录不存在时按空列表返回（不报错，也不创建目录）。
#[tauri::command]
pub fn list_workspaces(directory: String) -> Result<Vec<WorkspaceSummaryDto>, String> {
    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return Err("工作区目录不能为空".to_string());
    }

    let root = PathBuf::from(trimmed);
    tracing::info!(directory = %root.display(), "开始列出离线工作区文件");

    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(directory = %root.display(), "离线工作区目录不存在，按空列表返回");
            return Ok(Vec::new());
        }
        Err(error) => {
            return Err(format!(
                "读取工作区目录失败: path={}, error={error}",
                root.display()
            ))
        }
    };

    let mut summaries = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!(directory = %root.display(), %error, "读取工作区目录项失败，已跳过");
                continue;
            }
        };
        let path = entry.path();
        if !is_workspace_file(&path) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "读取工作区文件元数据失败，已跳过");
                continue;
            }
        };
        if !metadata.is_file() {
            continue;
        }

        summaries.push(WorkspaceSummaryDto {
            file_path: path.to_string_lossy().into_owned(),
            file_name: entry.file_name().to_string_lossy().into_owned(),
            size_bytes: metadata.len(),
            updated_at_ms: modified_at_ms(&metadata),
        });
    }

    summaries.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });

    tracing::info!(directory = %root.display(), count = summaries.len(), "离线工作区文件列表读取完成");
    Ok(summaries)
}

/// 读取工作区文件文本；返回内容不含 BOM，文件不存在时报中文错误。
#[tauri::command]
pub fn load_workspace(file_path: String) -> Result<String, String> {
    tracing::info!(file_path = %file_path, "开始读取离线工作区文件");
    let path = ensure_workspace_path(&file_path)?;

    if !path.is_file() {
        return Err(format!("工作区文件不存在: {}", path.display()));
    }

    let bytes = fs::read(&path)
        .map_err(|error| format!("读取工作区文件失败: path={}, error={error}", path.display()))?;
    let content = decode_workspace_text(&bytes, &path)?;

    tracing::info!(file_path = %path.display(), bytes = bytes.len(), "离线工作区文件读取完成");
    Ok(content)
}

/// 保存工作区文本（原子写入），返回最终写入路径。
///
/// 覆盖已有文件前会把旧内容备份为 `<文件名主干>.json.bak`。
#[tauri::command]
pub fn save_workspace(file_path: String, content: String) -> Result<String, String> {
    tracing::info!(file_path = %file_path, bytes = content.len(), "开始保存离线工作区文件");
    let path = ensure_workspace_path(&file_path)?;

    write_workspace_file(&path, &content).map_err(|error| {
        tracing::error!(file_path = %path.display(), %error, "写入离线工作区文件失败");
        error
    })?;

    let final_path = path.to_string_lossy().into_owned();
    tracing::info!(file_path = %final_path, bytes = content.len(), "离线工作区文件保存完成");
    Ok(final_path)
}

/// 删除工作区文件及其备份文件；文件不存在时也返回成功（幂等）。
#[tauri::command]
pub fn delete_workspace(file_path: String) -> Result<(), String> {
    tracing::info!(file_path = %file_path, "开始删除离线工作区文件");
    let path = ensure_workspace_path(&file_path)?;
    let backup = backup_path(&path);

    remove_file_if_exists(&path)?;
    remove_file_if_exists(&backup)?;

    tracing::info!(file_path = %path.display(), backup = %backup.display(), "离线工作区文件删除完成");
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        thread::sleep,
        time::Duration,
    };

    use super::{delete_workspace, list_workspaces, load_workspace, save_workspace};

    /// 建立本次测试专用的临时目录；测试结束由 `cleanup` 清理。
    fn temp_workspace_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mskdsp-upper-workspace-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn save_then_load_returns_same_text_with_chinese_content() {
        let root = temp_workspace_dir("roundtrip");
        let path = root.join("带中文的工作区.mskwsp");
        let content =
            "{\n  \"workspace_name\": \"测试工作区\",\n  \"备注\": \"包含中文与换行\"\n}\n";

        let saved = save_workspace(text(&path), content.to_string()).unwrap();
        assert_eq!(saved, text(&path));
        assert_eq!(load_workspace(text(&path)).unwrap(), content);

        cleanup(&root);
    }

    #[test]
    fn empty_path_is_rejected_with_chinese_error() {
        let error = save_workspace("   ".to_string(), "内容".to_string()).unwrap_err();
        assert!(error.contains("不能为空"), "实际错误: {error}");

        let load_error = load_workspace(String::new()).unwrap_err();
        assert!(load_error.contains("不能为空"), "实际错误: {load_error}");

        let delete_error = delete_workspace("\t".to_string()).unwrap_err();
        assert!(
            delete_error.contains("不能为空"),
            "实际错误: {delete_error}"
        );

        let list_error = list_workspaces("  ".to_string()).unwrap_err();
        assert!(list_error.contains("不能为空"), "实际错误: {list_error}");
    }

    #[test]
    fn save_appends_default_extension_when_missing() {
        let root = temp_workspace_dir("extension");
        let path = root.join("无扩展名工作区");

        let saved = save_workspace(text(&path), "内容".to_string()).unwrap();
        assert!(saved.ends_with(".mskwsp"), "实际路径: {saved}");
        assert_eq!(
            fs::read_to_string(root.join("无扩展名工作区.mskwsp")).unwrap(),
            "内容"
        );

        cleanup(&root);
    }

    #[test]
    fn save_rejects_directory_path_with_chinese_error() {
        let root = temp_workspace_dir("directory");

        let error = save_workspace(text(&root), "内容".to_string()).unwrap_err();
        assert!(error.contains("目录"), "实际错误: {error}");
        assert!(root.is_dir());

        cleanup(&root);
    }

    #[test]
    fn overwrite_creates_backup_holding_previous_version() {
        let root = temp_workspace_dir("backup");
        let path = root.join("demo.mskwsp");
        // 备份命名规则：demo.mskwsp -> demo.json.bak。
        let backup = root.join("demo.json.bak");

        save_workspace(text(&path), "第一版内容".to_string()).unwrap();
        assert!(!backup.exists(), "首次保存不应产生备份");

        save_workspace(text(&path), "第二版内容".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "第二版内容");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "第一版内容");
        assert_eq!(load_workspace(text(&path)).unwrap(), "第二版内容");

        cleanup(&root);
    }

    #[test]
    fn load_missing_file_reports_chinese_error() {
        let root = temp_workspace_dir("missing");
        let path = root.join("不存在的工作区.mskwsp");

        let error = load_workspace(text(&path)).unwrap_err();
        assert!(error.contains("不存在"), "实际错误: {error}");
        assert!(error.contains("不存在的工作区.mskwsp"), "实际错误: {error}");

        cleanup(&root);
    }

    #[test]
    fn load_strips_utf8_bom() {
        let root = temp_workspace_dir("bom");
        let path = root.join("bom.mskwsp");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("{\"备注\":\"BOM\"}".as_bytes());
        fs::write(&path, bytes).unwrap();

        assert_eq!(load_workspace(text(&path)).unwrap(), "{\"备注\":\"BOM\"}");

        cleanup(&root);
    }

    #[test]
    fn list_workspaces_returns_all_workspaces_sorted_and_empty_for_missing_directory() {
        let root = temp_workspace_dir("list");
        let first = root.join("工作区甲.mskwsp");
        let second = root.join("工作区乙.mskwsp");

        save_workspace(text(&first), "甲".to_string()).unwrap();
        // 拉开修改时间，验证倒序排列。
        sleep(Duration::from_millis(20));
        save_workspace(text(&second), "乙乙".to_string()).unwrap();
        // 无关文件必须被忽略。
        fs::write(root.join("说明.txt"), "无关文件").unwrap();
        fs::write(root.join("备份.mskwsp.bak"), "无关文件").unwrap();

        let summaries = list_workspaces(text(&root)).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].file_name, "工作区乙.mskwsp");
        assert_eq!(summaries[1].file_name, "工作区甲.mskwsp");
        assert_eq!(summaries[0].file_path, text(&second));
        assert_eq!(summaries[0].size_bytes, "乙乙".len() as u64);
        assert_eq!(summaries[1].size_bytes, "甲".len() as u64);
        assert!(summaries[0].updated_at_ms >= summaries[1].updated_at_ms);
        assert!(summaries[1].updated_at_ms > 0);

        // 目录不存在时返回空列表而不是报错。
        let missing = root.join("不存在的目录").join("更深一层");
        assert!(list_workspaces(text(&missing)).unwrap().is_empty());

        cleanup(&root);
    }

    #[test]
    fn delete_workspace_is_idempotent_and_removes_backup() {
        let root = temp_workspace_dir("delete");
        let path = root.join("待删除.mskwsp");
        let backup = root.join("待删除.json.bak");

        save_workspace(text(&path), "第一版".to_string()).unwrap();
        save_workspace(text(&path), "第二版".to_string()).unwrap();
        assert!(path.is_file() && backup.is_file());

        delete_workspace(text(&path)).unwrap();
        assert!(!path.exists());
        assert!(!backup.exists());

        // 重复删除仍然成功（幂等）。
        delete_workspace(text(&path)).unwrap();
        delete_workspace(text(&backup)).unwrap();

        cleanup(&root);
    }
}
