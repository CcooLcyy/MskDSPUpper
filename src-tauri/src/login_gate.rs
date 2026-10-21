use tauri::{ipc::Invoke, Runtime};

fn is_authentication_command(command: &str) -> bool {
    matches!(
        command,
        "get_platform_login_settings"
            | "save_platform_login_settings"
            | "platform_login"
            | "has_platform_saved_password"
            | "platform_auto_login"
            | "get_platform_auth_status"
            | "platform_logout"
    )
}

/// 自定义命令默认要求有效登录，仅登录所需的最小入口匿名可用。
pub fn with_authentication<R, F, C>(
    handler: F,
    check: C,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    R: Runtime,
    F: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    C: Fn() -> Result<(), String> + Send + Sync + 'static,
{
    move |invoke| {
        let command = invoke.message.command();
        if !is_authentication_command(command) {
            if let Err(error) = check() {
                tracing::debug!(command, "登录资格无效，已拒绝上位机命令");
                invoke.resolver.reject(error);
                return true;
            }
        }
        handler(invoke)
    }
}

#[cfg(test)]
#[path = "login_gate_tests.rs"]
mod tests;
