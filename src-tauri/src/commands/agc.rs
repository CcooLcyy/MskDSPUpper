use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::agc::AgcClient;
use crate::proto::agc_proto::{
    strategy_config, DefaultPointInfo, DerivedOutputs, GroupConfig,
    GroupControlProfile, GroupInfo, MemberConfig, MemberControlProfile, SignalSpec, StrategyConfig,
    TuningConfig, TuningStatus, ValueSpec, WeightedStrategyConfig,
};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SignalSpecDto {
    pub tag: String,
    pub unit: String,
    pub scale: f64,
    pub offset: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValueSpecDto {
    pub signal: Option<SignalSpecDto>,
    pub mode: i32,
    pub delta_base: i32,
    pub base_tag: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StrategyConfigDto {
    pub strategy_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemberConfigDto {
    pub member_name: String,
    pub controllable: bool,
    pub capacity_kw: f64,
    pub weight: f64,
    pub min_kw: f64,
    pub max_kw: f64,
    pub p_meas: Option<SignalSpecDto>,
    pub p_set: Option<ValueSpecDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DerivedOutputsDto {
    pub p_total_meas: Option<SignalSpecDto>,
    pub p_total_target: Option<SignalSpecDto>,
    pub p_total_error: Option<SignalSpecDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupConfigDto {
    pub group_name: String,
    pub p_cmd: Option<ValueSpecDto>,
    pub strategy: Option<StrategyConfigDto>,
    pub members: Vec<MemberConfigDto>,
    pub outputs: Option<DerivedOutputsDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupInfoDto {
    pub config: Option<GroupConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
    pub default_points: Vec<DefaultPointInfoDto>,
    pub function_enabled: bool,
    pub remote_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DefaultPointInfoDto {
    pub kind: i32,
    pub tag: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemberControlProfileDto {
    pub member_name: String,
    pub up_p_gain: f64,
    pub up_i_gain: f64,
    pub down_p_gain: f64,
    pub down_i_gain: f64,
    pub up_bias_kw: f64,
    pub down_bias_kw: f64,
    pub integral_limit_kw: f64,
    pub max_step_kw: f64,
    pub max_ramp_kw_per_s: f64,
    pub version: u64,
    pub confirmed_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupControlProfileDto {
    pub group_name: String,
    pub members: Vec<MemberControlProfileDto>,
    pub version: u64,
    pub confirmed_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TuningConfigDto {
    pub target_lower_kw: f64,
    pub target_upper_kw: f64,
    pub total_time_minutes: u32,
    pub attempt_max_time_minutes: u32,
    pub target_entry_time_seconds: u32,
    pub stable_hold_time_seconds: u32,
    pub min_up_tests: u32,
    pub min_down_tests: u32,
    pub total_tolerance_kw: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TuningStatusDto {
    pub group_name: String,
    pub state: i32,
    pub direction: i32,
    pub completed_up_tests: u32,
    pub completed_down_tests: u32,
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
    pub current_target_kw: f64,
    pub current_total_meas_kw: f64,
    pub target_entry_elapsed_seconds: f64,
    pub stable_elapsed_seconds: f64,
    pub last_error: String,
    pub candidate_profile: Option<GroupControlProfileDto>,
}

impl From<SignalSpec> for SignalSpecDto {
    fn from(signal: SignalSpec) -> Self {
        Self {
            tag: signal.tag,
            unit: signal.unit,
            scale: signal.scale,
            offset: signal.offset,
        }
    }
}

impl From<ValueSpec> for ValueSpecDto {
    fn from(value: ValueSpec) -> Self {
        Self {
            signal: value.signal.map(|signal| signal.into()),
            mode: value.mode,
            delta_base: value.delta_base,
            base_tag: value.base_tag,
        }
    }
}

impl From<StrategyConfig> for StrategyConfigDto {
    fn from(strategy: StrategyConfig) -> Self {
        let strategy_type = match strategy.strategy {
            Some(strategy_config::Strategy::Weighted(_)) => "weighted".to_string(),
            None => String::new(),
        };

        Self { strategy_type }
    }
}

impl From<MemberConfig> for MemberConfigDto {
    fn from(member: MemberConfig) -> Self {
        Self {
            member_name: member.member_name,
            controllable: member.controllable,
            capacity_kw: member.capacity_kw,
            weight: member.weight,
            min_kw: member.min_kw,
            max_kw: member.max_kw,
            p_meas: member.p_meas.map(|signal| signal.into()),
            p_set: member.p_set.map(|value| value.into()),
        }
    }
}

impl From<DerivedOutputs> for DerivedOutputsDto {
    fn from(outputs: DerivedOutputs) -> Self {
        Self {
            p_total_meas: outputs.p_total_meas.map(|signal| signal.into()),
            p_total_target: outputs.p_total_target.map(|signal| signal.into()),
            p_total_error: outputs.p_total_error.map(|signal| signal.into()),
        }
    }
}

impl From<GroupConfig> for GroupConfigDto {
    fn from(config: GroupConfig) -> Self {
        Self {
            group_name: config.group_name,
            p_cmd: config.p_cmd.map(|value| value.into()),
            strategy: config.strategy.map(|strategy| strategy.into()),
            members: config
                .members
                .into_iter()
                .map(|member| member.into())
                .collect(),
            outputs: config.outputs.map(|outputs| outputs.into()),
        }
    }
}

impl From<DefaultPointInfo> for DefaultPointInfoDto {
    fn from(point: DefaultPointInfo) -> Self {
        Self {
            kind: point.kind,
            tag: point.tag,
            name: point.name,
            description: point.description,
        }
    }
}

impl From<GroupInfo> for GroupInfoDto {
    fn from(group: GroupInfo) -> Self {
        Self {
            config: group.config.map(|config| config.into()),
            conn_id: group.conn_id,
            state: group.state,
            last_error: group.last_error,
            default_points: group.default_points.into_iter().map(Into::into).collect(),
            function_enabled: group.function_enabled,
            remote_enabled: group.remote_enabled,
        }
    }
}

impl From<MemberControlProfile> for MemberControlProfileDto {
    fn from(member: MemberControlProfile) -> Self {
        Self {
            member_name: member.member_name,
            up_p_gain: member.up_p_gain,
            up_i_gain: member.up_i_gain,
            down_p_gain: member.down_p_gain,
            down_i_gain: member.down_i_gain,
            up_bias_kw: member.up_bias_kw,
            down_bias_kw: member.down_bias_kw,
            integral_limit_kw: member.integral_limit_kw,
            max_step_kw: member.max_step_kw,
            max_ramp_kw_per_s: member.max_ramp_kw_per_s,
            version: member.version,
            confirmed_at_ms: member.confirmed_at_ms,
        }
    }
}

impl From<GroupControlProfile> for GroupControlProfileDto {
    fn from(profile: GroupControlProfile) -> Self {
        Self {
            group_name: profile.group_name,
            members: profile.members.into_iter().map(Into::into).collect(),
            version: profile.version,
            confirmed_at_ms: profile.confirmed_at_ms,
        }
    }
}

impl From<TuningStatus> for TuningStatusDto {
    fn from(status: TuningStatus) -> Self {
        Self {
            group_name: status.group_name,
            state: status.state,
            direction: status.direction,
            completed_up_tests: status.completed_up_tests,
            completed_down_tests: status.completed_down_tests,
            started_at_ms: status.started_at_ms,
            elapsed_ms: status.elapsed_ms,
            current_target_kw: status.current_target_kw,
            current_total_meas_kw: status.current_total_meas_kw,
            target_entry_elapsed_seconds: status.target_entry_elapsed_seconds,
            stable_elapsed_seconds: status.stable_elapsed_seconds,
            last_error: status.last_error,
            candidate_profile: status.candidate_profile.map(Into::into),
        }
    }
}

impl MemberControlProfileDto {
    fn to_proto(&self) -> MemberControlProfile {
        MemberControlProfile {
            member_name: self.member_name.clone(),
            up_p_gain: self.up_p_gain,
            up_i_gain: self.up_i_gain,
            down_p_gain: self.down_p_gain,
            down_i_gain: self.down_i_gain,
            up_bias_kw: self.up_bias_kw,
            down_bias_kw: self.down_bias_kw,
            integral_limit_kw: self.integral_limit_kw,
            max_step_kw: self.max_step_kw,
            max_ramp_kw_per_s: self.max_ramp_kw_per_s,
            version: self.version,
            confirmed_at_ms: self.confirmed_at_ms,
        }
    }
}

impl GroupControlProfileDto {
    fn to_proto(&self) -> GroupControlProfile {
        GroupControlProfile {
            group_name: self.group_name.clone(),
            members: self.members.iter().map(MemberControlProfileDto::to_proto).collect(),
            version: self.version,
            confirmed_at_ms: self.confirmed_at_ms,
        }
    }
}

impl TuningConfigDto {
    fn to_proto(&self) -> TuningConfig {
        TuningConfig {
            target_lower_kw: self.target_lower_kw,
            target_upper_kw: self.target_upper_kw,
            total_time_minutes: self.total_time_minutes,
            attempt_max_time_minutes: self.attempt_max_time_minutes,
            target_entry_time_seconds: self.target_entry_time_seconds,
            stable_hold_time_seconds: self.stable_hold_time_seconds,
            min_up_tests: self.min_up_tests,
            min_down_tests: self.min_down_tests,
            total_tolerance_kw: self.total_tolerance_kw,
        }
    }
}

impl SignalSpecDto {
    pub(crate) fn to_proto(&self) -> SignalSpec {
        SignalSpec {
            tag: self.tag.clone(),
            unit: self.unit.clone(),
            scale: self.scale,
            offset: self.offset,
        }
    }
}

impl ValueSpecDto {
    pub(crate) fn to_proto(&self) -> ValueSpec {
        ValueSpec {
            signal: self.signal.as_ref().map(|signal| signal.to_proto()),
            mode: self.mode,
            delta_base: self.delta_base,
            base_tag: self.base_tag.clone(),
        }
    }
}

impl StrategyConfigDto {
    pub(crate) fn to_proto(&self) -> StrategyConfig {
        let strategy = match self.strategy_type.as_str() {
            "weighted" => Some(strategy_config::Strategy::Weighted(
                WeightedStrategyConfig {},
            )),
            _ => None,
        };

        StrategyConfig { strategy }
    }
}

impl MemberConfigDto {
    pub(crate) fn to_proto(&self) -> MemberConfig {
        MemberConfig {
            member_name: self.member_name.clone(),
            controllable: self.controllable,
            capacity_kw: self.capacity_kw,
            weight: self.weight,
            min_kw: self.min_kw,
            max_kw: self.max_kw,
            p_meas: self.p_meas.as_ref().map(|signal| signal.to_proto()),
            p_set: self.p_set.as_ref().map(|value| value.to_proto()),
        }
    }
}

impl DerivedOutputsDto {
    pub(crate) fn to_proto(&self) -> DerivedOutputs {
        DerivedOutputs {
            p_total_meas: self.p_total_meas.as_ref().map(|signal| signal.to_proto()),
            p_total_target: self.p_total_target.as_ref().map(|signal| signal.to_proto()),
            p_total_error: self.p_total_error.as_ref().map(|signal| signal.to_proto()),
        }
    }
}

impl GroupConfigDto {
    pub(crate) fn to_proto(&self) -> GroupConfig {
        GroupConfig {
            group_name: self.group_name.clone(),
            p_cmd: self.p_cmd.as_ref().map(|value| value.to_proto()),
            strategy: self.strategy.as_ref().map(|strategy| strategy.to_proto()),
            members: self
                .members
                .iter()
                .map(|member| member.to_proto())
                .collect(),
            outputs: self.outputs.as_ref().map(|outputs| outputs.to_proto()),
        }
    }
}

fn collect_group_tag_owner(
    tag_owners: &mut BTreeMap<String, Vec<String>>,
    tag: Option<&str>,
    owner: String,
) {
    let normalized_tag = tag.map(str::trim).filter(|tag| !tag.is_empty());
    if let Some(normalized_tag) = normalized_tag {
        tag_owners
            .entry(normalized_tag.to_string())
            .or_default()
            .push(owner);
    }
}

fn validate_group_tag_uniqueness(config: &GroupConfigDto) -> Result<(), String> {
    let mut tag_owners = BTreeMap::<String, Vec<String>>::new();

    collect_group_tag_owner(
        &mut tag_owners,
        config
            .p_cmd
            .as_ref()
            .and_then(|value| value.signal.as_ref())
            .map(|signal| signal.tag.as_str()),
        "p_cmd".to_string(),
    );

    for (index, member) in config.members.iter().enumerate() {
        let member_label = if member.member_name.trim().is_empty() {
            format!("member #{}", index + 1)
        } else {
            member.member_name.trim().to_string()
        };
        collect_group_tag_owner(
            &mut tag_owners,
            member.p_meas.as_ref().map(|signal| signal.tag.as_str()),
            format!("{member_label}.p_meas"),
        );
        collect_group_tag_owner(
            &mut tag_owners,
            member
                .p_set
                .as_ref()
                .and_then(|value| value.signal.as_ref())
                .map(|signal| signal.tag.as_str()),
            format!("{member_label}.p_set"),
        );
    }

    if let Some(outputs) = &config.outputs {
        collect_group_tag_owner(
            &mut tag_owners,
            outputs
                .p_total_meas
                .as_ref()
                .map(|signal| signal.tag.as_str()),
            "outputs.p_total_meas".to_string(),
        );
        collect_group_tag_owner(
            &mut tag_owners,
            outputs
                .p_total_target
                .as_ref()
                .map(|signal| signal.tag.as_str()),
            "outputs.p_total_target".to_string(),
        );
        collect_group_tag_owner(
            &mut tag_owners,
            outputs
                .p_total_error
                .as_ref()
                .map(|signal| signal.tag.as_str()),
            "outputs.p_total_error".to_string(),
        );
    }

    let duplicate_tags = tag_owners
        .into_iter()
        .filter(|(_, owners)| owners.len() > 1)
        .map(|(tag, owners)| format!("{tag} ({})", owners.join(", ")))
        .collect::<Vec<_>>();

    if duplicate_tags.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "同一 AGC 控制组内 DataBus tag 不能重复: {}",
            duplicate_tags.join("；")
        ))
    }
}

#[tauri::command]
pub async fn agc_upsert_group(
    state: State<'_, AppState>,
    config: GroupConfigDto,
    create_only: bool,
) -> Result<GroupInfoDto, String> {
    validate_group_tag_uniqueness(&config)?;
    let group_name = config.group_name.clone();
    tracing::info!(control = "AGC", group_name = %group_name, create_only, "开始保存控制组配置");
    let client = AgcClient::new(&state.conn_manager);
    let group = client
        .upsert_group(config.to_proto(), create_only)
        .await
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "保存控制组配置失败");
            error.to_string()
        })?;
    tracing::info!(control = "AGC", group_name = %group_name, "保存控制组配置完成");
    Ok(group.into())
}

#[tauri::command]
pub async fn agc_get_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<GroupInfoDto, String> {
    let client = AgcClient::new(&state.conn_manager);
    let group = client
        .get_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "获取控制组失败");
            error.to_string()
        })?;
    Ok(group.into())
}

#[tauri::command]
pub async fn agc_list_groups(state: State<'_, AppState>) -> Result<Vec<GroupInfoDto>, String> {
    let client = AgcClient::new(&state.conn_manager);
    let groups = client.list_groups().await.map_err(|error| {
        tracing::error!(control = "AGC", error = %error, "获取控制组列表失败");
        error.to_string()
    })?;
    tracing::info!(
        control = "AGC",
        group_count = groups.groups.len(),
        "获取控制组列表完成"
    );
    Ok(groups
        .groups
        .into_iter()
        .map(|group| group.into())
        .collect())
}

#[tauri::command]
pub async fn agc_delete_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<(), String> {
    tracing::info!(control = "AGC", group_name = %group_name, "开始删除控制组");
    let client = AgcClient::new(&state.conn_manager);
    client
        .delete_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "删除控制组失败");
            error.to_string()
        })?;
    tracing::info!(control = "AGC", group_name = %group_name, "删除控制组完成");
    Ok(())
}

#[tauri::command]
pub async fn agc_start_group(state: State<'_, AppState>, group_name: String) -> Result<(), String> {
    tracing::info!(control = "AGC", group_name = %group_name, "开始启动控制组");
    let client = AgcClient::new(&state.conn_manager);
    client
        .start_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "启动控制组失败");
            error.to_string()
        })?;
    tracing::info!(control = "AGC", group_name = %group_name, "启动控制组请求完成");
    Ok(())
}

#[tauri::command]
pub async fn agc_stop_group(state: State<'_, AppState>, group_name: String) -> Result<(), String> {
    tracing::info!(control = "AGC", group_name = %group_name, "开始停止控制组");
    let client = AgcClient::new(&state.conn_manager);
    client
        .stop_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "停止控制组失败");
            error.to_string()
        })?;
    tracing::info!(control = "AGC", group_name = %group_name, "停止控制组请求完成");
    Ok(())
}

#[tauri::command]
pub async fn agc_start_tuning(
    state: State<'_, AppState>,
    group_name: String,
    config: TuningConfigDto,
) -> Result<TuningStatusDto, String> {
    tracing::info!(control = "AGC", group_name = %group_name, "开始自动参数调试");
    let client = AgcClient::new(&state.conn_manager);
    client
        .start_tuning(group_name.clone(), config.to_proto())
        .await
        .map(Into::into)
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "启动自动参数调试失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn agc_stop_tuning(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<TuningStatusDto, String> {
    let client = AgcClient::new(&state.conn_manager);
    client
        .stop_tuning(group_name.clone())
        .await
        .map(Into::into)
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "停止自动参数调试失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn agc_get_tuning_status(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<TuningStatusDto, String> {
    let client = AgcClient::new(&state.conn_manager);
    client
        .get_tuning_status(group_name.clone())
        .await
        .map(Into::into)
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "获取自动调试状态失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn agc_get_control_profile(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<GroupControlProfileDto, String> {
    let client = AgcClient::new(&state.conn_manager);
    client
        .get_control_profile(group_name.clone())
        .await
        .map(Into::into)
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "获取固定控制参数失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn agc_confirm_control_profile(
    state: State<'_, AppState>,
    profile: GroupControlProfileDto,
) -> Result<GroupControlProfileDto, String> {
    let group_name = profile.group_name.clone();
    let client = AgcClient::new(&state.conn_manager);
    client
        .confirm_control_profile(profile.to_proto())
        .await
        .map(Into::into)
        .map_err(|error| {
            tracing::error!(control = "AGC", group_name = %group_name, error = %error, "确认固定控制参数失败");
            error.to_string()
        })
}
