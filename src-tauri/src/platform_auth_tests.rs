use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::{Request, Response, Status};

#[derive(Default)]
struct FakeCredentials(Mutex<HashMap<String, String>>);
impl CredentialStore for FakeCredentials {
    fn load(&self, endpoint: &str, username: &str) -> Result<Option<String>, String> {
        Ok(self
            .0
            .lock()
            .get(&format!("{endpoint}:{username}"))
            .cloned())
    }
    fn save(&self, endpoint: &str, username: &str, password: &str) -> Result<(), String> {
        self.0
            .lock()
            .insert(format!("{endpoint}:{username}"), password.into());
        Ok(())
    }
    fn delete(&self, endpoint: &str, username: &str) -> Result<(), String> {
        self.0.lock().remove(&format!("{endpoint}:{username}"));
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
        .login("alice".into(), "secret".into(), true)
        .await
        .unwrap();
    assert!(status.authenticated);
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("private-session"));
    let json = std::fs::read_to_string(&path).unwrap();
    assert!(!json.contains("secret") && !json.contains("token") && !json.contains("password"));
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
        .login("alice".into(), "secret".into(), false)
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
        .login("alice".into(), "secret".into(), false)
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
    let pending =
        tokio::spawn(async move { worker.login("alice".into(), "secret".into(), false).await });
    while service.login_calls.load(Ordering::Relaxed) == 0 {
        tokio::task::yield_now().await;
    }
    assert!(manager
        .login("alice".into(), "secret".into(), false)
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
        .login("alice".into(), "secret".into(), true)
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
        .login("alice".into(), "wrong".into(), false)
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
            .login("alice".into(), "secret".into(), false)
            .await
            .is_err());
        assert!(manager.require_authenticated().is_err());
    }
    service.mode.store(0, Ordering::Relaxed);
    service.ttl.store(0, Ordering::Relaxed);
    assert!(manager
        .login("alice".into(), "secret".into(), false)
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
        .login("alice".into(), "secret".into(), false)
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
    let pending =
        tokio::spawn(async move { worker.login("alice".into(), "secret".into(), false).await });
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
        .login(" ALICE ".into(), "secret".into(), false)
        .await
        .unwrap();
    assert_eq!(status.username.as_deref(), Some("alice"));
    assert_eq!(manager.settings().unwrap().username, "alice");
    manager.logout().await.unwrap();
    server.abort();
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}
