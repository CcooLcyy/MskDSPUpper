use super::*;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

struct FakeTarget {
    data: Mutex<Live<rtu::LinkConfig>>,
    events: Mutex<Vec<String>>,
    fail_points: bool,
    race_config: bool,
    switch_on_stop: bool,
    lose_point_response: bool,
    switch_on_points: bool,
    fail_start: bool,
    current: Arc<AtomicBool>,
}
impl FakeTarget {
    fn new(running: bool) -> Self {
        Self {
            data: Mutex::new(Live {
                config: rtu::LinkConfig {
                    conn_name: "a".into(),
                    address_base: 1,
                    read_plan: Some(rtu::ReadPlan {
                        mode: 2,
                        blocks: vec![],
                    }),
                    ..Default::default()
                },
                revision: 7,
                state: if running { 2 } else { 1 },
            }),
            events: Mutex::default(),
            fail_points: false,
            race_config: false,
            switch_on_stop: false,
            lose_point_response: false,
            switch_on_points: false,
            fail_start: false,
            current: Arc::new(AtomicBool::new(true)),
        }
    }
}
#[tonic::async_trait]
impl TemplateTarget for FakeTarget {
    type Config = rtu::LinkConfig;
    async fn read(&self, _: &str) -> Result<Live<Self::Config>, String> {
        Ok(self.data.lock().clone())
    }
    async fn stop(&self, _: &str) -> Result<(), String> {
        self.events.lock().push("stop".into());
        self.data.lock().state = 1;
        if self.switch_on_stop {
            self.current.store(false, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn start(&self, _: &str) -> Result<(), String> {
        self.events.lock().push("start".into());
        if self.fail_start {
            return Err("连接无法恢复".into());
        }
        self.data.lock().state = 2;
        Ok(())
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
        let mut data = self.data.lock();
        if data.config != expected || data.revision != revision {
            self.events.lock().push("rollback_conflict".into());
            return Err("连接配置或点表版本并发冲突".into());
        }
        self.events.lock().push("config".into());
        data.config = config.clone();
        Ok(config)
    }
    async fn save_points(
        &self,
        _: &str,
        _: Vec<rtu::Point>,
        revision: u64,
        _: String,
        expected: Self::Config,
    ) -> Result<(), String> {
        self.events.lock().push("points".into());
        let mut data = self.data.lock();
        if data.revision != revision || data.config != expected {
            return Err("点表并发冲突".into());
        }
        if self.race_config {
            data.config.poll_interval_ms = 9999;
        }
        if self.switch_on_points {
            self.current.store(false, Ordering::SeqCst);
        }
        if self.fail_points {
            return Err("点表保存失败".into());
        }
        data.revision += 1;
        if self.lose_point_response {
            return Err("点表响应超时".into());
        }
        Ok(())
    }
}
fn points() -> Vec<rtu::Point> {
    vec![rtu::Point {
        tag: "p".into(),
        function: 2,
        address: 20,
        reg_count: 2,
        ..Default::default()
    }]
}
async fn apply(
    fake: &FakeTarget,
    revision: u64,
    config: rtu::LinkConfig,
) -> Result<TemplateApplyResult, String> {
    apply_transaction(fake, "a", points(), revision, "{}".into(), config, || {
        if fake.current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("设备已切换".into())
        }
    })
    .await
}

// 验证：过期点表或完整配置变化必须在暂停链路及写入前拒绝。
#[tokio::test]
async fn stale_revision_and_configuration_never_write() {
    let fake = FakeTarget::new(true);
    let original = fake.data.lock().config.clone();
    assert!(apply(&fake, 6, original.clone())
        .await
        .unwrap_err()
        .contains("点表"));
    let mut stale = original;
    stale.poll_interval_ms = 1;
    assert!(apply(&fake, 7, stale).await.unwrap_err().contains("配置"));
    assert!(fake.events.lock().is_empty());
}

// 验证：原停止状态保存后保持停止，RTU 补齐完整点位区间。
#[tokio::test]
async fn stopped_link_stays_stopped_and_read_plan_is_extended() {
    let fake = FakeTarget::new(false);
    let original = fake.data.lock().config.clone();
    let result = apply(&fake, 7, original).await.unwrap();
    assert!(result.read_plan_extended);
    assert!(result.restart_error.is_none());
    assert_eq!(fake.data.lock().state, 1);
    assert_eq!(&*fake.events.lock(), &["config", "points"]);
}

// 验证：暂停后切换设备拒绝后续配置和点表写入，但恢复旧目标链路。
#[tokio::test]
async fn switch_after_stop_only_restores_original_target() {
    let mut fake = FakeTarget::new(true);
    fake.switch_on_stop = true;
    let original = fake.data.lock().config.clone();
    assert!(apply(&fake, 7, original)
        .await
        .unwrap_err()
        .contains("设备已切换"));
    assert_eq!(&*fake.events.lock(), &["stop", "start"]);
}

// 验证：点表保存失败后，回滚 CAS 不得覆盖其他客户端新连接配置。
#[tokio::test]
async fn rollback_preserves_competing_configuration_and_reports_failure() {
    let mut fake = FakeTarget::new(true);
    fake.fail_points = true;
    fake.race_config = true;
    let original = fake.data.lock().config.clone();
    let error = apply(&fake, 7, original).await.unwrap_err();
    assert!(error.contains("点表保存失败"));
    assert!(error.contains("回滚"));
    assert_eq!(fake.data.lock().config.poll_interval_ms, 9999);
    assert_eq!(fake.events.lock().last().unwrap(), "start");
}

// 验证：失败且无并发时恢复原读取区间，并恢复原运行状态。
#[tokio::test]
async fn failed_points_roll_back_own_config_and_restore_running_state() {
    let mut fake = FakeTarget::new(true);
    fake.fail_points = true;
    let original = fake.data.lock().config.clone();
    assert!(apply(&fake, 7, original.clone()).await.is_err());
    assert_eq!(fake.data.lock().config, original);
    assert_eq!(fake.data.lock().state, 2);
    assert_eq!(
        &*fake.events.lock(),
        &["stop", "config", "points", "config", "start"]
    );
}

// 验证：点表实际提交但响应丢失时，点表版本 CAS 阻止回滚读取计划。
#[tokio::test]
async fn committed_points_with_lost_response_keep_extended_plan() {
    let mut fake = FakeTarget::new(true);
    fake.lose_point_response = true;
    let original = fake.data.lock().config.clone();
    let error = apply(&fake, 7, original.clone()).await.unwrap_err();
    assert!(error.contains("核对保存结果"));
    assert!(error.contains("回滚失败"));
    assert_eq!(fake.data.lock().revision, 8);
    assert_ne!(fake.data.lock().config, original);
    assert_eq!(
        fake.data
            .lock()
            .config
            .read_plan
            .as_ref()
            .unwrap()
            .blocks
            .len(),
        1
    );
    assert_eq!(fake.data.lock().state, 2);
}

// 验证：切换设备后仍可在旧目标双 CAS 回滚自己的配置并恢复旧目标。
#[tokio::test]
async fn switched_connection_allows_safe_cleanup_of_original_target() {
    let mut fake = FakeTarget::new(true);
    fake.fail_points = true;
    fake.switch_on_points = true;
    let original = fake.data.lock().config.clone();
    assert!(apply(&fake, 7, original.clone()).await.is_err());
    assert_eq!(fake.data.lock().config, original);
    assert_eq!(
        &*fake.events.lock(),
        &["stop", "config", "points", "config", "start"]
    );
}

// 验证：保存成功但恢复失败应返回明确警告，保存失败则合并恢复错误。
#[tokio::test]
async fn restore_failures_do_not_hide_the_save_outcome() {
    let mut fake = FakeTarget::new(true);
    fake.fail_start = true;
    let original = fake.data.lock().config.clone();
    let result = apply(&fake, 7, original).await.unwrap();
    assert!(result.restart_error.unwrap().contains("连接无法恢复"));
    let mut failed = FakeTarget::new(true);
    failed.fail_points = true;
    failed.fail_start = true;
    let original = failed.data.lock().config.clone();
    let error = apply(&failed, 7, original).await.unwrap_err();
    assert!(error.contains("点表保存失败"));
    assert!(error.contains("连接无法恢复"));
}

// 验证：旧下位机零版本及预览已切换目标都不能暂停或修改任何链路。
#[tokio::test]
async fn unsupported_or_changed_target_is_rejected_before_mutation() {
    let fake = FakeTarget::new(true);
    fake.data.lock().revision = 0;
    let original = fake.data.lock().config.clone();
    assert!(apply(&fake, 1, original.clone())
        .await
        .unwrap_err()
        .contains("升级"));
    fake.current.store(false, Ordering::SeqCst);
    assert!(apply(&fake, 1, original)
        .await
        .unwrap_err()
        .contains("设备已切换"));
    assert!(fake.events.lock().is_empty());
}

// 验证：真实核心入口使用运行连接代次，旧预览在任何设备 RPC 前即被拒绝。
#[tokio::test]
async fn core_entry_rejects_previous_device_generation_without_rpc() {
    let manager = Arc::new(ConnectionManager::new("unreachable:1".into()));
    let token = manager.runtime_generation().to_string();
    manager.clear_runtime_cache();
    let options = ModbusTemplateSaveOptionsDto {
        expected_revision: "1".into(),
        template_bindings_json: "{\"schema_version\":1,\"applications\":[]}".into(),
    };
    let config = ModbusLinkConfigDto::from(rtu::LinkConfig {
        conn_name: "a".into(),
        ..Default::default()
    });
    assert!(
        apply_rtu(manager, "a".into(), vec![], options, config, token)
            .await
            .unwrap_err()
            .contains("设备连接已变化")
    );
}

// 验证：运行代次必须为原始十进制字符串，切换代次不允许应用旧预览。
#[test]
fn generation_tokens_require_exact_identity() {
    assert!(check_generation("0", 0).is_ok());
    for token in ["01", "1.0", "-1", "18446744073709551616", "8"] {
        assert!(check_generation(token, 7).is_err());
    }
}

// 验证：跨两个响应的局部覆盖不算完整覆盖，保留手工读取区间。
#[test]
fn read_plan_covers_each_whole_point() {
    let mut config = FakeTarget::new(false).data.lock().config.clone();
    config.read_plan.as_mut().unwrap().blocks = vec![
        rtu::ReadBlock {
            function: 2,
            start: 20,
            quantity: 1,
        },
        rtu::ReadBlock {
            function: 2,
            start: 21,
            quantity: 1,
        },
    ];
    let next = extend_rtu_read_plan(&config, &points()).unwrap();
    assert_eq!(next.read_plan.as_ref().unwrap().blocks.len(), 3);
    assert_eq!(next.read_plan.as_ref().unwrap().blocks[2].quantity, 2);
    assert_eq!(extend_rtu_read_plan(&next, &points()).unwrap(), next);
}
