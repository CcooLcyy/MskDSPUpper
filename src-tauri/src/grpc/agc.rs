use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::agc_proto::{
    DeleteGroupRequest, Empty, GetGroupRequest, GroupConfig, GroupInfo, ListGroupsResponse,
    StartGroupRequest, StopGroupRequest, UpsertGroupRequest,
    agc_service_client::AgcServiceClient,
};

pub struct AgcClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> AgcClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn upsert_group(&self, config: GroupConfig, create_only: bool) -> Result<GroupInfo> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        let resp = client
            .upsert_group(UpsertGroupRequest {
                config: Some(config),
                create_only,
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn get_group(&self, group_name: String) -> Result<GroupInfo> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        let resp = client.get_group(GetGroupRequest { group_name }).await?;
        Ok(resp.into_inner())
    }

    pub async fn list_groups(&self) -> Result<ListGroupsResponse> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        let resp = client.list_groups(Empty {}).await?;
        Ok(resp.into_inner())
    }

    pub async fn delete_group(&self, group_name: String) -> Result<()> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        client.delete_group(DeleteGroupRequest { group_name }).await?;
        Ok(())
    }

    pub async fn start_group(&self, group_name: String) -> Result<()> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        client.start_group(StartGroupRequest { group_name }).await?;
        Ok(())
    }

    pub async fn stop_group(&self, group_name: String) -> Result<()> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        client.stop_group(StopGroupRequest { group_name }).await?;
        Ok(())
    }
}
