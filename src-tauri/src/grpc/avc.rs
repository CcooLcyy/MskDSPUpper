use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::avc_proto::{
    avc_service_client::AvcServiceClient, DeleteGroupRequest, Empty, GetGroupRequest, GroupConfig,
    GroupInfo, ListGroupsResponse, RenameGroupRequest, StartGroupRequest, StopGroupRequest,
    UpsertGroupRequest,
};

pub struct AvcClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> AvcClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn upsert_group(&self, config: GroupConfig, create_only: bool) -> Result<GroupInfo> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        let resp = client
            .upsert_group(UpsertGroupRequest {
                config: Some(config),
                create_only,
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn rename_group(
        &self,
        old_group_name: String,
        new_group_name: String,
    ) -> Result<GroupInfo> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        let resp = client
            .rename_group(RenameGroupRequest {
                old_group_name,
                new_group_name,
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn get_group(&self, group_name: String) -> Result<GroupInfo> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        let resp = client.get_group(GetGroupRequest { group_name }).await?;
        Ok(resp.into_inner())
    }

    pub async fn list_groups(&self) -> Result<ListGroupsResponse> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        let resp = client.list_groups(Empty {}).await?;
        Ok(resp.into_inner())
    }

    pub async fn delete_group(&self, group_name: String) -> Result<()> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        client
            .delete_group(DeleteGroupRequest { group_name })
            .await?;
        Ok(())
    }

    pub async fn start_group(&self, group_name: String) -> Result<()> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        client.start_group(StartGroupRequest { group_name }).await?;
        Ok(())
    }

    pub async fn stop_group(&self, group_name: String) -> Result<()> {
        let channel = self.conn.module_channel("AVC").await?;
        let mut client = AvcServiceClient::new(channel);
        client.stop_group(StopGroupRequest { group_name }).await?;
        Ok(())
    }
}
