use anyhow::{anyhow, Result};
use parking_lot::RwLock;
use std::collections::HashMap;
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
}

impl ConnectionManager {
    pub fn new(manager_addr: String) -> Self {
        Self {
            manager_addr: RwLock::new(manager_addr),
            module_addrs: RwLock::new(HashMap::new()),
            channels: RwLock::new(HashMap::new()),
        }
    }

    /// 设置 ModuleManager 地址
    pub fn set_manager_addr(&self, addr: String) {
        *self.manager_addr.write() = addr;
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

    /// 批量更新模块地址
    pub fn update_module_addrs(&self, addrs: HashMap<String, String>) {
        *self.module_addrs.write() = addrs;
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
        let channel = Channel::from_shared(endpoint.clone())
            .map_err(|e| anyhow!("无效的地址 {}: {}", addr, e))?
            .connect()
            .await
            .map_err(|e| anyhow!("连接 {} 失败: {}", addr, e))?;

        self.channels
            .write()
            .insert(addr.to_string(), channel.clone());
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
            .ok_or_else(|| anyhow!("模块 {} 地址未知，请先刷新运行信息", module_name))?;
        self.get_channel(&addr).await
    }

    /// 清除所有缓存的 Channel（用于断线重连场景）
    pub fn clear_channels(&self) {
        self.channels.write().clear();
    }
}
