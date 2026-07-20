use anyhow::{anyhow, Result};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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
}

impl ConnectionManager {
    pub fn new(manager_addr: String) -> Self {
        Self {
            manager_addr: RwLock::new(manager_addr),
            module_addrs: RwLock::new(HashMap::new()),
            channels: RwLock::new(HashMap::new()),
            runtime_generation: AtomicU64::new(0),
        }
    }

    /// 设置 ModuleManager 地址，返回地址是否发生变化
    pub fn set_manager_addr(&self, addr: String) -> bool {
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

        self.channels
            .write()
            .insert(addr.to_string(), channel.clone());
        tracing::info!(address = %addr, "gRPC 连接建立完成");
        Ok(channel)
    }

    /// 获取 ModuleManager 的 Channel
    pub async fn manager_channel(&self) -> Result<Channel> {
        let addr = self.manager_addr();
        self.get_channel(&addr).await
    }

    /// 获取指定模块的 Channel
    pub async fn module_channel(&self, module_name: &str) -> Result<Channel> {
        let addr = self
            .get_module_addr(module_name)
            .ok_or_else(|| {
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
}

#[cfg(test)]
mod tests {
    use super::ConnectionManager;
    use std::collections::HashMap;

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

        let stale_addrs = HashMap::from([(
            "ModbusRTU".to_string(),
            "192.168.1.219:17001".to_string(),
        )]);
        assert!(!manager.update_module_addrs_if_generation(stale_generation, stale_addrs));
        assert!(manager.get_module_addr("ModbusRTU").is_none());

        let current_addrs = HashMap::from([(
            "ModbusRTU".to_string(),
            "192.168.1.219:17123".to_string(),
        )]);
        assert!(manager.update_module_addrs_if_generation(
            manager.runtime_generation(),
            current_addrs
        ));
        assert_eq!(
            manager.get_module_addr("ModbusRTU").as_deref(),
            Some("192.168.1.219:17123")
        );
    }
}
