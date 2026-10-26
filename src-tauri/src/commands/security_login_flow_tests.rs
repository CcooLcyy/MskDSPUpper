use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    read_named_command(peer, 4, name).await;
    peer.write_i32(4).await.unwrap();
    peer.write_i32(0).await.unwrap();
    peer.write_u8(name.len() as u8).await.unwrap();
    peer.write_all(name.as_bytes()).await.unwrap();
    read_named_command(peer, 5, name).await;
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
