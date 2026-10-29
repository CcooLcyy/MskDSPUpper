use super::*;

#[test]
fn remote_target_rejects_certificate_before_connecting() {
    let remote = LowerUpdateRemoteTargetDto {
        endpoint: "https://platform.example".into(),
        device_id: "field-a".into(),
    };
    assert!(validate_remote_update_target(
        &remote,
        &LowerUpdateSshAuthDto::Certificate,
        "https://platform.example"
    )
    .is_err());
}

#[test]
fn remote_target_never_crosses_platform_or_accepts_empty_device() {
    let mut remote = LowerUpdateRemoteTargetDto {
        endpoint: "https://platform.example".into(),
        device_id: "field-a".into(),
    };
    let auth = LowerUpdateSshAuthDto::Password {
        password: "example".into(),
    };
    assert!(validate_remote_update_target(&remote, &auth, "https://other.example").is_err());
    assert!(validate_remote_update_target(&remote, &auth, "https://platform.example").is_ok());
    remote.device_id.clear();
    assert!(validate_remote_update_target(&remote, &auth, "https://platform.example").is_err());
}

#[test]
fn missing_remote_target_keeps_legacy_request_compatible() {
    let request: LowerUpdateRuntimeInfoRequestDto = serde_json::from_value(serde_json::json!({
        "upload_account":"user@host:22", "auth":{"method":"password","password":"example"}, "sudo_password":""
    })).unwrap();
    assert!(request.remote_target.is_none());
}

#[test]
fn fixed_device_never_falls_back_to_another_available_ssh_device() {
    let device = |id: &str, allow_ssh| remote_access::RemoteDevice {
        device_id: id.into(),
        display_name: id.into(),
        online: true,
        allow_grpc: true,
        allow_ssh,
        services: vec!["ssh".into()],
        agent_version: "test".into(),
    };
    let devices = vec![
        device("currently-selected", true),
        device("original", false),
    ];
    assert!(authorized_update_device(devices.clone(), "original").is_err());
    assert!(authorized_update_device(devices.clone(), "missing-original").is_err());
    assert_eq!(
        authorized_update_device(devices, "currently-selected")
            .unwrap()
            .device_id,
        "currently-selected"
    );
}

#[tokio::test]
async fn invalidated_remote_connection_is_rejected_before_ssh_dial() {
    let auth = Arc::new(crate::platform_auth::PlatformAuthManager::test_session(
        "http://127.0.0.1:50000".into(),
    ));
    let device = remote_access::RemoteDevice {
        device_id: "original".into(),
        display_name: "原设备".into(),
        online: true,
        allow_grpc: true,
        allow_ssh: true,
        services: vec!["ssh".into()],
        agent_version: "test".into(),
    };
    let connection = RemoteConnection::new(device, auth).unwrap();
    connection.cancel();
    let mut target = parse_upload_account("user@127.0.0.1:1").unwrap();
    target.remote = Some(RemoteUpdateIdentity {
        connection,
        verifier: Arc::new(RemoteSshManager::new(
            std::env::temp_dir().join("unused-update-test-pins"),
        )),
    });
    let result = connect_password_ssh(&target, "example").await;
    assert!(matches!(result, Err(error) if error.contains("已失效")));
}

// SSH 协议错误和认证拒绝不能被同时发生的 socket 断开改判为可重试。
#[test]
fn ssh_protocol_errors_are_recorded_as_permanent_before_tunnel_classification() {
    let rejection = Arc::new(parking_lot::Mutex::new(None));
    let message = observed_ssh_error(russh::Error::Version, "SSH 协议握手失败", &rejection);
    assert_eq!(rejection.lock().as_deref(), Some(message.as_str()));
    let transport = Arc::new(parking_lot::Mutex::new(None));
    observed_ssh_error(russh::Error::Disconnect, "SSH 传输断开", &transport);
    assert!(transport.lock().is_none());
}

// 原设备离线可等待，SSH 授权撤销必须优先拒绝且不产生可重试标记。
#[test]
fn offline_device_is_retryable_only_with_existing_ssh_authorization() {
    for allow_ssh in [true, false] {
        let device = remote_access::RemoteDevice { device_id:"original".into(), display_name:"原设备".into(), online:false, allow_grpc:true, allow_ssh, services:vec!["ssh".into()], agent_version:"test".into() };
        let error = match authorized_update_device(vec![device], "original") { Err(error) => error, Ok(_) => panic!("离线设备必须等待或拒绝") };
        assert_eq!(error.contains(remote_access::UPDATE_TUNNEL_INTERRUPTED), allow_ssh);
    }
}

// 非法 SSH 版本必须在有界等待内返回协议错误，不能在分类时再次锁住身份错误缓存。
#[tokio::test]
async fn invalid_ssh_version_returns_without_identity_cache_deadlock() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = socket.write_all(b"SSH-1.0-invalid-test\r\n").await;
        let _ = socket.shutdown().await;
    });
    let target = parse_upload_account(&format!("user@{address}")).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), connect_password_ssh(&target, "isolated-secret")).await.expect("协议错误分类不得阻塞");
    let error = match result { Err(error) => error, Ok(_) => panic!("非法版本不应完成SSH握手") };
    assert!(!error.contains(remote_access::UPDATE_TUNNEL_INTERRUPTED));
    server.await.unwrap();
}

// 响应阶段后台 SSH 协议错误也必须保留为永久拒绝，不能退化为 EOF 重试。
#[tokio::test]
async fn background_ssh_protocol_failure_keeps_permanent_reason() {
    use russh::client::Handler;
    let rejection = Arc::new(parking_lot::Mutex::new(None));
    let mut handler = PasswordSshHandler { host:"127.0.0.1".into(), port:22, remote:None, recovery_trust:None, trust_error:rejection.clone() };
    assert!(handler.disconnected(russh::client::DisconnectReason::Error(russh::Error::PacketAuth)).await.is_err());
    assert!(rejection.lock().as_ref().unwrap().contains("协议"));
    assert!(!ssh_transport_error(&russh::Error::IO(io::Error::new(io::ErrorKind::InvalidData, "非法帧"))));
}
