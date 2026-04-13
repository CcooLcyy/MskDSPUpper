use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::data_center_proto::{
    data_center_service_client::DataCenterServiceClient, ConnTags, DeleteRoutesRequest, Empty,
    GetConnTagsRequest, GetLatestRequest, GetLatestResponse, ListConnectionsResponse,
    ListRoutesRequest, ListRoutesResponse, Route, UpsertRoutesRequest,
};

/// 封装 DataCenter gRPC 调用
pub struct DataCenterClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> DataCenterClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    /// 列出所有连接
    pub async fn list_connections(&self) -> Result<ListConnectionsResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.list_connections(Empty {}).await?;
        Ok(resp.into_inner())
    }

    /// 获取某连接的标签注册表
    pub async fn get_conn_tags(&self, conn_id: u32) -> Result<ConnTags> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.get_conn_tags(GetConnTagsRequest { conn_id }).await?;
        Ok(resp.into_inner())
    }

    /// 列出路由
    pub async fn list_routes(&self, request: ListRoutesRequest) -> Result<ListRoutesResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.list_routes(request).await?;
        Ok(resp.into_inner())
    }

    /// 配置路由
    pub async fn upsert_routes(&self, routes: Vec<Route>, replace: bool) -> Result<()> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        client
            .upsert_routes(UpsertRoutesRequest { routes, replace })
            .await?;
        Ok(())
    }

    /// 删除路由
    pub async fn delete_routes(&self, routes: Vec<Route>) -> Result<()> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        client.delete_routes(DeleteRoutesRequest { routes }).await?;
        Ok(())
    }

    /// 获取最新值快照
    pub async fn get_latest(&self, request: GetLatestRequest) -> Result<GetLatestResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.get_latest(request).await?;
        Ok(resp.into_inner())
    }
}
