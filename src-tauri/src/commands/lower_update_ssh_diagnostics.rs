//! 更新 SSH 的阶段诊断；只记录固定阶段、目标身份与去密后的错误。
use parking_lot::Mutex;
use std::{
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub(crate) struct UpdateSshObserver(Arc<ObserverInner>);

struct ObserverInner {
    operation_id: String,
    action: String,
    target: String,
    secrets: Vec<String>,
    started: Instant,
    stage: Mutex<(&'static str, Instant)>,
}

impl UpdateSshObserver {
    pub(crate) fn new(operation_id: &str, action: &str, target: &str, secrets: &[&str]) -> Self {
        let mut secrets: Vec<_> = secrets
            .iter()
            .filter(|secret| !secret.is_empty())
            .map(|secret| secret.to_string())
            .collect();
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        let redact = |value: &str| {
            secrets.iter().fold(value.to_string(), |text, secret| {
                text.replace(secret, "[已隐藏]")
            })
        };
        Self(Arc::new(ObserverInner {
            operation_id: redact(operation_id),
            action: redact(action),
            target: redact(target),
            secrets,
            started: Instant::now(),
            stage: Mutex::new(("准备", Instant::now())),
        }))
    }

    pub(crate) fn redact(&self, value: &str) -> String {
        self.0
            .secrets
            .iter()
            .fold(value.to_string(), |text, secret| {
                text.replace(secret, "[已隐藏]")
            })
    }

    pub(crate) fn stage(&self, phase: &'static str) {
        let (previous, elapsed) = {
            let mut stage = self.0.stage.lock();
            let previous = (stage.0, stage.1.elapsed().as_millis());
            *stage = (phase, Instant::now());
            previous
        };
        tracing::info!(operation_id = %self.0.operation_id, action = %self.0.action, target = %self.0.target,
            previous_phase = previous, previous_elapsed_ms = elapsed as u64,
            phase, elapsed_ms = self.0.started.elapsed().as_millis() as u64, "下位机更新通信阶段");
    }

    pub(crate) fn failure(&self, error: &str) -> String {
        let detail = self.redact(error);
        let phase = self.0.stage.lock().0;
        tracing::warn!(operation_id = %self.0.operation_id, action = %self.0.action, target = %self.0.target,
            phase, elapsed_ms = self.0.started.elapsed().as_millis() as u64, detail = %detail,
            "下位机更新通信未完成，保留原任务身份");
        format!("{}未完成（阶段：{phase}）：{detail}", self.0.action)
    }

    fn disconnect_started(&self) {
        tracing::info!(operation_id = %self.0.operation_id, action = %self.0.action, target = %self.0.target,
            phase = "SSH断开", elapsed_ms = self.0.started.elapsed().as_millis() as u64,
            "开始清理 SSH 连接，命令结果已返回");
    }

    fn disconnect_result(&self, success: bool, duration: Duration) {
        if success {
            tracing::info!(operation_id = %self.0.operation_id, action = %self.0.action, target = %self.0.target,
                phase = "SSH断开", phase_elapsed_ms = duration.as_millis() as u64, elapsed_ms = self.0.started.elapsed().as_millis() as u64,
                "SSH 连接清理完成");
        } else {
            tracing::warn!(operation_id = %self.0.operation_id, action = %self.0.action, target = %self.0.target,
                phase = "SSH断开", phase_elapsed_ms = duration.as_millis() as u64, elapsed_ms = self.0.started.elapsed().as_millis() as u64,
                "SSH 连接清理未完成，不影响已经收到的命令结果");
        }
    }
}

/// 断开仅清理客户端连接，不能延迟已收到的响应或取消宿主机独立安装服务。
pub(crate) fn complete_without_waiting_for_disconnect<T, F>(
    value: T,
    disconnect: F,
    observer: &UpdateSshObserver,
) -> T
where
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    let observer = observer.clone();
    tokio::spawn(async move {
        observer.disconnect_started();
        let started = Instant::now();
        let success = matches!(
            tokio::time::timeout(Duration::from_secs(1), disconnect).await,
            Ok(Ok(()))
        );
        observer.disconnect_result(success, started.elapsed());
    });
    value
}
