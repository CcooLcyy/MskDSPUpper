use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::iec61850::Iec61850Client;
use crate::proto::iec61850_proto::{
    ChannelInfo, IedConfig, IedInfo, ImportSclRequest, NetworkChannelConfig, PointMapping,
    PointMappings, ProtectionInputCondition, ProtectionOutputValue, ProtectionRule,
    ProtectionSignalReference, RuntimeStatistics, SclModelSummary,
};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValidationIssueDto {
    pub severity: i32,
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SclModelSummaryDto {
    pub model_name: String,
    pub source_name: String,
    pub document_kind: i32,
    pub source_checksum: String,
    pub ied_count: u32,
    pub logical_node_count: u32,
    pub data_attribute_count: u32,
    pub data_set_count: u32,
    pub report_control_count: u32,
    pub gse_control_count: u32,
    pub sampled_value_control_count: u32,
    pub external_reference_count: u32,
    pub ieds: Vec<SclIedSummaryDto>,
    pub connected_access_points: Vec<SclConnectedApSummaryDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SclConnectedApSummaryDto {
    pub ied_name: String,
    pub ap_name: String,
    pub subnetwork_name: String,
    pub network_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SclAccessPointSummaryDto {
    pub name: String,
    pub has_server: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SclIedSummaryDto {
    pub name: String,
    pub access_points: Vec<SclAccessPointSummaryDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImportSclResponseDto {
    pub summary: Option<SclModelSummaryDto>,
    pub issues: Vec<ValidationIssueDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetworkChannelConfigDto {
    pub channel: i32,
    pub enabled: bool,
    pub interface_name: String,
    pub subnetwork_name: String,
    pub local_ip: String,
    pub remote_ip: String,
    pub remote_port: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProtectionInputConditionDto {
    pub signal_id: u32,
    pub comparator: i32,
    pub value_type: i32,
    pub bool_value: bool,
    pub int_value: i64,
    pub double_value: f64,
    pub max_age_ms: u32,
    pub data_ref: String,
    pub fc: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProtectionSignalReferenceDto {
    pub data_ref: String,
    pub fc: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProtectionOutputValueDto {
    pub value_type: i32,
    pub bool_value: bool,
    pub int_value: i64,
    pub double_value: f64,
    pub quality_bits: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProtectionRuleDto {
    pub rule_id: String,
    pub conditions: Vec<ProtectionInputConditionDto>,
    pub interlock_signal_ids: Vec<u32>,
    pub output_subscription_id: u32,
    pub assert_values: Vec<ProtectionOutputValueDto>,
    pub release_values: Vec<ProtectionOutputValueDto>,
    pub assert_delay_ms: u32,
    pub release_delay_ms: u32,
    pub output_control_ref: String,
    pub interlock_signals: Vec<ProtectionSignalReferenceDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IedConfigDto {
    pub conn_name: String,
    pub model_name: String,
    pub ied_name: String,
    pub access_point: String,
    pub channels: Vec<NetworkChannelConfigDto>,
    pub enable_mms: bool,
    pub enable_goose: bool,
    pub enable_sv: bool,
    pub auto_start: bool,
    pub mms_event_queue_capacity: u32,
    pub publish_batch_size: u32,
    pub publish_batch_window_ms: u32,
    pub protection_rules: Vec<ProtectionRuleDto>,
    pub nominal_frequency_hz: f64,
    pub realtime_cpu_indices: Vec<u32>,
    pub realtime_scheduling: i32,
    pub realtime_priority: i32,
    pub realtime_failure_mode: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointMappingDto {
    pub tag: String,
    pub data_ref: String,
    pub fc: i32,
    pub source: i32,
    pub value_type: i32,
    pub scale: f64,
    pub offset: f64,
    pub deadband: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointMappingsDto {
    pub conn_name: String,
    pub points: Vec<PointMappingDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelInfoDto {
    pub config: Option<NetworkChannelConfigDto>,
    pub state: i32,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IedInfoDto {
    pub config: Option<IedConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub active_channel: i32,
    pub channels: Vec<ChannelInfoDto>,
    pub last_error: String,
    pub data_center_available: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeStatisticsDto {
    pub conn_name: String,
    pub mms_reports_received: u64,
    pub mms_events_dropped: u64,
    pub mms_queue_high_watermark: u64,
    pub data_center_batches_published: u64,
    pub data_center_publish_failures: u64,
    pub goose_frames_received: u64,
    pub goose_frames_sent: u64,
    pub goose_frames_invalid: u64,
    pub goose_timeouts: u64,
    pub sv_frames_received: u64,
    pub sv_frames_invalid: u64,
    pub sv_samples_dropped: u64,
    pub reconnect_count: u64,
    pub last_event_ts_ms: u64,
    pub mms_values_unmapped: u64,
    pub mms_values_type_mismatch: u64,
    pub mms_values_invalid: u64,
    pub mms_values_deadband_filtered: u64,
    pub mms_values_oversized: u64,
    pub mms_reports_oversized: u64,
    pub mms_queue_bytes_high_watermark: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SclModelTargetDto {
    pub model_name: String,
    pub source_name: String,
    pub content: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IedTargetDto {
    pub config: Option<IedConfigDto>,
    pub points: Vec<PointMappingDto>,
    pub desired_running: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApplyTargetConfigRequestDto {
    pub models: Vec<SclModelTargetDto>,
    pub ieds: Vec<IedTargetDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApplyTargetConfigResponseDto {
    pub models: Vec<SclModelSummaryDto>,
    pub ieds: Vec<IedInfoDto>,
    pub issues: Vec<ValidationIssueDto>,
}

impl ApplyTargetConfigRequestDto {
    fn to_proto(&self) -> crate::proto::iec61850_proto::ApplyTargetConfigRequest {
        crate::proto::iec61850_proto::ApplyTargetConfigRequest {
            models: self
                .models
                .iter()
                .map(|model| crate::proto::iec61850_proto::SclModelTarget {
                    model_name: model.model_name.clone(),
                    source_name: model.source_name.clone(),
                    content: model.content.clone(),
                })
                .collect(),
            ieds: self
                .ieds
                .iter()
                .map(|ied| crate::proto::iec61850_proto::IedTarget {
                    config: ied.config.as_ref().map(IedConfigDto::to_proto),
                    points: ied.points.iter().map(PointMappingDto::to_proto).collect(),
                    desired_running: ied.desired_running,
                })
                .collect(),
        }
    }
}

impl From<crate::proto::iec61850_proto::ApplyTargetConfigResponse>
    for ApplyTargetConfigResponseDto
{
    fn from(value: crate::proto::iec61850_proto::ApplyTargetConfigResponse) -> Self {
        Self {
            models: value.models.into_iter().map(Into::into).collect(),
            ieds: value.ieds.into_iter().map(Into::into).collect(),
            issues: value.issues.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<crate::proto::iec61850_proto::ValidationIssue> for ValidationIssueDto {
    fn from(v: crate::proto::iec61850_proto::ValidationIssue) -> Self {
        Self {
            severity: v.severity,
            code: v.code,
            path: v.path,
            message: v.message,
        }
    }
}
impl From<SclModelSummary> for SclModelSummaryDto {
    fn from(v: SclModelSummary) -> Self {
        Self {
            model_name: v.model_name,
            source_name: v.source_name,
            document_kind: v.document_kind,
            source_checksum: v.source_checksum,
            ied_count: v.ied_count,
            logical_node_count: v.logical_node_count,
            data_attribute_count: v.data_attribute_count,
            data_set_count: v.data_set_count,
            report_control_count: v.report_control_count,
            gse_control_count: v.gse_control_count,
            sampled_value_control_count: v.sampled_value_control_count,
            external_reference_count: v.external_reference_count,
            ieds: v.ieds.into_iter().map(Into::into).collect(),
            connected_access_points: v
                .connected_access_points
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}
impl From<crate::proto::iec61850_proto::SclConnectedApSummary> for SclConnectedApSummaryDto {
    fn from(v: crate::proto::iec61850_proto::SclConnectedApSummary) -> Self {
        Self {
            ied_name: v.ied_name,
            ap_name: v.ap_name,
            subnetwork_name: v.subnetwork_name,
            network_type: v.network_type,
        }
    }
}
impl From<crate::proto::iec61850_proto::SclAccessPointSummary> for SclAccessPointSummaryDto {
    fn from(v: crate::proto::iec61850_proto::SclAccessPointSummary) -> Self {
        Self {
            name: v.name,
            has_server: v.has_server,
        }
    }
}
impl From<crate::proto::iec61850_proto::SclIedSummary> for SclIedSummaryDto {
    fn from(v: crate::proto::iec61850_proto::SclIedSummary) -> Self {
        Self {
            name: v.name,
            access_points: v.access_points.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<crate::proto::iec61850_proto::ImportSclResponse> for ImportSclResponseDto {
    fn from(v: crate::proto::iec61850_proto::ImportSclResponse) -> Self {
        Self {
            summary: v.summary.map(Into::into),
            issues: v.issues.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<NetworkChannelConfig> for NetworkChannelConfigDto {
    fn from(v: NetworkChannelConfig) -> Self {
        Self {
            channel: v.channel,
            enabled: v.enabled,
            interface_name: v.interface_name,
            subnetwork_name: v.subnetwork_name,
            local_ip: v.local_ip,
            remote_ip: v.remote_ip,
            remote_port: v.remote_port,
        }
    }
}
impl NetworkChannelConfigDto {
    fn to_proto(&self) -> NetworkChannelConfig {
        NetworkChannelConfig {
            channel: self.channel,
            enabled: self.enabled,
            interface_name: self.interface_name.clone(),
            subnetwork_name: self.subnetwork_name.clone(),
            local_ip: self.local_ip.clone(),
            remote_ip: self.remote_ip.clone(),
            remote_port: self.remote_port,
        }
    }
}
impl From<ProtectionInputCondition> for ProtectionInputConditionDto {
    fn from(v: ProtectionInputCondition) -> Self {
        Self {
            signal_id: v.signal_id,
            comparator: v.comparator,
            value_type: v.value_type,
            bool_value: v.bool_value,
            int_value: v.int_value,
            double_value: v.double_value,
            max_age_ms: v.max_age_ms,
            data_ref: v.data_ref,
            fc: v.fc,
        }
    }
}
impl ProtectionInputConditionDto {
    fn to_proto(&self) -> ProtectionInputCondition {
        ProtectionInputCondition {
            signal_id: self.signal_id,
            comparator: self.comparator,
            value_type: self.value_type,
            bool_value: self.bool_value,
            int_value: self.int_value,
            double_value: self.double_value,
            max_age_ms: self.max_age_ms,
            data_ref: self.data_ref.clone(),
            fc: self.fc,
        }
    }
}
impl From<ProtectionSignalReference> for ProtectionSignalReferenceDto {
    fn from(v: ProtectionSignalReference) -> Self {
        Self {
            data_ref: v.data_ref,
            fc: v.fc,
        }
    }
}
impl ProtectionSignalReferenceDto {
    fn to_proto(&self) -> ProtectionSignalReference {
        ProtectionSignalReference {
            data_ref: self.data_ref.clone(),
            fc: self.fc,
        }
    }
}
impl From<ProtectionOutputValue> for ProtectionOutputValueDto {
    fn from(v: ProtectionOutputValue) -> Self {
        Self {
            value_type: v.value_type,
            bool_value: v.bool_value,
            int_value: v.int_value,
            double_value: v.double_value,
            quality_bits: v.quality_bits,
        }
    }
}
impl ProtectionOutputValueDto {
    fn to_proto(&self) -> ProtectionOutputValue {
        ProtectionOutputValue {
            value_type: self.value_type,
            bool_value: self.bool_value,
            int_value: self.int_value,
            double_value: self.double_value,
            quality_bits: self.quality_bits,
        }
    }
}
impl From<ProtectionRule> for ProtectionRuleDto {
    fn from(v: ProtectionRule) -> Self {
        Self {
            rule_id: v.rule_id,
            conditions: v.conditions.into_iter().map(Into::into).collect(),
            interlock_signal_ids: v.interlock_signal_ids,
            output_subscription_id: v.output_subscription_id,
            assert_values: v.assert_values.into_iter().map(Into::into).collect(),
            release_values: v.release_values.into_iter().map(Into::into).collect(),
            assert_delay_ms: v.assert_delay_ms,
            release_delay_ms: v.release_delay_ms,
            output_control_ref: v.output_control_ref,
            interlock_signals: v.interlock_signals.into_iter().map(Into::into).collect(),
        }
    }
}
impl ProtectionRuleDto {
    fn to_proto(&self) -> ProtectionRule {
        ProtectionRule {
            rule_id: self.rule_id.clone(),
            conditions: self.conditions.iter().map(|x| x.to_proto()).collect(),
            interlock_signal_ids: self.interlock_signal_ids.clone(),
            output_subscription_id: self.output_subscription_id,
            assert_values: self.assert_values.iter().map(|x| x.to_proto()).collect(),
            release_values: self.release_values.iter().map(|x| x.to_proto()).collect(),
            assert_delay_ms: self.assert_delay_ms,
            release_delay_ms: self.release_delay_ms,
            output_control_ref: self.output_control_ref.clone(),
            interlock_signals: self
                .interlock_signals
                .iter()
                .map(|x| x.to_proto())
                .collect(),
        }
    }
}
impl From<IedConfig> for IedConfigDto {
    fn from(v: IedConfig) -> Self {
        Self {
            conn_name: v.conn_name,
            model_name: v.model_name,
            ied_name: v.ied_name,
            access_point: v.access_point,
            channels: v.channels.into_iter().map(Into::into).collect(),
            enable_mms: v.enable_mms,
            enable_goose: v.enable_goose,
            enable_sv: v.enable_sv,
            auto_start: v.auto_start,
            mms_event_queue_capacity: v.mms_event_queue_capacity,
            publish_batch_size: v.publish_batch_size,
            publish_batch_window_ms: v.publish_batch_window_ms,
            protection_rules: v.protection_rules.into_iter().map(Into::into).collect(),
            nominal_frequency_hz: v.nominal_frequency_hz,
            realtime_cpu_indices: v.realtime_cpu_indices,
            realtime_scheduling: v.realtime_scheduling,
            realtime_priority: v.realtime_priority,
            realtime_failure_mode: v.realtime_failure_mode,
        }
    }
}
impl IedConfigDto {
    fn to_proto(&self) -> IedConfig {
        IedConfig {
            conn_name: self.conn_name.clone(),
            model_name: self.model_name.clone(),
            ied_name: self.ied_name.clone(),
            access_point: self.access_point.clone(),
            channels: self.channels.iter().map(|x| x.to_proto()).collect(),
            enable_mms: self.enable_mms,
            enable_goose: self.enable_goose,
            enable_sv: self.enable_sv,
            auto_start: self.auto_start,
            mms_event_queue_capacity: self.mms_event_queue_capacity,
            publish_batch_size: self.publish_batch_size,
            publish_batch_window_ms: self.publish_batch_window_ms,
            protection_rules: self.protection_rules.iter().map(|x| x.to_proto()).collect(),
            nominal_frequency_hz: self.nominal_frequency_hz,
            realtime_cpu_indices: self.realtime_cpu_indices.clone(),
            realtime_scheduling: self.realtime_scheduling,
            realtime_priority: self.realtime_priority,
            realtime_failure_mode: self.realtime_failure_mode,
        }
    }
}
impl From<PointMapping> for PointMappingDto {
    fn from(v: PointMapping) -> Self {
        Self {
            tag: v.tag,
            data_ref: v.data_ref,
            fc: v.fc,
            source: v.source,
            value_type: v.value_type,
            scale: v.scale,
            offset: v.offset,
            deadband: v.deadband,
        }
    }
}
impl PointMappingDto {
    fn to_proto(&self) -> PointMapping {
        PointMapping {
            tag: self.tag.clone(),
            data_ref: self.data_ref.clone(),
            fc: self.fc,
            source: self.source,
            value_type: self.value_type,
            scale: self.scale,
            offset: self.offset,
            deadband: self.deadband,
        }
    }
}
impl From<PointMappings> for PointMappingsDto {
    fn from(v: PointMappings) -> Self {
        Self {
            conn_name: v.conn_name,
            points: v.points.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<ChannelInfo> for ChannelInfoDto {
    fn from(v: ChannelInfo) -> Self {
        Self {
            config: v.config.map(Into::into),
            state: v.state,
            last_error: v.last_error,
        }
    }
}
impl From<IedInfo> for IedInfoDto {
    fn from(v: IedInfo) -> Self {
        Self {
            config: v.config.map(Into::into),
            conn_id: v.conn_id,
            state: v.state,
            active_channel: v.active_channel,
            channels: v.channels.into_iter().map(Into::into).collect(),
            last_error: v.last_error,
            data_center_available: v.data_center_available,
        }
    }
}
impl From<RuntimeStatistics> for RuntimeStatisticsDto {
    fn from(v: RuntimeStatistics) -> Self {
        Self {
            conn_name: v.conn_name,
            mms_reports_received: v.mms_reports_received,
            mms_events_dropped: v.mms_events_dropped,
            mms_queue_high_watermark: v.mms_queue_high_watermark,
            data_center_batches_published: v.data_center_batches_published,
            data_center_publish_failures: v.data_center_publish_failures,
            goose_frames_received: v.goose_frames_received,
            goose_frames_sent: v.goose_frames_sent,
            goose_frames_invalid: v.goose_frames_invalid,
            goose_timeouts: v.goose_timeouts,
            sv_frames_received: v.sv_frames_received,
            sv_frames_invalid: v.sv_frames_invalid,
            sv_samples_dropped: v.sv_samples_dropped,
            reconnect_count: v.reconnect_count,
            last_event_ts_ms: v.last_event_ts_ms,
            mms_values_unmapped: v.mms_values_unmapped,
            mms_values_type_mismatch: v.mms_values_type_mismatch,
            mms_values_invalid: v.mms_values_invalid,
            mms_values_deadband_filtered: v.mms_values_deadband_filtered,
            mms_values_oversized: v.mms_values_oversized,
            mms_reports_oversized: v.mms_reports_oversized,
            mms_queue_bytes_high_watermark: v.mms_queue_bytes_high_watermark,
        }
    }
}

#[tauri::command]
pub async fn iec61850_import_scl(
    state: State<'_, AppState>,
    model_name: String,
    source_name: String,
    content: Vec<u8>,
    validate_only: bool,
    replace: bool,
) -> Result<ImportSclResponseDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .import_scl(ImportSclRequest {
            model_name,
            source_name,
            content,
            validate_only,
            replace,
        })
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_get_model_summary(
    state: State<'_, AppState>,
    model_name: String,
) -> Result<SclModelSummaryDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .get_model_summary(model_name)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_list_models(
    state: State<'_, AppState>,
) -> Result<Vec<SclModelSummaryDto>, String> {
    Iec61850Client::new(&state.conn_manager)
        .list_models()
        .await
        .map(|r| r.models.into_iter().map(Into::into).collect())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_delete_model(
    state: State<'_, AppState>,
    model_name: String,
) -> Result<(), String> {
    Iec61850Client::new(&state.conn_manager)
        .delete_model(model_name)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_apply_target_config(
    state: State<'_, AppState>,
    request: ApplyTargetConfigRequestDto,
) -> Result<ApplyTargetConfigResponseDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .apply_target_config(request.to_proto())
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_upsert_ied(
    state: State<'_, AppState>,
    config: IedConfigDto,
    create_only: bool,
) -> Result<IedInfoDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .upsert_ied(config.to_proto(), create_only)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_get_ied(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<IedInfoDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .get_ied(conn_name)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_list_ieds(state: State<'_, AppState>) -> Result<Vec<IedInfoDto>, String> {
    Iec61850Client::new(&state.conn_manager)
        .list_ieds()
        .await
        .map(|r| r.ieds.into_iter().map(Into::into).collect())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_delete_ied(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    Iec61850Client::new(&state.conn_manager)
        .delete_ied(conn_name)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_start_ied(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    Iec61850Client::new(&state.conn_manager)
        .start_ied(conn_name)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_stop_ied(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<(), String> {
    Iec61850Client::new(&state.conn_manager)
        .stop_ied(conn_name)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_upsert_point_mappings(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<PointMappingDto>,
    replace: bool,
) -> Result<(), String> {
    Iec61850Client::new(&state.conn_manager)
        .upsert_point_mappings(
            conn_name,
            points.into_iter().map(|x| x.to_proto()).collect(),
            replace,
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_get_point_mappings(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<PointMappingsDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .get_point_mappings(conn_name)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn iec61850_get_runtime_statistics(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<RuntimeStatisticsDto, String> {
    Iec61850Client::new(&state.conn_manager)
        .get_runtime_statistics(conn_name)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
