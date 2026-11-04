//! 独立纵密登录、默认密码修改与只读初始化；未知应答不建立身份。
use crate::state::AppState;
use native_tls::{Certificate, Identity};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sm3::{Digest, Sm3};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWriteExt},
    sync::watch,
};
use zeroize::{Zeroize, Zeroizing};

#[path = "security_login_tunnels.rs"]
mod tunnels;

#[path = "security_login_admin.rs"]
mod admin;
pub use admin::{AdminRequest, AdminResult};

#[path = "security_login_operator.rs"]
mod operator;
#[path = "security_login_operator_codec.rs"]
mod operator_codec;
pub use operator::{OperatorRequest, OperatorResult};

#[path = "security_login_builtin.rs"]
mod builtin;

#[path = "security_login_sessions.rs"]
mod sessions;

#[path = "security_login_protocol.rs"]
mod protocol;
use protocol::{read_login_reply, Reply};
use sessions::{ConnectionContext, ConnectionKind, StoredConnection};

#[path = "security_login_lockout.rs"]
mod lockout;
pub use lockout::LoginLockStatus;
use lockout::{AccountKey, AuthenticationBlocked};

const TARGET_IP: &str = "11.22.33.44";
const TARGET_PORT: u16 = 8888;
const MAX_CERT_BYTES: u64 = 4 * 1024 * 1024;
const REMOTE_REASON: &str = "远程纵密网络通道待接入，平台在线或 SSH 可达不能代替纵密管理连接";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinMode {
    #[default]
    Auto,
    Old,
    New,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuiltinCertificateRequest {
    mode: BuiltinMode,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LoginMode {
    Direct,
    Remote,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    request_id: String,
    mode: LoginMode,
    device_id: Option<String>,
    username: String,
    password: String,
    role: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OneClickLoginRequest {
    request_id: String,
    mode: LoginMode,
    device_id: Option<String>,
    role: u8,
}

fn automatic_account(role: u8) -> Option<(&'static str, &'static str)> {
    match role {
        1 => Some(("admin", "Nari.6712")),
        2 => Some(("secure", "Nari6702")),
        _ => None,
    }
}

const MANAGED_PASSWORD: &str = "Meg@Admin123";
impl Drop for LoginRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CertificateRequest {
    client_certificate_path: String,
    trust_certificate_path: String,
    certificate_password: String,
    server_name: String,
}
impl Drop for CertificateRequest {
    fn drop(&mut self) {
        self.certificate_password.zeroize();
    }
}

#[derive(Clone, Serialize)]
pub struct CertificateProfile {
    configured: bool,
    source: &'static str,
    label: &'static str,
    builtin_mode: Option<BuiltinMode>,
    client_certificate_path: Option<String>,
    trust_certificate_path: Option<String>,
    server_name: Option<String>,
}
impl Default for CertificateProfile {
    fn default() -> Self {
        Self {
            configured: false,
            source: "builtin",
            label: "内置配套证书",
            builtin_mode: Some(BuiltinMode::Auto),
            client_certificate_path: None,
            trust_certificate_path: None,
            server_name: None,
        }
    }
}

#[derive(Serialize)]
pub struct LoginCapabilities {
    direct_available: bool,
    remote_available: bool,
    password_change_available: bool,
    reason: &'static str,
}
#[derive(Serialize)]
pub struct LoginStep {
    id: &'static str,
    name: &'static str,
    state: &'static str,
    message: String,
}
#[derive(Serialize)]
pub struct LoginResult {
    request_id: String,
    state: &'static str,
    code: &'static str,
    message: String,
    target_ip: &'static str,
    mode: LoginMode,
    device_id: Option<String>,
    session_id: Option<String>,
    challenge_id: Option<String>,
    username: Option<String>,
    role: Option<u8>,
    lock_seconds: Option<u32>,
    last_login_at: Option<String>,
    device_version: Option<String>,
    certificate_group: Option<&'static str>,
    legacy_compatibility: bool,
    steps: Vec<LoginStep>,
}
impl LoginResult {
    fn new(request: &LoginRequest) -> Self {
        Self {
            request_id: request.request_id.clone(),
            state: "failed",
            code: "not_started",
            message: String::new(),
            target_ip: TARGET_IP,
            mode: request.mode,
            device_id: request.device_id.clone(),
            session_id: None,
            challenge_id: None,
            username: None,
            role: None,
            lock_seconds: None,
            last_login_at: None,
            device_version: None,
            certificate_group: None,
            legacy_compatibility: false,
            steps: [
                ("connect", "连接纵密"),
                ("tls", "证书连接"),
                ("authenticate", "身份认证"),
                ("initialize", "读取登录资料"),
            ]
            .into_iter()
            .map(|(id, name)| LoginStep {
                id,
                name,
                state: "pending",
                message: "尚未执行".into(),
            })
            .collect(),
        }
    }
    fn failure(mut self, index: usize, code: &'static str, message: &str) -> Self {
        self.state = "failed";
        self.code = code;
        self.message = message.into();
        self.steps[index].state = "failed";
        self.steps[index].message = message.into();
        self
    }
    fn success_step(&mut self, index: usize, message: &str) {
        self.steps[index].state = "success";
        self.steps[index].message = message.into();
    }
}

struct TlsCandidate {
    connector: tokio_native_tls::TlsConnector,
    validity: Option<builtin::Validity>,
    group: Option<&'static str>,
    legacy_compatibility: bool,
    server_name: String,
}
struct LoadedProfile {
    metadata: CertificateProfile,
    candidates: Vec<TlsCandidate>,
}
#[derive(Default)]
struct LoginInner {
    profile: Option<Arc<LoadedProfile>>,
    builtin_cache: HashMap<BuiltinMode, Arc<LoadedProfile>>,
    pending: HashMap<String, watch::Sender<bool>>,
    connections: HashMap<String, StoredConnection>,
    // 保留取消及完成记录，防止 IPC 迟到造成先取消后启动，或重复使用请求标识。
    retired: HashMap<String, Instant>,
    config_generation: u64,
}
#[derive(Default)]
pub struct SecurityLoginManager {
    inner: Mutex<LoginInner>,
    // 固定直连目标的完整认证流程独占，包括换密码、重连和手动认证入口。
    authentication: tokio::sync::Mutex<()>,
    management_probe: tokio::sync::Mutex<()>,
    lockout: Mutex<lockout::LockoutState>,
}
struct RequestGuard<'a> {
    manager: &'a SecurityLoginManager,
    id: String,
}
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.manager.inner.lock();
        inner.pending.remove(&self.id);
        inner.retired.insert(self.id.clone(), Instant::now());
    }
}
impl SecurityLoginManager {
    fn advance_configuration(inner: &mut LoginInner) -> u64 {
        tracing::info!("证书配置开始变化，立即取消纵密请求并关闭已有身份和改密连接");
        inner.config_generation = inner.config_generation.wrapping_add(1);
        for sender in inner.pending.values() {
            let _ = sender.send(true);
        }
        for (_, entry) in inner.connections.drain() {
            entry.close();
        }
        inner.config_generation
    }
    pub fn cancel_all(&self) {
        tracing::info!("清理纵密登录请求、临时改密连接与已登录身份，保留进程证书配置");
        let mut inner = self.inner.lock();
        for cancellation in inner.pending.values() {
            let _ = cancellation.send(true);
        }
        for (_, entry) in inner.connections.drain() {
            entry.close();
        }
    }
    fn prune(inner: &mut LoginInner) {
        inner
            .retired
            .retain(|_, at| at.elapsed() < Duration::from_secs(300));
        let generation = inner.config_generation;
        inner.connections.retain(|_, entry| {
            let active =
                entry.context.expires_at > Instant::now() && entry.context.generation == generation;
            if !active {
                entry.close();
            }
            active
        });
    }
    fn begin(&self, id: &str) -> Result<(watch::Receiver<bool>, RequestGuard<'_>), &'static str> {
        validate_request_id(id)?;
        let mut inner = self.inner.lock();
        Self::prune(&mut inner);
        if inner.pending.contains_key(id) || inner.retired.contains_key(id) {
            return Err("请求标识已经使用或取消，请重新发起登录");
        }
        if inner.pending.len() >= 4 || inner.retired.len() >= 1024 {
            return Err("纵密请求过多，请稍后重试");
        }
        let (sender, receiver) = watch::channel(false);
        inner.pending.insert(id.to_string(), sender);
        Ok((
            receiver,
            RequestGuard {
                manager: self,
                id: id.into(),
            },
        ))
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        tracing::info!("收到纵密登录取消请求");
        validate_request_id(id).map_err(str::to_string)?;
        let mut inner = self.inner.lock();
        Self::prune(&mut inner);
        if let Some(sender) = inner.pending.get(id) {
            let _ = sender.send(true);
        }
        inner.connections.retain(|connection_id, entry| {
            let keep = connection_id != id && entry.context.request_id != id;
            if !keep {
                entry.close();
            }
            keep
        });
        if inner.pending.contains_key(id) {
            return Ok(());
        }
        if inner.retired.contains_key(id) {
            return Ok(());
        }
        if inner.retired.len() >= 1024 {
            return Err("取消记录已满，请稍后重试".into());
        }
        inner.retired.insert(id.to_string(), Instant::now());
        Ok(())
    }
}
fn validate_request_id(id: &str) -> Result<(), &'static str> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
    {
        return Err("请求标识格式无效");
    }
    Ok(())
}

fn sm3_hex(input: &[u8]) -> String {
    Sm3::digest(input)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}
fn encode_login(
    username: &str,
    password: &str,
    role: u8,
) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    if !(1..=3).contains(&role) {
        return Err("纵密角色无效");
    }
    for value in [username, password] {
        if value.is_empty() || value.encode_utf16().count() > 32 {
            return Err("用户名和密码应为 1 至 32 个字符");
        }
        if !value.is_ascii() || value.bytes().any(|byte| byte.is_ascii_control()) {
            return Err("非 ASCII 凭据的原软件编码尚未确认，当前不发送该凭据");
        }
    }
    let mut input = Zeroizing::new(Vec::with_capacity(username.len() + password.len()));
    input.extend_from_slice(username.as_bytes());
    input.extend_from_slice(password.as_bytes());
    let hash = Zeroizing::new(sm3_hex(&input));
    let mut packet = Zeroizing::new(Vec::with_capacity(13 + username.len() + hash.len()));
    packet.extend_from_slice(&12_i32.to_be_bytes());
    packet.extend_from_slice(&(username.len() as i32).to_be_bytes());
    packet.extend_from_slice(username.as_bytes());
    packet.extend_from_slice(&(hash.len() as i32).to_be_bytes());
    packet.extend_from_slice(hash.as_bytes());
    packet.push(role);
    Ok(packet)
}

fn read_certificate_file(path: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if !Path::new(path).is_absolute() {
        return Err("请选择证书文件的绝对路径".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "无法打开所选证书文件".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "无法读取所选证书文件信息".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CERT_BYTES {
        return Err("证书文件应为非空普通文件，且不超过 4 MiB".into());
    }
    let mut data = Zeroizing::new(Vec::new());
    file.take(MAX_CERT_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| "无法读取所选证书文件".to_string())?;
    if data.len() as u64 > MAX_CERT_BYTES {
        return Err("证书文件超过 4 MiB".into());
    }
    Ok(data)
}
fn load_profile(mut request: CertificateRequest) -> Result<LoadedProfile, String> {
    let name = request.server_name.trim();
    if name.is_empty()
        || name.len() > 253
        || !name.is_ascii()
        || name
            .bytes()
            .any(|b| !(b.is_ascii_alphanumeric() || b".-:".contains(&b)))
    {
        return Err("请填写证书对应的有效服务器名称或 IP".into());
    }
    let client = read_certificate_file(&request.client_certificate_path)?;
    let identity = Identity::from_pkcs12(&client, &request.certificate_password)
        .map_err(|_| "无法加载客户端 PKCS12，请检查格式与证书口令".to_string())?;
    request.certificate_password.zeroize();
    let trust = read_certificate_file(&request.trust_certificate_path)?;
    let certificate = Certificate::from_pem(&trust)
        .or_else(|_| Certificate::from_der(&trust))
        .map_err(|_| "信任证书必须为 PEM 或 DER X.509 格式".to_string())?;
    let mut builder = native_tls::TlsConnector::builder();
    builder
        .identity(identity)
        .disable_built_in_roots(true)
        .add_root_certificate(certificate);
    // 始终启用证书链和服务器名称校验，不降低 TLS 默认安全配置。
    let connector = builder
        .build()
        .map_err(|_| "无法创建纵密证书连接配置".to_string())?;
    let server_name = request.server_name.trim().to_string();
    Ok(LoadedProfile {
        metadata: CertificateProfile {
            configured: true,
            source: "custom",
            label: "自定义证书",
            builtin_mode: None,
            client_certificate_path: Some(request.client_certificate_path.clone()),
            trust_certificate_path: Some(request.trust_certificate_path.clone()),
            server_name: Some(server_name.clone()),
        },
        candidates: vec![TlsCandidate {
            connector: connector.into(),
            validity: None,
            group: None,
            legacy_compatibility: false,
            server_name: server_name.clone(),
        }],
    })
}

#[cfg(test)]
fn load_builtin_profile() -> Result<LoadedProfile, String> {
    load_builtin_profile_at(current_unix_time()?)
}

fn current_unix_time() -> Result<i64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效，无法检查内置证书有效期".to_string())
        .and_then(|duration| {
            i64::try_from(duration.as_secs()).map_err(|_| "系统时间无效".to_string())
        })
}

fn parse_builtin_candidate(resource: &builtin::BuiltinIdentity) -> Result<TlsCandidate, String> {
    let password = builtin::bundle_password(resource.unlock_seed);
    let identity = Identity::from_pkcs12(resource.identity, &password)
        .map_err(|_| "内置配套客户端证书无法解析，请检查程序资源".to_string())?;
    let mut builder = native_tls::TlsConnector::builder();
    builder.identity(identity).disable_built_in_roots(true);
    for encoded in resource.trust {
        let certificate = Certificate::from_der(encoded)
            .map_err(|_| "内置配套信任证书无法解析，请检查程序资源".to_string())?;
        builder.add_root_certificate(certificate);
    }
    if resource.id == "old" {
        #[cfg(windows)]
        builder.mskdsp_legacy_certificate_pin(
            Certificate::from_der(resource.trust[0])
                .map_err(|_| "旧版配套 pin 证书无法解析".to_string())?,
        );
        #[cfg(not(windows))]
        return Err("旧版配套证书兼容仅支持 Windows 桌面上位机".into());
    }
    let connector = builder
        .build()
        .map_err(|_| "内置配套证书连接配置加载失败".to_string())?;
    Ok(TlsCandidate {
        connector: connector.into(),
        validity: Some(resource.validity()?),
        group: Some(resource.id),
        legacy_compatibility: resource.id == "old",
        server_name: if resource.id == "new" {
            "NARI"
        } else {
            TARGET_IP
        }
        .into(),
    })
}

#[cfg(test)]
fn load_builtin_profile_at(now: i64) -> Result<LoadedProfile, String> {
    load_builtin_profile_mode_at(now, BuiltinMode::Auto)
}

fn load_builtin_profile_mode_at(now: i64, mode: BuiltinMode) -> Result<LoadedProfile, String> {
    let mut candidates = Vec::with_capacity(builtin::IDENTITIES.len());
    for resource in builtin::IDENTITIES {
        if (mode == BuiltinMode::Old && resource.id != "old")
            || (mode == BuiltinMode::New && resource.id != "new")
        {
            continue;
        }
        #[cfg(not(windows))]
        if resource.id == "old" && mode == BuiltinMode::Auto {
            continue;
        }
        if resource.id != "old" && !resource.validity()?.contains(now) {
            tracing::info!(profile = resource.id, "内置纵密证书不在有效期内，已跳过");
            continue;
        }
        candidates.push(parse_builtin_candidate(resource)?);
        tracing::info!(profile = resource.id, "内置纵密配套证书已在进程内解析");
    }
    if candidates.is_empty() {
        return Err("内置配套证书均未生效或已过期，请检查系统时间或替换有效证书".into());
    }
    let label = match mode {
        BuiltinMode::Auto => "内置配套证书（自动匹配）",
        BuiltinMode::Old => "内置配套证书（旧版）",
        BuiltinMode::New => "内置配套证书（新版）",
    };
    Ok(LoadedProfile {
        metadata: CertificateProfile {
            configured: true,
            source: "builtin",
            label,
            builtin_mode: Some(mode),
            client_certificate_path: None,
            trust_certificate_path: None,
            server_name: match mode {
                BuiltinMode::Auto => None,
                BuiltinMode::Old => Some(TARGET_IP.into()),
                BuiltinMode::New => Some("NARI".into()),
            },
        },
        candidates,
    })
}

async fn initialize_builtin_profile(
    manager: &SecurityLoginManager,
    force: bool,
    mode: BuiltinMode,
) -> Result<Arc<LoadedProfile>, String> {
    let (generation, cached) = {
        let mut inner = manager.inner.lock();
        if !force {
            if let Some(profile) = &inner.profile {
                return Ok(profile.clone());
            }
        } else {
            SecurityLoginManager::advance_configuration(&mut inner);
        }
        (
            inner.config_generation,
            inner.builtin_cache.get(&mode).cloned(),
        )
    };
    let loaded = match cached {
        Some(cached) => cached,
        None => Arc::new(
            tokio::task::spawn_blocking(move || {
                load_builtin_profile_mode_at(current_unix_time()?, mode)
            })
            .await
            .map_err(|_| "内置证书加载任务未完成".to_string())??,
        ),
    };
    activate_builtin_profile(manager, generation, force, loaded)
}

fn activate_builtin_profile(
    manager: &SecurityLoginManager,
    generation: u64,
    force: bool,
    loaded: Arc<LoadedProfile>,
) -> Result<Arc<LoadedProfile>, String> {
    let mut inner = manager.inner.lock();
    if !force {
        if let Some(profile) = &inner.profile {
            return Ok(profile.clone());
        }
    }
    if inner.config_generation != generation {
        return Err("证书配置已被后续请求替代，请重新检查配置".into());
    }
    if force {
        for sender in inner.pending.values() {
            let _ = sender.send(true);
        }
        for (_, entry) in inner.connections.drain() {
            entry.close();
        }
    }
    if let Some(mode) = loaded.metadata.builtin_mode {
        inner.builtin_cache.insert(mode, loaded.clone());
    }
    inner.profile = Some(loaded.clone());
    Ok(loaded)
}

#[derive(Debug, Clone, Copy)]
enum TlsAttemptError {
    ConnectionTimeout(Option<i32>),
    ConnectionFailed(Option<i32>),
    TlsTimeout,
    CertificateMismatch(Option<i32>),
    CertificateValidationFailed(Option<i32>),
    TlsFailed(Option<i32>),
}
impl TlsAttemptError {
    fn code(self) -> &'static str {
        match self {
            Self::ConnectionTimeout(_) => "connection_timeout",
            Self::ConnectionFailed(_) => "connection_failed",
            Self::TlsTimeout => "tls_timeout",
            Self::CertificateMismatch(_) => "certificate_mismatch",
            Self::CertificateValidationFailed(_) => "certificate_validation_failed",
            Self::TlsFailed(_) => "tls_failed",
        }
    }
    fn is_tls(self) -> bool {
        !matches!(self, Self::ConnectionTimeout(_) | Self::ConnectionFailed(_))
    }
    fn system_code(self) -> Option<i32> {
        match self {
            Self::ConnectionTimeout(code)
            | Self::ConnectionFailed(code)
            | Self::CertificateMismatch(code)
            | Self::CertificateValidationFailed(code)
            | Self::TlsFailed(code) => code,
            Self::TlsTimeout => None,
        }
    }
    fn message(self) -> &'static str {
        match self {
            Self::ConnectionTimeout(_) => "连接纵密管理服务超时，请检查 101 至 108 口的访问路径",
            Self::ConnectionFailed(Some(10061 | 111 | 61)) => {
                "纵密管理端口 8888 拒绝连接，请检查装置管理服务或访问策略"
            }
            Self::ConnectionFailed(_) => "无法连接纵密管理服务，请检查地址路径与服务状态",
            Self::TlsTimeout => "等待纵密证书握手超时，尚未发送账号",
            Self::CertificateMismatch(_) => {
                "服务端证书与所选配套证书或服务器名称不匹配，尚未发送账号"
            }
            Self::CertificateValidationFailed(_) => {
                "纵密证书验证失败，请检查配套证书、有效期及证书用途"
            }
            Self::TlsFailed(_) => "纵密 TLS 握手失败，请检查设备协议与客户端证书兼容性",
        }
    }
}

fn classify_tls_failure_text(text: &str) -> TlsAttemptError {
    // 原始 TLS 错误仅在此提取稳定类别与系统码，不进入日志或前端响应。
    let code = text
        .rfind("(os error ")
        .and_then(|start| text[start + 10..].split(')').next())
        .and_then(|value| value.trim().parse::<i32>().ok())
        .or_else(|| {
            text.rfind("(os=0x")
                .and_then(|start| text[start + 6..].split(')').next())
                .and_then(|value| u32::from_str_radix(value.trim(), 16).ok())
                .map(|code| code as i32)
        });
    if text.contains("MSKDSP_LEGACY_CERTIFICATE_MISMATCH") || text.contains("MSKDSP_LEGACY_TARGET_REJECTED") || text.contains("MSKDSP_LEGACY_PIN_INVALID")
        || code.is_some_and(|code| matches!(code as u32, 0x800B010F | 0x80090322)) {
        TlsAttemptError::CertificateMismatch(code)
    } else if text.contains("MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED") || code.is_some_and(|code| matches!(code as u32, 0x800B0100..=0x800B0120 | 0x80096000..=0x80096020 | 0x80092000..=0x80092030 | 0x80090325 | 0x80090328)) {
        TlsAttemptError::CertificateValidationFailed(code)
    } else { TlsAttemptError::TlsFailed(code) }
}

async fn select_tls_candidate<T, F, Fut>(
    count: usize,
    mut handshake: F,
) -> Result<(usize, T), TlsAttemptError>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<T, TlsAttemptError>>,
{
    for index in 0..count {
        match handshake(index).await {
            Ok(stream) => return Ok((index, stream)),
            Err(error) if error.is_tls() && index + 1 < count => {
                tracing::info!("内置配套证书握手未通过，尚未发送账号，尝试另一组证书");
            }
            Err(error) => return Err(error),
        }
    }
    Err(TlsAttemptError::CertificateValidationFailed(None))
}

fn apply_reply(result: LoginResult, reply: Reply) -> LoginResult {
    let (code, message) = match reply {
        Reply::CredentialsRejected => (
            "credentials_rejected",
            "纵密拒绝用户名或密码，请手动确认后重试",
        ),
        Reply::Locked(seconds) => {
            let mut result = result.failure(2, "account_locked", "纵密账号已锁定，请等待后再操作");
            result.lock_seconds = seconds;
            return result;
        }
        Reply::UkeyUnavailable => (
            "ukey_unavailable",
            "设备报告无法连接 UKey，请检查 UKey 状态与设备要求",
        ),
        Reply::PinRejected => (
            "pin_rejected",
            "设备报告用户名或 PIN 错误；旧模式 PIN 分支尚未接入",
        ),
        Reply::UkeyLimit => (
            "ukey_attempt_limit",
            "纵密 UKey 连接尝试次数超过限制，请停止重试并检查装置",
        ),
        Reply::LicenseRequired => ("license_required", "设备要求处理许可，许可流程尚未接入"),
        Reply::Accepted(_) => {
            return result.failure(
                2,
                "incomplete_login_flow",
                "登录资料尚未完成验证，不能直接创建纵密身份",
            );
        }
        Reply::Unverified => {
            let mut result = result.failure(
                2,
                "unverified_response",
                "收到尚未验证的登录应答，已关闭连接，未建立纵密身份",
            );
            result.state = "unverified_response";
            return result;
        }
    };
    result.failure(2, code, message)
}

struct AuthenticationContext {
    username: String,
    role: u8,
    old_digest: Zeroizing<String>,
    default_password: bool,
    generation: u64,
}

async fn complete_login<S>(
    manager: &Arc<SecurityLoginManager>,
    mut result: LoginResult,
    credentials: AuthenticationContext,
    mut stream: S,
    reply: Reply,
) -> LoginResult
where
    S: AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    if let Reply::Locked(seconds) = &reply {
        // 在结果可能被取消分支覆盖前保存装置状态，不受连接清理影响。
        manager.record_account_lock(
            AccountKey::from_result(&result, &credentials.username),
            *seconds,
        );
    }
    let Reply::Accepted(info) = reply else {
        return apply_reply(result, reply);
    };
    tracing::info!(phase = "authenticate", "实测格式的纵密登录应答已通过校验");
    result.success_step(2, "装置已接受本次登录，登录资料结构校验通过");
    result.last_login_at = Some(info.last_login);
    let must_change = credentials.default_password || info.password_expired;
    if must_change {
        let context = ConnectionContext {
            request_id: result.request_id.clone(),
            username: credentials.username.clone(),
            role: credentials.role,
            generation: credentials.generation,
            kind: ConnectionKind::Challenge,
            device_version: None,
            expires_at: Instant::now() + Duration::from_secs(300),
        };
        match manager.retain_connection(context, stream, Some(credentials.old_digest)) {
            Ok(id) => {
                result.state = "password_change_required";
                result.code = if credentials.default_password {
                    "default_password"
                } else {
                    "password_expired"
                };
                result.message = if credentials.default_password {
                    "当前使用默认密码，请设置新密码后重新登录"
                } else {
                    "装置报告密码已过有效期，请设置新密码后重新登录"
                }
                .into();
                result.challenge_id = Some(id);
                result.username = Some(credentials.username);
                result.role = Some(credentials.role);
                result.steps[3].message = "修改密码并重新登录后读取装置资料".into();
                tracing::info!(
                    reason = result.code,
                    "已建立短时单次改密连接，尚未开放纵密业务"
                );
                result
            }
            Err(message) => result.failure(2, "challenge_unavailable", message),
        }
    } else {
        drop(credentials.old_digest);
        let info = match tokio::time::timeout(
            Duration::from_secs(12),
            protocol::initialize(&mut stream, &credentials.username, credentials.role),
        )
        .await
        {
            Ok(Ok(info)) => info,
            Ok(Err(message)) => return result.failure(3, "initialization_failed", message),
            Err(_) => {
                return result.failure(
                    3,
                    "initialization_timeout",
                    "读取装置登录资料超时，连接已关闭，请重新登录",
                )
            }
        };
        let context = ConnectionContext {
            request_id: result.request_id.clone(),
            username: credentials.username.clone(),
            role: credentials.role,
            generation: credentials.generation,
            kind: ConnectionKind::Authenticated,
            device_version: Some(info.version.clone()),
            expires_at: Instant::now() + Duration::from_secs(900),
        };
        match manager.retain_connection(context, stream, None) {
            Ok(id) => {
                result.success_step(3, "已读取固定账号与版本资料，并确认当前账号角色");
                result.state = "authenticated";
                result.code = "authenticated";
                result.message = "已登录纵密装置，只读初始化完成".into();
                result.username = Some(credentials.username);
                result.role = Some(credentials.role);
                result.session_id = Some(id);
                result.device_version = Some(info.version);
                tracing::info!("纵密只读初始化完成，保留已认证连接");
                result
            }
            Err(message) => result.failure(3, "session_unavailable", message),
        }
    }
}

// 登录与连通检查共用此建连入口，证书候选选择结束前不发送账号。
struct ManagementConnection {
    stream: tokio_native_tls::TlsStream<tokio::net::TcpStream>,
    group: Option<&'static str>,
    legacy_compatibility: bool,
}

pub(super) struct ManagementError {
    pub tcp_connected: bool,
    pub(super) step_index: usize,
    pub(super) code: &'static str,
    pub message: String,
}
impl ManagementError {
    fn profile(code: &'static str, message: &str) -> Self {
        Self {
            tcp_connected: false,
            step_index: 1,
            code,
            message: message.into(),
        }
    }
}

async fn connect_management(
    profile: Arc<LoadedProfile>,
) -> Result<ManagementConnection, ManagementError> {
    connect_management_via(profile, None).await
}

async fn connect_management_via(
    profile: Arc<LoadedProfile>,
    remote: Option<&crate::remote_access::RemoteConnection>,
) -> Result<ManagementConnection, ManagementError> {
    let Ok(now) = current_unix_time() else {
        return Err(ManagementError::profile(
            "certificate_time_invalid",
            "系统时间无效，无法检查证书有效期",
        ));
    };
    let active: Vec<_> = profile
        .candidates
        .iter()
        .filter(|candidate| {
            candidate.legacy_compatibility
                || candidate
                    .validity
                    .map(|validity| validity.contains(now))
                    .unwrap_or(true)
        })
        .collect();
    if active.is_empty() {
        return Err(ManagementError::profile(
            "certificate_expired",
            "内置配套证书均未生效或已过期，请替换有效证书",
        ));
    }
    // 在此阶段尚未发送任何账号材料；候选切换只处理 TLS 证书阶段失败。
    let (index, stream) = match select_tls_candidate(active.len(), |index| {
        let connector = active[index].connector.clone();
        let server_name = active[index].server_name.clone();
        let group = active[index].group.unwrap_or("custom");
        async move {
            tracing::info!(certificate_group = group, phase = "connect", "开始连接纵密固定管理服务");
            let outcome = async {
            let stream = tokio::time::timeout(
                Duration::from_secs(10),
                async {
                    if let Some(remote) = remote {
                        remote.vertical_security_socket().await.map_err(std::io::Error::other)
                    } else {
                        tokio::net::TcpStream::connect((TARGET_IP, TARGET_PORT)).await
                    }
                },
            )
            .await
            .map_err(|_| TlsAttemptError::ConnectionTimeout(None))?
            .map_err(|error| if error.kind() == std::io::ErrorKind::TimedOut { TlsAttemptError::ConnectionTimeout(error.raw_os_error()) } else { TlsAttemptError::ConnectionFailed(error.raw_os_error()) })?;
            tracing::info!(certificate_group = group, phase = "tls", "纵密固定管理服务已连接，开始证书握手");
            tokio::time::timeout(
                Duration::from_secs(6),
                connector.connect(&server_name, stream),
            )
            .await
            .map_err(|_| TlsAttemptError::TlsTimeout)?
            .map_err(|error| classify_tls_failure_text(&error.to_string()))
            }.await;
            if let Err(error) = &outcome {
                tracing::warn!(certificate_group = group, phase = if error.is_tls() { "tls" } else { "connect" }, code = error.code(), system_code = ?error.system_code(), "纵密连接阶段失败，尚未发送账号");
            }
            outcome
        }
    })
    .await
    {
        Ok(selection) => selection,
        Err(error) => {
            return Err(ManagementError { tcp_connected: error.is_tls(), step_index: if error.is_tls() { 1 } else { 0 }, code: error.code(), message: error.message().into() });
        }
    };
    Ok(ManagementConnection {
        stream,
        group: active[index].group,
        legacy_compatibility: active[index].legacy_compatibility,
    })
}

// 探测只验证管理连接，不交换账号、不注册会话；返回前关闭并释放流。
pub(super) async fn probe_management_connection(
    manager: &SecurityLoginManager,
) -> Result<(), ManagementError> {
    probe_management_connection_via(manager, None).await
}

pub(super) async fn probe_management_connection_via(
    manager: &SecurityLoginManager,
    remote: Option<&crate::remote_access::RemoteConnection>,
) -> Result<(), ManagementError> {
    run_management_probe(manager, || async {
        let profile = initialize_builtin_profile(manager, false, BuiltinMode::Auto)
            .await
            .map_err(|message| {
                ManagementError::profile("certificate_configuration_failed", &message)
            })?;
        let connection = connect_management_via(profile.clone(), remote).await?;
        if !manager
            .inner
            .lock()
            .profile
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &profile))
        {
            return Err(ManagementError {
                tcp_connected: true,
                step_index: 1,
                code: "certificate_configuration_changed",
                message: "证书配置已改变，请重新检查管理连接".into(),
            });
        }
        Ok(connection.stream)
    })
    .await
}

// 并发保护覆盖证书准备、建连和释放，取消页面不会叠加新的探测连接。
async fn run_management_probe<S, F, Fut>(
    manager: &SecurityLoginManager,
    connect: F,
) -> Result<(), ManagementError>
where
    S: tokio::io::AsyncWrite + Unpin,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<S, ManagementError>>,
{
    let _permit = manager.management_probe.try_lock().map_err(|_| {
        ManagementError::profile(
            "management_probe_busy",
            "上次管理连接检查尚未结束，请稍后重试",
        )
    })?;
    let stream = connect().await?;
    close_probe_stream(stream).await;
    tracing::info!("纵密管理连接检查完成，探测连接已释放，未发送账号");
    Ok(())
}

async fn close_probe_stream<S: tokio::io::AsyncWrite + Unpin>(mut stream: S) {
    // 关闭通知也受超时限制；超时后直接释放底层连接。
    let _ = tokio::time::timeout(Duration::from_secs(1), stream.shutdown()).await;
}

async fn connect_and_authenticate(
    manager: &Arc<SecurityLoginManager>,
    mut result: LoginResult,
    profile: Arc<LoadedProfile>,
    packet: Zeroizing<Vec<u8>>,
    credentials: AuthenticationContext,
) -> LoginResult {
    let account = AccountKey::from_result(&result, &credentials.username);
    if let Some(seconds) = manager.account_lock_seconds(&account) {
        return lockout::locked_result(result, seconds);
    }
    {
        let inner = manager.inner.lock();
        if inner.config_generation != credentials.generation
            || inner.pending.get(&result.request_id).is_none_or(|sender| *sender.borrow())
        {
            return result.failure(2, "cancelled", "登录请求已取消或证书配置已改变，未发送认证请求");
        }
    }
    let connection = match connect_management(profile).await {
        Ok(connection) => connection,
        Err(error) => {
            if error.tcp_connected {
                result.success_step(0, "已连接固定纵密管理服务");
            }
            return result.failure(error.step_index, error.code, &error.message);
        }
    };
    let mut stream = connection.stream;
    result.success_step(0, "已连接固定纵密管理服务");
    result.certificate_group = connection.group;
    result.legacy_compatibility = connection.legacy_compatibility;
    result.success_step(
        1,
        if result.legacy_compatibility {
            "已精确匹配批准的旧版服务端证书，启用限定日期及名称兼容"
        } else {
            "证书链、有效期与服务器名称验证通过"
        },
    );
    tracing::info!(
        certificate_group = result.certificate_group.unwrap_or("custom"),
        legacy_compatibility = result.legacy_compatibility,
        phase = "authenticate",
        "纵密证书验证通过，开始单次身份认证"
    );
    // TLS 建连可能耗时，发送凭据前再次核对单调时钟锁定记录。
    if let Some(seconds) = manager.account_lock_seconds(&account) {
        return lockout::locked_result(result, seconds);
    }
    {
        let inner = manager.inner.lock();
        if inner.config_generation != credentials.generation
            || inner.pending.get(&result.request_id).is_none_or(|sender| *sender.borrow())
        {
            return result.failure(2, "cancelled", "登录请求已取消或证书配置已改变，未发送认证请求");
        }
    }
    let exchange = exchange_credentials_once(&mut stream, &packet);
    let reply = tokio::time::timeout(Duration::from_secs(8), exchange).await;
    // 只有合法应答可转交临时改密或已认证连接，其余分支关闭流。
    match reply {
        Ok(Ok(reply)) => complete_login(manager, result, credentials, stream, reply).await,
        Ok(Err(message)) => {
            let mut result = result.failure(2, "invalid_response", message);
            result.state = "unverified_response";
            result
        }
        Err(_) => result.failure(
            2,
            "authentication_timeout",
            "等待纵密登录应答超时，连接已关闭",
        ),
    }
}

async fn exchange_credentials_once<S: AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    packet: &[u8],
) -> Result<Reply, &'static str> {
    stream
        .write_all(packet)
        .await
        .map_err(|_| "无法发送登录请求")?;
    stream.flush().await.map_err(|_| "无法发送登录请求")?;
    read_login_reply(stream).await
}

#[tauri::command]
pub fn get_vertical_security_login_locks(
    state: tauri::State<'_, AppState>,
) -> Vec<LoginLockStatus> {
    state.security_login.login_locks()
}

#[tauri::command]
pub fn get_vertical_security_login_capabilities() -> LoginCapabilities {
    LoginCapabilities {
        direct_available: cfg!(windows),
        remote_available: false,
        password_change_available: cfg!(windows),
        reason: "支持直连一键登录、默认密码自动修改及重新认证；远程通道待接入",
    }
}
#[tauri::command]
pub async fn get_vertical_security_certificate_profile(
    state: tauri::State<'_, AppState>,
) -> Result<CertificateProfile, String> {
    Ok(
        initialize_builtin_profile(&state.security_login, false, BuiltinMode::Auto)
            .await?
            .metadata
            .clone(),
    )
}
#[tauri::command]
pub async fn use_builtin_vertical_security_certificates(
    state: tauri::State<'_, AppState>,
    request: Option<BuiltinCertificateRequest>,
) -> Result<CertificateProfile, String> {
    let profile = initialize_builtin_profile(
        &state.security_login,
        true,
        request.unwrap_or_default().mode,
    )
    .await?;
    tracing::info!("已恢复内置纵密配套证书，取消旧登录请求");
    Ok(profile.metadata.clone())
}
#[tauri::command]
pub async fn configure_vertical_security_certificate_profile(
    state: tauri::State<'_, AppState>,
    request: CertificateRequest,
) -> Result<CertificateProfile, String> {
    let manager = &state.security_login;
    let generation = {
        let mut inner = manager.inner.lock();
        SecurityLoginManager::advance_configuration(&mut inner)
    };
    let loaded = tokio::task::spawn_blocking(move || load_profile(request))
        .await
        .map_err(|_| "证书加载任务未完成".to_string())??;
    let mut inner = manager.inner.lock();
    if inner.config_generation != generation {
        return Err("证书配置已被后续请求替代".into());
    }
    for sender in inner.pending.values() {
        let _ = sender.send(true);
    }
    for (_, entry) in inner.connections.drain() {
        entry.close();
    }
    let metadata = loaded.metadata.clone();
    inner.profile = Some(Arc::new(loaded));
    tracing::info!("纵密证书配置完成，仅在当前进程有效");
    Ok(metadata)
}
#[tauri::command]
pub async fn login_vertical_security(
    state: tauri::State<'_, AppState>,
    request: LoginRequest,
) -> Result<LoginResult, String> {
    run_login(&state.security_login, request, false).await
}

#[tauri::command]
pub async fn login_vertical_security_one_click(
    state: tauri::State<'_, AppState>,
    request: OneClickLoginRequest,
) -> Result<LoginResult, String> {
    let (username, password) = automatic_account(request.role)
        .ok_or_else(|| "一键登录仅支持系统管理员和安全操作员".to_string())?;
    run_login(
        &state.security_login,
        LoginRequest {
            request_id: request.request_id,
            mode: request.mode,
            device_id: request.device_id,
            username: username.into(),
            password: password.into(),
            role: request.role,
        },
        true,
    )
    .await
}

// 调用取消或调用者释放未来时，及时关闭流程中保留的改密或认证连接。
struct LoginConnectionCleanup<'a> {
    manager: &'a SecurityLoginManager,
    request_id: &'a str,
    armed: bool,
}
impl Drop for LoginConnectionCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.manager.cancel(self.request_id);
        }
    }
}

async fn run_login(
    manager: &Arc<SecurityLoginManager>,
    mut request: LoginRequest,
    automatic: bool,
) -> Result<LoginResult, String> {
    tracing::info!("开始独立纵密登录请求");
    let mut result = LoginResult::new(&request);
    let _authentication_guard = match manager.authentication.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(result.failure(
                2,
                "authentication_pending",
                "纵密已有登录流程正在执行，请等待结束后再操作",
            ));
        }
    };
    let packet = match encode_login(&request.username, &request.password, request.role) {
        Ok(packet) => packet,
        Err(message) => return Ok(result.failure(2, "invalid_credentials", message)),
    };
    let default_password = protocol::default_password(&request.username, &request.password);
    let old_digest = protocol::password_digest(&request.username, &request.password);
    request.password.zeroize();
    let (mut cancellation, _guard) = match manager.begin(&request.request_id) {
        Ok(started) => started,
        Err(message) => return Ok(result.failure(0, "request_rejected", message)),
    };
    if matches!(request.mode, LoginMode::Remote) {
        result = result.failure(0, "remote_unavailable", REMOTE_REASON);
        result.state = "unsupported";
        return Ok(result);
    }
    if !cfg!(windows) {
        result = result.failure(
            0,
            "platform_unavailable",
            "请使用 Windows 桌面上位机建立证书连接",
        );
        result.state = "unsupported";
        return Ok(result);
    }
    if request.device_id.is_some() {
        return Ok(result.failure(0, "invalid_target", "直连登录不应携带远程设备标识"));
    }
    let account = AccountKey::from_result(&result, &request.username);
    let _account_guard = match manager.begin_account_authentication(account) {
        Ok(guard) => guard,
        Err(AuthenticationBlocked::Locked(seconds)) => {
            return Ok(lockout::locked_result(result, seconds));
        }
        Err(AuthenticationBlocked::Pending) => {
            return Ok(result.failure(
                2,
                "authentication_pending",
                "同一纵密账号已有登录请求，请等待该请求结束",
            ));
        }
    };
    let profile = match initialize_builtin_profile(manager, false, BuiltinMode::Auto).await {
        Ok(profile) => profile,
        Err(_) => {
            return Ok(result.failure(
                1,
                "certificate_required",
                "内置配套证书加载失败，可在高级选项中替换自定义证书",
            ))
        }
    };
    let generation = {
        let inner = manager.inner.lock();
        if !inner
            .profile
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &profile))
        {
            return Ok(result.failure(1, "certificate_changed", "证书配置已改变，请重新登录"));
        }
        inner.config_generation
    };
    let credentials = AuthenticationContext {
        username: request.username.clone(),
        role: request.role,
        old_digest,
        default_password,
        generation,
    };
    let cancelled =
        LoginResult::new(&request).failure(0, "cancelled", "纵密登录已取消，连接已关闭");
    let mut cleanup = LoginConnectionCleanup {
        manager,
        request_id: &request.request_id,
        armed: true,
    };
    tokio::select! { biased;
        _ = async { if !*cancellation.borrow() { let _ = cancellation.changed().await; } } => Ok(cancelled),
        response = async {
            if automatic {
                let (_, default) = automatic_account(request.role).expect("一键角色已校验");
                run_automatic_login(manager, default, |password| {
                    let profile = profile.clone();
                    let attempt_result = LoginResult::new(&request);
                    let username = request.username.clone();
                    let role = request.role;
                    async move {
                        let packet = match encode_login(&username, password, role) {
                            Ok(packet) => packet,
                            Err(message) => return attempt_result.failure(2, "invalid_credentials", message),
                        };
                        let credentials = AuthenticationContext {
                            default_password: protocol::default_password(&username, password),
                            old_digest: protocol::password_digest(&username, password),
                            username,
                            role,
                            generation,
                        };
                        connect_and_authenticate(manager, attempt_result, profile, packet, credentials).await
                    }
                }).await
            } else {
                connect_and_authenticate(manager, result, profile, packet, credentials).await
            }
        } => {
            tracing::info!(code = response.code, state = response.state, "纵密登录尝试结束");
            if *cancellation.borrow() {
                Ok(cancelled)
            } else {
                cleanup.armed = false;
                Ok(response)
            }
        }
    }
}

async fn run_automatic_login<F, Fut>(
    manager: &SecurityLoginManager,
    default: &'static str,
    mut attempt: F,
) -> LoginResult
where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = LoginResult>,
{
    tracing::info!("纵密一键登录开始，先执行默认凭据认证，不记录密码");
    let mut result = attempt(default).await;
    if result.state == "failed" && result.code == "credentials_rejected" {
        tracing::info!("装置明确拒绝默认凭据，仅切换统一凭据认证一次");
        result = attempt(MANAGED_PASSWORD).await;
        // 统一密码已过期时，不能把相同密码当作新密码提交。
        if result.state == "password_change_required" {
            return automatic_change_failure(manager, result, "managed_password_expired", "统一密码已过期或装置要求重新设密，已停止自动登录，请人工处理密码策略");
        }
        return result;
    }
    if result.state != "password_change_required" {
        return result;
    }
    let Some(challenge) = result.challenge_id.take() else {
        return result.failure(2, "challenge_unavailable", "自动改密连接缺失，已停止登录");
    };
    tracing::info!("默认凭据认证成功，提交一次统一密码修改请求");
    let changed = manager
        .change_password(&challenge, Zeroizing::new(MANAGED_PASSWORD.into()))
        .await;
    if !changed.changed {
        // 请求可能已经到达装置；结果不确定时不继续认证或重复改密。
        return result.failure(2, "automatic_password_change_failed", changed.message);
    }
    tracing::info!("装置明确确认改密成功，使用统一凭据重新认证一次");
    let result = attempt(MANAGED_PASSWORD).await;
    if result.state == "password_change_required" {
        automatic_change_failure(manager, result, "password_change_still_required", "改密后装置仍要求修改密码，已停止自动登录，请核实装置状态")
    } else {
        result
    }
}

fn automatic_change_failure(
    manager: &SecurityLoginManager,
    mut result: LoginResult,
    code: &'static str,
    message: &str,
) -> LoginResult {
    if let Some(challenge) = result.challenge_id.take() {
        let mut inner = manager.inner.lock();
        if let Some(entry) = inner.connections.remove(&challenge) {
            entry.close();
        }
    }
    result.failure(2, code, message)
}
#[tauri::command]
pub async fn run_vertical_security_admin(
    state: tauri::State<'_, AppState>,
    request: AdminRequest,
) -> Result<AdminResult, String> {
    state.security_login.run_admin(request).await
}
#[tauri::command]
pub async fn run_vertical_security_operator(
    state: tauri::State<'_, AppState>,
    request: OperatorRequest,
) -> Result<OperatorResult, String> {
    state.security_login.run_operator(request).await
}
#[tauri::command]
pub fn cancel_vertical_security_login(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    state.security_login.cancel(&request_id)
}
#[tauri::command]
pub fn logout_vertical_security(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.security_login.close_session(&session_id)
}
#[tauri::command]
pub fn is_vertical_security_login_active(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> bool {
    state.security_login.connection_active(&connection_id)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasswordChangeRequest {
    challenge_id: String,
    new_password: String,
}
impl Drop for PasswordChangeRequest {
    fn drop(&mut self) {
        self.new_password.zeroize();
    }
}
#[derive(Serialize)]
pub struct PasswordChangeResult {
    changed: bool,
    message: &'static str,
}
#[tauri::command]
pub async fn change_vertical_security_password(
    state: tauri::State<'_, AppState>,
    mut request: PasswordChangeRequest,
) -> Result<PasswordChangeResult, String> {
    validate_request_id(&request.challenge_id).map_err(str::to_string)?;
    let password = Zeroizing::new(std::mem::take(&mut request.new_password));
    Ok(state
        .security_login
        .change_password(&request.challenge_id, password)
        .await)
}

#[cfg(test)]
#[path = "security_login_flow_tests.rs"]
mod flow_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    // 默认自动模式应先尝试明确批准的旧版 pin，禁止把旧版兼容扩大到新版。
    #[cfg(windows)]
    #[test]
    fn security_login_builtin_modes_and_legacy_expiration_boundary() {
        let automatic = load_builtin_profile_mode_at(1_790_000_000, BuiltinMode::Auto).unwrap();
        assert_eq!(automatic.metadata.builtin_mode, Some(BuiltinMode::Auto));
        assert_eq!(
            automatic
                .candidates
                .iter()
                .map(|candidate| candidate.group)
                .collect::<Vec<_>>(),
            vec![Some("old"), Some("new")]
        );
        assert!(automatic.candidates[0].legacy_compatibility);
        assert!(!automatic.candidates[1].legacy_compatibility);
        assert_eq!(automatic.candidates[0].server_name, TARGET_IP);
        assert_eq!(automatic.candidates[1].server_name, "NARI");
        assert!(automatic.metadata.server_name.is_none());
        let new = load_builtin_profile_mode_at(1_790_000_000, BuiltinMode::New).unwrap();
        assert_eq!(new.metadata.server_name.as_deref(), Some("NARI"));
        assert!(new
            .candidates
            .iter()
            .all(|candidate| !candidate.legacy_compatibility));
        assert!(load_builtin_profile_mode_at(4_802_035_178, BuiltinMode::New).is_err());
        let old = load_builtin_profile_mode_at(4_802_035_178, BuiltinMode::Old).unwrap();
        assert_eq!(old.candidates.len(), 1);
        assert_eq!(old.candidates[0].group, Some("old"));
        assert!(old.candidates[0].legacy_compatibility);
    }

    // 模式请求只接受已定义的内置组，不接受任意目标或兼容开关。
    #[test]
    fn security_login_builtin_mode_payload_is_strict_and_optional_default_is_auto() {
        assert_eq!(BuiltinCertificateRequest::default().mode, BuiltinMode::Auto);
        for mode in ["auto", "old", "new"] {
            assert!(serde_json::from_value::<BuiltinCertificateRequest>(
                serde_json::json!({"mode":mode})
            )
            .is_ok());
        }
        for payload in [
            serde_json::json!({"mode":"other"}),
            serde_json::json!({"mode":"old","target_ip":"other"}),
            serde_json::json!({"mode":"new","skip_verification":true}),
        ] {
            assert!(serde_json::from_value::<BuiltinCertificateRequest>(payload).is_err());
        }
    }

    // TLS 还未成功时不能声明已匹配任何内置证书。
    #[test]
    fn security_login_matching_fields_start_empty_and_safe_error_codes_are_distinct() {
        let result = LoginResult::new(&fixture_request());
        assert!(result.certificate_group.is_none());
        assert!(!result.legacy_compatibility);
        assert_eq!(
            classify_tls_failure_text("MSKDSP_LEGACY_CERTIFICATE_MISMATCH").code(),
            "certificate_mismatch"
        );
        assert_eq!(
            classify_tls_failure_text("native failure (os error -2146762487)").code(),
            "certificate_validation_failed"
        );
        assert_eq!(
            classify_tls_failure_text("unclassified handshake failure").code(),
            "tls_failed"
        );
        let hexadecimal = classify_tls_failure_text(
            "MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED (os=0x800B0110)",
        );
        assert_eq!(hexadecimal.code(), "certificate_validation_failed");
        assert_eq!(hexadecimal.system_code(), Some(0x800B0110_u32 as i32));
    }

    // 实际加载两套内置配套身份及信任证书，不连接设备或写入系统证书存储。
    #[test]
    fn security_login_builtin_profiles_are_real_and_default() {
        let profile = load_builtin_profile_at(1_790_000_000).unwrap();
        assert!(profile.metadata.configured);
        assert_eq!(profile.metadata.source, "builtin");
        assert_eq!(profile.metadata.label, "内置配套证书（自动匹配）");
        assert!(profile.metadata.client_certificate_path.is_none());
        assert!(profile.metadata.trust_certificate_path.is_none());
        assert!(profile.metadata.server_name.is_none());
        if cfg!(windows) {
            assert_eq!(profile.candidates[0].server_name, TARGET_IP);
            assert_eq!(profile.candidates[1].server_name, "NARI");
            assert_eq!(profile.candidates.len(), 2);
        } else {
            assert_eq!(profile.candidates.len(), 1);
            assert_eq!(profile.candidates[0].server_name, "NARI");
        }
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../resources/vertical-security/manifest.json"
        ))
        .unwrap();
        for resource in builtin::IDENTITIES {
            // 旧版仅使用批准的精确 pin；新版继续要求有效期与名称验证。
            if cfg!(windows) || resource.id != "old" {
                assert!(parse_builtin_candidate(resource).is_ok());
            } else {
                assert!(Identity::from_pkcs12(
                    resource.identity,
                    &builtin::bundle_password(resource.unlock_seed)
                )
                .is_ok());
            }
            let metadata = manifest["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .find(|metadata| metadata["id"].as_str() == Some(resource.id))
                .unwrap();
            assert_eq!(resource.id, metadata["id"].as_str().unwrap());
            assert!(metadata["identity_key_matches"].as_bool().unwrap());
            for (encoded, expected) in resource
                .trust
                .iter()
                .zip(metadata["trust"].as_array().unwrap())
            {
                let certificate = Certificate::from_der(encoded).unwrap();
                let actual: String = sha2::Sha256::digest(certificate.to_der().unwrap())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                assert_eq!(actual, expected["sha256"].as_str().unwrap());
            }
            assert_eq!(
                resource.validity().unwrap().contains(1_790_000_000),
                resource.id == "new"
            );
        }
        assert!(load_builtin_profile_mode_at(0, BuiltinMode::New).is_err());
        assert!(load_builtin_profile_mode_at(4_802_035_178, BuiltinMode::New).is_err());
    }

    // 通过真实内置资源验证默认缓存、自定义替换保留及恢复默认时取消旧请求。
    #[tokio::test]
    async fn security_login_builtin_cache_custom_override_and_restore() {
        let manager = SecurityLoginManager::default();
        let initial = initialize_builtin_profile(&manager, false, BuiltinMode::Auto)
            .await
            .unwrap();
        let cached = initialize_builtin_profile(&manager, false, BuiltinMode::Auto)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&initial, &cached));
        let mut custom = load_builtin_profile().unwrap();
        custom.metadata.source = "custom";
        custom.metadata.label = "自定义证书";
        custom.metadata.builtin_mode = None;
        let custom = Arc::new(custom);
        {
            let mut inner = manager.inner.lock();
            inner.config_generation += 1;
            inner.profile = Some(custom.clone());
        }
        assert!(Arc::ptr_eq(
            &custom,
            &initialize_builtin_profile(&manager, false, BuiltinMode::Auto)
                .await
                .unwrap()
        ));
        let late = activate_builtin_profile(&manager, 0, false, initial.clone()).unwrap();
        assert!(Arc::ptr_eq(&custom, &late));
        assert!(activate_builtin_profile(&manager, 0, true, initial.clone()).is_err());
        let (receiver, _guard) = manager.begin("fixture-before-reset").unwrap();
        let restored = initialize_builtin_profile(&manager, true, BuiltinMode::Auto)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&initial, &restored));
        assert_eq!(restored.metadata.source, "builtin");
        assert!(*receiver.borrow());
    }

    // 只有 TLS 阶段失败可以切换配套身份，连接失败及身份认证结果均不能重发凭据。
    #[tokio::test]
    async fn security_login_builtin_fallback_is_limited_to_tls_stage() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let count = Arc::new(AtomicUsize::new(0));
        let attempts = count.clone();
        let selected = select_tls_candidate(2, move |index| {
            attempts.fetch_add(1, Ordering::SeqCst);
            async move {
                if index == 0 {
                    Err(TlsAttemptError::CertificateValidationFailed(None))
                } else {
                    Ok("stream")
                }
            }
        })
        .await;
        assert_eq!(selected.unwrap(), (1, "stream"));
        assert_eq!(count.load(Ordering::SeqCst), 2);
        let count = Arc::new(AtomicUsize::new(0));
        let attempts = count.clone();
        assert!(select_tls_candidate::<(), _, _>(2, move |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err(TlsAttemptError::ConnectionFailed(None)) }
        })
        .await
        .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    // 高级模式选择保持独立缓存，普通读取不能覆盖已显式选择的组或自定义配置。
    #[cfg(windows)]
    #[tokio::test]
    async fn security_login_builtin_mode_switch_preserves_generation_and_cache() {
        let manager = SecurityLoginManager::default();
        let automatic = initialize_builtin_profile(&manager, false, BuiltinMode::Auto)
            .await
            .unwrap();
        let new = initialize_builtin_profile(&manager, true, BuiltinMode::New)
            .await
            .unwrap();
        assert_eq!(new.metadata.builtin_mode, Some(BuiltinMode::New));
        assert!(Arc::ptr_eq(
            &new,
            &initialize_builtin_profile(&manager, false, BuiltinMode::Auto)
                .await
                .unwrap()
        ));
        let (receiver, _guard) = manager.begin("fixture-mode-switch").unwrap();
        let old = initialize_builtin_profile(&manager, true, BuiltinMode::Old)
            .await
            .unwrap();
        assert_eq!(old.candidates.len(), 1);
        assert_eq!(old.candidates[0].group, Some("old"));
        assert!(*receiver.borrow());
        let restored = initialize_builtin_profile(&manager, true, BuiltinMode::Auto)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&automatic, &restored));
        assert!(activate_builtin_profile(&manager, 0, true, old).is_err());
    }

    // 双工流验证 TLS 候选切换发生在账号报文之前，账号拒绝后只发送一次完整报文。
    #[tokio::test]
    async fn security_login_credentials_sent_once_after_tls_fallback_and_never_retried() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let packet = encode_login("fixture", "fixture-secret", 1).unwrap();
        let expected = packet.to_vec();
        let (client, mut server) = tokio::io::duplex(256);
        let server_task = tokio::spawn(async move {
            let mut received = vec![0; expected.len()];
            server.read_exact(&mut received).await.unwrap();
            assert_eq!(received, expected);
            server
                .write_all(&[0, 0, 0, 12, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            let mut repeated = Vec::new();
            server.read_to_end(&mut repeated).await.unwrap();
            repeated
        });
        let count = Arc::new(AtomicUsize::new(0));
        let attempts = count.clone();
        let mut client = Some(client);
        let (index, mut selected) = select_tls_candidate(2, move |index| {
            attempts.fetch_add(1, Ordering::SeqCst);
            let stream = if index == 1 { client.take() } else { None };
            async move { stream.ok_or(TlsAttemptError::CertificateMismatch(None)) }
        })
        .await
        .unwrap();
        assert_eq!(index, 1);
        assert!(matches!(
            exchange_credentials_once(&mut selected, &packet)
                .await
                .unwrap(),
            Reply::CredentialsRejected
        ));
        drop(selected);
        assert!(server_task.await.unwrap().is_empty());
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    // 即使账号报文只写出部分内容就断线，也不能转到另一证书组再次尝试。
    #[tokio::test]
    async fn security_login_partial_write_failure_does_not_return_to_tls_selection() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let packet = encode_login("fixture", "fixture-secret", 1).unwrap();
        let (client, mut server) = tokio::io::duplex(4);
        let receiver = tokio::spawn(async move {
            let mut header = [0; 4];
            server.read_exact(&mut header).await.unwrap();
            header
        });
        let count = Arc::new(AtomicUsize::new(0));
        let attempts = count.clone();
        let mut client = Some(client);
        let (_, mut selected) = select_tls_candidate(2, move |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            let stream = client.take();
            async move { stream.ok_or(TlsAttemptError::TlsFailed(None)) }
        })
        .await
        .unwrap();
        assert!(exchange_credentials_once(&mut selected, &packet)
            .await
            .is_err());
        assert_eq!(receiver.await.unwrap(), [0, 0, 0, 12]);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    // 本地随机端口 TLS fixture：只使用配套资源和回环地址，不发送任何账号或应用报文。
    #[cfg(windows)]
    async fn local_tls_fixture(
        server_group: &str,
        client_group: &str,
        override_name: Option<&str>,
    ) -> Result<(), String> {
        use std::process::Stdio;
        use tokio::io::AsyncBufReadExt;
        // Node 仅承载本地 TLS 服务；旧证书弱签名的服务端设置不改变 Rust 客户端校验。
        const SERVER: &str = r#"
const fs = require('node:fs');
const tls = require('node:tls');
try {
  const config = JSON.parse(fs.readFileSync(0, 'utf8'));
  let applicationBytes = 0;
  let peerCertificateSha256 = null;
  let completed = false;
  const server = tls.createServer({
    pfx: fs.readFileSync(config.pfx), passphrase: config.password,
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'DEFAULT@SECLEVEL=0',
    requestCert: true, rejectUnauthorized: false
  }, socket => {
    const peer = socket.getPeerCertificate();
    if (peer && peer.fingerprint256) peerCertificateSha256 = peer.fingerprint256.replaceAll(':', '').toLowerCase();
    socket.on('data', data => { applicationBytes += data.length; });
    socket.on('close', finish);
    socket.end();
  });
  function finish() {
    if (completed) return;
    completed = true;
    process.stdout.write(JSON.stringify({applicationBytes, peerCertificateSha256}) + '\n');
    server.close(() => process.exit(0));
  }
  server.on('tlsClientError', finish);
  server.on('error', () => process.exit(2));
  server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({port: server.address().port}) + '\n'));
  setTimeout(() => process.exit(3), 12000).unref();
} catch (error) { process.stdout.write(JSON.stringify({fixtureError: error.code || 'START_FAILED'}) + '\n'); process.exit(2); }
"#;
        let resource = builtin::IDENTITIES
            .iter()
            .find(|resource| resource.id == server_group)
            .unwrap();
        let password = builtin::bundle_password(resource.unlock_seed);
        let resource_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/vertical-security")
            .join(format!("builtin-{server_group}.p12"));
        let payload = Zeroizing::new(
            serde_json::to_string(
                &serde_json::json!({"pfx":resource_path,"password":password.as_str()}),
            )
            .unwrap(),
        );
        let mut command = tokio::process::Command::new(
            std::env::var_os("MSKDSP_TEST_NODE").unwrap_or_else(|| "node".into()),
        );
        command
            .args(["--eval", SERVER])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动本地 Node TLS fixture".to_string())?;
        let mut input = child.stdin.take().unwrap();
        input
            .write_all(payload.as_bytes())
            .await
            .map_err(|_| "本地 fixture 输入失败".to_string())?;
        input
            .shutdown()
            .await
            .map_err(|_| "本地 fixture 输入未完成".to_string())?;
        drop(input);
        let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(8), output.next_line())
            .await
            .map_err(|_| "本地 fixture 启动超时".to_string())?
            .map_err(|_| "本地 fixture 状态读取失败".to_string())?
            .ok_or_else(|| "本地 fixture 未启动".to_string())?;
        let status: serde_json::Value =
            serde_json::from_str(&line).map_err(|_| "本地 fixture 状态无效".to_string())?;
        let port = status["port"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| "本地 fixture 没有分配端口".to_string())?;
        let client_resource = builtin::IDENTITIES
            .iter()
            .find(|resource| resource.id == client_group)
            .unwrap();
        let client = parse_builtin_candidate(client_resource).unwrap();
        let socket = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            client
                .connector
                .connect(override_name.unwrap_or(&client.server_name), socket),
        )
        .await
        .map_err(|_| "本地客户端握手超时".to_string())
        .and_then(|result| result.map(|_| ()).map_err(|error| error.to_string()));
        // 客户端无论成功或拒绝都不发送应用数据，并只清理本次创建的服务端进程。
        let summary = tokio::time::timeout(Duration::from_secs(2), output.next_line()).await;
        if let Ok(Ok(Some(summary))) = &summary {
            let summary: serde_json::Value = serde_json::from_str(summary).unwrap();
            assert_eq!(summary["applicationBytes"].as_u64(), Some(0));
            if result.is_ok() {
                // 配套 trust 与客户端叶证书逐字节一致，核对服务端实际收到的身份。
                let expected: String = sha2::Sha256::digest(client_resource.trust[0])
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                assert_eq!(
                    summary["peerCertificateSha256"].as_str(),
                    Some(expected.as_str())
                );
            }
        } else if result.is_ok() {
            return Err("本地 mTLS fixture 没有返回客户端身份核验结果".into());
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        result
    }

    // 真实旧叶证书已过期且名称为 server，只有指定 pin 分支允许固定逻辑目标完成握手。
    #[cfg(windows)]
    #[tokio::test]
    async fn security_login_local_tls_exact_legacy_pin_completes_async_handshake() {
        local_tls_fixture("old", "old", None).await.unwrap();
    }

    // 异证书不能利用旧版例外，即便普通系统策略尚未完成也必须拒绝。
    #[cfg(windows)]
    #[tokio::test]
    async fn security_login_local_tls_legacy_pin_rejects_different_leaf_and_target() {
        let mismatch = local_tls_fixture("new", "old", None).await.unwrap_err();
        assert_eq!(
            classify_tls_failure_text(&mismatch).code(),
            "certificate_mismatch"
        );
        assert!(local_tls_fixture("old", "old", Some("wrong.invalid"))
            .await
            .is_err());
    }

    // 新组使用明确的 NARI 配套逻辑名称，仍拒绝错误名称和旧组过期叶证书。
    #[cfg(windows)]
    #[tokio::test]
    async fn security_login_local_tls_new_group_keeps_strict_identity_validation() {
        local_tls_fixture("new", "new", None).await.unwrap();
        assert!(local_tls_fixture("new", "new", Some("wrong.invalid"))
            .await
            .is_err());
        assert!(local_tls_fixture("old", "new", None).await.is_err());
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[test]
    fn security_login_sm3_standard_vectors() {
        assert_eq!(
            sm3_hex(b"abc"),
            "66C7F0F462EEEDD9D1F2D46BDC10E4E24167C4875CF2F7A2297DA02B8F4BA8E0"
        );
        assert_eq!(
            sm3_hex(&b"abcd".repeat(16)),
            "DEBE9FF92275B8A138604889C18E5A4D6FDB70E5387E5765293DCBA39C0C5732"
        );
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[test]
    fn security_login_packet_is_fixed_big_endian_ascii_and_role() {
        let packet = encode_login("fixture", "fixture-secret", 1).unwrap();
        assert_eq!(&packet[..8], &[0, 0, 0, 12, 0, 0, 0, 7]);
        assert_eq!(&packet[8..15], b"fixture");
        assert_eq!(&packet[15..19], &[0, 0, 0, 64]);
        assert_eq!(packet.last(), Some(&1));
        assert_eq!(packet.len(), 84);
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[test]
    fn security_login_rejects_unverified_encoding_and_boundaries() {
        assert!(encode_login("fixture", "password", 0).is_err());
        assert!(encode_login("fixture", "password", 4).is_err());
        assert!(encode_login("", "password", 1).is_err());
        assert!(encode_login("名字", "password", 1).is_err());
        assert!(encode_login("fixture", "密码", 1).is_err());
        assert!(encode_login(&"a".repeat(33), "password", 1).is_err());
        assert!(encode_login("fixture", &"a".repeat(33), 1).is_err());
        assert!(encode_login(&"a".repeat(32), &"a".repeat(32), 3).is_ok());
    }

    async fn fragmented_reply(ret: i32, tail: &[u8]) -> Reply {
        let mut bytes = Vec::from(12_i32.to_be_bytes());
        bytes.extend_from_slice(&ret.to_be_bytes());
        bytes.extend_from_slice(tail);
        let (mut writer, mut reader) = tokio::io::duplex(256);
        let sender = tokio::spawn(async move {
            for byte in bytes {
                writer.write_all(&[byte]).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let result = read_login_reply(&mut reader).await.unwrap();
        sender.await.unwrap();
        result
    }
    fn fixture_request() -> LoginRequest {
        LoginRequest {
            request_id: "fixture-1".into(),
            mode: LoginMode::Direct,
            device_id: None,
            username: "fixture".into(),
            password: "fixture-secret".into(),
            role: 1,
        }
    }

    // 使用本地字节流或进程内状态验证，不连接真实纵密装置。
    #[tokio::test]
    async fn security_login_known_rejections_and_lock_are_not_sessions() {
        for (ret, tail, code) in [
            (0, vec![0], "credentials_rejected"),
            (0, vec![2, b'6', b'0'], "account_locked"),
            (-2, vec![], "ukey_unavailable"),
            (-1, vec![], "pin_rejected"),
            (-4, vec![], "ukey_attempt_limit"),
            (1, vec![], "license_required"),
        ] {
            let result = apply_reply(
                LoginResult::new(&fixture_request()),
                fragmented_reply(ret, &tail).await,
            );
            assert_eq!(result.code, code);
            assert_eq!(result.state, "failed");
            assert!(result.session_id.is_none());
            assert!(result.username.is_none());
            assert!(result.role.is_none());
            if code == "account_locked" {
                assert_eq!(result.lock_seconds, Some(60));
            }
        }
    }

    // 使用本地字节流或进程内状态验证，不连接真实纵密装置。
    #[tokio::test]
    async fn security_login_unknown_nonzero_tail_never_authenticates() {
        for ret in [2, 3, 7, 99, -3, -99] {
            let result = apply_reply(
                LoginResult::new(&fixture_request()),
                fragmented_reply(ret, &[1, 0, 3, b'n', b'o', b'w']).await,
            );
            assert_eq!(result.state, "unverified_response");
            assert!(result.session_id.is_none());
            assert!(result.last_login_at.is_none());
        }
    }

    // 使用本地字节流或进程内状态验证，不连接真实纵密装置。
    #[tokio::test]
    async fn security_login_unknown_expiration_never_opens_change_challenge() {
        let result = apply_reply(
            LoginResult::new(&fixture_request()),
            fragmented_reply(7, &[1, 2, 0]).await,
        );
        assert_eq!(result.state, "unverified_response");
        assert!(result.challenge_id.is_none());
        assert!(result.session_id.is_none());
        assert_eq!(
            get_vertical_security_login_capabilities().password_change_available,
            cfg!(windows)
        );
    }

    // 使用本地字节流或进程内状态验证，不连接真实纵密装置。
    #[tokio::test]
    async fn security_login_malformed_or_truncated_responses_fail_closed() {
        for bytes in [
            vec![],
            vec![0, 0, 0, 12],
            vec![0, 0, 0, 13, 0, 0, 0, 0],
            vec![0, 0, 0, 12, 0, 0, 0, 0, 128],
            vec![0, 0, 0, 12, 0, 0, 0, 17, 1, 0, 128],
        ] {
            let mut cursor = &bytes[..];
            assert!(read_login_reply(&mut cursor).await.is_err());
        }
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[test]
    fn security_login_cancellation_precedes_start_and_is_idempotent() {
        let manager = SecurityLoginManager::default();
        manager.cancel("fixture-early").unwrap();
        manager.cancel("fixture-early").unwrap();
        assert!(manager.begin("fixture-early").is_err());
        let (receiver, guard) = manager.begin("fixture-running").unwrap();
        assert!(!*receiver.borrow());
        assert!(manager.begin("fixture-running").is_err());
        manager.cancel("fixture-running").unwrap();
        assert!(*receiver.borrow());
        drop(guard);
        assert!(manager.begin("fixture-running").is_err());
        let (receiver, _guard) = manager.begin("fixture-next").unwrap();
        manager.cancel_all();
        assert!(*receiver.borrow());
    }

    // 验证待处理请求及取消记录均有上限，避免重复调用无限占用进程资源。
    #[test]
    fn security_login_pending_and_cancel_records_are_bounded() {
        let manager = SecurityLoginManager::default();
        let guards: Vec<_> = (0..4)
            .map(|index| manager.begin(&format!("fixture-active-{index}")).unwrap())
            .collect();
        assert!(manager.begin("fixture-over-limit").is_err());
        manager.cancel_all();
        assert!(guards.iter().all(|(receiver, _)| *receiver.borrow()));
        drop(guards);
        for index in 0..1020 {
            manager.cancel(&format!("fixture-retired-{index}")).unwrap();
        }
        assert!(manager.cancel("fixture-cancel-over-limit").is_err());
        assert!(manager.begin("fixture-start-over-limit").is_err());
        assert!(manager.inner.lock().retired.len() <= 1024);
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[test]
    fn security_login_request_ids_and_payloads_are_bounded_and_strict() {
        for id in ["", "bad id", "../bad", "名字"] {
            assert!(validate_request_id(id).is_err());
        }
        assert!(validate_request_id(&"x".repeat(129)).is_err());
        let base = serde_json::json!({"request_id":"fixture", "mode":"direct", "username":"fixture", "password":"fixture-secret", "role":1});
        for field in [
            "target_ip",
            "port",
            "command",
            "skip_certificate_verification",
        ] {
            let mut input = base.clone();
            input[field] = serde_json::json!("arbitrary");
            assert!(serde_json::from_value::<LoginRequest>(input).is_err());
        }
        assert!(serde_json::from_value::<LoginRequest>(base).is_ok());
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[test]
    fn security_login_invalid_certificate_never_configures_profile() {
        let request = CertificateRequest {
            client_certificate_path: "relative.p12".into(),
            trust_certificate_path: "relative.pem".into(),
            certificate_password: "fixture-secret".into(),
            server_name: TARGET_IP.into(),
        };
        assert!(load_profile(request).is_err());
        let profile = CertificateProfile::default();
        assert!(!profile.configured);
        let serialized = serde_json::to_string(&profile).unwrap();
        assert!(!serialized.contains("password"));
    }

    // 纯 fixture 验证该分支，不连接真实纵密装置。
    #[tokio::test]
    async fn security_login_unknown_change_and_logout_are_errors() {
        let manager = SecurityLoginManager::default();
        assert!(manager.close_session("unknown").is_err());
        assert!(
            !manager
                .change_password("unknown", Zeroizing::new("Fixture@2468X".into()))
                .await
                .changed
        );
        assert!(!get_vertical_security_login_capabilities().remote_available);
    }
}

#[cfg(test)]
mod management_probe_tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    // 探测关闭时不写入账号或业务字节，远端应读到 EOF。
    #[tokio::test]
    async fn security_management_probe_closes_without_credentials() {
        let (stream, mut peer) = tokio::io::duplex(256);
        let manager = SecurityLoginManager::default();
        assert!(run_management_probe(&manager, || async { Ok(stream) })
            .await
            .is_ok());
        assert!(manager.management_probe.try_lock().is_ok());
        let mut received = Vec::new();
        peer.read_to_end(&mut received).await.unwrap();
        assert!(received.is_empty());
    }

    // 探测进行中不执行第二次建连，取消未来后连接与并发许可均应释放。
    #[tokio::test]
    async fn security_management_probe_rejects_overlap_and_releases_on_cancel() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (stream, mut peer) = tokio::io::duplex(256);
        let (started, ready) = tokio::sync::oneshot::channel();
        let owner = manager.clone();
        let task = tokio::spawn(async move {
            run_management_probe(&owner, || async move {
                let _stream = stream;
                let _ = started.send(());
                std::future::pending::<Result<tokio::io::DuplexStream, ManagementError>>().await
            })
            .await
        });
        ready.await.unwrap();
        let called = std::sync::atomic::AtomicBool::new(false);
        let result = run_management_probe(&manager, || async {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            let (stream, _) = tokio::io::duplex(32);
            Ok(stream)
        })
        .await;
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(result.err().unwrap().code, "management_probe_busy");
        task.abort();
        let _ = task.await;
        assert!(manager.management_probe.try_lock().is_ok());
        let mut received = Vec::new();
        peer.read_to_end(&mut received).await.unwrap();
        assert!(received.is_empty());
        let (stream, _) = tokio::io::duplex(32);
        assert!(run_management_probe(&manager, || async { Ok(stream) })
            .await
            .is_ok());
    }

    // 拒绝连接与超时的提示必须可区分，并且都属于 TCP 阶段。
    #[test]
    fn security_management_refusal_is_distinct_from_timeout() {
        for code in [10061, 111, 61] {
            let refusal = TlsAttemptError::ConnectionFailed(Some(code));
            assert!(refusal.message().contains("拒绝连接"));
            assert!(!refusal.is_tls());
        }
        assert!(TlsAttemptError::ConnectionTimeout(None)
            .message()
            .contains("超时"));
        assert!(!TlsAttemptError::ConnectionTimeout(None).is_tls());
    }
}
