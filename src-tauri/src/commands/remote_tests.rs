use super::*;
use russh::client::Handler as _;
use russh::keys::ssh_key::{private::Ed25519Keypair, PrivateKey};
use std::sync::atomic::AtomicU32;
use tokio::net::TcpListener;

fn key(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}
fn fixture() -> (
    Arc<RemoteSshManager>,
    Confirmation,
    Channel<SshEvent>,
    mpsc::Receiver<SshEvent>,
) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "upper-ssh-test-{}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let manager = Arc::new(RemoteSshManager::new(path));
    let confirmation = Arc::new(Mutex::new(None));
    let (tx, rx) = mpsc::channel(32);
    let events = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            let _ = tx.try_send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (manager, confirmation, events, rx)
}
fn verifier(
    manager: Arc<RemoteSshManager>,
    confirmation: Confirmation,
    events: Channel<SshEvent>,
) -> HostVerifier {
    HostVerifier {
        manager,
        identity: host_identity("https://platform", "field"),
        device_id: "field".into(),
        confirmation,
        events,
    }
}

#[test]
fn host_identity_is_device_and_platform_scoped() {
    assert_ne!(
        host_identity("https://platform", "field"),
        host_identity("https://platform", "other")
    );
    assert_ne!(
        host_identity("https://platform", "field"),
        host_identity("https://other", "field")
    );
}

#[tokio::test]
async fn update_requires_terminal_trust_and_rejects_changed_or_other_device_keys() {
    let (manager, _, _, _) = fixture();
    let first_key = key(1);
    let untrusted = manager
        .verify_update_host_key("https://platform", "field", first_key.public_key())
        .await;
    assert!(untrusted.unwrap_err().contains("远程终端"));
    let mut pins = HashMap::new();
    pins.insert(
        host_identity("https://platform", "field"),
        first_key
            .public_key()
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string(),
    );
    tokio::fs::write(&manager.pins_path, serde_json::to_vec(&pins).unwrap())
        .await
        .unwrap();
    assert!(manager
        .verify_update_host_key("https://platform", "field", first_key.public_key())
        .await
        .is_ok());
    assert!(manager
        .verify_update_host_key("https://platform", "other", first_key.public_key())
        .await
        .is_err());
    assert!(manager
        .verify_update_host_key("https://other", "field", first_key.public_key())
        .await
        .is_err());
    assert!(manager
        .verify_update_host_key("https://platform", "field", key(2).public_key())
        .await
        .unwrap_err()
        .contains("已变化"));
    let _ = tokio::fs::remove_file(&manager.pins_path).await;
}

#[tokio::test]
async fn ssh_first_trust_requires_confirmation_and_changed_key_is_rejected() {
    let (manager, confirmation, events, mut output) = fixture();
    let mut handler = verifier(manager.clone(), confirmation.clone(), events.clone());
    let first_key = key(1);
    let check = tokio::spawn(async move {
        handler
            .check_server_key(first_key.public_key())
            .await
            .unwrap()
    });
    assert!(matches!(
        timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap(),
        Some(SshEvent::HostKey { .. })
    ));
    assert!(!manager.pins_path.exists());
    confirmation.lock().take().unwrap().send(false).unwrap();
    assert!(!check.await.unwrap());
    assert!(!manager.pins_path.exists());

    let mut handler = verifier(manager.clone(), confirmation.clone(), events.clone());
    let first_key = key(1);
    let check = tokio::spawn(async move {
        handler
            .check_server_key(first_key.public_key())
            .await
            .unwrap()
    });
    assert!(matches!(
        timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap(),
        Some(SshEvent::HostKey { .. })
    ));
    confirmation.lock().take().unwrap().send(true).unwrap();
    assert!(check.await.unwrap());
    assert!(manager.pins_path.exists());
    let mut handler = verifier(manager.clone(), confirmation.clone(), events);
    assert!(handler.check_server_key(key(1).public_key()).await.unwrap());
    assert!(
        output.try_recv().is_err(),
        "固定设备身份的重连不应重复询问信任"
    );
    assert!(!handler.check_server_key(key(2).public_key()).await.unwrap());
    assert!(matches!(output.recv().await, Some(SshEvent::Closed { .. })));
    let _ = std::fs::remove_file(&manager.pins_path);
}

struct Echo {
    width: Arc<AtomicU32>,
}
impl russh::server::Handler for Echo {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        Ok(if user == "test" && password == "test-password" {
            russh::server::Auth::Accept
        } else {
            russh::server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _term: &str,
        cols: u32,
        _rows: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.width.store(cols, Ordering::SeqCst);
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        _channel: russh::ChannelId,
        cols: u32,
        _rows: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.width.store(cols, Ordering::SeqCst);
        Ok(())
    }
    async fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        if data == b"exit" {
            session.exit_status_request(channel, 0)?;
            session.data(channel, b"last".to_vec())?;
            session.eof(channel)?;
            session.close(channel)?;
        } else {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn real_localhost_ssh_supports_login_binary_output_resize_and_exit_tail() {
    let (manager, confirmation, events, mut output) = fixture();
    let private_key = key(3);
    let pin = private_key
        .public_key()
        .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string();
    let pins = HashMap::from([(host_identity("https://platform", "field"), pin)]);
    tokio::fs::write(&manager.pins_path, serde_json::to_vec(&pins).unwrap())
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let width = Arc::new(AtomicU32::new(0));
    let server_width = width.clone();
    let config = Arc::new(russh::server::Config {
        keys: vec![private_key],
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    });
    let server = tokio::spawn(async move {
        let socket = listener.accept().await.unwrap().0;
        let _ = russh::server::run_stream(
            config,
            socket,
            Echo {
                width: server_width,
            },
        )
        .await
        .unwrap()
        .await;
    });
    let (input, rx) = mpsc::channel(8);
    let handler = verifier(manager.clone(), confirmation, events.clone());
    let output_budget = Arc::new(Semaphore::new(8));
    let client = tokio::spawn(ssh_session(
        address,
        "test".into(),
        "test-password".into(),
        80,
        24,
        handler,
        rx,
        events,
        output_budget.clone(),
    ));
    assert!(matches!(
        timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap(),
        Some(SshEvent::Connected)
    ));
    input.send(SshInput::Resize(132, 40)).await.unwrap();
    input
        .send(SshInput::Data(vec![0, 1, 127, 255]))
        .await
        .unwrap();
    assert!(
        matches!(timeout(Duration::from_secs(3), output.recv()).await.unwrap(), Some(SshEvent::Data { bytes }) if bytes == [0, 1, 127, 255])
    );
    assert_eq!(width.load(Ordering::SeqCst), 132);
    output_budget.add_permits(1);
    for byte in b'a'..=b'j' {
        input.send(SshInput::Data(vec![byte])).await.unwrap();
    }
    for byte in b'a'..=b'h' {
        assert!(
            matches!(timeout(Duration::from_secs(3), output.recv()).await.unwrap(), Some(SshEvent::Data { bytes }) if bytes == [byte])
        );
    }
    assert!(
        timeout(Duration::from_millis(100), output.recv())
            .await
            .is_err(),
        "未消费输出最多积压八块"
    );
    output_budget.add_permits(2);
    for byte in b'i'..=b'j' {
        assert!(
            matches!(timeout(Duration::from_secs(3), output.recv()).await.unwrap(), Some(SshEvent::Data { bytes }) if bytes == [byte])
        );
    }
    output_budget.add_permits(8);
    input.send(SshInput::Data(b"exit".to_vec())).await.unwrap();
    assert!(
        matches!(timeout(Duration::from_secs(3), output.recv()).await.unwrap(), Some(SshEvent::Data { bytes }) if bytes == b"last")
    );
    timeout(Duration::from_secs(3), client)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    server.abort();
    let _ = std::fs::remove_file(&manager.pins_path);
}

#[tokio::test]
async fn explicit_close_aborts_pending_ssh_session() {
    let (manager, confirmation, _, _) = fixture();
    let (tx, _) = mpsc::channel(8);
    let task = tokio::spawn(std::future::pending::<()>());
    let handle = task.abort_handle();
    manager.sessions.lock().insert(
        "one".into(),
        SshSession {
            input: tx,
            confirmation,
            task,
            output_budget: Arc::new(Semaphore::new(8)),
        },
    );
    manager.close("one");
    tokio::task::yield_now().await;
    assert!(handle.is_finished());
    assert!(manager.sessions.lock().is_empty());
}
