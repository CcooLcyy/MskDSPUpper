//! 装置返回的账号锁定等待；不自行累计密码错误或推测锁定时长。

use super::{LoginMode, LoginResult, SecurityLoginManager};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct AccountKey {
    pub(super) mode: LoginMode,
    pub(super) device_id: Option<String>,
    pub(super) username: String,
}

impl AccountKey {
    pub(super) fn from_result(result: &LoginResult, username: &str) -> Self {
        Self {
            mode: result.mode,
            device_id: result.device_id.clone(),
            username: username.into(),
        }
    }
}

#[derive(Serialize)]
pub struct LoginLockStatus {
    mode: LoginMode,
    device_id: Option<String>,
    username: String,
    lock_seconds: u32,
}

#[derive(Default)]
pub(super) struct LockoutState {
    deadlines: HashMap<AccountKey, Instant>,
    pending: HashSet<AccountKey>,
}

impl LockoutState {
    fn remaining_at(&mut self, key: &AccountKey, now: Instant) -> Option<u32> {
        let deadline = *self.deadlines.get(key)?;
        let remaining = deadline.saturating_duration_since(now);
        if remaining.is_zero() {
            self.deadlines.remove(key);
            return None;
        }
        Some((remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0)) as u32)
    }

    fn record_at(&mut self, key: AccountKey, seconds: Option<u32>, now: Instant) {
        match seconds {
            Some(0) => {
                self.deadlines.remove(&key);
            }
            Some(seconds) => {
                self.deadlines.insert(key, now + Duration::from_secs(u64::from(seconds)));
            }
            None => {}
        }
    }

    fn snapshot_at(&mut self, now: Instant) -> Vec<LoginLockStatus> {
        self.deadlines.retain(|_, deadline| *deadline > now);
        let keys: Vec<_> = self.deadlines.keys().cloned().collect();
        keys.into_iter()
            .filter_map(|key| {
                self.remaining_at(&key, now).map(|seconds| LoginLockStatus {
                    mode: key.mode,
                    device_id: key.device_id,
                    username: key.username,
                    lock_seconds: seconds,
                })
            })
            .collect()
    }
}

#[derive(Debug)]
pub(super) enum AuthenticationBlocked {
    Locked(u32),
    Pending,
}

pub(super) struct AccountAuthenticationGuard<'a> {
    state: &'a Mutex<LockoutState>,
    key: AccountKey,
}

impl Drop for AccountAuthenticationGuard<'_> {
    fn drop(&mut self) {
        self.state.lock().pending.remove(&self.key);
    }
}

impl SecurityLoginManager {
    pub(super) fn account_lock_seconds(&self, key: &AccountKey) -> Option<u32> {
        self.lockout.lock().remaining_at(key, Instant::now())
    }

    pub(super) fn begin_account_authentication(
        &self,
        key: AccountKey,
    ) -> Result<AccountAuthenticationGuard<'_>, AuthenticationBlocked> {
        let mut state = self.lockout.lock();
        if let Some(seconds) = state.remaining_at(&key, Instant::now()) {
            tracing::info!(seconds, "纵密账号仍处于装置锁定等待期，未发起认证连接");
            return Err(AuthenticationBlocked::Locked(seconds));
        }
        if !state.pending.insert(key.clone()) {
            tracing::info!("同一纵密账号已有认证请求，拒绝并发提交");
            return Err(AuthenticationBlocked::Pending);
        }
        Ok(AccountAuthenticationGuard {
            state: &self.lockout,
            key,
        })
    }

    pub(super) fn record_account_lock(&self, key: AccountKey, seconds: Option<u32>) {
        tracing::info!(seconds, "记录纵密装置返回的账号锁定时间");
        self.lockout.lock().record_at(key, seconds, Instant::now());
    }

    pub(super) fn login_locks(&self) -> Vec<LoginLockStatus> {
        self.lockout.lock().snapshot_at(Instant::now())
    }
}

pub(super) fn locked_result(result: LoginResult, seconds: u32) -> LoginResult {
    let mut result = result.failure(
        2,
        "account_locked",
        "纵密账号仍在锁定等待期，请等待倒计时结束后再操作",
    );
    result.lock_seconds = Some(seconds);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(username: &str) -> AccountKey {
        AccountKey {
            mode: LoginMode::Direct,
            device_id: None,
            username: username.into(),
        }
    }

    // 剩余时间向上取整，后台休眠后按截止时刻恢复，边界时刻立即放行。
    #[test]
    fn deadline_rounding_and_expiration() {
        let mut state = LockoutState::default();
        let at = Instant::now();
        state.record_at(key("fixture"), Some(60), at);
        assert_eq!(state.remaining_at(&key("fixture"), at), Some(60));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_millis(1)), Some(60));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_millis(59_999)), Some(1));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_secs(60)), None);
        assert!(state.deadlines.is_empty());
        state.record_at(key("fixture"), Some(u32::MAX), at);
        assert_eq!(state.remaining_at(&key("fixture"), at), Some(u32::MAX));
    }

    // 最新装置应答可延长或缩短等待，零秒不追加等待，未知秒数不猜测。
    #[test]
    fn only_device_seconds_update_deadline() {
        let mut state = LockoutState::default();
        let at = Instant::now();
        state.record_at(key("fixture"), None, at);
        assert_eq!(state.remaining_at(&key("fixture"), at), None);
        state.record_at(key("fixture"), Some(60), at);
        state.record_at(key("fixture"), None, at + Duration::from_secs(1));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_secs(1)), Some(59));
        state.record_at(key("fixture"), Some(120), at + Duration::from_secs(1));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_secs(1)), Some(120));
        state.record_at(key("fixture"), Some(2), at + Duration::from_secs(2));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_secs(2)), Some(2));
        state.record_at(key("fixture"), Some(0), at + Duration::from_secs(2));
        assert_eq!(state.remaining_at(&key("fixture"), at + Duration::from_secs(2)), None);
    }

    // 锁定区分账号、直连与远程及远程目标；同一账号的角色不属于键。
    #[test]
    fn accounts_and_targets_are_isolated() {
        let mut state = LockoutState::default();
        let at = Instant::now();
        state.record_at(key("fixture"), Some(60), at);
        assert_eq!(state.remaining_at(&key("other"), at), None);
        let remote = AccountKey { mode: LoginMode::Remote, device_id: Some("device-a".into()), username: "fixture".into() };
        assert_eq!(state.remaining_at(&remote, at), None);
        state.record_at(remote.clone(), Some(10), at);
        assert_eq!(state.remaining_at(&AccountKey { device_id: Some("device-b".into()), ..remote }, at), None);
        let snapshot = state.snapshot_at(at + Duration::from_secs(11));
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].username, "fixture");
        assert_eq!(snapshot[0].lock_seconds, 49);
        assert_eq!(snapshot[0].device_id, None);
    }

    // 同账号并发认证被拒绝，取消后释放占用；账号锁定优先于并发拒绝。
    #[test]
    fn pending_guard_and_lock_prevent_duplicate_authentication() {
        let manager = SecurityLoginManager::default();
        let guard = manager.begin_account_authentication(key("fixture")).unwrap();
        assert!(matches!(manager.begin_account_authentication(key("fixture")), Err(AuthenticationBlocked::Pending)));
        assert!(manager.begin_account_authentication(key("other")).is_ok());
        manager.record_account_lock(key("fixture"), Some(60));
        assert!(matches!(manager.begin_account_authentication(key("fixture")), Err(AuthenticationBlocked::Locked(1..=60))));
        drop(guard);
        assert!(matches!(manager.begin_account_authentication(key("fixture")), Err(AuthenticationBlocked::Locked(1..=60))));
        manager.record_account_lock(key("fixture"), Some(0));
        assert!(manager.begin_account_authentication(key("fixture")).is_ok());
    }

    // 取消请求、页面清理和证书配置更新均不清除装置锁定记录。
    #[test]
    fn connection_cleanup_does_not_clear_device_lock() {
        let manager = SecurityLoginManager::default();
        manager.record_account_lock(key("fixture"), Some(60));
        manager.cancel_all();
        manager.cancel("cancel-fixture").unwrap();
        SecurityLoginManager::advance_configuration(&mut manager.inner.lock());
        assert!((1..=60).contains(&manager.login_locks()[0].lock_seconds));
        assert!(matches!(manager.account_lock_seconds(&key("fixture")), Some(1..=60)));
    }

    // 真实认证编排收到装置锁定后先保存，再返回失败；不进行资料读取或建立身份。
    #[tokio::test]
    async fn device_reply_is_saved_before_failed_result_is_returned() {
        use super::super::{
            complete_login, connect_and_authenticate, AuthenticationContext, CertificateProfile,
            LoadedProfile, LoginRequest, Reply,
        };
        use std::sync::Arc;
        use tokio::io::AsyncReadExt;
        let manager = Arc::new(SecurityLoginManager::default());
        let request = LoginRequest {
            request_id: "fixture-lock-reply".into(),
            mode: LoginMode::Direct,
            device_id: None,
            username: "fixture".into(),
            password: String::new(),
            role: 1,
        };
        let credentials = AuthenticationContext {
            username: request.username.clone(),
            role: 1,
            old_digest: zeroize::Zeroizing::new(String::new()),
            default_password: false,
            generation: 0,
        };
        let (stream, mut peer) = tokio::io::duplex(64);
        let response = complete_login(
            &manager,
            LoginResult::new(&request),
            credentials,
            stream,
            Reply::Locked(Some(60)),
        ).await;
        assert_eq!(response.code, "account_locked");
        assert_eq!(response.lock_seconds, Some(60));
        assert!(response.session_id.is_none());
        assert!(response.challenge_id.is_none());
        manager.cancel(&request.request_id).unwrap();
        assert!(matches!(manager.begin_account_authentication(key("fixture")), Err(AuthenticationBlocked::Locked(1..=60))));
        let retry = connect_and_authenticate(
            &manager,
            LoginResult::new(&request),
            Arc::new(LoadedProfile { metadata: CertificateProfile::default(), candidates: Vec::new() }),
            zeroize::Zeroizing::new(Vec::new()),
            AuthenticationContext {
                username: request.username.clone(),
                role: 3,
                old_digest: zeroize::Zeroizing::new(String::new()),
                default_password: false,
                generation: 0,
            },
        ).await;
        assert_eq!(retry.code, "account_locked");
        assert!(matches!(retry.lock_seconds, Some(1..=60)));
        assert_eq!(retry.steps[0].state, "pending");
        assert_eq!(retry.steps[1].state, "pending");
        let mut received = Vec::new();
        peer.read_to_end(&mut received).await.unwrap();
        assert!(received.is_empty());
        assert!(manager.inner.lock().connections.is_empty());
    }
}
