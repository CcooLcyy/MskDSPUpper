use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::iec104_proto::{
    DeleteLinkRequest, Empty, GetLinkRequest, GetPointTableRequest, LinkConfig, LinkInfo,
    Point, PointTable, SendTimeSyncRequest, StartLinkRequest, StopLinkRequest,
    UpsertLinkRequest, UpsertPointTableRequest, iec104_service_client::Iec104ServiceClient,
};

pub struct Iec104Client<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> Iec104Client<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn upsert_link(&self, config: LinkConfig, create_only: bool) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        let resp = client
            .upsert_link(UpsertLinkRequest {
                config: Some(config),
                create_only,
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn get_link(&self, conn_name: String) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        let resp = client.get_link(GetLinkRequest { conn_name }).await?;
        Ok(resp.into_inner())
    }

    pub async fn list_links(&self) -> Result<Vec<LinkInfo>> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        let resp = client.list_links(Empty {}).await?;
        Ok(resp.into_inner().links)
    }

    pub async fn delete_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        client.delete_link(DeleteLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn start_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        client.start_link(StartLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn stop_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        client.stop_link(StopLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn upsert_point_table(
        &self,
        conn_name: String,
        points: Vec<Point>,
        replace: bool,
    ) -> Result<()> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
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
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        let resp = client
            .get_point_table(GetPointTableRequest { conn_name })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn send_time_sync(&self, conn_name: String, ts_ms: i64) -> Result<()> {
        let channel = self.conn.module_channel("IEC104").await?;
        let mut client = Iec104ServiceClient::new(channel);
        client
            .send_time_sync(SendTimeSyncRequest { conn_name, ts_ms })
            .await?;
        Ok(())
    }
}
