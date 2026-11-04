use anyhow::{anyhow, Result};
use std::{collections::HashMap, future::Future, time::Duration};

use crate::grpc::connection::ConnectionManager;
use crate::proto::module_manager_proto::{
    module_manage_client::ModuleManageClient, Empty, ModuleInfo,
};

#[cfg(test)]
#[path = "module_manager_tests.rs"]
mod tests;

/// 现场直连读取的建连和 RPC 共用同一个五秒预算。
const DIRECT_MODULE_LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// 封装 ModuleManager gRPC 调用
pub struct ModuleManagerClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> ModuleManagerClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    async fn read_module_list<T>(
        &self,
        operation: &'static str,
        request: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        // 平台远程沿用通道自身的超时策略；仅限制现场直连的列表读取。
        if self.conn.is_remote() {
            return request.await;
        }
        tokio::time::timeout(DIRECT_MODULE_LIST_TIMEOUT, request)
            .await
            .map_err(|_| {
                tracing::warn!(operation, timeout_seconds = 5, "现场直连读取模块列表超时");
                anyhow!(
                    "现场直连{}超时（5 秒），请检查网络或切换平台远程",
                    operation
                )
            })?
    }

    /// 获取可用模块列表（扫描 ./module 目录）
    pub async fn get_module_info(&self) -> Result<Vec<ModuleInfo>> {
        self.read_module_list("读取可用模块列表", async {
            let channel = self.conn.manager_channel().await?;
            let mut client = ModuleManageClient::new(channel);
            let resp = client.get_module_info(Empty {}).await?;
            Ok(resp.into_inner().module_info)
        })
        .await
    }

    /// 获取运行中模块的信息，同时刷新模块地址缓存
    pub async fn get_running_module_info(
        &self,
    ) -> Result<Vec<crate::proto::module_manager_proto::ModuleRunningInfo>> {
        self.read_module_list("读取运行模块列表", self.get_running_module_info_inner())
            .await
    }

    async fn get_running_module_info_inner(
        &self,
    ) -> Result<Vec<crate::proto::module_manager_proto::ModuleRunningInfo>> {
        let request_generation = self.conn.runtime_generation();
        let channel = self.conn.manager_channel().await?;
        let mut client = ModuleManageClient::new(channel);
        let resp = client.get_running_module_info(Empty {}).await?;
        let infos = resp.into_inner().module_running_info;

        // 刷新模块地址缓存
        // 模块上报的 outer_grpc_server 可能是 "0.0.0.0:port"（监听所有网卡），
        // 上位机无法直连 0.0.0.0，需替换为 ModuleManager 的实际 IP。
        let manager_host = self.conn.manager_host();
        let mut addrs = HashMap::new();
        for info in &infos {
            if !info.outer_grpc_server.is_empty() {
                let resolved = if info.outer_grpc_server.starts_with("0.0.0.0:") {
                    info.outer_grpc_server.replacen("0.0.0.0", &manager_host, 1)
                } else {
                    info.outer_grpc_server.clone()
                };
                addrs.insert(info.module_name.clone(), resolved);
            }
        }
        let mut mappings = addrs
            .iter()
            .map(|(module_name, address)| format!("{module_name}={address}"))
            .collect::<Vec<_>>();
        mappings.sort();
        let module_count = addrs.len();
        if !self
            .conn
            .update_module_addrs_if_generation(request_generation, addrs)
        {
            tracing::warn!(
                request_generation,
                current_generation = self.conn.runtime_generation(),
                "丢弃过期的运行模块地址响应"
            );
            return Err(anyhow!("ModuleManager 连接已切换，运行模块地址响应已过期"));
        }
        tracing::info!(
            generation = request_generation,
            module_count,
            module_addresses = %mappings.join(","),
            "刷新模块 gRPC 地址完成"
        );

        Ok(infos)
    }

    /// 启动模块
    pub async fn start_module(&self, module_info: ModuleInfo) -> Result<()> {
        let channel = self.conn.manager_channel().await?;
        let mut client = ModuleManageClient::new(channel);
        client.start_module(module_info).await?;
        Ok(())
    }

    /// 停止模块
    pub async fn stop_module(&self, module_info: ModuleInfo) -> Result<()> {
        let channel = self.conn.manager_channel().await?;
        let mut client = ModuleManageClient::new(channel);
        client.stop_module(module_info).await?;
        Ok(())
    }
}
