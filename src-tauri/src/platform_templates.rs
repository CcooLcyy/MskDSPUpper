//! 平台点表目录使用当前上位机会话获取，模板内容保持原始十进制 JSON。
use crate::platform_auth::PlatformAuthManager;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use tonic::{
    transport::{Channel, ClientTlsConfig, Endpoint},
    Code, Request,
};

pub mod protocol {
    tonic::include_proto!("mskdsp.platform.templates.v1");
}
use protocol::template_catalog_client::TemplateCatalogClient;

const JSON_LIMIT: usize = 10 * 1024 * 1024;
const MESSAGE_LIMIT: usize = 12 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateSummaryDto {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub manufacturer: String,
    pub models: Vec<String>,
    pub protocol_version: String,
    pub point_count: u32,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateRecordDto {
    pub id: String,
    pub revision: String,
    pub template_json: String,
    pub created_at: u64,
    pub updated_at: u64,
}

impl TemplateSummaryDto {
    fn validate(&self) -> Result<(), String> {
        validate_revision(&self.revision)?;
        if !valid_id(&self.id)
            || self.point_count == 0
            || self.point_count > 10000
            || self.name.trim().is_empty()
            || !valid_text(&self.name, 256)
            || !valid_text(&self.manufacturer, 256)
            || !valid_text(&self.protocol_version, 256)
            || self.models.len() > 100
            || self
                .models
                .iter()
                .any(|value| value.trim().is_empty() || !valid_text(value, 256))
        {
            return Err("平台点表目录格式不合法".into());
        }
        Ok(())
    }
}

impl TemplateRecordDto {
    fn validate(&self) -> Result<(), String> {
        validate_revision(&self.revision)?;
        if !valid_id(&self.id) || self.template_json.len() > JSON_LIMIT {
            return Err("平台点表标识无效或文件超过 10 MiB".into());
        }
        let template = serde_json::from_str(&self.template_json)
            .map_err(|_| "平台点表内容不是合法 JSON".to_string())?;
        crate::commands::modbus_templates::validate_template(&template)
    }
}

/// 仅接受受限的平台目录和经过模板校验的快照，缓存不承载登录凭据。
pub(crate) fn validate_cache(value: &serde_json::Value) -> Result<(), String> {
    let invalid = || "平台点表缓存格式不合法".to_string();
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > 50 * 1024 * 1024 {
        return Err("平台点表缓存不能超过 50 MiB".into());
    }
    let root = value.as_object().ok_or_else(invalid)?;
    if root.len() != 2
        || root
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
    {
        return Err(invalid());
    }
    let entries = root
        .get("entries")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(invalid)?;
    if entries.len() > 2001 {
        return Err("平台点表缓存条目数量超过限制".into());
    }
    for (key, entry) in entries {
        if !key.starts_with("protocol.modbus.platform-cache.v1:") || key.len() > 4096 {
            return Err(invalid());
        }
        let entry = entry.as_object().ok_or_else(invalid)?;
        if entry.len() != 2
            || entry
                .get("used_at")
                .and_then(serde_json::Value::as_u64)
                .is_none()
        {
            return Err(invalid());
        }
        let payload = entry.get("value").ok_or_else(invalid)?;
        if payload.is_array() {
            let summaries: Vec<TemplateSummaryDto> =
                serde_json::from_value(payload.clone()).map_err(|_| invalid())?;
            if summaries.len() > 1000 {
                return Err(invalid());
            }
            let mut ids = HashSet::new();
            for summary in summaries {
                summary.validate()?;
                if !ids.insert(summary.id) {
                    return Err(invalid());
                }
            }
        } else {
            let record: TemplateRecordDto =
                serde_json::from_value(payload.clone()).map_err(|_| invalid())?;
            record.validate()?;
        }
    }
    Ok(())
}

pub(crate) fn validate_revision(value: &str) -> Result<u64, String> {
    let number = value.parse::<u64>().ok().filter(|number| *number > 0);
    match number {
        Some(number) if number.to_string() == value => Ok(number),
        _ => Err("平台点表版本必须为有效的正整数".into()),
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn valid_text(value: &str, maximum: usize) -> bool {
    value.chars().count() <= maximum && !value.contains('\0')
}

fn request<T>(value: T, token: &str) -> Result<Request<T>, String> {
    let mut request = Request::new(value);
    request.set_timeout(Duration::from_secs(15));
    request.metadata_mut().insert(
        "authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "平台登录凭据无效，请重新登录".to_string())?,
    );
    Ok(request)
}

fn status(error: tonic::Status) -> String {
    tracing::warn!(code = ?error.code(), "平台点表读取失败");
    match error.code() {
        Code::Unauthenticated => "平台登录已失效，请重新登录".into(),
        Code::PermissionDenied => "当前平台账号没有读取点表的权限".into(),
        Code::NotFound => "平台点表或指定历史版本不存在，可能已被删除".into(),
        Code::Unimplemented => "当前平台不支持点表获取，请升级平台".into(),
        Code::DeadlineExceeded => "平台点表请求超时，请稍后重试".into(),
        Code::Unavailable => "平台点表服务暂时不可用，请稍后重试".into(),
        Code::ResourceExhausted => "平台点表响应超过大小限制".into(),
        _ => "读取平台点表失败，请检查平台日志".into(),
    }
}

async fn client(address: &str) -> Result<TemplateCatalogClient<Channel>, String> {
    let address = crate::platform_software::validate_endpoint(address)?;
    let mut endpoint = Endpoint::from_shared(address.clone())
        .map_err(|_| "平台点表地址不合法".to_string())?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15));
    if address.starts_with("https://") {
        endpoint = endpoint
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|_| "平台点表 TLS 校验配置失败".to_string())?;
    }
    let channel = endpoint
        .connect()
        .await
        .map_err(|_| "连接平台点表服务失败，请检查网络与 TLS".to_string())?;
    Ok(TemplateCatalogClient::new(channel).max_decoding_message_size(MESSAGE_LIMIT))
}

pub async fn list(auth: &PlatformAuthManager) -> Result<Vec<TemplateSummaryDto>, String> {
    let (endpoint, token, generation) = auth.remote_credentials()?;
    let result = tokio::time::timeout(TIMEOUT, async {
        client(&endpoint)
            .await?
            .list_templates(request(protocol::ListTemplatesRequest {}, &token)?)
            .await
            .map_err(status)
            .map(|response| response.into_inner().templates)
    })
    .await
    .map_err(|_| "平台点表请求超时，请稍后重试".to_string())?;
    if !auth.remote_generation_valid(generation) {
        return Err("平台登录已变化，请重新读取点表".into());
    }
    let records = result?;
    if records.len() > 1000 {
        return Err("平台点表目录超过数量限制".into());
    }
    let mut ids = HashSet::new();
    let mut output = Vec::with_capacity(records.len());
    for value in records {
        validate_revision(&value.revision)?;
        if !valid_id(&value.id)
            || !ids.insert(value.id.clone())
            || value.point_count == 0
            || value.point_count > 10000
            || value.name.trim().is_empty()
            || !valid_text(&value.name, 256)
            || !valid_text(&value.manufacturer, 256)
            || !valid_text(&value.protocol_version, 256)
            || value.models.len() > 100
            || value
                .models
                .iter()
                .any(|model| model.trim().is_empty() || !valid_text(model, 256))
        {
            return Err("平台点表目录格式不合法".into());
        }
        output.push(TemplateSummaryDto {
            id: value.id,
            revision: value.revision,
            name: value.name,
            manufacturer: value.manufacturer,
            models: value.models,
            protocol_version: value.protocol_version,
            point_count: value.point_count,
            updated_at: value.updated_at,
        });
    }
    tracing::info!(count = output.len(), "已获取平台点表目录");
    Ok(output)
}

pub async fn get(
    auth: &PlatformAuthManager,
    id: String,
    revision: Option<String>,
) -> Result<TemplateRecordDto, String> {
    if !valid_id(&id) {
        return Err("平台点表标识不合法".into());
    }
    let revision = revision
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    if !revision.is_empty() {
        validate_revision(&revision)?;
    }
    let (endpoint, token, generation) = auth.remote_credentials()?;
    let result = tokio::time::timeout(TIMEOUT, async {
        client(&endpoint)
            .await?
            .get_template(request(
                protocol::GetTemplateRequest {
                    id: id.clone(),
                    revision: revision.clone(),
                },
                &token,
            )?)
            .await
            .map_err(status)
            .map(|response| response.into_inner())
    })
    .await
    .map_err(|_| "平台点表请求超时，请稍后重试".to_string())?;
    if !auth.remote_generation_valid(generation) {
        return Err("平台登录已变化，请重新读取点表".into());
    }
    let value = result?;
    validate_revision(&value.revision)?;
    if value.id != id || (!revision.is_empty() && value.revision != revision) {
        return Err("平台点表身份或版本与所选记录不一致，请刷新目录".into());
    }
    if value.template_json.len() > JSON_LIMIT {
        return Err("平台点表文件不能超过 10 MiB".into());
    }
    let template: serde_json::Value = serde_json::from_str(&value.template_json)
        .map_err(|_| "平台点表内容不是合法 JSON".to_string())?;
    crate::commands::modbus_templates::validate_template(&template)?;
    tracing::info!(template_id = %id, revision = %value.revision, "已获取平台点表快照");
    Ok(TemplateRecordDto {
        id: value.id,
        revision: value.revision,
        template_json: value.template_json,
        created_at: value.created_at,
        updated_at: value.updated_at,
    })
}

#[cfg(test)]
#[path = "platform_templates_tests.rs"]
mod tests;
