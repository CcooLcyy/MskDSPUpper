use crate::{
    platform_templates::{self, TemplateRecordDto, TemplateSummaryDto},
    state::AppState,
};
use tauri::State;

#[tauri::command]
pub async fn list_platform_modbus_templates(
    state: State<'_, AppState>,
) -> Result<Vec<TemplateSummaryDto>, String> {
    platform_templates::list(&state.platform_auth).await
}

#[tauri::command]
pub async fn get_platform_modbus_template(
    state: State<'_, AppState>,
    id: String,
    revision: Option<String>,
) -> Result<TemplateRecordDto, String> {
    platform_templates::get(&state.platform_auth, id, revision).await
}
