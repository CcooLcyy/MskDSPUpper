use serde::Deserialize;
use tokio::sync::Mutex;

pub(super) const PROBE_COMMAND: &str = concat!(
    "set -e; ",
    "if ! command -v docker >/dev/null 2>&1; then ",
    "printf '%s\\n' '__MSKDSP_DOCKER_UNAVAILABLE__' >&2; exit 127; fi; ",
    "RESULT=\"$(docker inspect --type=container --format ",
    "'{{.State.Running}} {{.Image}}' mskdsp 2>&1)\" || { ",
    "case \"$RESULT\" in ",
    "*\"No such container\"*|*\"No such object\"*) ",
    "printf '%s\\n' '__MSKDSP_CONTAINER_MISSING__'; exit 0 ;; ",
    "*) printf '%s\\n' \"$RESULT\" >&2; exit 1 ;; esac; }; ",
    "printf '%s\\n' \"$RESULT\"; set -- $RESULT; ",
    "docker image inspect --format '{{json .}}' \"$2\""
);
pub(super) const CONFIG_DIGEST_SCRIPT: &str = include_str!("lower_update_runtime_digest.py");

const MAX_VERIFIED_MAPPINGS: usize = 64;
static VERIFIED_CONFIG_DIGESTS: Mutex<Vec<(String, String)>> = Mutex::const_new(Vec::new());

#[derive(Deserialize)]
struct ImageInspection {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Descriptor", default)]
    descriptor: Option<ImageDescriptor>,
}

#[derive(Deserialize)]
struct ImageDescriptor {
    digest: String,
}

pub(super) fn split_probe_output(stdout: &str) -> (&str, Option<&str>) {
    let output = stdout.trim();
    match output.split_once('\n') {
        Some((runtime, inspection)) => (runtime.trim(), Some(inspection.trim())),
        None => (output, None),
    }
}

// 有 descriptor 时 .Image 和 image inspect .Id 均可能是 manifest/index，不能当作 config。
pub(super) fn requires_config_resolution(
    raw_image_id: &str,
    inspection: Option<&str>,
) -> Result<bool, String> {
    let inspection: ImageInspection = serde_json::from_str(
        inspection.ok_or_else(|| "运行镜像查询缺少镜像存储类型信息".to_string())?,
    )
    .map_err(|_| "解析运行镜像存储类型失败".to_string())?;
    if !inspection.id.eq_ignore_ascii_case(raw_image_id) {
        return Err("运行容器引用与查询镜像身份不一致".into());
    }
    if let Some(descriptor) = inspection.descriptor {
        let Some((algorithm, digest)) = descriptor.digest.split_once(':') else {
            return Err("运行镜像 descriptor 摘要不合法".into());
        };
        if algorithm != "sha256"
            || digest.len() != 64
            || !digest.chars().all(|value| value.is_ascii_hexdigit())
        {
            return Err("运行镜像 descriptor 摘要不合法".into());
        }
        return Ok(true);
    }
    Ok(false)
}

pub(super) async fn cached_config_digest(raw_image_id: &str) -> Option<String> {
    VERIFIED_CONFIG_DIGESTS
        .lock()
        .await
        .iter()
        .find(|(reference, _)| reference == raw_image_id)
        .map(|(_, config)| config.clone())
}

pub(super) async fn cache_verified_config_digest(raw_image_id: String, config_digest: String) {
    let mut mappings = VERIFIED_CONFIG_DIGESTS.lock().await;
    remember_config_digest(&mut mappings, raw_image_id, config_digest);
}

fn remember_config_digest(
    mappings: &mut Vec<(String, String)>,
    raw_image_id: String,
    config_digest: String,
) {
    if let Some((_, value)) = mappings
        .iter_mut()
        .find(|(reference, _)| reference == &raw_image_id)
    {
        *value = config_digest;
        return;
    }
    if mappings.len() >= MAX_VERIFIED_MAPPINGS {
        mappings.remove(0);
    }
    mappings.push((raw_image_id, config_digest));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    // 验证经典 Docker 存储的 ID 已经是 config，无需远端 Python 或导出。
    #[test]
    fn classic_store_keeps_config_identity() {
        let raw = digest('a');
        let inspection = serde_json::json!({ "Id": raw }).to_string();
        assert!(!requires_config_resolution(&raw, Some(&inspection)).unwrap());
        let inspection = serde_json::json!({ "Id": raw, "Descriptor": null }).to_string();
        assert!(!requires_config_resolution(&raw, Some(&inspection)).unwrap());
    }

    // 验证 containerd 的 inspect Id 与容器 Image 一样时仍必须解析 config。
    #[test]
    fn containerd_identity_requires_verified_resolution() {
        let raw = digest('b');
        let inspection =
            serde_json::json!({ "Id": raw, "Descriptor": { "digest": raw } }).to_string();
        assert!(requires_config_resolution(&raw, Some(&inspection)).unwrap());
    }

    // 验证无法判断存储类型或身份不一致时明确查询失败，不能回退为错误的 config。
    #[test]
    fn refuses_missing_invalid_or_unrelated_inspection() {
        let raw = digest('c');
        assert!(requires_config_resolution(&raw, None).is_err());
        assert!(requires_config_resolution(&raw, Some("{}")).is_err());
        let unrelated = serde_json::json!({ "Id": digest('d') }).to_string();
        assert!(requires_config_resolution(&raw, Some(&unrelated)).is_err());
        let invalid =
            serde_json::json!({ "Id": raw, "Descriptor": { "digest": "latest" } }).to_string();
        assert!(requires_config_resolution(&raw, Some(&invalid)).is_err());
    }

    // 验证停止容器和容器不存在的状态协议保持原有含义。
    #[test]
    fn splits_runtime_state_without_changing_it() {
        let output = format!("false {}\n{{\"Id\":\"{}\"}}\n", digest('e'), digest('e'));
        let (state, inspection) = split_probe_output(&output);
        assert!(state.starts_with("false sha256:"));
        assert!(inspection.unwrap().starts_with('{'));
        assert_eq!(
            split_probe_output("__MSKDSP_CONTAINER_MISSING__\n"),
            ("__MSKDSP_CONTAINER_MISSING__", None)
        );
    }

    // 验证缓存按不可变摘要隔离，容量有界且同一个引用不会积累重复映射。
    #[test]
    fn cache_is_bounded_and_uses_immutable_references() {
        let mut cache = Vec::new();
        for index in 0..=MAX_VERIFIED_MAPPINGS {
            remember_config_digest(&mut cache, format!("sha256:{index:064x}"), digest('a'));
        }
        assert_eq!(cache.len(), MAX_VERIFIED_MAPPINGS);
        assert!(!cache
            .iter()
            .any(|(key, _)| key == &format!("sha256:{:064x}", 0)));
        let last = format!("sha256:{MAX_VERIFIED_MAPPINGS:064x}");
        remember_config_digest(&mut cache, last.clone(), digest('b'));
        assert_eq!(cache.len(), MAX_VERIFIED_MAPPINGS);
        assert_eq!(
            cache.iter().find(|(key, _)| key == &last).unwrap().1,
            digest('b')
        );
    }

    // 验证映射命中返回 config，实际容器切换到其他不可变引用时不能复用旧结果。
    #[tokio::test]
    async fn verified_cache_hits_only_the_same_runtime_reference() {
        let manifest = digest('7');
        let config = digest('2');
        cache_verified_config_digest(manifest.clone(), config.clone()).await;
        assert_eq!(cached_config_digest(&manifest).await, Some(config));
        assert_eq!(cached_config_digest(&digest('8')).await, None);
    }
}
