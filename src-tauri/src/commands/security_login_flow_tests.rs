use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// 一键入口只接收角色和目标，账号与凭据不允许由调用方覆盖。
#[test]
fn security_login_one_click_accounts_and_request_are_fixed() {
    for (role, username, password) in [(1, "admin", "Nari.6712"), (2, "secure", "Nari6702")] {
        assert_eq!(automatic_account(role), Some((username, password)));
        assert!(protocol::default_password(username, password));
        assert!(protocol::validate_new_password(MANAGED_PASSWORD, &protocol::password_digest(username, password), username).is_ok());
    }
    assert!(automatic_account(3).is_none());
    let base = serde_json::json!({"request_id":"fixture", "mode":"direct", "role":1});
    assert!(serde_json::from_value::<OneClickLoginRequest>(base.clone()).is_ok());
    for field in ["username", "password", "target_ip"] {
        let mut value = base.clone();
        value[field] = serde_json::json!("override");
        assert!(serde_json::from_value::<OneClickLoginRequest>(value).is_err());
    }
}

// 只有明确凭据拒绝会触发第二次认证；锁定、未知、网络失败均仅执行一次。
#[tokio::test]
async fn security_login_one_click_fallback_is_bounded_and_rejections_are_distinct() {
    for code in ["credentials_rejected", "account_locked", "invalid_response", "authentication_timeout", "connection_failed"] {
        let manager = SecurityLoginManager::default();
        let mut passwords = Vec::new();
        let response = run_automatic_login(&manager, "Nari.6712", |password| {
            passwords.push(password);
            std::future::ready(result().failure(2, code, "测试认证失败"))
        }).await;
        assert_eq!(response.code, code);
        assert!(response.session_id.is_none());
        if code == "credentials_rejected" {
            assert_eq!(passwords, ["Nari.6712", MANAGED_PASSWORD]);
        } else {
            assert_eq!(passwords, ["Nari.6712"]);
        }
    }
}

// 改密必须收到明确成功才重登；断开导致结果不确定时不继续发送任何认证。
#[tokio::test]
async fn security_login_one_click_changes_once_and_only_relogs_on_confirmation() {
    for confirmed in [true, false] {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let challenge = complete_login(&manager, result(), credentials(true), client, accepted(false)).await;
        let challenge_id = challenge.challenge_id.clone().unwrap();
        let server = tokio::spawn(async move {
            let expected = protocol::encode_password_change("fixture", &protocol::password_digest("fixture", "Before@2468X"), MANAGED_PASSWORD).unwrap();
            let mut actual = vec![0; expected.len()];
            peer.read_exact(&mut actual).await.unwrap();
            assert_eq!(actual.as_slice(), expected.as_slice());
            if confirmed {
                peer.write_i32(14).await.unwrap();
                peer.write_i32(1).await.unwrap();
                let mut remainder = Vec::new();
                peer.read_to_end(&mut remainder).await.unwrap();
                assert!(remainder.is_empty());
            }
        });
        let mut authenticated = result();
        authenticated.state = "authenticated";
        authenticated.code = "authenticated";
        let mut responses = std::collections::VecDeque::from([challenge, authenticated]);
        let mut passwords = Vec::new();
        let response = run_automatic_login(&manager, "Nari.6712", |password| {
            passwords.push(password);
            std::future::ready(responses.pop_front().expect("认证次数超出预期"))
        }).await;
        server.await.unwrap();
        assert!(!manager.connection_active(&challenge_id));
        assert!(response.challenge_id.is_none());
        if confirmed {
            assert_eq!(response.state, "authenticated");
            assert_eq!(passwords, ["Nari.6712", MANAGED_PASSWORD]);
        } else {
            assert_eq!(response.code, "automatic_password_change_failed");
            assert_eq!(passwords, ["Nari.6712"]);
        }
    }
}

// 整个流程共用独占许可，释放调用者时同时撤销临时连接，防止下一次点击重叠认证。
#[tokio::test]
async fn security_login_one_click_cleanup_and_flow_permit_release() {
    let manager = Arc::new(SecurityLoginManager::default());
    let permit = manager.authentication.try_lock().unwrap();
    assert!(manager.authentication.try_lock().is_err());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(1024);
    let challenge = complete_login(&manager, result(), credentials(true), client, accepted(false)).await;
    let id = challenge.challenge_id.unwrap();
    let cleanup = LoginConnectionCleanup { manager: &manager, request_id: "fixture-flow", armed: true };
    drop(cleanup);
    drop(permit);
    assert!(manager.authentication.try_lock().is_ok());
    assert!(!manager.connection_active(&id));
    assert_eq!(peer.read_u8().await.unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
}

// 已使用统一密码但装置报告过期时，不重复提交相同密码，也不泄露可继续改密的挑战。
#[tokio::test]
async fn security_login_one_click_expired_managed_password_closes_challenge() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(1024);
    let challenge = complete_login(&manager, result(), credentials(false), client, accepted(true)).await;
    let challenge_id = challenge.challenge_id.clone().unwrap();
    let mut responses = std::collections::VecDeque::from([
        result().failure(2, "credentials_rejected", "测试默认凭据拒绝"),
        challenge,
    ]);
    let mut passwords = Vec::new();
    let response = run_automatic_login(&manager, "Nari.6712", |password| {
        passwords.push(password);
        std::future::ready(responses.pop_front().expect("认证次数超出预期"))
    }).await;
    assert_eq!(passwords, ["Nari.6712", MANAGED_PASSWORD]);
    assert_eq!(response.code, "managed_password_expired");
    assert!(response.challenge_id.is_none());
    assert!(!manager.connection_active(&challenge_id));
    let mut received = Vec::new();
    peer.read_to_end(&mut received).await.unwrap();
    assert!(received.is_empty());
}

fn request() -> LoginRequest {
    LoginRequest {
        request_id: "fixture-flow".into(),
        mode: LoginMode::Direct,
        device_id: None,
        username: "fixture".into(),
        password: String::new(),
        role: 1,
    }
}

fn credentials(default_password: bool) -> AuthenticationContext {
    AuthenticationContext {
        username: "fixture".into(),
        role: 1,
        old_digest: protocol::password_digest("fixture", "Before@2468X"),
        default_password,
        generation: 0,
    }
}

fn result() -> LoginResult {
    let mut result = LoginResult::new(&request());
    result.success_step(0, "本地字节流连接");
    result.success_step(1, "本地认证编排测试");
    result
}

fn accepted(expired: bool) -> Reply {
    Reply::Accepted(protocol::LoginInfo {
        count: 0,
        password_expired: expired,
        last_login: "20260101000000".into(),
    })
}

async fn read_named_command(peer: &mut tokio::io::DuplexStream, command: i32, expected: &str) {
    assert_eq!(peer.read_i32().await.unwrap(), command);
    let length = peer.read_i32().await.unwrap();
    assert_eq!(length as usize, expected.len());
    let mut name = vec![0; length as usize];
    peer.read_exact(&mut name).await.unwrap();
    assert_eq!(name, expected.as_bytes());
}

async fn serve_file(peer: &mut tokio::io::DuplexStream, name: &str, body: &[u8]) {
    serve_returned_file(peer, name, name, body).await;
}

async fn serve_returned_file(
    peer: &mut tokio::io::DuplexStream,
    name: &str,
    returned_name: &str,
    body: &[u8],
) {
    read_named_command(peer, 4, name).await;
    peer.write_i32(4).await.unwrap();
    peer.write_i32(0).await.unwrap();
    peer.write_u8(returned_name.len() as u8).await.unwrap();
    peer.write_all(returned_name.as_bytes()).await.unwrap();
    read_named_command(peer, 5, returned_name).await;
    peer.write_i32(5).await.unwrap();
    peer.write_i32(body.len() as i32).await.unwrap();
    peer.write_all(body).await.unwrap();
    peer.write_i32(6).await.unwrap();
    peer.write_i32(1).await.unwrap();
    read_named_command(peer, 6, "").await;
}

// 默认密码和设备过期各自触发绑定当前身份的挑战，均不读取业务资料或创建已登录会话。
#[tokio::test]
async fn security_login_flow_default_and_expired_are_separate_challenges() {
    for (default, expired, code) in [
        (true, false, "default_password"),
        (false, true, "password_expired"),
    ] {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let response = complete_login(
            &manager,
            result(),
            credentials(default),
            client,
            accepted(expired),
        )
        .await;
        assert_eq!(response.state, "password_change_required");
        assert_eq!(response.code, code);
        assert_eq!(response.username.as_deref(), Some("fixture"));
        assert_eq!(response.role, Some(1));
        assert!(response.session_id.is_none());
        assert_eq!(response.steps[3].state, "pending");
        let id = response.challenge_id.unwrap();
        assert!(manager.connection_active(&id));
        manager.cancel(&id).unwrap();
        assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
    }
}

// 单次改密收到明确成功后关闭连接；并发或重复提交都不能再发送命令，也不会自动登录。
#[tokio::test]
async fn security_login_flow_change_is_single_use_and_requires_manual_relogin() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(1024);
    let response = complete_login(
        &manager,
        result(),
        credentials(true),
        client,
        accepted(false),
    )
    .await;
    let id = response.challenge_id.unwrap();
    let task_manager = manager.clone();
    let task_id = id.clone();
    let first = tokio::spawn(async move {
        task_manager
            .change_password(&task_id, Zeroizing::new("Fixture@2468X".into()))
            .await
    });
    assert_eq!(peer.read_i32().await.unwrap(), 14);
    assert_eq!(peer.read_i32().await.unwrap(), 7);
    let mut username = [0; 7];
    peer.read_exact(&mut username).await.unwrap();
    assert_eq!(&username, b"fixture");
    for _ in 0..2 {
        assert_eq!(peer.read_i32().await.unwrap(), 64);
        peer.read_exact(&mut [0; 64]).await.unwrap();
    }
    assert!(
        !manager
            .change_password(&id, Zeroizing::new("Another@2468X".into()))
            .await
            .changed
    );
    peer.write_i32(14).await.unwrap();
    peer.write_i32(1).await.unwrap();
    assert!(first.await.unwrap().changed);
    assert!(!manager.connection_active(&id));
    let mut remaining = Vec::new();
    peer.read_to_end(&mut remaining).await.unwrap();
    assert!(remaining.is_empty());
    assert!(
        !manager
            .change_password(&id, Zeroizing::new("Another@2468X".into()))
            .await
            .changed
    );
}

// 已取消的登录不能因迟到的成功应答重新保留挑战或身份。
#[tokio::test]
async fn security_login_flow_cancelled_result_cannot_retain_connection() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    manager.cancel("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(1024);
    let response = complete_login(
        &manager,
        result(),
        credentials(true),
        client,
        accepted(false),
    )
    .await;
    assert_eq!(response.state, "failed");
    assert!(response.challenge_id.is_none());
    assert!(response.session_id.is_none());
    assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
}

// 使用已修改密码重新登录时，固定资料及角色全部验证后才创建持有连接的身份。
#[tokio::test]
async fn security_login_flow_initializes_before_authenticated_and_closes_on_logout() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(4096);
    let server = tokio::spawn(async move {
        serve_file(
            &mut peer,
            "account.txt",
            b"fixture,1,fixture account,0,opaque,0,0,1\n",
        )
        .await;
        serve_file(&mut peer, "version.txt", b"V1.1.fixture\n").await;
        let mut remaining = Vec::new();
        peer.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
    });
    let response = complete_login(
        &manager,
        result(),
        credentials(false),
        client,
        accepted(false),
    )
    .await;
    assert_eq!(response.state, "authenticated");
    assert_eq!(response.device_version.as_deref(), Some("V1.1.fixture"));
    assert!(response.steps.iter().all(|step| step.state == "success"));
    assert!(response.challenge_id.is_none());
    let id = response.session_id.unwrap();
    assert!(manager.connection_active(&id));
    manager.close_session(&id).unwrap();
    assert!(!manager.connection_active(&id));
    server.await.unwrap();
}

// 账号或版本初始化失败必须关闭连接，不能只凭登录返回字段建立身份。
#[tokio::test]
async fn security_login_flow_failed_initialization_has_no_identity() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(1024);
    let server = tokio::spawn(async move {
        read_named_command(&mut peer, 4, "account.txt").await;
        peer.write_i32(999).await.unwrap();
        assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
    });
    let response = complete_login(
        &manager,
        result(),
        credentials(false),
        client,
        accepted(false),
    )
    .await;
    assert_eq!(response.code, "initialization_failed");
    assert!(response.session_id.is_none());
    assert_eq!(response.steps[3].state, "failed");
    assert!(manager.inner.lock().connections.is_empty());
    server.await.unwrap();
}

// 已发送改密请求但尚未收到应答时切换证书，应关闭旧连接并报告结果未确认，禁止重试。
#[tokio::test]
async fn security_login_flow_certificate_switch_cancels_inflight_change() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(1024);
    let response = complete_login(
        &manager,
        result(),
        credentials(true),
        client,
        accepted(false),
    )
    .await;
    let id = response.challenge_id.unwrap();
    let task_manager = manager.clone();
    let task_id = id.clone();
    let change = tokio::spawn(async move {
        task_manager
            .change_password(&task_id, Zeroizing::new("Fixture@2468X".into()))
            .await
    });
    let mut request = [0; 151];
    peer.read_exact(&mut request).await.unwrap();
    assert_eq!(&request[..4], &14_i32.to_be_bytes());
    SecurityLoginManager::advance_configuration(&mut manager.inner.lock());
    let outcome = tokio::time::timeout(Duration::from_secs(1), change)
        .await
        .unwrap()
        .unwrap();
    assert!(!outcome.changed);
    assert!(outcome.message.contains("核实装置密码状态"));
    assert!(!manager.connection_active(&id));
    assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
}

// 复现现场返回 /log 路径及账号行末逗号；初始化完成后必须创建真实会话并可退出。
#[tokio::test]
async fn security_login_flow_initializes_log_paths_and_java_trailing_columns() {
    let manager = Arc::new(SecurityLoginManager::default());
    let (_cancel, _guard) = manager.begin("fixture-flow").unwrap();
    let (client, mut peer) = tokio::io::duplex(4096);
    let server = tokio::spawn(async move {
        serve_returned_file(
            &mut peer,
            "account.txt",
            "/log/account.txt",
            b"fixture,1,fixture account,0,opaque,0,0,1,\r\n",
        )
        .await;
        serve_returned_file(
            &mut peer,
            "version.txt",
            "/log/version.txt",
            b"V1.1.fixture\n",
        )
        .await;
        assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
    });
    let response = complete_login(
        &manager,
        result(),
        credentials(false),
        client,
        accepted(false),
    )
    .await;
    assert_eq!(response.state, "authenticated");
    assert!(response.steps.iter().all(|step| step.state == "success"));
    assert_eq!(response.device_version.as_deref(), Some("V1.1.fixture"));
    let id = response.session_id.unwrap();
    assert!(manager.connection_active(&id));
    manager.close_session(&id).unwrap();
    server.await.unwrap();
}
