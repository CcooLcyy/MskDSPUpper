//! 上位机更新状态：新下载失败时保留旧可安装包，安装只使用本地验签字节。
use crate::{
    platform_software::{self, Package, PlatformCatalog},
    state::AppState,
    update_policy::validate_update_channel,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{OfflineUpdate, Update, UpdaterExt};
use tokio::sync::Mutex;

const PRODUCT: &str = "mskdsp-upper";
const PLATFORM: &str = "windows-x86_64-nsis";
const EVENT: &str = "app-update-download-progress";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
}

#[derive(Clone)]
struct Candidate {
    package: Package,
    endpoint: String,
    channel: String,
    info: AppUpdateInfo,
}
#[derive(Clone)]
struct Ready {
    candidate: Candidate,
    path: PathBuf,
}
#[derive(Default)]
struct UpdateState {
    pending: Option<Candidate>,
    ready: Option<Ready>,
}

impl UpdateState {
    fn checked(&mut self, pending: Option<Candidate>) {
        self.pending = pending;
    }

    fn release(&mut self) {
        self.pending = None;
        self.ready = None;
    }
}

// 仅在新包验签并落盘后调用，清理由旧进程遗留的缓存也遵循相同保留规则。
async fn cleanup_download_cache(directory: &Path, keep: &Path) -> io::Result<usize> {
    if keep.parent() != Some(directory)
        || keep.extension().and_then(|extension| extension.to_str()) != Some("exe")
        || !is_download_cache_file(keep)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "保留的上位机安装包路径不合法",
        ));
    }
    // 新包不存在或路径被替换为链接时不删除任何历史包。
    if !tokio::fs::symlink_metadata(directory)
        .await?
        .file_type()
        .is_dir()
        || !tokio::fs::symlink_metadata(keep)
            .await?
            .file_type()
            .is_file()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "上位机更新缓存目录或保留包不是普通目录或文件",
        ));
    }
    let mut entries = tokio::fs::read_dir(directory).await?;
    let keep_name = keep
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut removed = 0;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        // Windows 复用已有包时，目录中的实际大小写可能与平台摘要大小写不同。
        let is_kept = path == keep
            || (cfg!(windows)
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(keep_name)));
        if is_kept || !entry.file_type().await?.is_file() || !is_download_cache_file(&path) {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => removed += 1,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "清理上位机历史更新缓存失败，保留当前可安装包")
            }
        }
    }
    tracing::info!(removed_files = removed, retained_path = %keep.display(), "上位机更新缓存清理完成，保留最新已验签安装包");
    Ok(removed)
}

fn is_download_cache_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("exe" | "part")
    ) && path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.len() == 64 && stem.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

#[derive(Default)]
pub struct AppUpdateStore {
    inner: Mutex<UpdateState>,
    operation: Mutex<()>,
}

fn channel(version: &str) -> &'static str {
    if version.contains("-ci.") {
        "ci"
    } else {
        "stable"
    }
}

fn candidate(
    package: Package,
    endpoint: String,
    current_version: &str,
) -> Result<Option<Candidate>, String> {
    let channel = channel(current_version).to_string();
    validate_update_channel(current_version, &channel)?;
    platform_software::matches_selection(&package, PRODUCT, PLATFORM, &channel)?;
    let metadata = platform_software::metadata(&package)?;
    if metadata.version == current_version {
        return Ok(None);
    }
    if metadata.size > 512 * 1024 * 1024 || !metadata.file_name.ends_with(".exe") {
        return Err("上位机更新必须是有界的 NSIS 安装包".into());
    }
    let info = AppUpdateInfo {
        current_version: current_version.into(),
        version: metadata.version.clone(),
        date: Some(package.published_at.clone()),
        body: Some(metadata.notes.clone()),
        raw_json: serde_json::json!({"packageId":package.id,"sha256":metadata.sha256,"channel":channel,"platform":metadata.platform,"sourceSha":metadata.source_sha}),
    };
    Ok(Some(Candidate {
        package,
        endpoint,
        channel,
        info,
    }))
}

fn validate_candidate(current_version: &str, candidate: &Candidate) -> Result<(), String> {
    validate_update_channel(current_version, &candidate.channel)?;
    platform_software::matches_selection(&candidate.package, PRODUCT, PLATFORM, &candidate.channel)
}

fn local_update<R: tauri::Runtime>(
    app: &AppHandle<R>,
    candidate: &Candidate,
) -> Result<Update, String> {
    let metadata = platform_software::metadata(&candidate.package)?;
    let source = format!(
        "{}://{}/software/packages/{}",
        if candidate.endpoint.starts_with("https://") {
            "grpcs"
        } else {
            "grpc"
        },
        candidate
            .endpoint
            .split_once("://")
            .ok_or("平台来源格式不合法")?
            .1,
        candidate.package.id
    );
    app.updater_builder()
        .build_offline_update(OfflineUpdate {
            version: metadata.version.clone(),
            target: PLATFORM.into(),
            signature: metadata.signature.clone(),
            source: source.parse().map_err(|_| "平台软件来源标识不合法")?,
            body: Some(metadata.notes.clone()),
            raw_json: candidate.info.raw_json.clone(),
        })
        .map_err(|_| "构造本地签名安装对象失败".into())
}

fn emit(app: &AppHandle, task_id: &str, event: &str, data: Option<serde_json::Value>) {
    let payload = serde_json::json!({"task_id":task_id,"event":event,"data":data});
    if let Err(error) = app.emit(EVENT, payload) {
        tracing::warn!(%error, "发送上位机下载进度失败");
    }
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<AppUpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    validate_update_channel(&current, channel(&current))?;
    let endpoint = platform_software::configured_endpoint(&state)?;
    tracing::info!(channel = channel(&current), "开始查询平台上位机更新目录");
    let package = PlatformCatalog::new(&endpoint)?
        .latest(PRODUCT, PLATFORM, channel(&current))
        .await?;
    let pending = package
        .map(|package| candidate(package, endpoint, &current))
        .transpose()?
        .flatten();
    let info = pending.as_ref().map(|pending| pending.info.clone());
    state.app_updates.inner.lock().await.checked(pending);
    tracing::info!(available = info.is_some(), "平台上位机更新目录查询完成");
    Ok(info)
}

#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<AppUpdateInfo, String> {
    if task_id.is_empty() || task_id.len() > 128 {
        return Err("上位机下载任务标识不合法".into());
    }
    let store = Arc::clone(&state.app_updates);
    let _operation = store.operation.lock().await;
    let candidate = store
        .inner
        .lock()
        .await
        .pending
        .clone()
        .ok_or("没有可下载的上位机更新")?;
    validate_candidate(&app.package_info().version.to_string(), &candidate)?;
    if platform_software::configured_endpoint(&state)? != candidate.endpoint {
        return Err("平台地址已变化，请重新检查更新".into());
    }
    let catalog = PlatformCatalog::new(&candidate.endpoint)?;
    let package = catalog
        .get_expected(&candidate.package.id, PRODUCT, PLATFORM, &candidate.channel)
        .await?;
    if !platform_software::same_identity(&candidate.package, &package) {
        return Err("平台包身份已变化，请重新检查更新".into());
    }
    let metadata = platform_software::metadata(&package)?;
    let directory = state.runtime_paths.cache_dir().join("upper-update");
    let path = directory.join(format!("{}.exe", metadata.sha256));
    let partial = directory.join(format!("{}.part", metadata.sha256));
    emit(
        &app,
        &task_id,
        "Started",
        Some(serde_json::json!({"contentLength":metadata.size})),
    );
    let result = async {
        let reuse = platform_software::file_matches(&path, metadata.size, &metadata.sha256).await?;
        if !reuse {
            let mut last = 0;
            catalog
                .download(&package, &partial, |offset, _| {
                    if offset >= last {
                        emit(
                            &app,
                            &task_id,
                            "Progress",
                            Some(serde_json::json!({"chunkLength":offset-last})),
                        );
                        last = offset;
                    }
                })
                .await?;
        }
        let source = if reuse { &path } else { &partial };
        let bytes = tokio::fs::read(source)
            .await
            .map_err(|e| format!("读取上位机签名安装包失败：{e}"))?;
        local_update(&app, &candidate)?
            .verify(&bytes)
            .map_err(|_| "上位机更新包的 Tauri 签名校验失败")?;
        if source == &partial {
            if path.exists() {
                tokio::fs::remove_file(&path)
                    .await
                    .map_err(|e| format!("替换上位机缓存失败：{e}"))?;
            }
            tokio::fs::rename(&partial, &path)
                .await
                .map_err(|e| format!("保存上位机更新包失败：{e}"))?;
        }
        store.inner.lock().await.ready = Some(Ready {
            candidate: candidate.clone(),
            path: path.clone(),
        });
        if let Err(error) = cleanup_download_cache(&directory, &path).await {
            tracing::warn!(%error, "扫描上位机历史更新缓存失败，当前已验签安装包仍可安装");
        }
        emit(&app, &task_id, "Finished", None);
        tracing::info!(package_id = %package.id, "上位机更新包完整性与签名校验完成，等待手动安装");
        Ok(candidate.info.clone())
    }
    .await;
    if let Err(error) = &result {
        tracing::warn!(%error, "上位机更新下载失败，保留原可安装包");
    }
    result
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateInfo, String> {
    let store = Arc::clone(&state.app_updates);
    let _operation = store.operation.lock().await;
    let ready = store
        .inner
        .lock()
        .await
        .ready
        .clone()
        .ok_or("没有已下载且验签的上位机更新包")?;
    validate_candidate(&app.package_info().version.to_string(), &ready.candidate)?;
    let metadata = platform_software::metadata(&ready.candidate.package)?;
    let bytes = tokio::fs::read(&ready.path)
        .await
        .map_err(|e| format!("读取待安装上位机更新包失败：{e}"))?;
    if bytes.len() as u64 != metadata.size
        || format!("{:x}", Sha256::digest(&bytes)) != metadata.sha256.to_lowercase()
    {
        return Err("待安装上位机包已损坏，拒绝进入安装器".into());
    }
    let update = local_update(&app, &ready.candidate)?;
    tracing::info!(package_id = %ready.candidate.package.id, "开始对上位机更新包再次验签并交由原 NSIS 安装流程处理");
    tokio::task::spawn_blocking(move || update.install_verified(&bytes))
        .await
        .map_err(|_| "上位机安装任务异常退出")?
        .map_err(|_| "上位机更新签名校验或安装器执行失败")?;
    store.inner.lock().await.ready = None;
    Ok(ready.candidate.info)
}

#[tauri::command]
pub async fn dispose_app_update(state: State<'_, AppState>) -> Result<(), String> {
    let store = Arc::clone(&state.app_updates);
    let _operation = store.operation.lock().await;
    let mut inner = store.inner.lock().await;
    inner.release();
    tracing::info!("已释放上位机更新候选与待安装状态，保留最新安装包缓存");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CacheTestDir(PathBuf);

    impl CacheTestDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "upper-cache-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, "测试缓存内容".as_bytes()).unwrap();
            path
        }
    }

    impl Drop for CacheTestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // 验证清理跨进程遗留包和所有下载残留，只保留指定包且可重复调用。
    #[tokio::test]
    async fn download_cache_keeps_only_verified_package() {
        let root = CacheTestDir::new();
        let keep = root.file(&format!("{}.exe", "a".repeat(64)));
        let old = root.file(&format!("{}.exe", "b".repeat(64)));
        let interrupted = root.file(&format!("{}.part", "c".repeat(64)));
        let same_partial = root.file(&format!("{}.part", "a".repeat(64)));
        let unrelated = root.file("notes.txt");
        let foreign = root.file("manual-installer.exe");
        let short = root.file(&format!("{}.exe", "a".repeat(63)));
        let long = root.file(&format!("{}.exe", "a".repeat(65)));
        let non_hex = root.file(&format!("{}.exe", "g".repeat(64)));
        let directory = root.0.join(format!("{}.exe", "d".repeat(64)));
        std::fs::create_dir(&directory).unwrap();
        let nested = directory.join(format!("{}.exe", "e".repeat(64)));
        std::fs::write(&nested, "保留子目录内容".as_bytes()).unwrap();

        assert_eq!(cleanup_download_cache(&root.0, &keep).await.unwrap(), 3);
        assert_eq!(std::fs::read(&keep).unwrap(), "测试缓存内容".as_bytes());
        for path in [old, interrupted, same_partial] {
            assert!(!path.exists(), "历史缓存未清理：{}", path.display());
        }
        for path in [unrelated, foreign, short, long, non_hex, nested] {
            assert!(path.exists(), "误删非缓存文件：{}", path.display());
        }
        assert_eq!(cleanup_download_cache(&root.0, &keep).await.unwrap(), 0);
    }

    // 验证 Windows 文件占用不会影响最新包和其他残留清理，解锁后可再次清理。
    #[cfg(windows)]
    #[tokio::test]
    async fn download_cache_retries_locked_old_package_without_losing_latest() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = CacheTestDir::new();
        let keep = root.file(&format!("{}.exe", "a".repeat(64)));
        let old = root.file(&format!("{}.exe", "b".repeat(64)));
        let partial = root.file(&format!("{}.part", "c".repeat(64)));
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&old)
            .unwrap();
        assert_eq!(cleanup_download_cache(&root.0, &keep).await.unwrap(), 1);
        assert!(keep.is_file());
        assert!(old.is_file());
        assert!(!partial.exists());
        drop(locked);
        assert_eq!(cleanup_download_cache(&root.0, &keep).await.unwrap(), 1);
        assert!(keep.is_file());
        assert!(!old.exists());
    }

    // 验证 Windows 缓存复用时摘要大小写变化不会误删保留包。
    #[cfg(windows)]
    #[tokio::test]
    async fn download_cache_preserves_case_insensitive_keep_path() {
        let root = CacheTestDir::new();
        let actual = root.file(&format!("{}.exe", "a".repeat(64)));
        let keep = root.0.join(format!("{}.exe", "A".repeat(64)));
        let old = root.file(&format!("{}.exe", "b".repeat(64)));
        assert_eq!(cleanup_download_cache(&root.0, &keep).await.unwrap(), 1);
        assert!(actual.is_file());
        assert!(keep.is_file());
        assert!(!old.exists());
    }

    // 验证新包尚未落盘或保留路径越界时拒绝清理，旧包和续传文件保持完整。
    #[tokio::test]
    async fn download_cache_rejects_missing_or_external_keep_without_deleting_old_package() {
        let root = CacheTestDir::new();
        let outside = CacheTestDir::new();
        let old = root.file(&format!("{}.exe", "a".repeat(64)));
        let partial = root.file(&format!("{}.part", "b".repeat(64)));
        let missing = root.0.join(format!("{}.exe", "c".repeat(64)));
        let external = outside.file(&format!("{}.exe", "d".repeat(64)));
        for keep in [missing, external] {
            assert!(cleanup_download_cache(&root.0, &keep).await.is_err());
            assert!(old.exists());
            assert!(partial.exists());
        }
    }

    // 验证释放待安装状态只清除内存，最新安装包仍可跨进程复用。
    #[test]
    fn releasing_update_state_preserves_downloaded_file() {
        let root = CacheTestDir::new();
        let path = root.file(&format!("{}.exe", "a".repeat(64)));
        let candidate = candidate(package(), "http://127.0.0.1:50000".into(), "0.7.1-ci.test")
            .unwrap()
            .unwrap();
        let mut state = UpdateState {
            pending: Some(candidate.clone()),
            ready: Some(Ready {
                candidate,
                path: path.clone(),
            }),
        };
        state.release();
        assert!(state.pending.is_none());
        assert!(state.ready.is_none());
        assert!(path.is_file());
    }

    fn package() -> Package {
        let bytes = include_bytes!("../../testdata/updater/fixture.bin");
        Package {
            id: "test-package".into(),
            channels: vec!["ci".into()],
            ever_published: true,
            metadata: Some(platform_software::PackageMetadata {
                product: PRODUCT.into(),
                platform: PLATFORM.into(),
                version: "0.7.2-ci.test+sha.abcdef0".into(),
                file_name: "upper.exe".into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
                signature: include_str!("../../testdata/updater/fixture.sig")
                    .trim()
                    .into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    // 验证完整版本相等时不提示更新，CI 回退版本仍按字符串身份差异提供候选。
    #[test]
    fn installed_version_is_current_without_semver_ordering() {
        let mut package = package();
        package.metadata.as_mut().unwrap().version = "0.7.1-ci.test".into();
        assert!(candidate(
            package.clone(),
            "http://127.0.0.1:50000".into(),
            "0.7.1-ci.test"
        )
        .unwrap()
        .is_none());
        assert!(
            candidate(package, "http://127.0.0.1:50000".into(), "0.7.9-ci.newer")
                .unwrap()
                .is_some()
        );
    }

    // 验证新检查没有候选时仍保留已验签的旧包，不产生无可安装包的窗口。
    #[test]
    fn checking_never_discards_ready_package() {
        let candidate = candidate(package(), "http://127.0.0.1:50000".into(), "0.7.1-ci.test")
            .unwrap()
            .unwrap();
        let mut state = UpdateState {
            pending: Some(candidate.clone()),
            ready: Some(Ready {
                candidate,
                path: "old.exe".into(),
            }),
        };
        state.checked(None);
        assert!(state.pending.is_none());
        assert_eq!(state.ready.unwrap().path, PathBuf::from("old.exe"));
    }

    #[test]
    fn stable_accepts_promoted_package_with_prerelease_version() {
        let mut package = package();
        package.channels.push("stable".into());
        let candidate = candidate(package, "http://127.0.0.1:50000".into(), "0.7.1")
            .unwrap()
            .unwrap();
        assert_eq!(candidate.channel, "stable");
        assert!(candidate.info.version.contains("-ci."));
        assert!(validate_candidate("0.7.1", &candidate).is_ok());
    }

    #[test]
    fn stable_rejects_nonstable_catalog_and_cached_candidates() {
        assert!(candidate(package(), "http://127.0.0.1:50000".into(), "0.7.1").is_err());
        let cached = candidate(package(), "http://127.0.0.1:50000".into(), "0.7.1-ci.test")
            .unwrap()
            .unwrap();
        assert!(validate_candidate("0.7.1", &cached).is_err());
        assert!(validate_candidate("0.7.1-beta.1", &cached).is_err());
    }

    // 历史 Beta 客户端版本转向正式目录，CI 仍查询自身目录。
    #[test]
    fn retired_beta_versions_use_stable_catalog() {
        assert_eq!(super::channel("0.8.0-beta.1"), "stable");
        assert_eq!(super::channel("0.9.0-ci.123+sha.abcdef0"), "ci");
        assert_eq!(super::channel("0.8.1"), "stable");
        let mut stable_package = package();
        stable_package.channels = vec!["stable".into()];
        let update = candidate(
            stable_package,
            "http://127.0.0.1:50000".into(),
            "0.8.0-beta.1",
        )
        .unwrap()
        .unwrap();
        assert_eq!(update.channel, "stable");
    }

    #[test]
    fn cached_candidate_channel_must_match_package_publication() {
        let mut cached = candidate(package(), "http://127.0.0.1:50000".into(), "0.7.1-ci.test")
            .unwrap()
            .unwrap();
        cached.channel = "stable".into();
        assert!(validate_candidate("0.7.1", &cached).is_err());
    }

    // 使用独立临时密钥生成的公开签名夹具，验证原 Tauri 验签成功且错误签名不能进入安装器。
    #[test]
    fn native_signature_verification_precedes_installer() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": include_str!("../../testdata/updater/fixture.pub").trim(), "endpoints": []
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(
                tauri_plugin_updater::Builder::new()
                    .pubkey(include_str!("../../testdata/updater/fixture.pub").trim())
                    .build(),
            )
            .build(context)
            .unwrap();
        let candidate = candidate(package(), "http://127.0.0.1:50000".into(), "0.7.1-ci.test")
            .unwrap()
            .unwrap();
        let update = local_update(app.handle(), &candidate).unwrap();
        assert_eq!(update.download_url.scheme(), "grpc");
        assert!(update
            .verify(include_bytes!("../../testdata/updater/fixture.bin"))
            .is_ok());
        let error = update.install_verified(b"corrupt bytes").unwrap_err();
        assert!(matches!(error, tauri_plugin_updater::Error::Minisign(_)));
    }
}
