//! 平台模板应用事务约定：预览返回设备运行代次、完整连接配置和点表版本。
//! 保存从不可变运行目标快照执行，复读配置及版本后使用下位机 CAS；只恢复原先运行的链路内功能。
//! RTU 批量读取区间与点表在同一停止周期内保存，失败按刚写入配置及原点表版本双 CAS 回滚。
//! 切换设备后拒绝新写入，仅允许对旧快照目标恢复本事务已暂停的链路内功能。

use serde::Serialize;
use std::sync::Arc;
use tauri::State;

use super::modbus_rtu::{
    ModbusLinkConfigDto, ModbusLinkInfoDto, ModbusPointDto, ModbusPointTableDto,
    ModbusTemplateSaveOptionsDto,
};
use super::modbus_tcp::{ModbusTcpLinkConfigDto, ModbusTcpLinkInfoDto, ModbusTcpPointTableDto};
use crate::grpc::{
    connection::{ConnectionManager, RuntimeRefreshSnapshot},
    modbus_rtu::ModbusRtuClient,
    modbus_tcp::ModbusTcpClient,
};
use crate::proto::{modbus_rtu_proto as rtu, modbus_tcp_proto as tcp};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct RtuTemplateContext {
    pub table: ModbusPointTableDto,
    pub link: ModbusLinkInfoDto,
    pub runtime_generation: String,
}

#[derive(Debug, Serialize)]
pub struct TcpTemplateContext {
    pub table: ModbusTcpPointTableDto,
    pub link: ModbusTcpLinkInfoDto,
    pub runtime_generation: String,
}

#[derive(Debug, Serialize)]
pub struct TemplateApplyResult {
    pub restart_error: Option<String>,
    pub read_plan_extended: bool,
}

#[derive(Clone)]
struct Live<C> {
    config: C,
    revision: u64,
    state: i32,
}

fn check_generation(token: &str, actual: u64) -> Result<(), String> {
    if token.parse::<u64>().ok() != Some(actual) || token != actual.to_string() {
        return Err("设备连接已变化，请关闭模板窗口并重新读取设备点表".into());
    }
    Ok(())
}

fn check_current(
    manager: &ConnectionManager,
    snapshot: &RuntimeRefreshSnapshot,
) -> Result<(), String> {
    if manager.runtime_refresh_is_current(snapshot) {
        Ok(())
    } else {
        Err("设备连接已变化，已中止模板应用，请重新读取设备点表".into())
    }
}

// 测试注入控制面操作，不依赖真实设备；生产实现只持有不可变快照的连接管理器。
#[tonic::async_trait]
trait TemplateTarget: Sync {
    type Config: Clone + PartialEq + Send + Sync;
    async fn read(&self, name: &str) -> Result<Live<Self::Config>, String>;
    async fn stop(&self, name: &str) -> Result<(), String>;
    async fn start(&self, name: &str) -> Result<(), String>;
    fn extended(
        &self,
        config: &Self::Config,
        points: &[rtu::Point],
    ) -> Result<Self::Config, String>;
    async fn save_config(
        &self,
        config: Self::Config,
        expected: Self::Config,
        revision: u64,
    ) -> Result<Self::Config, String>;
    async fn save_points(
        &self,
        name: &str,
        points: Vec<rtu::Point>,
        revision: u64,
        bindings: String,
        expected: Self::Config,
    ) -> Result<(), String>;
}

fn verify_live<C: PartialEq>(actual: &Live<C>, expected: &C, revision: u64) -> Result<(), String> {
    if actual.revision == 0 {
        return Err("当前下位机不支持模板来源记录和并发保护，请先升级下位机".into());
    }
    if actual.revision != revision {
        return Err("设备点表已变化，请重新读取并比对".into());
    }
    if actual.config != *expected {
        return Err("设备连接配置已变化，请重新读取并比对".into());
    }
    if !matches!(actual.state, 1 | 2) {
        return Err("连接状态不允许应用模板，请重新读取链路状态".into());
    }
    Ok(())
}

async fn apply_transaction<T, F>(
    target: &T,
    name: &str,
    points: Vec<rtu::Point>,
    revision: u64,
    bindings: String,
    expected: T::Config,
    current: F,
) -> Result<TemplateApplyResult, String>
where
    T: TemplateTarget,
    F: Fn() -> Result<(), String> + Send + Sync,
{
    current()?;
    let initial = target.read(name).await?;
    current()?;
    verify_live(&initial, &expected, revision)?;
    let originally_running = initial.state == 2;
    let mut paused = false;
    let mut changed_config: Option<T::Config> = None;
    let mut read_plan_extended = false;
    let operation: Result<(), String> = async {
        if originally_running {
            current()?;
            // 网络错误可能发生在停止已执行之后，因此失败也在旧目标尝试恢复。
            paused = true;
            target
                .stop(name)
                .await
                .map_err(|error| format!("停止链路内功能失败：{error}"))?;
        }
        current()?;
        let stopped = target.read(name).await?;
        verify_live(&stopped, &expected, revision)?;
        if stopped.state != 1 {
            return Err("链路内功能已被其他操作启动，请重新比对".into());
        }
        let next = target.extended(&expected, &points)?;
        let final_config = if next != expected {
            current()?;
            // 即使响应丢失，清理也只能使用这份预期配置 CAS，不能覆盖并发修改。
            changed_config = Some(next.clone());
            let saved = target.save_config(next, expected.clone(), revision).await?;
            changed_config = Some(saved.clone());
            read_plan_extended = true;
            saved
        } else {
            expected.clone()
        };
        current()?;
        target
            .save_points(name, points, revision, bindings, final_config)
            .await
            .map_err(|error| format!("点表保存返回错误，请重新读取设备核对保存结果：{error}"))
    }
    .await;

    let mut failure = operation.err();
    if failure.is_some() {
        if let Some(written) = changed_config {
            // 固定旧设备善后；点表已提交或有并发配置时双 CAS 拒绝恢复旧计划。
            if let Err(error) = target.save_config(expected, written, revision).await {
                failure.as_mut().unwrap().push_str(&format!(
                    "；读取计划回滚失败，已保留当前配置，请重新读取旧设备核对：{error}"
                ));
            }
        }
    }
    // 只对捕获的旧目标恢复；这里刻意不使用当前全局连接，也不启动原已停止连接。
    let restart_error = if paused {
        target
            .start(name)
            .await
            .err()
            .map(|error| format!("恢复原链路内功能失败：{error}"))
    } else {
        None
    };
    if let Some(mut error) = failure {
        if let Some(restart) = restart_error {
            error.push_str(&format!("；{restart}"));
        }
        tracing::warn!(conn_name = name, error = %error, "平台模板应用事务失败");
        return Err(error);
    }
    tracing::info!(conn_name = name, read_plan_extended, restart_error = ?restart_error, "平台模板点表及来源已原子保存");
    Ok(TemplateApplyResult {
        restart_error,
        read_plan_extended,
    })
}

fn extend_rtu_read_plan(
    config: &rtu::LinkConfig,
    points: &[rtu::Point],
) -> Result<rtu::LinkConfig, String> {
    let mut next = config.clone();
    let Some(plan) = next.read_plan.as_mut().filter(|plan| plan.mode == 2) else {
        return Ok(next);
    };
    for point in points
        .iter()
        .filter(|point| matches!(point.function, 2 | 3))
    {
        let count = if point.reg_count == 0 {
            if matches!(point.r#type, 3 | 5) {
                2
            } else {
                1
            }
        } else {
            point.reg_count
        };
        let end = point.address.checked_add(count).ok_or("点位地址范围溢出")?;
        if count > 125 || end > 65536 || (config.address_base == 2 && point.address == 0) {
            return Err("模板点位地址或寄存器数量不合法，不能补齐读取区间".into());
        }
        if plan.blocks.iter().any(|block| {
            block.function == point.function
                && block.start <= point.address
                && block
                    .start
                    .checked_add(block.quantity)
                    .is_some_and(|limit| limit >= end)
        }) {
            continue;
        }
        plan.blocks.push(rtu::ReadBlock {
            function: point.function,
            start: point.address,
            quantity: count,
        });
    }
    Ok(next)
}

struct RtuTarget<'a>(&'a ConnectionManager);
#[tonic::async_trait]
impl TemplateTarget for RtuTarget<'_> {
    type Config = rtu::LinkConfig;
    async fn read(&self, name: &str) -> Result<Live<Self::Config>, String> {
        let client = ModbusRtuClient::new(self.0);
        let (link, table) = tokio::try_join!(
            client.get_link(name.into()),
            client.get_point_table(name.into())
        )
        .map_err(|error| error.to_string())?;
        Ok(Live {
            config: link.config.ok_or("设备连接配置不存在")?,
            revision: table.revision,
            state: link.state,
        })
    }
    async fn stop(&self, name: &str) -> Result<(), String> {
        ModbusRtuClient::new(self.0)
            .stop_link(name.into())
            .await
            .map_err(|error| error.to_string())
    }
    async fn start(&self, name: &str) -> Result<(), String> {
        ModbusRtuClient::new(self.0)
            .start_link(name.into())
            .await
            .map_err(|error| error.to_string())
    }
    fn extended(
        &self,
        config: &Self::Config,
        points: &[rtu::Point],
    ) -> Result<Self::Config, String> {
        extend_rtu_read_plan(config, points)
    }
    async fn save_config(
        &self,
        config: Self::Config,
        expected: Self::Config,
        revision: u64,
    ) -> Result<Self::Config, String> {
        ModbusRtuClient::new(self.0)
            .upsert_link_checked(config, expected, Some(revision))
            .await
            .map_err(|error| error.to_string())?
            .config
            .ok_or("设备保存连接配置响应为空".into())
    }
    async fn save_points(
        &self,
        name: &str,
        points: Vec<rtu::Point>,
        revision: u64,
        bindings: String,
        expected: Self::Config,
    ) -> Result<(), String> {
        ModbusRtuClient::new(self.0)
            .upsert_point_table_checked(
                name.into(),
                points,
                true,
                Some(revision),
                Some(bindings),
                Some(expected),
            )
            .await
            .map_err(|error| error.to_string())
    }
}

struct TcpTarget<'a>(&'a ConnectionManager);
#[tonic::async_trait]
impl TemplateTarget for TcpTarget<'_> {
    type Config = tcp::LinkConfig;
    async fn read(&self, name: &str) -> Result<Live<Self::Config>, String> {
        let client = ModbusTcpClient::new(self.0);
        let (link, table) = tokio::try_join!(
            client.get_link(name.into()),
            client.get_point_table(name.into())
        )
        .map_err(|error| error.to_string())?;
        Ok(Live {
            config: link.config.ok_or("设备连接配置不存在")?,
            revision: table.revision,
            state: link.state,
        })
    }
    async fn stop(&self, name: &str) -> Result<(), String> {
        ModbusTcpClient::new(self.0)
            .stop_link(name.into())
            .await
            .map_err(|error| error.to_string())
    }
    async fn start(&self, name: &str) -> Result<(), String> {
        ModbusTcpClient::new(self.0)
            .start_link(name.into())
            .await
            .map_err(|error| error.to_string())
    }
    fn extended(&self, config: &Self::Config, _: &[rtu::Point]) -> Result<Self::Config, String> {
        Ok(config.clone())
    }
    async fn save_config(
        &self,
        config: Self::Config,
        expected: Self::Config,
        revision: u64,
    ) -> Result<Self::Config, String> {
        ModbusTcpClient::new(self.0)
            .upsert_link_checked(config, expected, Some(revision))
            .await
            .map_err(|error| error.to_string())?
            .config
            .ok_or("设备保存连接配置响应为空".into())
    }
    async fn save_points(
        &self,
        name: &str,
        points: Vec<rtu::Point>,
        revision: u64,
        bindings: String,
        expected: Self::Config,
    ) -> Result<(), String> {
        ModbusTcpClient::new(self.0)
            .upsert_point_table_checked(
                name.into(),
                points,
                true,
                Some(revision),
                Some(bindings),
                Some(expected),
            )
            .await
            .map_err(|error| error.to_string())
    }
}

pub(crate) async fn rtu_context(
    manager: Arc<ConnectionManager>,
    name: String,
) -> Result<RtuTemplateContext, String> {
    let snapshot = manager.runtime_operation_snapshot()?;
    check_current(&manager, &snapshot)?;
    let client = ModbusRtuClient::new(&snapshot.connection);
    let (link, table) =
        tokio::try_join!(client.get_link(name.clone()), client.get_point_table(name))
            .map_err(|error| error.to_string())?;
    check_current(&manager, &snapshot)?;
    Ok(RtuTemplateContext {
        link: link.into(),
        table: table.into(),
        runtime_generation: snapshot.generation().to_string(),
    })
}

pub(crate) async fn tcp_context(
    manager: Arc<ConnectionManager>,
    name: String,
) -> Result<TcpTemplateContext, String> {
    let snapshot = manager.runtime_operation_snapshot()?;
    check_current(&manager, &snapshot)?;
    let client = ModbusTcpClient::new(&snapshot.connection);
    let (link, table) =
        tokio::try_join!(client.get_link(name.clone()), client.get_point_table(name))
            .map_err(|error| error.to_string())?;
    check_current(&manager, &snapshot)?;
    Ok(TcpTemplateContext {
        link: link.into(),
        table: table.into(),
        runtime_generation: snapshot.generation().to_string(),
    })
}

pub(crate) async fn apply_rtu(
    manager: Arc<ConnectionManager>,
    name: String,
    points: Vec<ModbusPointDto>,
    options: ModbusTemplateSaveOptionsDto,
    expected_config: ModbusLinkConfigDto,
    generation: String,
) -> Result<TemplateApplyResult, String> {
    let snapshot = manager.runtime_operation_snapshot()?;
    check_generation(&generation, snapshot.generation())?;
    check_current(&manager, &snapshot)?;
    let (revision, bindings) = options.to_fields(true)?;
    if expected_config.conn_name != name {
        return Err("预览连接名称与应用目标不一致".into());
    }
    let result = apply_transaction(
        &RtuTarget(&snapshot.connection),
        &name,
        points.iter().map(ModbusPointDto::to_proto).collect(),
        revision.unwrap(),
        bindings.unwrap(),
        expected_config.to_proto(),
        || check_current(&manager, &snapshot),
    )
    .await?;
    Ok(warn_changed_target(result, &manager, &snapshot))
}

pub(crate) async fn apply_tcp(
    manager: Arc<ConnectionManager>,
    name: String,
    points: Vec<ModbusPointDto>,
    options: ModbusTemplateSaveOptionsDto,
    expected_config: ModbusTcpLinkConfigDto,
    generation: String,
) -> Result<TemplateApplyResult, String> {
    let snapshot = manager.runtime_operation_snapshot()?;
    check_generation(&generation, snapshot.generation())?;
    check_current(&manager, &snapshot)?;
    let (revision, bindings) = options.to_fields(true)?;
    if expected_config.conn_name != name {
        return Err("预览连接名称与应用目标不一致".into());
    }
    let result = apply_transaction(
        &TcpTarget(&snapshot.connection),
        &name,
        points.iter().map(ModbusPointDto::to_proto).collect(),
        revision.unwrap(),
        bindings.unwrap(),
        expected_config.to_proto(),
        || check_current(&manager, &snapshot),
    )
    .await?;
    Ok(warn_changed_target(result, &manager, &snapshot))
}

fn warn_changed_target(
    mut result: TemplateApplyResult,
    manager: &ConnectionManager,
    snapshot: &RuntimeRefreshSnapshot,
) -> TemplateApplyResult {
    if check_current(manager, snapshot).is_err() {
        let warning = "点表已保存到原设备，但设备连接已变化，请重新读取当前设备";
        result.restart_error = Some(match result.restart_error {
            Some(error) => format!("{error}；{warning}"),
            None => warning.into(),
        });
        tracing::warn!(
            generation = snapshot.generation(),
            "点表已保存到原设备，但设备连接已变化，请重新读取当前设备"
        );
    }
    result
}

#[tauri::command]
pub async fn get_modbus_rtu_template_context(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<RtuTemplateContext, String> {
    rtu_context(state.conn_manager.clone(), conn_name).await
}

#[tauri::command]
pub async fn get_modbus_tcp_template_context(
    state: State<'_, AppState>,
    conn_name: String,
) -> Result<TcpTemplateContext, String> {
    tcp_context(state.conn_manager.clone(), conn_name).await
}

#[tauri::command]
pub async fn apply_modbus_rtu_template(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<ModbusPointDto>,
    options: ModbusTemplateSaveOptionsDto,
    expected_config: ModbusLinkConfigDto,
    runtime_generation: String,
) -> Result<TemplateApplyResult, String> {
    apply_rtu(
        state.conn_manager.clone(),
        conn_name,
        points,
        options,
        expected_config,
        runtime_generation,
    )
    .await
}

#[tauri::command]
pub async fn apply_modbus_tcp_template(
    state: State<'_, AppState>,
    conn_name: String,
    points: Vec<ModbusPointDto>,
    options: ModbusTemplateSaveOptionsDto,
    expected_config: ModbusTcpLinkConfigDto,
    runtime_generation: String,
) -> Result<TemplateApplyResult, String> {
    apply_tcp(
        state.conn_manager.clone(),
        conn_name,
        points,
        options,
        expected_config,
        runtime_generation,
    )
    .await
}

#[cfg(test)]
#[path = "template_apply_tests.rs"]
mod tests;
