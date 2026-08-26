use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::control_orchestrator::ControlOrchestratorClient;
use crate::proto::control_orchestrator_proto::{CommandStep, WorkflowConfig};
use crate::proto::data_center_proto::{point_value, Endpoint, PointValue};
use crate::state::AppState;

use super::data_center::{EndpointDto, PointValueDto};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandStepDto {
    pub step_name: String,
    pub source: EndpointDto,
    pub value: Option<PointValueDto>,
    pub use_trigger_value: bool,
    pub timeout_ms: u32,
    pub delay_after_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowConfigDto {
    pub sequence_name: String,
    pub steps: Vec<CommandStepDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecuteSequenceRequestDto {
    pub sequence_name: String,
    #[serde(default)]
    pub trigger: Option<EndpointDto>,
    #[serde(default)]
    pub trigger_value: Option<PointValueDto>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecuteSequenceResponseDto {
    pub accepted: bool,
    pub executed_steps: u32,
    pub failed_step_index: u32,
    pub failed_step_name: String,
    pub reason: String,
}

fn point_value_to_proto(value: Option<PointValueDto>) -> Option<PointValue> {
    value.map(|value| PointValue { kind: Some(match value {
        PointValueDto::Bool(v) => point_value::Kind::BoolValue(v),
        PointValueDto::Int(v) => point_value::Kind::IntValue(v),
        PointValueDto::Double(v) => point_value::Kind::DoubleValue(v),
        PointValueDto::String(v) => point_value::Kind::StringValue(v),
        PointValueDto::Bytes(v) => point_value::Kind::BytesValue(v),
    }) })
}

fn point_value_from_proto(value: Option<PointValue>) -> Option<PointValueDto> {
    value.and_then(|value| value.kind.map(|kind| match kind {
        point_value::Kind::BoolValue(v) => PointValueDto::Bool(v),
        point_value::Kind::IntValue(v) => PointValueDto::Int(v),
        point_value::Kind::DoubleValue(v) => PointValueDto::Double(v),
        point_value::Kind::StringValue(v) => PointValueDto::String(v),
        point_value::Kind::BytesValue(v) => PointValueDto::Bytes(v),
    }))
}

fn endpoint_to_proto(value: EndpointDto) -> Endpoint {
    Endpoint {
        conn_id: value.conn_id.unwrap_or_default(),
        tag: value.tag,
        module_name: value.module_name,
        conn_name: value.conn_name,
    }
}

fn endpoint_from_proto(value: Option<Endpoint>) -> EndpointDto {
    let value = value.unwrap_or_default();
    EndpointDto {
        conn_id: (value.conn_id != 0).then_some(value.conn_id),
        module_name: value.module_name,
        conn_name: value.conn_name,
        tag: value.tag,
    }
}

impl CommandStepDto {
    fn to_proto(self) -> CommandStep {
        CommandStep {
            step_name: self.step_name,
            source: Some(endpoint_to_proto(self.source)),
            value: point_value_to_proto(self.value),
            use_trigger_value: self.use_trigger_value,
            timeout_ms: self.timeout_ms,
            delay_after_ms: self.delay_after_ms,
        }
    }
}

impl From<CommandStep> for CommandStepDto {
    fn from(value: CommandStep) -> Self {
        Self {
            step_name: value.step_name,
            source: endpoint_from_proto(value.source),
            value: point_value_from_proto(value.value),
            use_trigger_value: value.use_trigger_value,
            timeout_ms: value.timeout_ms,
            delay_after_ms: value.delay_after_ms,
        }
    }
}

impl WorkflowConfigDto {
    fn to_proto(self) -> WorkflowConfig {
        WorkflowConfig {
            sequence_name: self.sequence_name,
            steps: self.steps.into_iter().map(CommandStepDto::to_proto).collect(),
        }
    }
}

impl From<WorkflowConfig> for WorkflowConfigDto {
    fn from(value: WorkflowConfig) -> Self {
        Self {
            sequence_name: value.sequence_name,
            steps: value.steps.into_iter().map(Into::into).collect(),
        }
    }
}

#[tauri::command]
pub async fn control_orchestrator_upsert_sequence(
    state: State<'_, AppState>,
    config: WorkflowConfigDto,
    create_only: bool,
) -> Result<WorkflowConfigDto, String> {
    ControlOrchestratorClient::new(&state.conn_manager)
        .upsert_sequence(config.to_proto(), create_only)
        .await
        .map(Into::into)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn control_orchestrator_get_sequence(
    state: State<'_, AppState>,
    sequence_name: String,
) -> Result<WorkflowConfigDto, String> {
    ControlOrchestratorClient::new(&state.conn_manager)
        .get_sequence(sequence_name)
        .await
        .map(Into::into)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn control_orchestrator_list_sequences(
    state: State<'_, AppState>,
) -> Result<Vec<WorkflowConfigDto>, String> {
    ControlOrchestratorClient::new(&state.conn_manager)
        .list_sequences()
        .await
        .map(|response| response.configs.into_iter().map(Into::into).collect())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn control_orchestrator_delete_sequence(
    state: State<'_, AppState>,
    sequence_name: String,
) -> Result<(), String> {
    ControlOrchestratorClient::new(&state.conn_manager)
        .delete_sequence(sequence_name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn control_orchestrator_execute_sequence(
    state: State<'_, AppState>,
    request: ExecuteSequenceRequestDto,
) -> Result<ExecuteSequenceResponseDto, String> {
    let response = ControlOrchestratorClient::new(&state.conn_manager)
        .execute_sequence(
            request.sequence_name,
            request.trigger.map(endpoint_to_proto),
            point_value_to_proto(request.trigger_value),
            request.request_id.unwrap_or_default(),
            request.timeout_ms.unwrap_or_default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(ExecuteSequenceResponseDto {
        accepted: response.accepted,
        executed_steps: response.executed_steps,
        failed_step_index: response.failed_step_index,
        failed_step_name: response.failed_step_name,
        reason: response.reason,
    })
}
