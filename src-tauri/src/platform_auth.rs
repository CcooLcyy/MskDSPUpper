//! 密码由系统凭据存储保存，按需回填登录表单；会话令牌仅留在 Rust。
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};
use tonic::{
    transport::{Channel, ClientTlsConfig, Endpoint},
    Code, Request,
};

#[path = "platform_auth_store.rs"]
mod store;
pub use store::PlatformLoginSettings;
use store::{CredentialStore, StoredSettings, WindowsCredentials};

pub mod protocol {
    tonic::include_proto!("mskdsp.platform.v1");
}
use protocol::agent_service_client::AgentServiceClient;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: &str = "platform.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlatformAccountRole {
    Admin,
    Operator,
}

impl PlatformAccountRole {
    fn from_platform(role: &str) -> Result<Self, String> {
        match role {
            "admin" => Ok(Self::Admin),
            // 兼容尚未提供角色字段的旧版平台，空值按运维人员解析。
            "" | "operator" => Ok(Self::Operator),
            _ => Err("平台账号角色无效，请检查平台版本".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PlatformAuthStatus {
    pub authenticated: bool,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub role: Option<PlatformAccountRole>,
    pub connection_state: String,
    pub expires_at: Option<i64>,
    pub message: Option<String>,
}

struct Session {
    token: String,
    account_id: String,
    username: String,
    display_name: String,
    role: PlatformAccountRole,
    deadline: Instant,
    expires_at: i64,
}

struct Inner {
    stored: StoredSettings,
    settings_error: Option<String>,
    session: Option<Session>,
    generation: u64,
    connection_state: &'static str,
    message: Option<String>,
    auto_login_blocked: bool,
    shutting_down: bool,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct PlatformAuthManager {
    inner: Arc<Mutex<Inner>>,
    operation: Arc<AsyncMutex<()>>,
    logout_operation: Arc<AsyncMutex<()>>,
    settings_file: PathBuf,
    credentials: Arc<dyn CredentialStore>,
}

impl PlatformAuthManager {
    #[cfg(test)]
    pub(crate) fn test_session(endpoint: String) -> Self {
        let auth = Self::new(
            std::env::temp_dir().join(format!("remote-test-{}.json", std::process::id())),
        );
        {
            let mut state = auth.inner.lock();
            state.stored.settings.grpc_endpoint = endpoint;
            state.session = Some(Session {
                token: "test-session".into(),
                account_id: "test".into(),
                username: "test".into(),
                display_name: "test".into(),
                role: PlatformAccountRole::Operator,
                deadline: Instant::now() + Duration::from_secs(300),
                expires_at: now_ms() + 300_000,
            });
        }
        auth
    }
    /// 仅 Rust 传输层获取会话；不向前端暴露访问令牌。
    pub(crate) fn remote_credentials(&self) -> Result<(String, String, u64), String> {
        self.require_authenticated()?;
        let state = self.inner.lock();
        let session = state.session.as_ref().ok_or("平台登录已失效")?;
        Ok((
            state.stored.settings.grpc_endpoint.clone(),
            session.token.clone(),
            state.generation,
        ))
    }

    pub(crate) fn remote_generation_valid(&self, generation: u64) -> bool {
        self.status().authenticated && self.inner.lock().generation == generation
    }

    pub fn new(settings_file: PathBuf) -> Self {
        Self::with_store(settings_file, Arc::new(WindowsCredentials))
    }

    fn with_store(settings_file: PathBuf, credentials: Arc<dyn CredentialStore>) -> Self {
        let (stored, settings_error) = match StoredSettings::load(&settings_file) {
            Ok(stored) => (stored, None),
            Err(error) => (
                StoredSettings {
                    settings: PlatformLoginSettings::default(),
                    instance_id: String::new(),
                },
                Some(error),
            ),
        };
        Self {
            inner: Arc::new(Mutex::new(Inner {
                stored,
                settings_error,
                session: None,
                generation: 0,
                connection_state: "signed_out",
                message: None,
                auto_login_blocked: false,
                shutting_down: false,
                worker: None,
            })),
            operation: Arc::new(AsyncMutex::new(())),
            logout_operation: Arc::new(AsyncMutex::new(())),
            settings_file,
            credentials,
        }
    }

    pub fn status(&self) -> PlatformAuthStatus {
        let mut state = self.inner.lock();
        if state
            .session
            .as_ref()
            .is_some_and(|s| Instant::now() >= s.deadline || now_ms() >= s.expires_at)
        {
            clear_session(&mut state, Some("登录已过期，请重新登录".into()));
        }
        PlatformAuthStatus {
            authenticated: state.session.is_some(),
            username: state.session.as_ref().map(|s| s.username.clone()),
            display_name: state.session.as_ref().map(|s| s.display_name.clone()),
            role: state.session.as_ref().map(|s| s.role),
            connection_state: state.connection_state.to_string(),
            expires_at: state.session.as_ref().map(|s| s.expires_at),
            message: state
                .message
                .clone()
                .or_else(|| state.settings_error.clone()),
        }
    }

    pub fn require_authenticated(&self) -> Result<(), String> {
        if self.status().authenticated {
            Ok(())
        } else {
            Err("请先登录平台后再进行配置".into())
        }
    }

    pub fn settings(&self) -> Result<PlatformLoginSettings, String> {
        let state = self.inner.lock();
        if let Some(error) = &state.settings_error {
            return Err(error.clone());
        }
        Ok(state.stored.settings.clone())
    }

    pub async fn save_settings(
        &self,
        mut settings: PlatformLoginSettings,
    ) -> Result<PlatformLoginSettings, String> {
        settings.grpc_endpoint =
            crate::platform_software::validate_endpoint(settings.grpc_endpoint.trim())?;
        settings.username = settings.username.trim().to_ascii_lowercase();
        if settings.username.len() > 128 {
            return Err("用户名过长".into());
        }
        settings.remember_password |= settings.auto_login;
        let mut state = self.inner.lock();
        if let Some(error) = &state.settings_error {
            return Err(error.clone());
        }
        let old = &state.stored.settings;
        let changed_identity =
            old.grpc_endpoint != settings.grpc_endpoint || old.username != settings.username;
        let changed_settings = *old != settings;
        if changed_identity || !settings.remember_password {
            self.credentials.delete(&old.grpc_endpoint, &old.username)?;
        }
        // 偏好变更也取消在途登录，防止旧响应恢复已清除的密码。
        if changed_identity
            || (state.session.is_none()
                && (changed_settings || state.connection_state == "connecting"))
        {
            clear_session(&mut state, None);
            state.auto_login_blocked = true;
        }
        if changed_settings {
            tracing::info!("平台登录设置已变更");
        }
        let old_settings = state.stored.settings.clone();
        state.stored.settings = settings.clone();
        if let Err(error) = state.stored.save(&self.settings_file) {
            state.stored.settings = old_settings;
            return Err(error);
        }
        Ok(settings)
    }

    /// 保留凭据存在性接口，避免调用方为判断存在而接收密码。
    pub fn has_saved_password(&self, username: &str) -> Result<bool, String> {
        Ok(self.saved_password(username)?.is_some())
    }

    /// 仅为当前平台、当前已记住的账号回填登录表单；不写入状态或日志。
    pub fn saved_password(&self, username: &str) -> Result<Option<String>, String> {
        let username = username.trim().to_ascii_lowercase();
        let state = self.inner.lock();
        if let Some(error) = &state.settings_error {
            return Err(error.clone());
        }
        let settings = &state.stored.settings;
        if username.is_empty() || username != settings.username || !settings.remember_password {
            return Ok(None);
        }
        Ok(self
            .credentials
            .load(&settings.grpc_endpoint, &username)?
            .filter(|password| !password.is_empty()))
    }

    pub async fn login(
        &self,
        username: String,
        password: String,
        auto_login: bool,
        remember_password: bool,
    ) -> Result<PlatformAuthStatus, String> {
        self.login_internal(username, password, auto_login, remember_password, None)
            .await
    }

    pub async fn auto_login(&self) -> Result<PlatformAuthStatus, String> {
        let settings = self.settings()?;
        if !settings.auto_login || self.inner.lock().auto_login_blocked {
            return Err("自动登录未启用，请手动登录".into());
        }
        let password = self
            .credentials
            .load(&settings.grpc_endpoint, &settings.username)?
            .ok_or("未保存平台密码，请手动登录")?;
        self.login_internal(
            settings.username.clone(),
            password,
            true,
            true,
            Some(settings),
        )
        .await
    }

    async fn login_internal(
        &self,
        username: String,
        mut password: String,
        auto_login: bool,
        remember_password: bool,
        automatic: Option<PlatformLoginSettings>,
    ) -> Result<PlatformAuthStatus, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "正在登录，请稍候".to_string())?;
        let username = username.trim().to_ascii_lowercase();
        let remember_password = remember_password || auto_login;
        if username.is_empty() || username.len() > 128 || password.len() > 128 {
            return Err("请输入有效的用户名和密码".into());
        }
        let (generation, endpoint) = {
            let mut state = self.inner.lock();
            if state.shutting_down {
                return Err("上位机正在退出".into());
            }
            if let Some(error) = &state.settings_error {
                return Err(error.clone());
            }
            if let Some(expected) = &automatic {
                if state.auto_login_blocked || *expected != state.stored.settings {
                    return Err("自动登录设置已变更，请手动登录".into());
                }
            }
            if password.is_empty() {
                let settings = &state.stored.settings;
                if !remember_password
                    || !settings.remember_password
                    || settings.username != username
                {
                    return Err("请输入有效的用户名和密码".into());
                }
                password = self
                    .credentials
                    .load(&settings.grpc_endpoint, &username)?
                    .filter(|value| !value.is_empty() && value.len() <= 128)
                    .ok_or("未保存平台密码，请手动输入密码")?;
                tracing::info!("使用系统保存的平台凭据重新认证");
            }
            clear_session(&mut state, None);
            state.connection_state = "connecting";
            if automatic.is_none() {
                state.auto_login_blocked = false;
            }
            (
                state.generation,
                state.stored.settings.grpc_endpoint.clone(),
            )
        };
        // 从请求开始计有效期，避免响应延迟延长本地会话。
        let started = Instant::now();
        let started_ms = now_ms();
        let result = async {
            let mut client = client(&endpoint).await?;
            client
                .login(timed_request(protocol::LoginRequest {
                    username: username.clone(),
                    password: password.clone(),
                }))
                .await
                .map(|response| response.into_inner())
                .map_err(|s| RpcFailure::from_status(s, true))
        }
        .await;
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                let mut state = self.inner.lock();
                if state.generation == generation {
                    clear_session(&mut state, Some(error.message().into()));
                }
                return Err(error.message().into());
            }
        };
        let validated = validate_login(&response, &username, started, started_ms);
        let mut state = self.inner.lock();
        if state.generation != generation {
            revoke_issued_session(endpoint, response.access_token);
            return Err("登录已取消，请重新登录".into());
        }
        let session = match validated {
            Ok(session) => session,
            Err(error) => {
                clear_session(&mut state, Some(error.clone()));
                revoke_issued_session(endpoint, response.access_token);
                return Err(error);
            }
        };
        let previous = state.stored.settings.clone();
        let persist = (|| {
            if previous.username != username {
                self.credentials
                    .delete(&previous.grpc_endpoint, &previous.username)?;
            }
            if remember_password {
                self.credentials.save(&endpoint, &username, &password)?;
            } else {
                self.credentials.delete(&endpoint, &username)?;
            }
            state.stored.settings.username = username;
            state.stored.settings.auto_login = auto_login;
            state.stored.settings.remember_password = remember_password;
            state.stored.save(&self.settings_file)
        })();
        if let Err(error) = persist {
            state.stored.settings = previous;
            clear_session(&mut state, Some(error.clone()));
            revoke_issued_session(endpoint, response.access_token);
            return Err(error);
        }
        state.session = Some(session);
        state.connection_state = "connecting";
        state.message = None;
        state.auto_login_blocked = false;
        let manager = self.clone();
        state.worker = Some(tokio::spawn(async move {
            manager.run_connection(generation).await;
        }));
        drop(state);
        Ok(self.status())
    }

    pub async fn logout(&self) -> Result<PlatformAuthStatus, String> {
        let _logout = self.logout_operation.lock().await;
        let old = {
            let mut state = self.inner.lock();
            let old = state
                .session
                .as_ref()
                .map(|s| (state.stored.settings.grpc_endpoint.clone(), s.token.clone()));
            clear_session(&mut state, None);
            state.auto_login_blocked = true;
            old
        };
        if let Some((endpoint, token)) = old {
            // 本地立即退出；服务端退出请求失败不恢复本地会话。
            match revoke_session(&endpoint, &token).await {
                Ok(()) => tracing::info!("当前平台会话已注销"),
                Err(error) => tracing::warn!(?error, "注销当前平台会话失败"),
            }
        }
        Ok(self.status())
    }

    pub(crate) async fn shutdown(&self) {
        self.inner.lock().shutting_down = true;
        // 等待已发出的登录请求完成，避免退出时留下刚签发的会话。
        let _login = self.operation.lock().await;
        let _ = self.logout().await;
    }

    fn snapshot(&self, generation: u64) -> Option<(String, String, String)> {
        if !self.status().authenticated {
            return None;
        }
        let state = self.inner.lock();
        if state.generation != generation {
            return None;
        }
        Some((
            state.stored.settings.grpc_endpoint.clone(),
            state.session.as_ref()?.token.clone(),
            state.stored.instance_id.clone(),
        ))
    }

    fn network_failure(&self, generation: u64, error: &RpcFailure) {
        let mut state = self.inner.lock();
        if state.generation != generation {
            return;
        }
        if matches!(error, RpcFailure::Revoked) {
            clear_session(&mut state, Some(error.message().into()));
            state.auto_login_blocked = true;
        } else {
            state.connection_state = "reconnecting";
            state.message = Some("平台连接中断，有效期内可继续本地配置，正在重连".into());
        }
    }

    async fn check_session(&self, generation: u64) {
        let Some((endpoint, token, _)) = self.snapshot(generation) else {
            return;
        };
        let response = async {
            let mut client = client(&endpoint).await?;
            client
                .get_session(authenticated_request(protocol::SessionRequest {}, &token)?)
                .await
                .map(|r| r.into_inner())
                .map_err(|s| RpcFailure::from_status(s, false))
        }
        .await;
        match response {
            Err(error) => self.network_failure(generation, &error),
            Ok(response) => {
                let mut state = self.inner.lock();
                if state.generation != generation {
                    return;
                }
                let Some(session) = state.session.as_ref() else {
                    return;
                };
                if response.expires_in == 0
                    || response.token_type != "Bearer"
                    || !response.access_token.is_empty()
                    || response.account.as_ref().is_none_or(|a| {
                        a.id != session.account_id || a.username != session.username
                    })
                {
                    clear_session(&mut state, Some("平台登录身份已失效，请重新登录".into()));
                    state.auto_login_blocked = true;
                    return;
                }
                if Instant::now() >= session.deadline || now_ms() >= session.expires_at {
                    clear_session(&mut state, Some("登录已过期，请重新登录".into()));
                    return;
                }
                if let Some(account) = response.account {
                    let role = match PlatformAccountRole::from_platform(&account.role) {
                        Ok(role) => role,
                        Err(error) => {
                            clear_session(&mut state, Some(error));
                            state.auto_login_blocked = true;
                            return;
                        }
                    };
                    if let Some(session) = state.session.as_mut() {
                        if session.role != role {
                            tracing::info!(previous_role = ?session.role, role = ?role, "平台账号角色已更新");
                        }
                        session.role = role;
                        session.display_name = account.display_name;
                    }
                }
                // 身份及角色同步不续期本进程原有会话，也不改变连接代次。
            }
        }
    }

    async fn run_connection(&self, generation: u64) {
        let mut retry_secs = 1;
        loop {
            let Some((endpoint, token, instance_id)) = self.snapshot(generation) else {
                return;
            };
            let result = self
                .connection_once(generation, &endpoint, &token, instance_id)
                .await;
            if let Err(error) = result {
                self.network_failure(generation, &error);
            }
            if self.snapshot(generation).is_none() {
                return;
            }
            self.check_session(generation).await;
            if self.snapshot(generation).is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_secs(retry_secs)).await;
            retry_secs = (retry_secs * 2).min(30);
        }
    }

    async fn connection_once(
        &self,
        generation: u64,
        endpoint: &str,
        token: &str,
        instance_id: String,
    ) -> Result<(), RpcFailure> {
        use protocol::{
            agent_message::Payload as AgentPayload, server_message::Payload as ServerPayload,
        };
        let mut client = client(endpoint).await?;
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.send(protocol::AgentMessage {
            payload: Some(AgentPayload::Hello(protocol::Hello {
                agent_id: instance_id,
                site_id: String::new(),
                agent_version: env!("CARGO_PKG_VERSION").into(),
                protocol_version: PROTOCOL_VERSION.into(),
                capabilities: vec![],
            })),
        })
        .await
        .map_err(|_| RpcFailure::Network)?;
        let mut request = Request::new(tokio_stream::wrappers::ReceiverStream::new(rx));
        request.metadata_mut().insert(
            "authorization",
            format!("Bearer {token}")
                .parse()
                .map_err(|_| RpcFailure::Invalid)?,
        );
        let mut stream = tokio::time::timeout(REQUEST_TIMEOUT, client.connect_agent(request))
            .await
            .map_err(|_| RpcFailure::Network)?
            .map_err(|s| RpcFailure::from_status(s, false))?
            .into_inner();
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.tick().await;
        let mut expiry = tokio::time::interval(Duration::from_secs(1));
        let mut last_response = Instant::now();
        loop {
            tokio::select! {
                _ = expiry.tick() => {
                    if self.snapshot(generation).is_none() { return Ok(()); }
                    if last_response.elapsed() > HEARTBEAT_INTERVAL * 3 { return Err(RpcFailure::Network); }
                }
                _ = heartbeat.tick() => {
                    self.check_session(generation).await;
                    if self.snapshot(generation).is_none() { return Ok(()); }
                    tx.send(protocol::AgentMessage { payload: Some(AgentPayload::Heartbeat(protocol::Heartbeat { sent_at_unix_ms: now_ms() })) })
                        .await.map_err(|_| RpcFailure::Network)?;
                }
                message = stream.message() => {
                    let message = message.map_err(|s| RpcFailure::from_status(s, false))?.ok_or(RpcFailure::Network)?;
                    match message.payload {
                        Some(ServerPayload::Welcome(welcome)) if welcome.protocol_version != PROTOCOL_VERSION => {
                            return Err(RpcFailure::Invalid);
                        }
                        Some(ServerPayload::Welcome(_)) | Some(ServerPayload::HeartbeatAck(_)) => {
                            last_response = Instant::now();
                            let mut state = self.inner.lock();
                            if state.generation != generation { return Ok(()); }
                            state.connection_state = "online"; state.message = None;
                        }
                        Some(ServerPayload::Error(error)) => {
                            let code = error.code.to_ascii_uppercase();
                            return Err(if matches!(code.as_str(), "UNAUTHENTICATED" | "PERMISSION_DENIED" | "ACCOUNT_DISABLED" | "SESSION_EXPIRED") { RpcFailure::Revoked } else { RpcFailure::Network });
                        }
                        None => return Err(RpcFailure::Invalid),
                    }
                }
            }
        }
    }
}

fn clear_session(state: &mut Inner, message: Option<String>) {
    state.generation = state.generation.wrapping_add(1);
    state.session = None;
    state.connection_state = "signed_out";
    state.message = message;
    if let Some(worker) = state.worker.take() {
        worker.abort();
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn validate_login(
    response: &protocol::LoginResponse,
    username: &str,
    started: Instant,
    started_ms: i64,
) -> Result<Session, String> {
    let account = response
        .account
        .as_ref()
        .ok_or("平台登录响应缺少账号信息")?;
    if response.token_type != "Bearer"
        || response.access_token.is_empty()
        || response.access_token.len() > 8192
        || format!("Bearer {}", response.access_token)
            .parse::<tonic::metadata::MetadataValue<tonic::metadata::Ascii>>()
            .is_err()
        || response.expires_in == 0
        || response.expires_in > 366 * 24 * 3600
        || account.id.is_empty()
        || account.username != username
    {
        return Err("平台登录响应无效".into());
    }
    let duration = Duration::from_secs(response.expires_in);
    let deadline = started.checked_add(duration).ok_or("平台登录有效期无效")?;
    let expires_at = started_ms
        .checked_add((response.expires_in * 1000) as i64)
        .ok_or("平台登录有效期无效")?;
    if Instant::now() >= deadline {
        return Err("登录已过期，请重新登录".into());
    }
    Ok(Session {
        token: response.access_token.clone(),
        account_id: account.id.clone(),
        username: account.username.clone(),
        display_name: account.display_name.clone(),
        role: PlatformAccountRole::from_platform(&account.role)?,
        deadline,
        expires_at,
    })
}

#[derive(Debug)]
enum RpcFailure {
    Network,
    Revoked,
    Invalid,
    Credentials,
}
impl RpcFailure {
    fn from_status(status: tonic::Status, login: bool) -> Self {
        match status.code() {
            Code::Unauthenticated | Code::PermissionDenied if login => Self::Credentials,
            Code::Unauthenticated | Code::PermissionDenied => Self::Revoked,
            Code::InvalidArgument | Code::FailedPrecondition => Self::Invalid,
            _ => Self::Network,
        }
    }
    fn message(&self) -> &'static str {
        match self {
            Self::Credentials => "账号或密码错误，或账号已停用",
            Self::Revoked => "平台登录已失效，请重新登录",
            Self::Invalid => "平台登录协议响应无效，请检查平台版本",
            Self::Network => "无法连接平台，请检查网络、平台地址和证书",
        }
    }
}

async fn client(endpoint: &str) -> Result<AgentServiceClient<Channel>, RpcFailure> {
    let mut transport = Endpoint::from_shared(endpoint.to_string())
        .map_err(|_| RpcFailure::Invalid)?
        .connect_timeout(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT);
    if endpoint.starts_with("https://") {
        transport = transport
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|_| RpcFailure::Invalid)?;
    }
    let channel = transport.connect().await.map_err(|_| RpcFailure::Network)?;
    Ok(AgentServiceClient::new(channel))
}

fn timed_request<T>(body: T) -> Request<T> {
    let mut request = Request::new(body);
    request.set_timeout(REQUEST_TIMEOUT);
    request
}

async fn revoke_session(endpoint: &str, token: &str) -> Result<(), RpcFailure> {
    let request = authenticated_request(protocol::SessionRequest {}, token)?;
    let mut connection = client(endpoint).await?;
    connection
        .logout(request)
        .await
        .map_err(|status| RpcFailure::from_status(status, false))?;
    Ok(())
}

fn revoke_issued_session(endpoint: String, token: String) {
    // 退出或修改设置后才完成的登录，应清理未使用的服务端会话。
    // 清理任务不触碰当前本地会话，避免覆盖新账号的状态。
    if token.is_empty() || token.len() > 8192 {
        return;
    }
    tokio::spawn(async move {
        let _ = revoke_session(&endpoint, &token).await;
    });
}
fn authenticated_request<T>(body: T, token: &str) -> Result<Request<T>, RpcFailure> {
    let mut request = timed_request(body);
    request.metadata_mut().insert(
        "authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| RpcFailure::Invalid)?,
    );
    Ok(request)
}

#[cfg(test)]
#[path = "platform_auth_tests.rs"]
mod tests;
