//! 上位机更新状态：新下载失败时保留旧可安装包，安装只使用本地验签字节。
use crate::{
    platform_software::{self, Package, PlatformCatalog},
    state::AppState,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
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
}

#[derive(Default)]
pub struct AppUpdateStore {
    inner: Mutex<UpdateState>,
    operation: Mutex<()>,
}

fn channel(version: &str) -> &'static str {
    if version.contains("-ci.") {
        "ci"
    } else if version.contains("-beta.") {
        "beta"
    } else {
        "stable"
    }
}

fn candidate(
    package: Package,
    endpoint: String,
    current_version: &str,
) -> Result<Option<Candidate>, String> {
    let metadata = platform_software::metadata(&package)?;
    if metadata.version == current_version {
        return Ok(None);
    }
    if metadata.size > 512 * 1024 * 1024 || !metadata.file_name.ends_with(".exe") {
        return Err("上位机更新必须是有界的 NSIS 安装包".into());
    }
    let channel = channel(current_version).to_string();
    platform_software::matches_selection(&package, PRODUCT, PLATFORM, &channel)?;
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
        let previous = store.inner.lock().await.ready.replace(Ready {
            candidate: candidate.clone(),
            path: path.clone(),
        });
        if let Some(previous) = previous {
            if previous.path != path {
                let _ = tokio::fs::remove_file(previous.path).await;
            }
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
    inner.pending = None;
    if let Some(ready) = inner.ready.take() {
        let _ = tokio::fs::remove_file(ready.path).await;
    }
    tracing::info!("已释放上位机更新候选与待安装包");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
