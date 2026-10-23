use crate::remote_access::RemoteConnection;
use anyhow::{anyhow, Result};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tonic::transport::Channel;

/// 模块运行时地址信息
#[derive(Debug, Clone)]
pub struct ModuleEndpoint {
    pub module_name: String,
    pub outer_grpc_server: String,
}

/// gRPC 连接管理器
/// 维护到各模块的 gRPC channel 缓存，以及模块地址映射
pub struct ConnectionManager {
    /// ModuleManager 的固定地址（默认 host:17000）
    manager_addr: RwLock<String>,
    /// 模块名 -> 外部 gRPC 地址
    module_addrs: RwLock<HashMap<String, String>>,
    /// 地址 -> Channel 缓存
    channels: RwLock<HashMap<String, Channel>>,
    /// 运行时缓存代次，用于拒绝重连前发起的过期请求回写
    runtime_generation: AtomicU64,
    remote: RwLock<Option<Arc<RemoteConnection>>>,
    remote_channels: tokio::sync::Mutex<HashMap<(u64, String), Channel>>,
}

/// 独立缓存只向快照目标发请求，成功后再有条件发布到当前连接。
pub struct RuntimeRefreshSnapshot {
    pub connection: ConnectionManager,
    generation: u64,
    manager_addr: String,
    remote: Option<Arc<RemoteConnection>>,
}

impl ConnectionManager {
    pub fn new(manager_addr: String) -> Self {
        Self {
            manager_addr: RwLock::new(manager_addr),
            module_addrs: RwLock::new(HashMap::new()),
            channels: RwLock::new(HashMap::new()),
            runtime_generation: AtomicU64::new(0),
            remote: RwLock::new(None),
            remote_channels: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 设置 ModuleManager 地址，返回地址是否发生变化
    pub fn set_manager_addr(&self, addr: String) -> bool {
        // 页面恢复现场地址不会隐式切走当前远程设备。
        if self.is_remote() {
            return false;
        }
        let mut current = self.manager_addr.write();
        if *current == addr {
            tracing::info!(manager_addr = %addr, "ModuleManager 地址未变化");
            return false;
        }

        tracing::info!(old_manager_addr = %*current, manager_addr = %addr, "更新 ModuleManager 地址");
        *current = addr;
        true
    }

    /// 获取 ModuleManager 地址
    pub fn manager_addr(&self) -> String {
        self.manager_addr.read().clone()
    }

    /// 从 ModuleManager 地址中提取 host 部分（不含端口）
    /// 例如 "192.168.1.219:17000" → "192.168.1.219"
    pub fn manager_host(&self) -> String {
        let addr = self.manager_addr();
        // host:port 格式，取 host 部分
        match addr.rsplit_once(':') {
            Some((host, _port)) => host.to_string(),
            None => addr,
        }
    }

    /// 更新模块地址缓存
    pub fn update_module_addr(&self, module_name: &str, addr: &str) {
        self.module_addrs
            .write()
            .insert(module_name.to_string(), addr.to_string());
    }

    /// 获取当前运行时缓存代次
    pub fn runtime_generation(&self) -> u64 {
        self.runtime_generation.load(Ordering::SeqCst)
    }

    pub fn runtime_refresh_snapshot(&self) -> RuntimeRefreshSnapshot {
        let remote = self.remote.read();
        let manager_addr = self.manager_addr.read();
        let generation = self.runtime_generation();
        let connection = ConnectionManager::new(manager_addr.clone());
        *connection.remote.write() = remote.clone();
        RuntimeRefreshSnapshot {
            connection,
            generation,
            manager_addr: manager_addr.clone(),
            remote: remote.clone(),
        }
    }

    pub fn runtime_refresh_is_current(&self, snapshot: &RuntimeRefreshSnapshot) -> bool {
        let remote = self.remote.read();
        let manager_addr = self.manager_addr.read();
        self.runtime_generation() == snapshot.generation
            && *manager_addr == snapshot.manager_addr
            && same_remote(&remote, &snapshot.remote)
            && remote.as_ref().is_none_or(|connection| connection.active())
    }

    pub async fn publish_runtime_refresh(&self, snapshot: &RuntimeRefreshSnapshot) -> bool {
        let new_remote_channels = snapshot.connection.remote_channels.lock().await.clone();
        let new_addrs = snapshot.connection.module_addrs.read().clone();
        let new_channels = snapshot.connection.channels.read().clone();
        let mut remote_channels = self.remote_channels.lock().await;
        let remote = self.remote.read();
        let manager_addr = self.manager_addr.read();
        let mut module_addrs = self.module_addrs.write();
        let mut channels = self.channels.write();
        let next_generation = snapshot.generation.wrapping_add(1);
        if *manager_addr != snapshot.manager_addr
            || !same_remote(&remote, &snapshot.remote)
            || remote
                .as_ref()
                .is_some_and(|connection| !connection.active())
            || self
                .runtime_generation
                .compare_exchange(
                    snapshot.generation,
                    next_generation,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_err()
        {
            return false;
        }
        *module_addrs = new_addrs;
        *channels = new_channels;
        *remote_channels = new_remote_channels
            .into_iter()
            .map(|((_, service), channel)| ((next_generation, service), channel))
            .collect();
        tracing::info!(
            generation = next_generation,
            "已发布更新后的模块地址与 gRPC 连接"
        );
        true
    }

    /// 仅在请求代次仍有效时批量更新模块地址
    pub fn update_module_addrs_if_generation(
        &self,
        expected_generation: u64,
        addrs: HashMap<String, String>,
    ) -> bool {
        let mut module_addrs = self.module_addrs.write();
        if self.runtime_generation() != expected_generation {
            return false;
        }
        *module_addrs = addrs;
        true
    }

    /// 查询模块地址
    pub fn get_module_addr(&self, module_name: &str) -> Option<String> {
        self.module_addrs.read().get(module_name).cloned()
    }

    /// 获取或创建到指定地址的 gRPC Channel
    pub async fn get_channel(&self, addr: &str) -> Result<Channel> {
        let request_generation = self.runtime_generation();
        // 先尝试读缓存
        {
            let cache = self.channels.read();
            if let Some(ch) = cache.get(addr) {
                return Ok(ch.clone());
            }
        }

        // 创建新连接
        let endpoint = format!("http://{}", addr);
        tracing::info!(address = %addr, "开始建立 gRPC 连接");
        let channel = Channel::from_shared(endpoint.clone())
            .map_err(|e| {
                tracing::error!(address = %addr, error = %e, "gRPC 地址无效");
                anyhow!("无效的地址 {}: {}", addr, e)
            })?
            .connect()
            .await
            .map_err(|e| {
                tracing::error!(address = %addr, error = %e, "gRPC 连接失败");
                anyhow!("连接 {} 失败: {}", addr, e)
            })?;

        let mut channels = self.channels.write();
        if self.runtime_generation() == request_generation {
            channels.insert(addr.to_string(), channel.clone());
        }
        tracing::info!(address = %addr, "gRPC 连接建立完成");
        Ok(channel)
    }

    /// 获取 ModuleManager 的 Channel
    pub async fn manager_channel(&self) -> Result<Channel> {
        if self.is_remote() {
            return self.remote_channel("ModuleManager").await;
        }
        let addr = self.manager_addr();
        self.get_channel(&addr).await
    }

    /// 获取指定模块的 Channel
    pub async fn module_channel(&self, module_name: &str) -> Result<Channel> {
        if self.is_remote() {
            return self.remote_channel(module_name).await;
        }
        let addr = self.get_module_addr(module_name).ok_or_else(|| {
            tracing::error!(module = %module_name, "模块地址未知，无法建立 gRPC 连接");
            anyhow!("模块 {} 地址未知，请先刷新运行信息", module_name)
        })?;
        self.get_channel(&addr).await
    }

    /// 清除模块地址和 Channel，供地址切换或强制重连使用
    pub fn clear_runtime_cache(&self) {
        let generation = self.runtime_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut module_addrs = self.module_addrs.write();
        let mut channels = self.channels.write();
        tracing::info!(
            generation,
            module_address_count = module_addrs.len(),
            channel_count = channels.len(),
            "清理 gRPC 运行时缓存"
        );
        module_addrs.clear();
        channels.clear();
    }

    pub fn is_remote(&self) -> bool {
        self.remote.read().is_some()
    }
    pub fn remote_connection(&self) -> Option<Arc<RemoteConnection>> {
        self.remote.read().clone()
    }
    pub async fn select_remote(&self, remote: Option<Arc<RemoteConnection>>) {
        {
            let mut current = self.remote.write();
            let old = std::mem::replace(&mut *current, remote);
            if let Some(old) = old {
                old.cancel();
            }
            self.clear_runtime_cache();
        }
        self.remote_channels.lock().await.clear();
    }
    pub async fn select_remote_if_current(
        &self,
        expected_generation: u64,
        remote: Arc<RemoteConnection>,
    ) -> Result<()> {
        {
            // 与退出清理共用设备选择锁，检查和发布之间不能插入一次注销。
            let mut current = self.remote.write();
            if self.runtime_generation() != expected_generation || !remote.active() {
                remote.cancel();
                tracing::info!(
                    expected_generation,
                    current_generation = self.runtime_generation(),
                    "设备选择请求已过期或原连接已失效，已拒绝发布"
                );
                return Err(anyhow!("设备连接已切换或平台登录已失效，请重新选择设备"));
            }
            if let Some(old) = current.replace(remote) {
                old.cancel();
            }
            self.clear_runtime_cache();
        }
        self.remote_channels.lock().await.clear();
        Ok(())
    }
    async fn remote_channel(&self, service: &str) -> Result<Channel> {
        let (generation, remote) = {
            let current = self.remote.read();
            (
                self.runtime_generation(),
                current.clone().ok_or_else(|| anyhow!("远程连接已切换"))?,
            )
        };
        if !remote.active() {
            return Err(anyhow!("远程连接已失效，请重新选择设备"));
        }
        let mut cache = self.remote_channels.lock().await;
        if generation != self.runtime_generation() {
            return Err(anyhow!("远程设备已切换"));
        }
        let key = (generation, service.to_string());
        if let Some(channel) = cache.get(&key) {
            return Ok(channel.clone());
        }
        let channel = remote.channel(service).await?;
        if generation != self.runtime_generation() || !remote.active() {
            return Err(anyhow!("远程设备已切换"));
        }
        cache.insert(key, channel.clone());
        Ok(channel)
    }
}

fn same_remote(
    left: &Option<Arc<RemoteConnection>>,
    right: &Option<Arc<RemoteConnection>>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => Arc::ptr_eq(left, right),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::ConnectionManager;
    use crate::{
        platform_auth::PlatformAuthManager,
        remote_access::{RemoteConnection, RemoteDevice},
    };
    use std::collections::HashMap;
    use std::sync::Arc;

    fn remote(device_id: &str) -> Arc<RemoteConnection> {
        RemoteConnection::new(
            RemoteDevice {
                device_id: device_id.into(),
                display_name: device_id.into(),
                online: true,
                allow_grpc: true,
                allow_ssh: true,
                services: vec!["ModuleManager".into()],
                agent_version: "test".into(),
            },
            Arc::new(PlatformAuthManager::test_session(
                "http://127.0.0.1:1".into(),
            )),
        )
        .unwrap()
    }

    // 注销或切换发生后，旧选择请求不得覆盖当前设备及其缓存。
    #[tokio::test]
    async fn remote_selection_rejects_stale_generation_without_changing_current_device() {
        let manager = ConnectionManager::new("device:17000".into());
        let stale_generation = manager.runtime_generation();
        let candidate = remote("old");
        let current = remote("current");
        manager.select_remote(Some(current.clone())).await;
        manager.update_module_addr("current", "device:17001");
        let current_generation = manager.runtime_generation();

        assert!(manager
            .select_remote_if_current(stale_generation, candidate.clone())
            .await
            .is_err());
        assert!(Arc::ptr_eq(&manager.remote_connection().unwrap(), &current));
        assert_eq!(manager.runtime_generation(), current_generation);
        assert_eq!(
            manager.get_module_addr("current").as_deref(),
            Some("device:17001")
        );
        assert!(!candidate.active());
        assert!(current.active());
    }

    // 即使设备代次未变化，已失效的原账号连接也不能重新发布。
    #[tokio::test]
    async fn remote_selection_rejects_inactive_connection() {
        let manager = ConnectionManager::new("device:17000".into());
        let generation = manager.runtime_generation();
        let candidate = remote("old");
        candidate.cancel();
        assert!(manager
            .select_remote_if_current(generation, candidate)
            .await
            .is_err());
        assert!(manager.remote_connection().is_none());
        assert_eq!(manager.runtime_generation(), generation);
    }

    // 当前有效选择正常替换设备，取消原连接并清空两类连接缓存。
    #[tokio::test]
    async fn remote_selection_accepts_current_active_connection_and_clears_caches() {
        let manager = ConnectionManager::new("device:17000".into());
        let old = remote("old");
        manager.select_remote(Some(old.clone())).await;
        manager.update_module_addr("old", "device:17001");
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy();
        manager
            .channels
            .write()
            .insert("old".into(), channel.clone());
        manager
            .remote_channels
            .lock()
            .await
            .insert((manager.runtime_generation(), "old".into()), channel);
        let generation = manager.runtime_generation();
        let current = remote("current");
        manager
            .select_remote_if_current(generation, current.clone())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&manager.remote_connection().unwrap(), &current));
        assert!(!old.active());
        assert!(current.active());
        assert!(manager.get_module_addr("old").is_none());
        assert!(manager.channels.read().is_empty());
        assert!(manager.remote_channels.lock().await.is_empty());
        assert!(manager.runtime_generation() > generation);
    }

    // 刷新成功时保留管理端口，同时替换模块地址和两类旧业务 Channel 缓存。
    #[tokio::test]
    async fn refreshed_snapshot_replaces_addresses_and_both_channel_caches() {
        let manager = ConnectionManager::new("device:17999".into());
        manager.update_module_addr("old", "device:17001");
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy();
        manager
            .channels
            .write()
            .insert("old".into(), channel.clone());
        manager
            .remote_channels
            .lock()
            .await
            .insert((0, "old".into()), channel.clone());
        let snapshot = manager.runtime_refresh_snapshot();
        assert_eq!(snapshot.connection.manager_addr(), "device:17999");
        snapshot
            .connection
            .update_module_addr("new", "device:17123");
        snapshot
            .connection
            .channels
            .write()
            .insert("new".into(), channel);

        assert!(manager.publish_runtime_refresh(&snapshot).await);
        assert_eq!(
            manager.get_module_addr("new").as_deref(),
            Some("device:17123")
        );
        assert!(manager.get_module_addr("old").is_none());
        assert!(!manager.channels.read().contains_key("old"));
        assert!(manager.channels.read().contains_key("new"));
        assert!(manager.remote_channels.lock().await.is_empty());
    }

    // 原设备查询完成得较晚时，不得覆盖用户后来选择的设备及其地址缓存。
    #[tokio::test]
    async fn stale_refresh_does_not_overwrite_current_target_or_caches() {
        let manager = ConnectionManager::new("first:17000".into());
        let snapshot = manager.runtime_refresh_snapshot();
        snapshot.connection.update_module_addr("old", "first:17001");
        manager.set_manager_addr("second:17999".into());
        manager.clear_runtime_cache();
        manager.update_module_addr("new", "second:17002");

        assert!(!manager.publish_runtime_refresh(&snapshot).await);
        assert_eq!(manager.manager_addr(), "second:17999");
        assert_eq!(
            manager.get_module_addr("new").as_deref(),
            Some("second:17002")
        );
        assert!(manager.get_module_addr("old").is_none());
    }

    // 即使地址相同，用户已执行的新一轮重连也必须使旧快照失效。
    #[tokio::test]
    async fn same_target_reselected_generation_rejects_older_refresh() {
        let manager = ConnectionManager::new("device:17000".into());
        let snapshot = manager.runtime_refresh_snapshot();
        manager.clear_runtime_cache();
        assert!(!manager.publish_runtime_refresh(&snapshot).await);
    }

    #[test]
    fn same_manager_address_preserves_module_address_cache() {
        let manager = ConnectionManager::new("192.168.1.219:17000".to_string());
        manager.update_module_addr("ModbusRTU", "192.168.1.219:17123");

        assert!(!manager.set_manager_addr("192.168.1.219:17000".to_string()));
        assert_eq!(
            manager.get_module_addr("ModbusRTU").as_deref(),
            Some("192.168.1.219:17123")
        );
    }

    #[test]
    fn changed_manager_address_is_reported_and_runtime_cache_can_be_cleared() {
        let manager = ConnectionManager::new("127.0.0.1:17000".to_string());
        manager.update_module_addr("IEC104", "127.0.0.1:17543");

        assert!(manager.set_manager_addr("192.168.1.219:17000".to_string()));
        manager.clear_runtime_cache();

        assert_eq!(manager.manager_addr(), "192.168.1.219:17000");
        assert!(manager.get_module_addr("IEC104").is_none());
    }

    #[test]
    fn stale_runtime_generation_cannot_overwrite_module_addresses() {
        let manager = ConnectionManager::new("192.168.1.219:17000".to_string());
        let stale_generation = manager.runtime_generation();
        manager.clear_runtime_cache();

        let stale_addrs =
            HashMap::from([("ModbusRTU".to_string(), "192.168.1.219:17001".to_string())]);
        assert!(!manager.update_module_addrs_if_generation(stale_generation, stale_addrs));
        assert!(manager.get_module_addr("ModbusRTU").is_none());

        let current_addrs =
            HashMap::from([("ModbusRTU".to_string(), "192.168.1.219:17123".to_string())]);
        assert!(
            manager.update_module_addrs_if_generation(manager.runtime_generation(), current_addrs)
        );
        assert_eq!(
            manager.get_module_addr("ModbusRTU").as_deref(),
            Some("192.168.1.219:17123")
        );
    }
}
