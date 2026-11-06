use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::grpc::calc::CalcClient;
use crate::proto::calc_proto::{
    typed_constant, CalcGroupConfig, CalcGroupInfo, CalcItemConfig, CalcItemInfo,
    CalcOperandStatus, OperandSpec, TypedConstant,
};
use crate::state::AppState;

// 在 Tauri 边界显式保留 oneof，避免 JSON 编辑时丢失常量类型和十进制文本。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct TypedConstantDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bool_value: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub int_value: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub double_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimal_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OperandSpecDto {
    pub source_kind: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constant: Option<TypedConstantDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CalcItemConfigDto {
    pub item_name: String,
    pub operator_kind: i32,
    #[serde(default)]
    pub left_operand: Option<OperandSpecDto>,
    #[serde(default)]
    pub right_operand: Option<OperandSpecDto>,
    #[serde(default)]
    pub operands: Vec<OperandSpecDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimal_places: Option<u32>,
    /// 混合逻辑表达式；普通运算为空，语法由 Calc 服务执行权威校验。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub expression: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CalcGroupConfigDto {
    pub group_name: String,
    pub items: Vec<CalcItemConfigDto>,
    /// 0: 未指定（兼容旧配置），1: 变化触发，2: 周期定时。
    #[serde(default)]
    pub trigger_mode: i32,
    /// 周期定时执行周期，单位毫秒；变化触发时忽略。
    #[serde(default)]
    pub period_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CalcItemInfoDto {
    pub config: Option<CalcItemConfigDto>,
    pub left_input_tag: String,
    pub right_input_tag: String,
    pub result_tag: String,
    pub input_tags: Vec<String>,
    pub operand_status: Vec<CalcOperandStatusDto>,
    pub last_error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CalcOperandStatusDto {
    pub index: u32,
    pub input_tag: String,
    pub ready: bool,
    pub reason: String,
    pub quality: i32,
    pub ts_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CalcGroupInfoDto {
    pub config: Option<CalcGroupConfigDto>,
    pub conn_id: u32,
    pub state: i32,
    pub last_error: String,
    pub items: Vec<CalcItemInfoDto>,
}

impl From<TypedConstant> for TypedConstantDto {
    fn from(value: TypedConstant) -> Self {
        match value.kind {
            Some(typed_constant::Kind::BoolValue(value)) => Self {
                bool_value: Some(value),
                ..Self::default()
            },
            Some(typed_constant::Kind::IntValue(value)) => Self {
                int_value: Some(value),
                ..Self::default()
            },
            Some(typed_constant::Kind::DoubleValue(value)) => Self {
                double_value: Some(value),
                ..Self::default()
            },
            Some(typed_constant::Kind::DecimalValue(value)) => Self {
                decimal_value: Some(value),
                ..Self::default()
            },
            None => Self::default(),
        }
    }
}

impl TypedConstantDto {
    fn to_proto(&self) -> Result<TypedConstant, String> {
        let values = [
            self.bool_value.is_some(),
            self.int_value.is_some(),
            self.double_value.is_some(),
            self.decimal_value.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count();
        if values != 1 {
            return Err(
                "constant 必须且只能设置 bool_value、int_value、double_value、decimal_value 其中一个".to_string(),
            );
        }

        let kind = if let Some(value) = self.bool_value {
            typed_constant::Kind::BoolValue(value)
        } else if let Some(value) = self.int_value {
            typed_constant::Kind::IntValue(value)
        } else if let Some(value) = &self.decimal_value {
            typed_constant::Kind::DecimalValue(value.clone())
        } else {
            typed_constant::Kind::DoubleValue(self.double_value.expect("checked above"))
        };
        Ok(TypedConstant { kind: Some(kind) })
    }

    fn kind_matches_operator(&self, operator_kind: i32) -> bool {
        match operator_kind {
            1..=4 | 9..=10 => {
                self.int_value.is_some()
                    || self.double_value.is_some()
                    || self.decimal_value.is_some()
            }
            5..=8 | 11 => self.bool_value.is_some(),
            _ => false,
        }
    }
}

impl From<OperandSpec> for OperandSpecDto {
    fn from(value: OperandSpec) -> Self {
        Self {
            source_kind: value.source_kind,
            constant: value.constant.map(Into::into),
        }
    }
}

impl OperandSpecDto {
    fn to_proto(&self, field_name: &str) -> Result<OperandSpec, String> {
        let constant = self
            .constant
            .as_ref()
            .map(TypedConstantDto::to_proto)
            .transpose()
            .map_err(|error| format!("{field_name}: {error}"))?;
        Ok(OperandSpec {
            source_kind: self.source_kind,
            constant,
        })
    }
}

impl From<CalcItemConfig> for CalcItemConfigDto {
    fn from(value: CalcItemConfig) -> Self {
        Self {
            item_name: value.item_name,
            operator_kind: value.operator_kind,
            left_operand: value.left_operand.map(Into::into),
            right_operand: value.right_operand.map(Into::into),
            operands: value.operands.into_iter().map(Into::into).collect(),
            decimal_places: value.decimal_places,
            expression: value.expression,
        }
    }
}

impl CalcItemConfigDto {
    fn to_proto(&self) -> Result<CalcItemConfig, String> {
        Ok(CalcItemConfig {
            item_name: self.item_name.trim().to_string(),
            operator_kind: self.operator_kind,
            left_operand: self
                .left_operand
                .as_ref()
                .map(|operand| operand.to_proto("left_operand"))
                .transpose()?,
            right_operand: self
                .right_operand
                .as_ref()
                .map(|operand| operand.to_proto("right_operand"))
                .transpose()?,
            operands: self
                .operands
                .iter()
                .enumerate()
                .map(|(index, operand)| operand.to_proto(&format!("operands[{index}]")))
                .collect::<Result<Vec<_>, _>>()?,
            decimal_places: self.decimal_places,
            expression: self.expression.trim().to_string(),
        })
    }
}

impl From<CalcGroupConfig> for CalcGroupConfigDto {
    fn from(value: CalcGroupConfig) -> Self {
        Self {
            group_name: value.group_name,
            items: value.items.into_iter().map(Into::into).collect(),
            trigger_mode: value.trigger_mode,
            period_ms: value.period_ms,
        }
    }
}

impl CalcGroupConfigDto {
    pub(crate) fn to_proto(&self) -> Result<CalcGroupConfig, String> {
        Ok(CalcGroupConfig {
            group_name: self.group_name.trim().to_string(),
            items: self
                .items
                .iter()
                .map(CalcItemConfigDto::to_proto)
                .collect::<Result<Vec<_>, _>>()?,
            trigger_mode: self.trigger_mode,
            period_ms: self.period_ms,
        })
    }
}

impl From<CalcItemInfo> for CalcItemInfoDto {
    fn from(value: CalcItemInfo) -> Self {
        Self {
            config: value.config.map(Into::into),
            left_input_tag: value.left_input_tag,
            right_input_tag: value.right_input_tag,
            result_tag: value.result_tag,
            input_tags: value.input_tags,
            operand_status: value.operand_status.into_iter().map(Into::into).collect(),
            last_error: value.last_error,
        }
    }
}

impl From<CalcOperandStatus> for CalcOperandStatusDto {
    fn from(value: CalcOperandStatus) -> Self {
        Self {
            index: value.index,
            input_tag: value.input_tag,
            ready: value.ready,
            reason: value.reason,
            quality: value.quality,
            ts_ms: value.ts_ms,
        }
    }
}

impl From<CalcGroupInfo> for CalcGroupInfoDto {
    fn from(value: CalcGroupInfo) -> Self {
        Self {
            config: value.config.map(Into::into),
            conn_id: value.conn_id,
            state: value.state,
            last_error: value.last_error,
            items: value.items.into_iter().map(Into::into).collect(),
        }
    }
}

fn validate_operand(
    operand: &OperandSpecDto,
    operator_kind: i32,
    field_name: &str,
) -> Result<(), String> {
    match operand.source_kind {
        1 => {
            if operand.constant.is_some() {
                Err(format!("{field_name} 为 ROUTED_INPUT 时不能携带 constant"))
            } else {
                Ok(())
            }
        }
        2 => {
            let constant = operand
                .constant
                .as_ref()
                .ok_or_else(|| format!("{field_name} 为 CONSTANT 时必须提供 constant"))?;
            if !constant.kind_matches_operator(operator_kind) {
                let expected =
                    if (1..=4).contains(&operator_kind) || (9..=10).contains(&operator_kind) {
                        "int/double"
                    } else {
                        "bool"
                    };
                return Err(format!("{field_name} 的 constant 必须为 {expected}"));
            }
            // 保证 DTO 常量仅携带一个类型分支。
            constant.to_proto().map(|_| ())
        }
        0 => Err(format!("{field_name} source_kind 不能为空")),
        _ => Err(format!("{field_name} source_kind 非法")),
    }
}

fn validate_group_config(config: &CalcGroupConfigDto) -> Result<(), String> {
    if config.group_name.trim().is_empty() {
        return Err("group_name 不能为空".to_string());
    }
    if config.items.is_empty() {
        return Err("items 不能为空".to_string());
    }
    if !matches!(config.trigger_mode, 0..=2) {
        return Err(
            "trigger_mode 非法，只能为 0（未指定）、1（变化触发）或 2（周期定时）"
                .to_string(),
        );
    }
    if config.trigger_mode == 2 && config.period_ms == 0 {
        return Err("周期定时模式下 period_ms 必须大于 0".to_string());
    }

    let mut item_names = HashSet::with_capacity(config.items.len());
    for item in &config.items {
        let item_name = item.item_name.trim();
        if item_name.is_empty() {
            return Err("item_name 不能为空".to_string());
        }
        if !item_names.insert(item_name.to_string()) {
            return Err(format!("item_name 重复: {item_name}"));
        }
        let is_unary = item.operator_kind == 5;
        let is_binary = matches!(item.operator_kind, 1..=4 | 6..=8);
        let is_aggregate = matches!(item.operator_kind, 9..=10);
        let is_expression = item.operator_kind == 11;
        let is_multi_logic = matches!(item.operator_kind, 6..=8) && !item.operands.is_empty();
        let uses_operands = is_aggregate || is_expression || is_multi_logic;
        if !is_unary && !is_binary && !is_aggregate && !is_expression {
            return Err(format!("items[{item_name}].operator_kind 非法"));
        }

        if is_expression {
            if item.expression.trim().is_empty() {
                return Err(format!("items[{item_name}].expression 不能为空"));
            }
            if item.expression.len() > 4096 {
                return Err(format!("items[{item_name}].expression 不能超过 4096 个字符"));
            }
        } else if !item.expression.is_empty() {
            return Err(format!("items[{item_name}].expression 仅适用于混合逻辑表达式"));
        }
        if item.operator_kind != 10 && item.decimal_places.is_some() {
            return Err(format!(
                "items[{item_name}].decimal_places 仅适用于 AVERAGE"
            ));
        }

        if uses_operands {
            let minimum = if is_expression { 1 } else { 2 };
            if item.operands.len() < minimum {
                return Err(format!(
                    "items[{item_name}].operands 至少需要 {minimum} 个操作数"
                ));
            }
            if (is_expression || is_multi_logic) && item.operands.len() > 256 {
                return Err(format!(
                    "items[{item_name}].operands 不能超过 256 个逻辑输入"
                ));
            }
            if item.left_operand.is_some() || item.right_operand.is_some() {
                return Err(format!(
                    "items[{item_name}] 使用 operands 时不能携带 left_operand/right_operand"
                ));
            }
            if let Some(decimal_places) = item.decimal_places {
                if decimal_places > 20 {
                    return Err(format!("items[{item_name}].decimal_places 不能大于 20"));
                }
            }
            for (index, operand) in item.operands.iter().enumerate() {
                validate_operand(
                    operand,
                    item.operator_kind,
                    &format!("items[{item_name}].operands[{index}]"),
                )?;
            }
            continue;
        }

        if !item.operands.is_empty() {
            return Err(format!("items[{item_name}] 的普通运算不能携带 operands"));
        }
        if item.decimal_places.is_some() {
            return Err(format!(
                "items[{item_name}].decimal_places 仅适用于 AVERAGE"
            ));
        }

        let left = item
            .left_operand
            .as_ref()
            .ok_or_else(|| format!("items[{item_name}].left_operand 不能为空"))?;
        if is_binary && item.right_operand.is_none() {
            return Err(format!(
                "items[{item_name}].right_operand 不能为空（二元运算）"
            ));
        }
        if is_unary && item.right_operand.is_some() {
            return Err(format!(
                "items[{item_name}].right_operand 不允许设置（NOT 为单目运算）"
            ));
        }

        validate_operand(
            left,
            item.operator_kind,
            &format!("items[{item_name}].left_operand"),
        )?;
        if let Some(right) = item.right_operand.as_ref() {
            validate_operand(
                right,
                item.operator_kind,
                &format!("items[{item_name}].right_operand"),
            )?;
        }

        let left_routed = left.source_kind == 1;
        let right_routed = item
            .right_operand
            .as_ref()
            .is_some_and(|operand| operand.source_kind == 1);
        if !left_routed && !right_routed {
            return Err(format!("items[{item_name}] 至少一侧必须为 ROUTED_INPUT"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn calc_upsert_group(
    state: State<'_, AppState>,
    config: CalcGroupConfigDto,
    create_only: bool,
) -> Result<CalcGroupInfoDto, String> {
    validate_group_config(&config)?;
    let group_name = config.group_name.trim().to_string();
    tracing::info!(
        module = "Calc",
        group_name = %group_name,
        trigger_mode = config.trigger_mode,
        period_ms = config.period_ms,
        expression_count = config.items.iter().filter(|item| item.operator_kind == 11).count(),
        multi_logic_count = config.items.iter().filter(|item| matches!(item.operator_kind, 6..=8) && !item.operands.is_empty()).count(),
        create_only,
        "开始保存数值计算分组配置"
    );
    let client = CalcClient::new(&state.conn_manager);
    let group = client
        .upsert_group(config.to_proto()?, create_only)
        .await
        .map_err(|error| {
            tracing::error!(module = "Calc", group_name = %group_name, error = %error, "保存数值计算分组配置失败");
            error.to_string()
        })?;
    Ok(group.into())
}

#[tauri::command]
pub async fn calc_rename_group(
    state: State<'_, AppState>,
    old_group_name: String,
    new_group_name: String,
) -> Result<CalcGroupInfoDto, String> {
    let old_group_name = old_group_name.trim().to_string();
    let new_group_name = new_group_name.trim().to_string();
    if old_group_name.is_empty() || new_group_name.is_empty() {
        return Err("分组名称不能为空".to_string());
    }
    let client = CalcClient::new(&state.conn_manager);
    client
        .rename_group(old_group_name.clone(), new_group_name.clone())
        .await
        .map(|group| group.into())
        .map_err(|error| {
            tracing::error!(module = "Calc", old_group_name = %old_group_name, new_group_name = %new_group_name, error = %error, "重命名数值计算分组失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn calc_get_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<CalcGroupInfoDto, String> {
    let group_name = group_name.trim().to_string();
    if group_name.is_empty() {
        return Err("group_name 不能为空".to_string());
    }
    let client = CalcClient::new(&state.conn_manager);
    client
        .get_group(group_name.clone())
        .await
        .map(|group| group.into())
        .map_err(|error| {
            tracing::error!(module = "Calc", group_name = %group_name, error = %error, "获取数值计算分组失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn calc_list_groups(state: State<'_, AppState>) -> Result<Vec<CalcGroupInfoDto>, String> {
    let client = CalcClient::new(&state.conn_manager);
    let groups = client.list_groups().await.map_err(|error| {
        tracing::error!(module = "Calc", error = %error, "获取数值计算分组列表失败");
        error.to_string()
    })?;
    Ok(groups.groups.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn calc_delete_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<(), String> {
    let group_name = group_name.trim().to_string();
    if group_name.is_empty() {
        return Err("group_name 不能为空".to_string());
    }
    let client = CalcClient::new(&state.conn_manager);
    client
        .delete_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(module = "Calc", group_name = %group_name, error = %error, "删除数值计算分组失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn calc_start_group(
    state: State<'_, AppState>,
    group_name: String,
) -> Result<(), String> {
    let group_name = group_name.trim().to_string();
    if group_name.is_empty() {
        return Err("group_name 不能为空".to_string());
    }
    let client = CalcClient::new(&state.conn_manager);
    client
        .start_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(module = "Calc", group_name = %group_name, error = %error, "启动数值计算分组失败");
            error.to_string()
        })
}

#[tauri::command]
pub async fn calc_stop_group(state: State<'_, AppState>, group_name: String) -> Result<(), String> {
    let group_name = group_name.trim().to_string();
    if group_name.is_empty() {
        return Err("group_name 不能为空".to_string());
    }
    let client = CalcClient::new(&state.conn_manager);
    client
        .stop_group(group_name.clone())
        .await
        .map_err(|error| {
            tracing::error!(module = "Calc", group_name = %group_name, error = %error, "停止数值计算分组失败");
            error.to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn logic_group(kind: i32, count: usize, expression: &str) -> CalcGroupConfigDto {
        serde_json::from_value(serde_json::json!({
            "group_name": "逻辑组",
            "items": [{
                "item_name": "混合逻辑", "operator_kind": kind,
                "operands": (0..count).map(|_| serde_json::json!({"source_kind": 1})).collect::<Vec<_>>(),
                "expression": expression,
            }],
        }))
        .expect("构造逻辑配置")
    }

    // 验证：混合逻辑文本和有序布尔输入通过 DTO/protobuf 双向转换后完整保留。
    #[test]
    fn logical_expression_round_trips_through_proto() {
        let config = logic_group(11, 3, "(A AND B) OR NOT C");
        validate_group_config(&config).expect("表达式配置合法");
        let proto = config.to_proto().expect("转换表达式配置");
        assert_eq!(proto.items[0].expression, "(A AND B) OR NOT C");
        let restored = CalcGroupConfigDto::from(proto);
        assert_eq!(restored.items[0].expression, "(A AND B) OR NOT C");
        assert_eq!(restored.items[0].operands.len(), 3);
    }

    // 验证：旧二元配置缺少表达式字段时仍可反序列化、校验并往返保留左右槽位。
    #[test]
    fn legacy_binary_logic_keeps_its_slots() {
        for kind in 6..=8 {
            let config: CalcGroupConfigDto = serde_json::from_value(serde_json::json!({
                "group_name": "旧分组", "items": [{"item_name": "旧逻辑", "operator_kind": kind,
                    "left_operand": {"source_kind": 1},
                    "right_operand": {"source_kind": 2, "constant": {"bool_value": false}}}],
            }))
            .expect("读取旧配置");
            validate_group_config(&config).expect("兼容旧二元配置");
            let restored = CalcGroupConfigDto::from(config.to_proto().expect("转换旧配置"));
            assert!(restored.items[0].expression.is_empty());
            assert!(restored.items[0].left_operand.is_some());
            assert!(restored.items[0].right_operand.is_some());
            assert!(restored.items[0].operands.is_empty());
            let json = serde_json::to_value(&restored).expect("序列化旧配置");
            assert!(json["items"][0].get("expression").is_none());
        }
    }

    // 验证：与、或、异或可使用多个有序输入，且逻辑常量只能为布尔值。
    #[test]
    fn multi_input_logic_validates_boolean_constants() {
        for kind in 6..=8 {
            let mut config = logic_group(kind, 3, "");
            config.items[0].operands[2] = OperandSpecDto {
                source_kind: 2,
                constant: Some(TypedConstantDto {
                    bool_value: Some(true),
                    ..TypedConstantDto::default()
                }),
            };
            validate_group_config(&config).expect("多输入逻辑合法");
            config.items[0].operands[2].constant = Some(TypedConstantDto {
                int_value: Some(1),
                ..TypedConstantDto::default()
            });
            assert!(validate_group_config(&config)
                .expect_err("拒绝数字代替布尔")
                .contains("bool"));
        }
    }

    // 验证：新旧输入表示不能混用，逻辑表达式不允许数值精度设置。
    #[test]
    fn logical_inputs_reject_mixed_slots_and_numeric_precision() {
        let mut config = logic_group(11, 2, "A OR B");
        config.items[0].left_operand = Some(OperandSpecDto {
            source_kind: 1,
            constant: None,
        });
        assert!(validate_group_config(&config).is_err());
        config.items[0].left_operand = None;
        config.items[0].decimal_places = Some(2);
        assert!(validate_group_config(&config)
            .expect_err("逻辑不接受精度")
            .contains("AVERAGE"));
        config.items[0].decimal_places = None;
        config.items[0].operands[0] = OperandSpecDto {
            source_kind: 2,
            constant: Some(TypedConstantDto {
                decimal_value: Some("1".into()),
                ..TypedConstantDto::default()
            }),
        };
        assert!(validate_group_config(&config)
            .expect_err("表达式拒绝数值常量")
            .contains("bool"));
    }

    // 验证：空表达式、过长文本、过多输入以及普通运算携带表达式均在桥接边界拒绝。
    #[test]
    fn logical_expression_enforces_boundary_limits() {
        assert!(validate_group_config(&logic_group(11, 1, "NOT A")).is_ok());
        assert!(validate_group_config(&logic_group(11, 0, "A")).is_err());
        assert!(validate_group_config(&logic_group(11, 1, "  ")).is_err());
        assert!(validate_group_config(&logic_group(11, 1, &"A".repeat(4097))).is_err());
        assert!(validate_group_config(&logic_group(11, 257, "A")).is_err());
        assert!(validate_group_config(&logic_group(6, 1, "")).is_err());
        assert!(validate_group_config(&logic_group(6, 2, "A OR B")).is_err());
        assert!(validate_group_config(&logic_group(9, 2, "A OR B")).is_err());
    }

    // 验证：精确十进制常量通过 Tauri DTO 后仍以原始字符串进入 protobuf oneof。
    #[test]
    fn decimal_constant_keeps_text_at_proto_boundary() {
        let dto = TypedConstantDto {
            decimal_value: Some("0.12345678901234567890".to_string()),
            ..TypedConstantDto::default()
        };

        let value = dto.to_proto().expect("精确十进制常量应可转换");
        assert!(matches!(
            value.kind,
            Some(typed_constant::Kind::DecimalValue(ref text))
                if text == "0.12345678901234567890"
        ));
    }

    // 验证：精确十进制与旧 double 同时设置时拒绝转换，避免 oneof 优先级不明确。
    #[test]
    fn decimal_constant_rejects_multiple_kinds() {
        let dto = TypedConstantDto {
            double_value: Some(0.1),
            decimal_value: Some("0.1".to_string()),
            ..TypedConstantDto::default()
        };

        let error = dto.to_proto().expect_err("同时设置两个常量分支必须失败");
        assert!(error.contains("只能设置"));
    }
}
