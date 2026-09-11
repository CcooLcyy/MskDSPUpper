use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::modbus_rtu_proto::Point;
use crate::proto::modbus_tcp_proto::{
    modbus_tcp_service_client::ModbusTcpServiceClient, DeleteLinkRequest, Empty, GetLinkRequest,
    GetPointTableRequest, LinkConfig, LinkInfo, PointTable, RenameLinkRequest, StartLinkRequest,
    StopLinkRequest, UpsertLinkRequest, UpsertPointTableRequest,
};

pub struct ModbusTcpClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> ModbusTcpClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn upsert_link(&self, config: LinkConfig, create_only: bool) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        let response = client
            .upsert_link(UpsertLinkRequest {
                config: Some(config),
                create_only,
            })
            .await?;
        Ok(response.into_inner())
    }

    pub async fn rename_link(
        &self,
        old_conn_name: String,
        new_conn_name: String,
    ) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        let response = client
            .rename_link(RenameLinkRequest {
                old_conn_name,
                new_conn_name,
            })
            .await?;
        Ok(response.into_inner())
    }

    pub async fn get_link(&self, conn_name: String) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        let response = client.get_link(GetLinkRequest { conn_name }).await?;
        Ok(response.into_inner())
    }

    pub async fn list_links(&self) -> Result<Vec<LinkInfo>> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        let response = client.list_links(Empty {}).await?;
        Ok(response.into_inner().links)
    }

    pub async fn delete_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        client.delete_link(DeleteLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn start_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        client.start_link(StartLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn stop_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        client.stop_link(StopLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn upsert_point_table(
        &self,
        conn_name: String,
        points: Vec<Point>,
        replace: bool,
    ) -> Result<()> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        client
            .upsert_point_table(UpsertPointTableRequest {
                conn_name,
                points,
                replace,
            })
            .await?;
        Ok(())
    }

    pub async fn get_point_table(&self, conn_name: String) -> Result<PointTable> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        let response = client
            .get_point_table(GetPointTableRequest { conn_name })
            .await?;
        Ok(response.into_inner())
    }
}
