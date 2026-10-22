use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::{Request, Response, Status};

#[derive(Default)]
struct FakeCredentials {
    values: Mutex<HashMap<String, String>>,
    fail_read: AtomicBool,
    fail_delete: AtomicBool,
}
impl CredentialStore for FakeCredentials {
    fn load(&self, endpoint: &str, username: &str) -> Result<Option<String>, String> {
        if self.fail_read.load(Ordering::Relaxed) {
            return Err("读取 Windows 平台凭据失败".into());
        }
        Ok(self
            .values
            .lock()
            .get(&format!("{endpoint}:{username}"))
            .cloned())
    }
    fn save(&self, endpoint: &str, username: &str, password: &str) -> Result<(), String> {
        self.values
            .lock()
            .insert(format!("{endpoint}:{username}"), password.into());
        Ok(())
    }
    fn delete(&self, endpoint: &str, username: &str) -> Result<(), String> {
        if self.fail_delete.load(Ordering::Relaxed) {
            return Err("清除 Windows 平台凭据失败".into());
        }
        self.values.lock().remove(&format!("{endpoint}:{username}"));
        Ok(())
    }
}

#[derive(Clone, Default)]
struct MockPlatform {
    mode: Arc<AtomicU8>,
    login_calls: Arc<AtomicU64>,
    delay_ms: Arc<AtomicU64>,
    ttl: Arc<AtomicU64>,
}

#[tonic::async_trait]
impl protocol::agent_service_server::AgentService for MockPlatform {
    async fn check_health(
        &self,
        _: Request<protocol::HealthRequest>,
    ) -> Result<Response<protocol::HealthResponse>, Status> {
        Ok(Response::new(protocol::HealthResponse {
            protocol_version: PROTOCOL_VERSION.into(),
        }))
    }
    async fn login(
        &self,
        request: Request<protocol::LoginRequest>,
    ) -> Result<Response<protocol::LoginResponse>, Status> {
        self.login_calls.fetch_add(1, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(self.delay_ms.load(Ordering::Relaxed))).await;
        let request = request.into_inner();
        if request.password != "secret" {
            return Err(Status::unauthenticated("do not expose server-secret"));
        }
        let mut response = protocol::LoginResponse {
            access_token: "private-session-token".into(),
            token_type: "Bearer".into(),
            expires_in: self.ttl.load(Ordering::Relaxed),
            account: Some(protocol::AccountIdentity {
                id: "account-1".into(),
                username: request.username,
                display_name: "测试用户".into(),
            }),
        };
        match self.mode.load(Ordering::Relaxed) {
            4 => response.account.as_mut().unwrap().username = "other-account".into(),
            5 => response.account = None,
            6 => response.access_token = "bad\nmetadata".into(),
            _ => {}
        }
        Ok(Response::new(response))
    }
    async fn get_session(
        &self,
        request: Request<protocol::SessionRequest>,
    ) -> Result<Response<protocol::LoginResponse>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-session-token"
        );
        match self.mode.load(Ordering::Relaxed) {
            1 => Err(Status::unavailable("network-secret")),
            2 => Err(Status::unauthenticated("password-reset-secret")),
            3 => Err(Status::permission_denied("disabled-secret")),
            _ => Ok(Response::new(protocol::LoginResponse {
                access_token: String::new(),
                token_type: "Bearer".into(),
                expires_in: 9999,
                account: Some(protocol::AccountIdentity {
                    id: "account-1".into(),
                    username: "alice".into(),
                    display_name: "测试用户".into(),
                }),
            })),
        }
    }
    async fn logout(
        &self,
        _: Request<protocol::SessionRequest>,
    ) -> Result<Response<protocol::LogoutResponse>, Status> {
        Ok(Response::new(protocol::LogoutResponse {}))
    }
    type ConnectAgentStream = ReceiverStream<Result<protocol::ServerMessage, Status>>;
    async fn connect_agent(
        &self,
        request: Request<tonic::Streaming<protocol::AgentMessage>>,
    ) -> Result<Response<Self::ConnectAgentStream>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-session-token"
        );
        let mut input = request.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tokio::spawn(async move {
            while let Ok(Some(message)) = input.message().await {
                let payload = match message.payload {
                    Some(protocol::agent_message::Payload::Hello(_)) => {
                        protocol::server_message::Payload::Welcome(protocol::Welcome {
                            connection_id: "conn-1".into(),
                            protocol_version: PROTOCOL_VERSION.into(),
                            server_time_unix_ms: now_ms(),
                        })
                    }
                    _ => protocol::server_message::Payload::HeartbeatAck(protocol::HeartbeatAck {
                        server_time_unix_ms: now_ms(),
                    }),
                };
                if tx
                    .send(Ok(protocol::ServerMessage {
                        payload: Some(payload),
                    }))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn fixture() -> (
    PlatformAuthManager,
    MockPlatform,
    Arc<FakeCredentials>,
    PathBuf,
    tokio::task::JoinHandle<()>,
) {
    let service = MockPlatform::default();
    service.ttl.store(3600, Ordering::Relaxed);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = service.clone();
    let handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(protocol::agent_service_server::AgentServiceServer::new(
                server,
            ))
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir()
        .join(format!(
            "upper-auth-test-{}-{}-{}",
            std::process::id(),
            now_ms(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ))
        .join("login.json");
    let credentials = Arc::new(FakeCredentials::default());
    let manager = PlatformAuthManager::with_store(path.clone(), credentials.clone());
    manager
        .save_settings(PlatformLoginSettings {
            grpc_endpoint: endpoint,
            username: "alice".into(),
            auto_login: false,
            remember_password: false,
        })
        .await
        .unwrap();
    (manager, service, credentials, path, handle)
}

#[tokio::test]
async fn login_is_grpc_and_settings_never_contain_secrets_or_restore_session() {
    let (manager, _, credentials, path, server) = fixture().await;
    assert!(!manager.status().authenticated);
    let status = manager
        .login("alice".into(), "secret".into(), true, true)
        .await
        .unwrap();
    assert!(status.authenticated);
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("private-session"));
    let json = std::fs::read_to_string(&path).unwrap();
    assert!(!json.contains("secret") && !json.contains("token"));
    let settings_json: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(settings_json.get("password").is_none());
    let restarted = PlatformAuthManager::with_store(path.clone(), credentials);
    assert!(restarted.require_authenticated().is_err());
    assert!(restarted.auto_login().await.unwrap().authenticated);
    manager.logout().await.unwrap();
    restarted.logout().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn network_failure_preserves_original_lease_but_auth_denial_revokes() {
    let (manager, service, _, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, false)
        .await
        .unwrap();
    let expiry = manager.status().expires_at;
    let generation = manager.inner.lock().generation;
    service.mode.store(1, Ordering::Relaxed);
    manager.check_session(generation).await;
    assert!(manager.status().authenticated);
    assert_eq!(manager.status().expires_at, expiry);
    service.mode.store(0, Ordering::Relaxed);
    manager.check_session(generation).await;
    assert_eq!(
        manager.status().expires_at,
        expiry,
        "server response must never extend local lease"
    );
    service.mode.store(3, Ordering::Relaxed);
    manager.check_session(generation).await;
    assert!(manager.require_authenticated().is_err());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn expiry_blocks_configuration_even_offline() {
    let (manager, service, _, path, server) = fixture().await;
    service.ttl.store(1, Ordering::Relaxed);
    manager
        .login("alice".into(), "secret".into(), false, false)
        .await
        .unwrap();
    server.abort();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(manager.require_authenticated().is_err());
    assert_eq!(manager.status().connection_state, "signed_out");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn logout_during_login_cannot_restore_session_and_duplicate_login_is_rejected() {
    let (manager, service, _, path, server) = fixture().await;
    service.delay_ms.store(150, Ordering::Relaxed);
    let worker = manager.clone();
    let pending = tokio::spawn(async move {
        worker
            .login("alice".into(), "secret".into(), false, false)
            .await
    });
    while service.login_calls.load(Ordering::Relaxed) == 0 {
        tokio::task::yield_now().await;
    }
    assert!(manager
        .login("alice".into(), "secret".into(), false, false)
        .await
        .is_err());
    manager.logout().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(!manager.status().authenticated);
    assert!(manager.auto_login().await.is_err());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn changing_identity_clears_session_and_old_credential() {
    let (manager, _, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), true, true)
        .await
        .unwrap();
    let mut settings = manager.settings().unwrap();
    let old_endpoint = settings.grpc_endpoint.clone();
    settings.username = "bob".into();
    manager.save_settings(settings).await.unwrap();
    assert!(!manager.status().authenticated);
    assert!(credentials.load(&old_endpoint, "alice").unwrap().is_none());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn invalid_credentials_are_safe_and_never_authenticate() {
    let (manager, _, _, path, server) = fixture().await;
    let error = manager
        .login("alice".into(), "wrong".into(), false, false)
        .await
        .unwrap_err();
    assert!(!error.contains("secret"));
    assert!(!manager.status().authenticated);
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn mismatched_or_malformed_login_response_never_grants_access() {
    let (manager, service, _, path, server) = fixture().await;
    for mode in [4, 5, 6] {
        service.mode.store(mode, Ordering::Relaxed);
        assert!(manager
            .login("alice".into(), "secret".into(), false, false)
            .await
            .is_err());
        assert!(manager.require_authenticated().is_err());
    }
    service.mode.store(0, Ordering::Relaxed);
    service.ttl.store(0, Ordering::Relaxed);
    assert!(manager
        .login("alice".into(), "secret".into(), false, false)
        .await
        .is_err());
    assert!(manager.require_authenticated().is_err());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn password_reset_revokes_current_session() {
    let (manager, service, _, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, false)
        .await
        .unwrap();
    let generation = manager.inner.lock().generation;
    service.mode.store(2, Ordering::Relaxed);
    manager.check_session(generation).await;
    assert!(manager.require_authenticated().is_err());
    assert!(!manager.status().message.unwrap().contains("secret"));
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn settings_change_during_login_rejects_old_completion() {
    let (manager, service, _, path, server) = fixture().await;
    service.delay_ms.store(150, Ordering::Relaxed);
    let worker = manager.clone();
    let pending = tokio::spawn(async move {
        worker
            .login("alice".into(), "secret".into(), false, false)
            .await
    });
    while service.login_calls.load(Ordering::Relaxed) == 0 {
        tokio::task::yield_now().await;
    }
    let mut settings = manager.settings().unwrap();
    settings.grpc_endpoint = "http://127.0.0.1:9".into();
    manager.save_settings(settings.clone()).await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(manager.require_authenticated().is_err());
    assert_eq!(
        manager.settings().unwrap().grpc_endpoint,
        settings.grpc_endpoint
    );
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn username_normalization_matches_platform_accounts() {
    let (manager, _, _, path, server) = fixture().await;
    let status = manager
        .login(" ALICE ".into(), "secret".into(), false, false)
        .await
        .unwrap();
    assert_eq!(status.username.as_deref(), Some("alice"));
    assert_eq!(manager.settings().unwrap().username, "alice");
    manager.logout().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 记住密码可独立于自动登录，并在锁定后重新联网认证。
#[tokio::test]
async fn remember_without_auto_login_supports_manual_login_after_lock() {
    let (manager, service, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    assert!(manager.settings().unwrap().remember_password);
    assert!(!manager.settings().unwrap().auto_login);
    let restarted = PlatformAuthManager::with_store(path.clone(), credentials);
    assert!(restarted.auto_login().await.is_err());
    assert!(restarted.has_saved_password(" ALICE ").unwrap());
    assert!(!restarted.has_saved_password("bob").unwrap());
    service.mode.store(2, Ordering::Relaxed);
    let generation = manager.inner.lock().generation;
    manager.check_session(generation).await;
    assert!(!manager.status().authenticated);
    let calls = service.login_calls.load(Ordering::Relaxed);
    assert!(
        manager
            .login("alice".into(), String::new(), false, true)
            .await
            .unwrap()
            .authenticated
    );
    assert_eq!(service.login_calls.load(Ordering::Relaxed), calls + 1);
    manager.logout().await.unwrap();
    assert!(manager.has_saved_password("alice").unwrap());
    assert!(manager.auto_login().await.is_err());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 自动登录包含记住密码，取消自动登录保留凭据，取消记住立即清除。
#[tokio::test]
async fn disabling_auto_preserves_password_and_disabling_remember_deletes_it() {
    let (manager, _, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), true, false)
        .await
        .unwrap();
    let mut settings = manager.settings().unwrap();
    assert!(settings.remember_password);
    settings.auto_login = false;
    manager.save_settings(settings.clone()).await.unwrap();
    assert!(manager.has_saved_password("alice").unwrap());
    settings.remember_password = false;
    manager.save_settings(settings.clone()).await.unwrap();
    assert!(!manager.has_saved_password("alice").unwrap());
    assert!(credentials
        .load(&settings.grpc_endpoint, "alice")
        .unwrap()
        .is_none());
    assert!(manager
        .login("alice".into(), String::new(), false, true)
        .await
        .is_err());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 只有当前平台同账号且明确启用记住时才能复用保存密码。
#[tokio::test]
async fn saved_password_requires_matching_identity_and_explicit_remember_choice() {
    let (manager, service, _, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    let calls = service.login_calls.load(Ordering::Relaxed);
    assert!(manager
        .login("bob".into(), String::new(), false, true)
        .await
        .is_err());
    assert!(manager
        .login("alice".into(), String::new(), false, false)
        .await
        .is_err());
    assert_eq!(service.login_calls.load(Ordering::Relaxed), calls);
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 回填只读取当前平台、当前账号已记住的密码，保持状态和持久化设置不含凭据。
#[tokio::test]
async fn saved_password_prefill_is_scoped_to_current_remembered_identity() {
    let (manager, _, credentials, path, server) = fixture().await;
    assert!(manager.saved_password("alice").unwrap().is_none());
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    manager.logout().await.unwrap();
    let endpoint = manager.settings().unwrap().grpc_endpoint;
    let restarted = PlatformAuthManager::with_store(path.clone(), credentials.clone());
    assert_eq!(
        restarted.saved_password(" ALICE ").unwrap().as_deref(),
        Some("secret")
    );
    credentials.save(&endpoint, "bob", "other-secret").unwrap();
    assert!(restarted.saved_password("bob").unwrap().is_none());
    assert!(restarted.saved_password("").unwrap().is_none());
    assert!(!restarted.status().authenticated);
    assert!(!serde_json::to_string(&restarted.status())
        .unwrap()
        .contains("secret"));
    assert!(!std::fs::read_to_string(&path).unwrap().contains("secret"));

    let mut settings = restarted.settings().unwrap();
    settings.grpc_endpoint = "http://127.0.0.1:9".into();
    restarted.save_settings(settings.clone()).await.unwrap();
    // 即使旧平台凭据重新出现，也不能跨平台回填。
    credentials.save(&endpoint, "alice", "old-secret").unwrap();
    assert!(restarted.saved_password("alice").unwrap().is_none());
    credentials
        .save(&settings.grpc_endpoint, "alice", "new-secret")
        .unwrap();
    assert_eq!(
        restarted.saved_password("alice").unwrap().as_deref(),
        Some("new-secret")
    );
    settings.remember_password = false;
    restarted.save_settings(settings.clone()).await.unwrap();
    // 取消记住后，残留系统凭据也不能被回填。
    credentials
        .save(&settings.grpc_endpoint, "alice", "stale-secret")
        .unwrap();
    assert!(restarted.saved_password("alice").unwrap().is_none());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn saved_password_prefill_rejects_empty_credentials_and_read_failures() {
    let (manager, _, credentials, path, server) = fixture().await;
    let mut settings = manager.settings().unwrap();
    settings.remember_password = true;
    manager.save_settings(settings.clone()).await.unwrap();
    assert!(manager.saved_password("alice").unwrap().is_none());
    credentials
        .save(&settings.grpc_endpoint, "alice", "")
        .unwrap();
    assert!(manager.saved_password("alice").unwrap().is_none());
    credentials.fail_read.store(true, Ordering::Relaxed);
    assert_eq!(
        manager.saved_password("alice").unwrap_err(),
        "读取 Windows 平台凭据失败"
    );
    // 不匹配的账号不触碰系统凭据存储。
    assert!(manager.saved_password("bob").unwrap().is_none());
    assert!(manager.status().message.is_none());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 显式输入优先于旧凭据，认证成功后才更新保存密码。
#[tokio::test]
async fn explicit_password_takes_precedence_and_only_success_updates_saved_password() {
    let (manager, _, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    let endpoint = manager.settings().unwrap().grpc_endpoint;
    assert!(manager
        .login("alice".into(), "wrong".into(), false, true)
        .await
        .is_err());
    assert_eq!(
        credentials.load(&endpoint, "alice").unwrap().as_deref(),
        Some("secret")
    );
    credentials.save(&endpoint, "alice", "outdated").unwrap();
    assert!(manager
        .login("alice".into(), String::new(), false, true)
        .await
        .is_err());
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    assert_eq!(
        credentials.load(&endpoint, "alice").unwrap().as_deref(),
        Some("secret")
    );
    manager.logout().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 取消记住后，在途登录结果不能恢复已清除的凭据。
#[tokio::test]
async fn disabling_remember_during_login_prevents_restoring_deleted_password() {
    let (manager, service, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    service.delay_ms.store(150, Ordering::Relaxed);
    let calls = service.login_calls.load(Ordering::Relaxed);
    let worker = manager.clone();
    let pending = tokio::spawn(async move {
        worker
            .login("alice".into(), String::new(), false, true)
            .await
    });
    while service.login_calls.load(Ordering::Relaxed) == calls {
        tokio::task::yield_now().await;
    }
    let mut settings = manager.settings().unwrap();
    settings.remember_password = false;
    manager.save_settings(settings.clone()).await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(!manager.status().authenticated);
    assert!(!manager.settings().unwrap().remember_password);
    assert!(credentials
        .load(&settings.grpc_endpoint, "alice")
        .unwrap()
        .is_none());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 旧版自动登录设置加载时补齐记住密码标志。
#[tokio::test]
async fn legacy_auto_login_settings_migrate_to_remember_password() {
    let (manager, _, _, path, server) = fixture().await;
    let mut json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    json["auto_login"] = true.into();
    json.as_object_mut().unwrap().remove("remember_password");
    std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    let migrated = StoredSettings::load(&path).unwrap();
    assert!(migrated.settings.remember_password);
    assert!(migrated.settings.auto_login);
    assert!(!manager.settings().unwrap().remember_password);
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 首次登录尚未保存时取消记住，即使设置值未变也必须取消旧请求。
#[tokio::test]
async fn saving_disabled_remember_cancels_first_login_even_when_settings_match() {
    let (manager, service, credentials, path, server) = fixture().await;
    service.delay_ms.store(150, Ordering::Relaxed);
    let worker = manager.clone();
    let pending = tokio::spawn(async move {
        worker
            .login("alice".into(), "secret".into(), false, true)
            .await
    });
    while service.login_calls.load(Ordering::Relaxed) == 0 {
        tokio::task::yield_now().await;
    }
    let settings = manager.settings().unwrap();
    assert!(!settings.remember_password);
    manager.save_settings(settings.clone()).await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(!manager.status().authenticated);
    assert!(credentials
        .load(&settings.grpc_endpoint, "alice")
        .unwrap()
        .is_none());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 凭据读取失败时明确报错，不能把空密码请求视为已认证。
#[tokio::test]
async fn credential_read_failure_rejects_lookup_and_saved_password_login() {
    let (manager, service, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    manager.logout().await.unwrap();
    let calls = service.login_calls.load(Ordering::Relaxed);
    credentials.fail_read.store(true, Ordering::Relaxed);
    assert!(manager.has_saved_password("alice").is_err());
    assert_eq!(
        manager
            .login("alice".into(), String::new(), false, true)
            .await
            .unwrap_err(),
        "读取 Windows 平台凭据失败"
    );
    assert_eq!(service.login_calls.load(Ordering::Relaxed), calls);
    assert!(manager.require_authenticated().is_err());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 删除失败保留原记住选项并返回错误，登录也不能忽略凭据清理失败。
#[tokio::test]
async fn credential_delete_failure_preserves_preferences_and_rejects_login() {
    let (manager, _, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    manager.logout().await.unwrap();
    let previous = manager.settings().unwrap();
    let mut disabled = previous.clone();
    disabled.remember_password = false;
    credentials.fail_delete.store(true, Ordering::Relaxed);
    assert!(manager.save_settings(disabled).await.is_err());
    assert!(manager.settings().unwrap() == previous);
    assert!(StoredSettings::load(&path).unwrap().settings == previous);
    assert!(manager.has_saved_password("alice").unwrap());
    assert_eq!(
        manager
            .login("alice".into(), "secret".into(), false, false)
            .await
            .unwrap_err(),
        "清除 Windows 平台凭据失败"
    );
    assert!(manager.require_authenticated().is_err());
    assert!(manager.settings().unwrap() == previous);
    assert!(manager.has_saved_password("alice").unwrap());
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// 系统凭据实际缺失或为空时，即使偏好仍为记住也不能复用空密码登录。
#[tokio::test]
async fn missing_or_empty_saved_credential_never_grants_authentication() {
    let (manager, service, credentials, path, server) = fixture().await;
    manager
        .login("alice".into(), "secret".into(), false, true)
        .await
        .unwrap();
    manager.logout().await.unwrap();
    let endpoint = manager.settings().unwrap().grpc_endpoint;
    let calls = service.login_calls.load(Ordering::Relaxed);
    credentials.delete(&endpoint, "alice").unwrap();
    for empty_entry in [false, true] {
        if empty_entry {
            credentials.save(&endpoint, "alice", "").unwrap();
        }
        assert!(!manager.has_saved_password("alice").unwrap());
        assert!(manager
            .login("alice".into(), String::new(), false, true)
            .await
            .is_err());
        assert!(manager.require_authenticated().is_err());
    }
    assert_eq!(service.login_calls.load(Ordering::Relaxed), calls);
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}
