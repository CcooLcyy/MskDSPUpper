use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::agc_proto::{
    agc_service_client::AgcServiceClient, ConfirmControlProfileRequest, DeleteGroupRequest, Empty,
    GetControlProfileRequest, GetGroupRequest, GetTuningStatusRequest, GroupConfig,
    GroupControlProfile, GroupInfo, ListGroupsResponse, StartGroupRequest, StartTuningRequest,
    StopGroupRequest, StopTuningRequest, TuningStatus, TuningConfig, UpsertGroupRequest,
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
        client
            .delete_group(DeleteGroupRequest { group_name })
            .await?;
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

    pub async fn start_tuning(&self, group_name: String, config: TuningConfig) -> Result<TuningStatus> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        Ok(client
            .start_tuning(StartTuningRequest { group_name, config: Some(config) })
            .await?
            .into_inner())
    }

    pub async fn stop_tuning(&self, group_name: String) -> Result<TuningStatus> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        Ok(client.stop_tuning(StopTuningRequest { group_name }).await?.into_inner())
    }

    pub async fn get_tuning_status(&self, group_name: String) -> Result<TuningStatus> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        Ok(client
            .get_tuning_status(GetTuningStatusRequest { group_name })
            .await?
            .into_inner())
    }

    pub async fn get_control_profile(&self, group_name: String) -> Result<GroupControlProfile> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        Ok(client
            .get_control_profile(GetControlProfileRequest { group_name })
            .await?
            .into_inner())
    }

    pub async fn confirm_control_profile(&self, profile: GroupControlProfile) -> Result<GroupControlProfile> {
        let channel = self.conn.module_channel("AGC").await?;
        let mut client = AgcServiceClient::new(channel);
        Ok(client
            .confirm_control_profile(ConfirmControlProfileRequest { profile: Some(profile) })
            .await?
            .into_inner())
    }
}
