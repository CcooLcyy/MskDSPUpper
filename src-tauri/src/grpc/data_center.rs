use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::data_center_proto::{
    data_center_service_client::DataCenterServiceClient, ConnTags, ConnectionInfo, ConnectionKey,
    DeleteRoutesRequest, Empty, GetConnTagsRequest, GetLatestRequest, GetLatestResponse,
    GetOrCreateConnectionRequest, ListConnectionsResponse, ListRoutesRequest, ListRoutesResponse,
    PointUpdate, Route, SubscribeRequest, UpsertConnTagsRequest, UpsertRoutesRequest,
};

pub struct DataCenterClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> DataCenterClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn list_connections(&self) -> Result<ListConnectionsResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.list_connections(Empty {}).await?;
        Ok(resp.into_inner())
    }

    pub async fn get_conn_tags(&self, conn_id: u32) -> Result<ConnTags> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.get_conn_tags(GetConnTagsRequest { conn_id }).await?;
        Ok(resp.into_inner())
    }

    pub async fn get_or_create_connection(
        &self,
        module_name: String,
        conn_name: String,
    ) -> Result<ConnectionInfo> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client
            .get_or_create_connection(GetOrCreateConnectionRequest {
                key: Some(ConnectionKey {
                    module_name,
                    conn_name,
                }),
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn list_routes(&self, request: ListRoutesRequest) -> Result<ListRoutesResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.list_routes(request).await?;
        Ok(resp.into_inner())
    }

    pub async fn upsert_routes(&self, routes: Vec<Route>, replace: bool) -> Result<()> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        client
            .upsert_routes(UpsertRoutesRequest { routes, replace })
            .await?;
        Ok(())
    }

    pub async fn delete_routes(&self, routes: Vec<Route>) -> Result<()> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        client.delete_routes(DeleteRoutesRequest { routes }).await?;
        Ok(())
    }

    pub async fn upsert_conn_tags(
        &self,
        conn_id: u32,
        tags: Vec<String>,
        replace: bool,
    ) -> Result<()> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        client
            .upsert_conn_tags(UpsertConnTagsRequest {
                conn_id,
                tags,
                replace,
            })
            .await?;
        Ok(())
    }

    pub async fn get_latest(&self, request: GetLatestRequest) -> Result<GetLatestResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.get_latest(request).await?;
        Ok(resp.into_inner())
    }

    pub async fn subscribe(
        &self,
        request: SubscribeRequest,
    ) -> Result<tonic::Streaming<PointUpdate>> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.subscribe(request).await?;
        Ok(resp.into_inner())
    }
}
