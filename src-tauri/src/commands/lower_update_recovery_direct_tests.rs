use super::*;
use russh::keys::ssh_key::{private::Ed25519Keypair, PrivateKey};
use std::sync::atomic::{AtomicUsize, Ordering};

fn original() -> LowerUpdateRemoteTargetDto {
    LowerUpdateRemoteTargetDto {
        endpoint: "https://original.example".into(),
        device_id: "original-device".into(),
    }
}

fn verifier() -> (Arc<RemoteSshManager>, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "upper-recovery-pin-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    (Arc::new(RemoteSshManager::new(path.clone())), path)
}

// 恢复只替换通信地址，原用户和设备身份仍固定，且无需平台认证对象。
#[test]
fn recovery_direct_target_preserves_original_identity_without_platform() {
    let (verifier, _) = verifier();
    let target = recovery_direct_target(
        "megsky@remote:22",
        Some(&original()),
        &LowerUpdateSshAuthDto::Password {
            password: "example".into(),
        },
        "megsky@192.168.1.219:10022",
        verifier,
    )
    .unwrap();
    assert_eq!(target.user, "megsky");
    assert_eq!(target.host, "192.168.1.219");
    assert_eq!(target.port, 10022);
    assert!(target.remote.is_none());
    let trust = target.recovery_trust.unwrap();
    assert_eq!(trust.endpoint, original().endpoint);
    assert_eq!(trust.device_id, original().device_id);
}

// 无原身份、换用户、占位地址及非法地址不能成为恢复连接目标。
#[test]
fn recovery_direct_target_rejects_identity_or_address_changes() {
    let (verifier, _) = verifier();
    let auth = LowerUpdateSshAuthDto::Password {
        password: "example".into(),
    };
    for account in [
        "other@192.168.1.219:10022",
        "megsky@remote:22",
        "megsky@REMOTE:22",
        "megsky@:22",
        "megsky@192.168.1.219:0",
        "megsky@bad host:22",
        "megsky@192.168.1.219",
    ] {
        assert!(recovery_direct_target(
            "megsky@remote:22",
            Some(&original()),
            &auth,
            account,
            verifier.clone()
        )
        .is_err());
    }
    assert!(recovery_direct_target(
        "megsky@remote:22",
        None,
        &auth,
        "megsky@192.168.1.219:10022",
        verifier.clone()
    )
    .is_err());
    assert!(recovery_direct_target(
        "megsky@remote:22",
        Some(&original()),
        &LowerUpdateSshAuthDto::Certificate,
        "megsky@192.168.1.219:10022",
        verifier
    )
    .is_err());
}

// 普通安装包上传不能接受恢复通信地址，防止恢复能力扩大到新安装路径。
#[test]
fn ordinary_upload_rejects_recovery_direct_override() {
    let request = serde_json::json!({"upload_account":"megsky@remote:22","auth":{"method":"password","password":"example"},
        "sudo_password":"example","remote_target":original(),"install_dir":"/home/megsky", "package_name":"package",
        "package_path":"package", "package_size":1, "package_sha256":"a".repeat(64),
        "recovery_direct_account":"megsky@192.168.1.219:10022"});
    assert!(serde_json::from_value::<LowerUpdateUploadRequestDto>(request).is_err());
}

// 共享运行镜像请求保留兼容性，同时允许传递只在恢复时使用的地址。
#[test]
fn runtime_recovery_account_is_optional() {
    let value = serde_json::json!({"upload_account":"megsky@remote:22", "auth":{"method":"password","password":"example"},"sudo_password":"example"});
    let old: LowerUpdateRuntimeInfoRequestDto = serde_json::from_value(value.clone()).unwrap();
    assert!(old.recovery_direct_account.is_none());
    let request: LowerUpdateRuntimeInfoRequestDto = serde_json::from_value(serde_json::json!({
        "recovery_direct_account":"megsky@192.168.1.219:10022", "remote_target":original(),
        "upload_account":value["upload_account"],"auth":value["auth"],"sudo_password":value["sudo_password"]})).unwrap();
    assert_eq!(
        request.recovery_direct_account.as_deref(),
        Some("megsky@192.168.1.219:10022")
    );
}

struct AuthenticationCounter(Arc<AtomicUsize>);
impl russh::server::Handler for AuthenticationCounter {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _user: &str,
        _password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(russh::server::Auth::Accept)
    }
}

// 真实环回 SSH 握手证明：无原信任或错误指纹时绝不发送密码认证；匹配才放行。
#[tokio::test]
async fn direct_recovery_uses_original_pin_before_password_authentication() {
    for scenario in ["missing", "wrong", "trusted"] {
        let (verifier, path) = verifier();
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[67; 32]));
        let mut previous = None;
        if scenario != "missing" {
            let trusted = if scenario == "trusted" {
                key.clone()
            } else {
                PrivateKey::from(Ed25519Keypair::from_seed(&[68; 32]))
            };
            let identity = format!(
                "{:x}",
                Sha256::digest(
                    format!("{}\0{}", original().endpoint, original().device_id).as_bytes()
                )
            );
            let pins = std::collections::HashMap::from([(
                identity,
                trusted
                    .public_key()
                    .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                    .to_string(),
            )]);
            let bytes = serde_json::to_vec(&pins).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            previous = Some(bytes);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let server_count = count.clone();
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let server = tokio::spawn(async move {
            let socket = listener.accept().await.unwrap().0;
            if let Ok(session) =
                russh::server::run_stream(config, socket, AuthenticationCounter(server_count)).await
            {
                let _ = session.await;
            }
        });
        let target = recovery_direct_target(
            "megsky@remote:22",
            Some(&original()),
            &LowerUpdateSshAuthDto::Password {
                password: "test-password".into(),
            },
            &format!("megsky@{address}"),
            verifier,
        )
        .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            connect_password_ssh(&target, "test-password"),
        )
        .await
        .unwrap();
        if scenario == "trusted" {
            let session = result.unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 1);
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                session.disconnect(russh::Disconnect::ByApplication, "", "English"),
            )
            .await;
        } else {
            assert!(result.is_err());
            assert_eq!(count.load(Ordering::SeqCst), 0);
        }
        assert_eq!(
            std::fs::read(&path).ok(),
            previous,
            "验证不能创建或改变信任记录"
        );
        server.abort();
        let _ = std::fs::remove_file(path);
    }
}
