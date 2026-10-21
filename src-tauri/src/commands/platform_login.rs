use crate::{
    platform_auth::{PlatformAuthStatus, PlatformLoginSettings},
    state::AppState,
};
use tauri::State;

#[tauri::command]
pub fn get_platform_login_settings(
    state: State<'_, AppState>,
) -> Result<PlatformLoginSettings, String> {
    state.platform_auth.settings()
}

#[tauri::command]
pub async fn save_platform_login_settings(
    state: State<'_, AppState>,
    settings: PlatformLoginSettings,
) -> Result<PlatformLoginSettings, String> {
    state.platform_auth.save_settings(settings).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn platform_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
    auto_login: bool,
    remember_password: bool,
) -> Result<PlatformAuthStatus, String> {
    state
        .platform_auth
        .login(username, password, auto_login, remember_password)
        .await
}

#[tauri::command]
pub fn has_platform_saved_password(
    state: State<'_, AppState>,
    username: String,
) -> Result<bool, String> {
    state.platform_auth.has_saved_password(&username)
}

#[tauri::command]
pub async fn platform_auto_login(state: State<'_, AppState>) -> Result<PlatformAuthStatus, String> {
    state.platform_auth.auto_login().await
}

#[tauri::command]
pub fn get_platform_auth_status(state: State<'_, AppState>) -> PlatformAuthStatus {
    state.platform_auth.status()
}

#[tauri::command]
pub async fn platform_logout(state: State<'_, AppState>) -> Result<PlatformAuthStatus, String> {
    state.platform_auth.logout().await
}
