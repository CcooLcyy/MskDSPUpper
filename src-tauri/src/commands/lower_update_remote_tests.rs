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
