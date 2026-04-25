use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use tauri::State;
use tonic::{Code, Status};

use crate::grpc::avc::AvcClient;
use crate::proto::avc_proto::{
    group_config, strategy_config, DefaultPointInfo, GroupConfig, GroupInfo, MemberConfig,
    SignalSpec, StrategyConfig, ValueSpec, VoltageControlConfig, WeightedStrategyConfig,
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
pub struct VoltageControlConfigDto {
    pub kp: f64,
    pub deadband: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StrategyConfigDto {
    pub strategy_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemberConfigDto {
    pub member_name: String,
    pub controllable: bool,
    pub weight: f64,
    pub q_min_kvar: f64,
    pub q_max_kvar: f64,
    pub q_meas: Option<SignalSpecDto>,
    pub q_set: Option<ValueSpecDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupConfigDto {
    pub group_name: String,
    pub voltage_meas: Option<SignalSpecDto>,
    pub voltage_cmd: Option<SignalSpecDto>,
    pub q_total_cmd: Option<ValueSpecDto>,
    pub voltage_control: Option<VoltageControlConfigDto>,
    pub strategy: Option<StrategyConfigDto>,
    pub members: Vec<MemberConfigDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DefaultPointInfoDto {
    pub kind: i32,
    pub tag: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupInfoDto {
    pub config: Option<GroupConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
    pub default_points: Vec<DefaultPointInfoDto>,
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
            signal: value.signal.map(Into::into),
            mode: value.mode,
            delta_base: value.delta_base,
            base_tag: value.base_tag,
        }
    }
}

impl From<VoltageControlConfig> for VoltageControlConfigDto {
    fn from(config: VoltageControlConfig) -> Self {
        Self {
            kp: config.kp,
            deadband: config.deadband,
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
            weight: member.weight,
            q_min_kvar: member.q_min_kvar,
            q_max_kvar: member.q_max_kvar,
            q_meas: member.q_meas.map(Into::into),
            q_set: member.q_set.map(Into::into),
        }
    }
}

impl From<GroupConfig> for GroupConfigDto {
    fn from(config: GroupConfig) -> Self {
        let (voltage_cmd, q_total_cmd) = match config.command {
            Some(group_config::Command::VoltageCmd(signal)) => (Some(signal.into()), None),
            Some(group_config::Command::QTotalCmd(value)) => (None, Some(value.into())),
            None => (None, None),
        };

        Self {
            group_name: config.group_name,
            voltage_meas: config.voltage_meas.map(Into::into),
            voltage_cmd,
            q_total_cmd,
            voltage_control: config.voltage_control.map(Into::into),
            strategy: config.strategy.map(Into::into),
            members: config.members.into_iter().map(Into::into).collect(),
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
            config: group.config.map(Into::into),
            conn_id: group.conn_id,
            state: group.state,
            last_error: group.last_error,
            default_points: group.default_points.into_iter().map(Into::into).collect(),
        }
    }
}

impl SignalSpecDto {
    pub(crate) fn to_proto(&self) -> SignalSpec {
        SignalSpec {
            tag: self.tag.trim().to_string(),
            unit: self.unit.trim().to_string(),
            scale: self.scale,
            offset: self.offset,
        }
    }
}

impl ValueSpecDto {
    pub(crate) fn to_proto(&self) -> ValueSpec {
        ValueSpec {
            signal: self.signal.as_ref().map(SignalSpecDto::to_proto),
            mode: self.mode,
            delta_base: self.delta_base,
            base_tag: self.base_tag.trim().to_string(),
        }
    }
}

impl VoltageControlConfigDto {
    pub(crate) fn to_proto(&self) -> VoltageControlConfig {
        VoltageControlConfig {
            kp: self.kp,
            deadband: self.deadband,
        }
    }
}

impl StrategyConfigDto {
    pub(crate) fn to_proto(&self) -> StrategyConfig {
        let strategy = match self.strategy_type.trim() {
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
            member_name: self.member_name.trim().to_string(),
            controllable: self.controllable,
            weight: self.weight,
            q_min_kvar: self.q_min_kvar,
            q_max_kvar: self.q_max_kvar,
            q_meas: self.q_meas.as_ref().map(SignalSpecDto::to_proto),
            q_set: self.q_set.as_ref().map(ValueSpecDto::to_proto),
        }
    }
}

impl GroupConfigDto {
    pub(crate) fn to_proto(&self) -> GroupConfig {
        let command = match (&self.voltage_cmd, &self.q_total_cmd) {
            (Some(signal), None) => Some(group_config::Command::VoltageCmd(signal.to_proto())),
            (None, Some(value)) => Some(group_config::Command::QTotalCmd(value.to_proto())),
            _ => None,
        };

        GroupConfig {
            group_name: self.group_name.trim().to_string(),
            voltage_meas: self.voltage_meas.as_ref().map(SignalSpecDto::to_proto),
            command,
            voltage_control: self
                .voltage_control
                .as_ref()
                .map(VoltageControlConfigDto::to_proto),
            strategy: self.strategy.as_ref().map(StrategyConfigDto::to_proto),
            members: self.members.iter().map(MemberConfigDto::to_proto).collect(),
        }
    }
}

fn validate_non_empty_name(value: &str, field_name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field_name}不能为空"))
    } else {
        Ok(())
    }
}

fn validate_signal_spec(signal: &SignalSpecDto, field_name: &str) -> Result<(), String> {
    if signal.tag.trim().is_empty() {
        return Err(format!("{field_name}的 tag 不能为空"));
    }

    Ok(())
}

fn validate_value_spec(value: &ValueSpecDto, field_name: &str) -> Result<(), String> {
    if let Some(signal) = &value.signal {
        validate_signal_spec(signal, field_name)?;
    }

    let base_tag = value.base_tag.trim();
    let uses_base_tag = value.delta_base == 3;

    if uses_base_tag && base_tag.is_empty() {
        return Err(format!(
            "{field_name}使用 BASE_TAG 模式时，base_tag 不能为空"
        ));
    }

    if !uses_base_tag && !base_tag.is_empty() {
        return Err(format!(
            "{field_name}仅在 delta_base=BASE_TAG 时才能填写 base_tag"
        ));
    }

    Ok(())
}

fn collect_group_tag_owner(
    tag_owners: &mut BTreeMap<String, Vec<String>>,
    tag: Option<&str>,
    owner: impl Into<String>,
) {
    let normalized_tag = tag.map(str::trim).filter(|tag| !tag.is_empty());
    if let Some(normalized_tag) = normalized_tag {
        tag_owners
            .entry(normalized_tag.to_string())
            .or_default()
            .push(owner.into());
    }
}

fn collect_value_spec_tags(
    tag_owners: &mut BTreeMap<String, Vec<String>>,
    value: &ValueSpecDto,
    owner_prefix: &str,
) {
    collect_group_tag_owner(
        tag_owners,
        value.signal.as_ref().map(|signal| signal.tag.as_str()),
        format!("{owner_prefix}.signal"),
    );

    if value.delta_base == 3 {
        collect_group_tag_owner(
            tag_owners,
            Some(value.base_tag.as_str()),
            format!("{owner_prefix}.base_tag"),
        );
    }
}

fn validate_group_tag_uniqueness(config: &GroupConfigDto) -> Result<(), String> {
    let mut tag_owners = BTreeMap::<String, Vec<String>>::new();

    collect_group_tag_owner(
        &mut tag_owners,
        config
            .voltage_meas
            .as_ref()
            .map(|signal| signal.tag.as_str()),
        "voltage_meas",
    );
    collect_group_tag_owner(
        &mut tag_owners,
        config
            .voltage_cmd
            .as_ref()
            .map(|signal| signal.tag.as_str()),
        "voltage_cmd",
    );
    if let Some(value) = &config.q_total_cmd {
        collect_value_spec_tags(&mut tag_owners, value, "q_total_cmd");
    }

    for (index, member) in config.members.iter().enumerate() {
        let member_label = if member.member_name.trim().is_empty() {
            format!("member #{}", index + 1)
        } else {
            member.member_name.trim().to_string()
        };
        collect_group_tag_owner(
            &mut tag_owners,
            member.q_meas.as_ref().map(|signal| signal.tag.as_str()),
            format!("{member_label}.q_meas"),
        );
        if let Some(value) = &member.q_set {
            collect_value_spec_tags(&mut tag_owners, value, &format!("{member_label}.q_set"));
        }
    }

    let duplicate_tags = tag_owners
        .into_iter()
        .filter(|(_, owners)| owners.len() > 1)
        .map(|(tag, owners)| format!("{tag} ({})", owners.join("、")))
        .collect::<Vec<_>>();

    if duplicate_tags.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "同一 AVC 控制组内的 DataBus tag 不能重复：{}",
            duplicate_tags.join("；")
        ))
    }
}

fn validate_group_config(config: &GroupConfigDto) -> Result<(), String> {
    validate_non_empty_name(&config.group_name, "组名")?;

    match (&config.voltage_cmd, &config.q_total_cmd) {
        (Some(signal), None) => validate_signal_spec(signal, "voltage_cmd")?,
        (None, Some(value)) => validate_value_spec(value, "q_total_cmd")?,
        (Some(_), Some(_)) => {
            return Err("AVC 控制组只能配置一种命令：`voltage_cmd` 或 `q_total_cmd`".into())
        }
        (None, None) => {
            return Err("AVC 控制组必须配置一种命令：`voltage_cmd` 或 `q_total_cmd`".into())
        }
    }

    if let Some(signal) = &config.voltage_meas {
        validate_signal_spec(signal, "voltage_meas")?;
    }

    if let Some(strategy) = &config.strategy {
        let strategy_type = strategy.strategy_type.trim();
        if strategy_type.is_empty() {
            return Err("AVC 策略类型不能为空".into());
        }
        if strategy_type != "weighted" {
            return Err(format!(
                "AVC 暂不支持策略类型 `{strategy_type}`，当前仅支持 `weighted`"
            ));
        }
    }

    if config.members.is_empty() {
        return Err("AVC 控制组至少需要一个成员".into());
    }

    let mut seen_member_names = BTreeSet::new();

    for (index, member) in config.members.iter().enumerate() {
        let member_name = member.member_name.trim();
        validate_non_empty_name(member_name, &format!("成员 #{} 名称", index + 1))?;

        if !seen_member_names.insert(member_name.to_string()) {
            return Err(format!("AVC 控制组成员名不能重复：`{member_name}`"));
        }

        if member.q_min_kvar > member.q_max_kvar {
            return Err(format!(
                "成员 `{member_name}` 的 q_min_kvar 不能大于 q_max_kvar"
            ));
        }

        if let Some(signal) = &member.q_meas {
            validate_signal_spec(signal, &format!("成员 `{member_name}` 的 q_meas"))?;
        }

        if member.controllable && member.q_set.is_none() {
            return Err(format!("可控成员 `{member_name}` 必须配置 q_set"));
        }

        if let Some(q_set) = &member.q_set {
            validate_value_spec(q_set, &format!("成员 `{member_name}` 的 q_set"))?;
        }
    }

    validate_group_tag_uniqueness(config)
}

fn validate_group_name_argument(group_name: &str) -> Result<(), String> {
    validate_non_empty_name(group_name, "组名")
}

fn validate_rename_group_arguments(
    old_group_name: &str,
    new_group_name: &str,
) -> Result<(), String> {
    validate_non_empty_name(old_group_name, "原组名")?;
    validate_non_empty_name(new_group_name, "新组名")?;

    if old_group_name.trim() == new_group_name.trim() {
        return Err("原组名和新组名不能相同".into());
    }

    Ok(())
}

fn format_avc_error(error: anyhow::Error) -> String {
    if let Some(status) = error.downcast_ref::<Status>() {
        format_avc_status(status)
    } else {
        error.to_string()
    }
}

fn format_avc_status(status: &Status) -> String {
    let prefix = match status.code() {
        Code::InvalidArgument => "AVC 参数不合法",
        Code::NotFound => "AVC 控制组不存在",
        Code::AlreadyExists => "AVC 控制组已存在",
        Code::FailedPrecondition => "AVC 当前状态不允许执行该操作",
        Code::Unavailable => "AVC 服务不可用",
        Code::DeadlineExceeded => "AVC 请求超时",
        Code::PermissionDenied => "AVC 操作被拒绝",
        _ => "AVC 请求失败",
    };

    let message = status.message().trim();
    if message.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}: {message}")
    }
}

#[tauri::command]
pub async fn avc_upsert_group(
    state: State<'_, AppState>,
    config: GroupConfigDto,
    create_only: bool,
) -> Result<GroupInfoDto, String> {
    validate_group_config(&config)?;
    let client = AvcClient::new(&state.conn_manager);
    let group = client
        .upsert_group(config.to_proto(), create_only)
        .await
        .map_err(format_avc_error)?;
    Ok(group.into())
}

#[tauri::command]
pub async fn avc_rename_group(
    state: State<'_, AppState>,
    old_group_name: String,
    new_group_name: String,
) -> Result<GroupInfoDto, String> {
    validate_rename_group_arguments(&old_group_name, &new_group_name)?;
    let client = AvcClient::new(&state.conn_manager);
    let group = client
        .rename_group(
            old_group_name.trim().to_string(),
            new_group_name.trim().to_string(),
        )
        .await
        .map_err(format_avc_error)?;
    Ok(group.into())
}

#[tauri::command]
pub async fn avc_get_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<GroupInfoDto, String> {
    validate_group_name_argument(&group_name)?;
    let client = AvcClient::new(&state.conn_manager);
    let group = client
        .get_group(group_name.trim().to_string())
        .await
        .map_err(format_avc_error)?;
    Ok(group.into())
}

#[tauri::command]
pub async fn avc_list_groups(state: State<'_, AppState>) -> Result<Vec<GroupInfoDto>, String> {
    let client = AvcClient::new(&state.conn_manager);
    let groups = client.list_groups().await.map_err(format_avc_error)?;
    Ok(groups.groups.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn avc_delete_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<(), String> {
    validate_group_name_argument(&group_name)?;
    let client = AvcClient::new(&state.conn_manager);
    client
        .delete_group(group_name.trim().to_string())
        .await
        .map_err(format_avc_error)?;
    Ok(())
}

#[tauri::command]
pub async fn avc_start_group(state: State<'_, AppState>, group_name: String) -> Result<(), String> {
    validate_group_name_argument(&group_name)?;
    let client = AvcClient::new(&state.conn_manager);
    client
        .start_group(group_name.trim().to_string())
        .await
        .map_err(format_avc_error)?;
    Ok(())
}

#[tauri::command]
pub async fn avc_stop_group(state: State<'_, AppState>, group_name: String) -> Result<(), String> {
    validate_group_name_argument(&group_name)?;
    let client = AvcClient::new(&state.conn_manager);
    client
        .stop_group(group_name.trim().to_string())
        .await
        .map_err(format_avc_error)?;
    Ok(())
}
