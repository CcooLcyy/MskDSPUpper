//! 独立纵密 TLS 登录。成功码尚无设备证据，任何未知应答均关闭连接，不建立身份。
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
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::watch,
};
use zeroize::{Zeroize, Zeroizing};

#[path = "security_login_builtin.rs"]
mod builtin;

const TARGET_IP: &str = "11.22.33.44";
const TARGET_PORT: u16 = 8888;
const MAX_CERT_BYTES: u64 = 4 * 1024 * 1024;
const REMOTE_REASON: &str = "远程纵密网络通道待接入，平台在线或 SSH 可达不能代替纵密管理连接";

#[derive(Clone, Copy, Deserialize, Serialize)]
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
}
struct LoadedProfile {
    metadata: CertificateProfile,
    candidates: Vec<TlsCandidate>,
    server_name: String,
}
#[derive(Default)]
struct LoginInner {
    profile: Option<Arc<LoadedProfile>>,
    builtin_cache: Option<Arc<LoadedProfile>>,
    pending: HashMap<String, watch::Sender<bool>>,
    // 保留取消及完成记录，防止 IPC 迟到造成先取消后启动，或重复使用请求标识。
    retired: HashMap<String, Instant>,
    config_generation: u64,
}
#[derive(Default)]
pub struct SecurityLoginManager {
    inner: Mutex<LoginInner>,
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
    pub fn cancel_all(&self) {
        tracing::info!("清理纵密待处理登录，保留当前进程证书配置");
        for cancellation in self.inner.lock().pending.values() {
            let _ = cancellation.send(true);
        }
    }
    fn prune(inner: &mut LoginInner) {
        inner
            .retired
            .retain(|_, at| at.elapsed() < Duration::from_secs(300));
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
            client_certificate_path: Some(request.client_certificate_path.clone()),
            trust_certificate_path: Some(request.trust_certificate_path.clone()),
            server_name: Some(server_name.clone()),
        },
        candidates: vec![TlsCandidate {
            connector: connector.into(),
            validity: None,
        }],
        server_name,
    })
}

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
    let connector = builder
        .build()
        .map_err(|_| "内置配套证书连接配置加载失败".to_string())?;
    Ok(TlsCandidate {
        connector: connector.into(),
        validity: Some(resource.validity()?),
    })
}

fn load_builtin_profile_at(now: i64) -> Result<LoadedProfile, String> {
    let mut candidates = Vec::with_capacity(builtin::IDENTITIES.len());
    let mut selected = Vec::new();
    for resource in builtin::IDENTITIES {
        if !resource.validity()?.contains(now) {
            tracing::info!(profile = resource.id, "内置纵密证书不在有效期内，已跳过");
            continue;
        }
        candidates.push(parse_builtin_candidate(resource)?);
        selected.push(resource.id);
        tracing::info!(profile = resource.id, "内置纵密配套证书已在进程内解析");
    }
    if candidates.is_empty() {
        return Err("内置配套证书均未生效或已过期，请检查系统时间或替换有效证书".into());
    }
    let label = match selected.as_slice() {
        ["new"] => "内置配套证书（新组）",
        ["old"] => "内置配套证书（旧组）",
        _ => "内置配套证书",
    };
    Ok(LoadedProfile {
        metadata: CertificateProfile {
            configured: true,
            source: "builtin",
            label,
            client_certificate_path: None,
            trust_certificate_path: None,
            server_name: Some(TARGET_IP.into()),
        },
        candidates,
        server_name: TARGET_IP.into(),
    })
}

async fn initialize_builtin_profile(
    manager: &SecurityLoginManager,
    force: bool,
) -> Result<Arc<LoadedProfile>, String> {
    let (generation, cached) = {
        let mut inner = manager.inner.lock();
        if !force {
            if let Some(profile) = &inner.profile {
                return Ok(profile.clone());
            }
        } else {
            inner.config_generation = inner.config_generation.wrapping_add(1);
        }
        (inner.config_generation, inner.builtin_cache.clone())
    };
    let loaded = match cached {
        Some(cached) => cached,
        None => Arc::new(
            tokio::task::spawn_blocking(load_builtin_profile)
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
    }
    inner.builtin_cache = Some(loaded.clone());
    inner.profile = Some(loaded.clone());
    Ok(loaded)
}

#[derive(Debug)]
enum TlsAttemptError {
    Connection,
    Certificate,
}

async fn select_tls_candidate<T, F, Fut>(
    count: usize,
    mut handshake: F,
) -> Result<T, TlsAttemptError>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<T, TlsAttemptError>>,
{
    for index in 0..count {
        match handshake(index).await {
            Ok(stream) => return Ok(stream),
            Err(TlsAttemptError::Certificate) if index + 1 < count => {
                tracing::info!("内置配套证书握手未通过，尚未发送账号，尝试另一组证书");
            }
            Err(error) => return Err(error),
        }
    }
    Err(TlsAttemptError::Certificate)
}

enum Reply {
    CredentialsRejected,
    Locked(Option<u32>),
    UkeyUnavailable,
    PinRejected,
    UkeyLimit,
    LicenseRequired,
    PasswordExpired,
    Unverified,
}
async fn read_login_reply<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Reply, &'static str> {
    if reader.read_i32().await.map_err(|_| "登录应答不完整")? != 12 {
        return Err("登录应答命令不匹配");
    }
    let ret = reader.read_i32().await.map_err(|_| "登录应答不完整")?;
    match ret {
        0 => {
            let length = reader.read_u8().await.map_err(|_| "失败应答不完整")?;
            if length == 0 {
                return Ok(Reply::CredentialsRejected);
            }
            if length > 127 {
                return Err("锁定应答长度无效");
            }
            let mut seconds = vec![0; length as usize];
            reader
                .read_exact(&mut seconds)
                .await
                .map_err(|_| "锁定应答不完整")?;
            let value = std::str::from_utf8(&seconds)
                .ok()
                .filter(|text| text.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|text| text.parse().ok());
            Ok(Reply::Locked(value))
        }
        -2 => Ok(Reply::UkeyUnavailable),
        -1 => Ok(Reply::PinRejected),
        -4 => Ok(Reply::UkeyLimit),
        // 原程序在此应答后进入许可流程；本轮不调用许可命令。
        1 => Ok(Reply::LicenseRequired),
        _ => {
            let _count = reader.read_u8().await.map_err(|_| "登录资料不完整")?;
            let update = reader.read_u8().await.map_err(|_| "登录资料不完整")?;
            let length = reader.read_u8().await.map_err(|_| "登录资料不完整")?;
            if length > 127 {
                return Err("登录资料长度无效");
            }
            let mut last_login = vec![0; length as usize];
            reader
                .read_exact(&mut last_login)
                .await
                .map_err(|_| "登录资料不完整")?;
            // 正常成功码集合尚待设备验证；附带登录资料不能作为认证成功的依据。
            if update == 2 {
                Ok(Reply::PasswordExpired)
            } else {
                Ok(Reply::Unverified)
            }
        }
    }
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
        Reply::PasswordExpired => {
            let mut result = result.failure(
                2,
                "password_expired",
                "设备报告密码过期；修改流程待验证，请使用原纵密上位机处理后重新登录",
            );
            result.state = "password_change_required";
            return result;
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

async fn connect_and_authenticate(
    mut result: LoginResult,
    profile: Arc<LoadedProfile>,
    packet: Zeroizing<Vec<u8>>,
) -> LoginResult {
    let Ok(now) = current_unix_time() else {
        return result.failure(
            1,
            "certificate_time_invalid",
            "系统时间无效，无法检查证书有效期",
        );
    };
    let active: Vec<_> = profile
        .candidates
        .iter()
        .filter(|candidate| {
            candidate
                .validity
                .map(|validity| validity.contains(now))
                .unwrap_or(true)
        })
        .collect();
    if active.is_empty() {
        return result.failure(
            1,
            "certificate_expired",
            "内置配套证书均未生效或已过期，请替换有效证书",
        );
    }
    // 在此阶段尚未发送任何账号材料；候选切换只处理 TLS 证书阶段失败。
    let mut stream = match select_tls_candidate(active.len(), |index| {
        let profile = profile.clone();
        let connector = active[index].connector.clone();
        async move {
            let stream = tokio::time::timeout(
                Duration::from_secs(4),
                tokio::net::TcpStream::connect((TARGET_IP, TARGET_PORT)),
            )
            .await
            .map_err(|_| TlsAttemptError::Connection)?
            .map_err(|_| TlsAttemptError::Connection)?;
            tracing::info!("纵密固定管理服务已连接，开始证书握手");
            tokio::time::timeout(
                Duration::from_secs(6),
                connector.connect(&profile.server_name, stream),
            )
            .await
            .map_err(|_| TlsAttemptError::Certificate)?
            .map_err(|_| TlsAttemptError::Certificate)
        }
    })
    .await
    {
        Ok(stream) => stream,
        Err(TlsAttemptError::Connection) => {
            return result.failure(
                0,
                "connection_failed",
                "无法连接纵密管理服务，请检查 101 至 108 口的访问路径",
            )
        }
        Err(TlsAttemptError::Certificate) => {
            result.success_step(0, "已连接固定纵密管理服务");
            return result.failure(
                1,
                "tls_failed",
                "证书握手失败或超时，请检查证书、信任链、服务器名称与设备 TLS 兼容性",
            );
        }
    };
    result.success_step(0, "已连接固定纵密管理服务");
    result.success_step(1, "证书链与服务器名称验证通过");
    tracing::info!("纵密证书验证通过，开始身份认证");
    let exchange = async {
        stream
            .write_all(&packet)
            .await
            .map_err(|_| "无法发送登录请求")?;
        stream.flush().await.map_err(|_| "无法发送登录请求")?;
        read_login_reply(&mut stream).await
    };
    let reply = tokio::time::timeout(Duration::from_secs(8), exchange).await;
    // 每个分支均释放 TLS 和 TCP 流，关闭未经验证的连接。
    match reply {
        Ok(Ok(reply)) => apply_reply(result, reply),
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

#[tauri::command]
pub fn get_vertical_security_login_capabilities() -> LoginCapabilities {
    LoginCapabilities {
        direct_available: cfg!(windows),
        remote_available: false,
        password_change_available: false,
        reason: "当前仅支持证书配置及直连 TLS 登录尝试；正常成功码尚待真机验证，当前不会创建认证会话；改密和远程通道待接入",
    }
}
#[tauri::command]
pub async fn get_vertical_security_certificate_profile(
    state: tauri::State<'_, AppState>,
) -> Result<CertificateProfile, String> {
    Ok(initialize_builtin_profile(&state.security_login, false)
        .await?
        .metadata
        .clone())
}
#[tauri::command]
pub async fn use_builtin_vertical_security_certificates(
    state: tauri::State<'_, AppState>,
) -> Result<CertificateProfile, String> {
    let profile = initialize_builtin_profile(&state.security_login, true).await?;
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
        inner.config_generation = inner.config_generation.wrapping_add(1);
        inner.config_generation
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
    let metadata = loaded.metadata.clone();
    inner.profile = Some(Arc::new(loaded));
    tracing::info!("纵密证书配置完成，仅在当前进程有效");
    Ok(metadata)
}
#[tauri::command]
pub async fn login_vertical_security(
    state: tauri::State<'_, AppState>,
    mut request: LoginRequest,
) -> Result<LoginResult, String> {
    tracing::info!("开始独立纵密登录请求");
    let mut result = LoginResult::new(&request);
    let packet = match encode_login(&request.username, &request.password, request.role) {
        Ok(packet) => packet,
        Err(message) => return Ok(result.failure(2, "invalid_credentials", message)),
    };
    request.password.zeroize();
    let manager = &state.security_login;
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
    let profile = match initialize_builtin_profile(manager, false).await {
        Ok(profile) => profile,
        Err(_) => {
            return Ok(result.failure(
                1,
                "certificate_required",
                "内置配套证书加载失败，可在高级选项中替换自定义证书",
            ))
        }
    };
    let cancelled =
        LoginResult::new(&request).failure(0, "cancelled", "纵密登录已取消，连接已关闭");
    tokio::select! { biased;
        _ = async { if !*cancellation.borrow() { let _ = cancellation.changed().await; } } => Ok(cancelled),
        response = connect_and_authenticate(result, profile, packet) => {
            tracing::info!(code = response.code, state = response.state, "纵密登录尝试结束");
            if *cancellation.borrow() { Ok(cancelled) } else { Ok(response) }
        }
    }
}
#[tauri::command]
pub fn cancel_vertical_security_login(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    state.security_login.cancel(&request_id)
}
#[tauri::command]
pub fn logout_vertical_security(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Err("未知纵密会话；尚未创建已验证的纵密身份".into())
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
pub fn change_vertical_security_password(
    mut request: PasswordChangeRequest,
) -> Result<PasswordChangeResult, String> {
    request.new_password.zeroize();
    let _ = &request.challenge_id;
    Err("纵密密码修改尚未验证，当前未发送任何修改命令，请使用原纵密上位机处理".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 实际加载两套内置配套身份及信任证书，不连接设备或写入系统证书存储。
    #[test]
    fn security_login_builtin_profiles_are_real_and_default() {
        let profile = load_builtin_profile_at(1_790_000_000).unwrap();
        assert!(profile.metadata.configured);
        assert_eq!(profile.metadata.source, "builtin");
        assert_eq!(profile.metadata.label, "内置配套证书（新组）");
        assert!(profile.metadata.client_certificate_path.is_none());
        assert!(profile.metadata.trust_certificate_path.is_none());
        assert_eq!(profile.server_name, TARGET_IP);
        assert_eq!(profile.candidates.len(), 1);
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../resources/vertical-security/manifest.json"
        ))
        .unwrap();
        for resource in builtin::IDENTITIES {
            // 显式解析归档的两套身份；运行时仅选择在有效期内的新组。
            assert!(parse_builtin_candidate(resource).is_ok());
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
        assert!(load_builtin_profile_at(0).is_err());
        assert!(load_builtin_profile_at(4_802_035_178).is_err());
    }

    // 通过真实内置资源验证默认缓存、自定义替换保留及恢复默认时取消旧请求。
    #[tokio::test]
    async fn security_login_builtin_cache_custom_override_and_restore() {
        let manager = SecurityLoginManager::default();
        let initial = initialize_builtin_profile(&manager, false).await.unwrap();
        let cached = initialize_builtin_profile(&manager, false).await.unwrap();
        assert!(Arc::ptr_eq(&initial, &cached));
        let mut custom = load_builtin_profile().unwrap();
        custom.metadata.source = "custom";
        custom.metadata.label = "自定义证书";
        let custom = Arc::new(custom);
        {
            let mut inner = manager.inner.lock();
            inner.config_generation += 1;
            inner.profile = Some(custom.clone());
        }
        assert!(Arc::ptr_eq(
            &custom,
            &initialize_builtin_profile(&manager, false).await.unwrap()
        ));
        let late = activate_builtin_profile(&manager, 0, false, initial.clone()).unwrap();
        assert!(Arc::ptr_eq(&custom, &late));
        assert!(activate_builtin_profile(&manager, 0, true, initial.clone()).is_err());
        let (receiver, _guard) = manager.begin("fixture-before-reset").unwrap();
        let restored = initialize_builtin_profile(&manager, true).await.unwrap();
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
                    Err(TlsAttemptError::Certificate)
                } else {
                    Ok("stream")
                }
            }
        })
        .await;
        assert_eq!(selected.unwrap(), "stream");
        assert_eq!(count.load(Ordering::SeqCst), 2);
        let count = Arc::new(AtomicUsize::new(0));
        let attempts = count.clone();
        assert!(select_tls_candidate::<(), _, _>(2, move |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err(TlsAttemptError::Connection) }
        })
        .await
        .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
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
        let (mut writer, mut reader) = tokio::io::duplex(1);
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
    async fn security_login_expiration_is_not_authenticated_or_change_challenge() {
        let result = apply_reply(
            LoginResult::new(&fixture_request()),
            fragmented_reply(7, &[1, 2, 0]).await,
        );
        assert_eq!(result.state, "password_change_required");
        assert!(result.challenge_id.is_none());
        assert!(result.session_id.is_none());
        assert!(!get_vertical_security_login_capabilities().password_change_available);
    }

    // 使用本地字节流或进程内状态验证，不连接真实纵密装置。
    #[tokio::test]
    async fn security_login_malformed_or_truncated_responses_fail_closed() {
        for bytes in [
            vec![],
            vec![0, 0, 0, 12],
            vec![0, 0, 0, 13, 0, 0, 0, 0],
            vec![0, 0, 0, 12, 0, 0, 0, 0, 128],
            vec![0, 0, 0, 12, 0, 0, 0, 7, 1, 0, 128],
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
    #[test]
    fn security_login_unimplemented_change_and_unknown_logout_are_errors() {
        assert!(logout_vertical_security("unknown".into()).is_err());
        assert!(change_vertical_security_password(PasswordChangeRequest {
            challenge_id: "unknown".into(),
            new_password: "fixture-secret".into()
        })
        .is_err());
        assert!(!get_vertical_security_login_capabilities().remote_available);
    }
}
