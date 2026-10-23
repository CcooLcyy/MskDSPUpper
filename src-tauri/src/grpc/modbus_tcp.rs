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
                expected_config: None,
                expected_point_table_revision: None,
            })
            .await?;
        Ok(response.into_inner())
    }

    pub async fn upsert_link_checked(
        &self,
        config: LinkConfig,
        expected_config: LinkConfig,
        expected_point_table_revision: Option<u64>,
    ) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel);
        let response = client
            .upsert_link(UpsertLinkRequest {
                config: Some(config),
                create_only: false,
                expected_config: Some(expected_config),
                expected_point_table_revision,
            })
            .await
            .map_err(crate::grpc::modbus_rtu::point_table_error)?;
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
        expected_revision: Option<u64>,
        template_bindings_json: Option<String>,
    ) -> Result<()> {
        self.upsert_point_table_checked(
            conn_name,
            points,
            replace,
            expected_revision,
            template_bindings_json,
            None,
        )
        .await
    }

    pub async fn upsert_point_table_checked(
        &self,
        conn_name: String,
        points: Vec<Point>,
        replace: bool,
        expected_revision: Option<u64>,
        template_bindings_json: Option<String>,
        expected_link_config: Option<LinkConfig>,
    ) -> Result<()> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client = ModbusTcpServiceClient::new(channel)
            .max_decoding_message_size(64 * 1024 * 1024)
            .max_encoding_message_size(64 * 1024 * 1024);
        if template_bindings_json.is_some() {
            let actual = client
                .get_point_table(GetPointTableRequest {
                    conn_name: conn_name.clone(),
                })
                .await?
                .into_inner();
            crate::grpc::modbus_rtu::check_template_table_revision(
                actual.revision,
                expected_revision,
            )?;
        }
        client
            .upsert_point_table(UpsertPointTableRequest {
                conn_name,
                points,
                replace,
                expected_revision,
                template_bindings_json,
                expected_link_config,
            })
            .await
            .map_err(crate::grpc::modbus_rtu::point_table_error)?;
        Ok(())
    }

    pub async fn get_point_table(&self, conn_name: String) -> Result<PointTable> {
        let channel = self.conn.module_channel("ModbusTCP").await?;
        let mut client =
            ModbusTcpServiceClient::new(channel).max_decoding_message_size(64 * 1024 * 1024);
        let response = client
            .get_point_table(GetPointTableRequest { conn_name })
            .await?;
        Ok(response.into_inner())
    }
}
