use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

pub const APP_IDENTIFIER: &str = "com.mskdsp.upper";
const UPDATER_TEMP_PREFIX: &str = "MskDSP Upper-";
const UPDATER_TEMP_MARKER: &str = "-updater-";

#[derive(Clone, Debug)]
pub struct RuntimePaths {
    executable_dir: PathBuf,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    log_dir: PathBuf,
    using_fallback: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimePathsDto {
    pub executable_dir: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub log_dir: String,
    pub using_fallback: bool,
}

impl RuntimePaths {
    pub fn discover() -> Result<Self, String> {
        let executable =
            std::env::current_exe().map_err(|error| format!("获取上位机程序路径失败: {error}"))?;
        let executable_dir = executable
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("上位机程序路径没有父目录: {}", executable.display()))?;
        let preferred = create_writable_layout(&executable_dir);
        let (data_dir, cache_dir, log_dir, using_fallback) = match preferred {
            Ok(layout) => (layout.0, layout.1, layout.2, false),
            Err(preferred_error) => {
                let local_root = dirs::data_local_dir()
                    .ok_or_else(|| {
                        format!(
                            "exe 附近运行目录不可写，且无法获取用户本地数据目录: {preferred_error}"
                        )
                    })?
                    .join(APP_IDENTIFIER);
                let layout = create_writable_layout(&local_root).map_err(|fallback_error| {
                    format!(
                        "exe 附近与用户运行目录均不可写: preferred={}, preferred_error={preferred_error}, fallback={}, fallback_error={fallback_error}",
                        executable_dir.display(),
                        local_root.display(),
                    )
                })?;
                (layout.0, layout.1, layout.2, true)
            }
        };

        Ok(Self {
            executable_dir,
            data_dir,
            cache_dir,
            log_dir,
            using_fallback,
        })
    }

    pub fn executable_dir(&self) -> &Path {
        &self.executable_dir
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn lower_update_dir(&self) -> PathBuf {
        self.cache_dir.join("lower-update")
    }

    pub fn to_dto(&self) -> RuntimePathsDto {
        RuntimePathsDto {
            executable_dir: self.executable_dir.to_string_lossy().into_owned(),
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            cache_dir: self.cache_dir.to_string_lossy().into_owned(),
            log_dir: self.log_dir.to_string_lossy().into_owned(),
            using_fallback: self.using_fallback,
        }
    }
}

fn create_writable_layout(root: &Path) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let data_dir = root.join("data");
    let cache_dir = root.join("cache");
    let log_dir = root.join("logs");
    ensure_writable_directory(&data_dir)?;
    ensure_writable_directory(&cache_dir)?;
    ensure_writable_directory(&log_dir)?;
    Ok((data_dir, cache_dir, log_dir))
}

fn ensure_writable_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = path.join(format!(
        ".mskdsp-write-probe-{}-{unique}",
        std::process::id()
    ));
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|file| file.sync_all());
    let _ = fs::remove_file(&probe);
    result
}

pub fn cleanup_stale_updater_directories(max_age: Duration) -> io::Result<usize> {
    cleanup_stale_updater_directories_in(&std::env::temp_dir(), SystemTime::now(), max_age)
}

pub fn migrate_legacy_lower_update_cache(destination: &Path) -> io::Result<usize> {
    let Some(cache_dir) = dirs::cache_dir() else {
        return Ok(0);
    };
    let legacy = cache_dir.join(APP_IDENTIFIER).join("lower-update");
    if legacy == destination || !legacy.exists() {
        return Ok(0);
    }
    let metadata = fs::symlink_metadata(&legacy)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Ok(0);
    }
    fs::create_dir_all(destination)?;
    migrate_cache_tree(&legacy, destination)
}

fn migrate_cache_tree(source: &Path, destination: &Path) -> io::Result<usize> {
    let mut migrated_files = 0;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() && !file_type.is_symlink() {
            fs::create_dir_all(&destination_path)?;
            migrated_files += migrate_cache_tree(&source_path, &destination_path)?;
            let _ = fs::remove_dir(&source_path);
        } else if file_type.is_file() {
            if !destination_path.exists() {
                fs::copy(&source_path, &destination_path)?;
                migrated_files += 1;
            }
            fs::remove_file(&source_path)?;
        } else if file_type.is_symlink() {
            fs::remove_file(&source_path)?;
        }
    }
    let _ = fs::remove_dir(source);
    Ok(migrated_files)
}

fn cleanup_stale_updater_directories_in(
    temp_root: &Path,
    now: SystemTime,
    max_age: Duration,
) -> io::Result<usize> {
    let mut removed = 0;
    let entries = match fs::read_dir(temp_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() || file_type.is_symlink() || !is_updater_temp_directory(&path) {
            continue;
        }
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(_) => continue,
        };
        let age = now.duration_since(modified).unwrap_or_default();
        if age < max_age {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }

    Ok(removed)
}

fn is_updater_temp_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(UPDATER_TEMP_PREFIX) && name.contains(UPDATER_TEMP_MARKER)
        })
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::{
        cleanup_stale_updater_directories_in, is_updater_temp_directory, migrate_cache_tree,
    };

    fn temp_test_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mskdsp-upper-runtime-paths-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn recognizes_only_our_updater_directories() {
        assert!(is_updater_temp_directory(std::path::Path::new(
            "MskDSP Upper-0.4.2-updater-abc"
        )));
        assert!(!is_updater_temp_directory(std::path::Path::new(
            "Other App-0.4.2-updater-abc"
        )));
        assert!(!is_updater_temp_directory(std::path::Path::new(
            "MskDSP Upper-download"
        )));
    }

    #[test]
    fn cleanup_removes_only_matching_old_directories() {
        let root = temp_test_dir("cleanup");
        let updater = root.join("MskDSP Upper-0.4.2-updater-test");
        let unrelated = root.join("unrelated");
        std::fs::create_dir_all(&updater).unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();

        let removed = cleanup_stale_updater_directories_in(
            &root,
            SystemTime::now() + Duration::from_secs(1),
            Duration::ZERO,
        )
        .unwrap();

        assert_eq!(removed, 1);
        assert!(!updater.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_migration_preserves_destination_and_removes_legacy_files() {
        let root = temp_test_dir("cache-migration");
        let source = root.join("legacy");
        let destination = root.join("current");
        std::fs::create_dir_all(source.join("stable/linux-arm64")).unwrap();
        std::fs::create_dir_all(destination.join("stable/linux-arm64")).unwrap();
        std::fs::write(source.join("stable/linux-arm64/old.bin"), b"old").unwrap();
        std::fs::write(source.join("stable/linux-arm64/keep.bin"), b"legacy").unwrap();
        std::fs::write(destination.join("stable/linux-arm64/keep.bin"), b"current").unwrap();

        let migrated = migrate_cache_tree(&source, &destination).unwrap();

        assert_eq!(migrated, 1);
        assert_eq!(
            std::fs::read(destination.join("stable/linux-arm64/old.bin")).unwrap(),
            b"old"
        );
        assert_eq!(
            std::fs::read(destination.join("stable/linux-arm64/keep.bin")).unwrap(),
            b"current"
        );
        assert!(!source.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
