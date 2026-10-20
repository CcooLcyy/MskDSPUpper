use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

// 使用真实Tauri IPC确认匿名配置命令不会到达执行函数，登录和撤销后状态即时生效。
#[test]
fn native_ipc_rejects_configuration_before_login_and_after_revocation() {
    let allowed = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let auth = allowed.clone();
    let app = tauri::test::mock_builder()
        .invoke_handler(with_authentication(
            move |invoke| {
                observed.fetch_add(1, Ordering::SeqCst);
                invoke.resolver.resolve("executed");
                true
            },
            move || {
                if auth.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("请先登录平台".into())
                }
            },
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |command: &str| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
    };
    for command in [
        "save_app_setting",
        "migrate_legacy_app_settings",
        "load_app_settings",
        "save_workspace",
        "iec104_upsert_link",
        "agc_start_group",
        "load_workspace",
    ] {
        assert!(invoke(command).is_err(), "匿名命令必须拒绝：{command}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(invoke("get_platform_auth_status").is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    allowed.store(true, Ordering::SeqCst);
    assert!(invoke("save_workspace").is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    allowed.store(false, Ordering::SeqCst);
    assert!(invoke("save_workspace").is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

// 登录白名单是精确匹配，伪造前后缀或新增未知配置命令不能成为匿名入口。
#[test]
fn only_exact_authentication_commands_are_public() {
    for command in [
        "get_platform_login_settings",
        "save_platform_login_settings",
        "platform_login",
        "platform_auto_login",
        "get_platform_auth_status",
        "platform_logout",
    ] {
        assert!(is_authentication_command(command));
        assert!(!is_authentication_command(&format!("{command}_extra")));
    }
    assert!(!is_authentication_command("load_app_settings"));
    assert!(!is_authentication_command("future_configuration_command"));
    assert!(!is_authentication_command(""));
}
