use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::modbus_rtu_proto::{
    modbus_rtu_service_client::ModbusRtuServiceClient, DeleteLinkRequest, Empty, GetConfigResponse,
    GetLinkRequest, GetPointTableRequest, LinkConfig, LinkInfo, MqttConfig, Point, PointTable,
    RenameLinkRequest, StartLinkRequest, StopLinkRequest, UpdateConfigRequest,
    UpdateConfigResponse, UpsertLinkRequest, UpsertPointTableRequest,
};

pub struct ModbusRtuClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> ModbusRtuClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn update_config(&self, mqtt: MqttConfig) -> Result<UpdateConfigResponse> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let resp = client
            .update_config(UpdateConfigRequest { mqtt: Some(mqtt) })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn get_config(&self) -> Result<GetConfigResponse> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let resp = client.get_config(Empty {}).await?;
        Ok(resp.into_inner())
    }

    pub async fn upsert_link(&self, config: LinkConfig, create_only: bool) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let resp = client
            .upsert_link(UpsertLinkRequest {
                config: Some(config),
                create_only,
                expected_config: None,
                expected_point_table_revision: None,
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn upsert_link_checked(
        &self,
        config: LinkConfig,
        expected_config: LinkConfig,
        expected_point_table_revision: Option<u64>,
    ) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let response = client
            .upsert_link(UpsertLinkRequest {
                config: Some(config),
                create_only: false,
                expected_config: Some(expected_config),
                expected_point_table_revision,
            })
            .await
            .map_err(point_table_error)?;
        Ok(response.into_inner())
    }

    pub async fn rename_link(
        &self,
        old_conn_name: String,
        new_conn_name: String,
    ) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let resp = client
            .rename_link(RenameLinkRequest {
                old_conn_name,
                new_conn_name,
            })
            .await?;
        Ok(resp.into_inner())
    }

    pub async fn get_link(&self, conn_name: String) -> Result<LinkInfo> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let resp = client.get_link(GetLinkRequest { conn_name }).await?;
        Ok(resp.into_inner())
    }

    pub async fn list_links(&self) -> Result<Vec<LinkInfo>> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        let resp = client.list_links(Empty {}).await?;
        Ok(resp.into_inner().links)
    }

    pub async fn delete_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        client.delete_link(DeleteLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn start_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
        client.start_link(StartLinkRequest { conn_name }).await?;
        Ok(())
    }

    pub async fn stop_link(&self, conn_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel);
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
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client = ModbusRtuServiceClient::new(channel)
            .max_decoding_message_size(64 * 1024 * 1024)
            .max_encoding_message_size(64 * 1024 * 1024);
        if template_bindings_json.is_some() {
            let actual = client
                .get_point_table(GetPointTableRequest {
                    conn_name: conn_name.clone(),
                })
                .await?
                .into_inner();
            check_template_table_revision(actual.revision, expected_revision)?;
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
            .map_err(point_table_error)?;
        Ok(())
    }

    pub async fn get_point_table(&self, conn_name: String) -> Result<PointTable> {
        let channel = self.conn.module_channel("ModbusRTU").await?;
        let mut client =
            ModbusRtuServiceClient::new(channel).max_decoding_message_size(64 * 1024 * 1024);
        let resp = client
            .get_point_table(GetPointTableRequest { conn_name })
            .await?;
        Ok(resp.into_inner())
    }
}

pub(crate) fn point_table_error(error: tonic::Status) -> anyhow::Error {
    match error.code() {
        tonic::Code::Aborted => {
            anyhow::Error::new(error).context("下位机连接配置或点表已变化，请重新读取并核对更新")
        }
        tonic::Code::ResourceExhausted => {
            anyhow::Error::new(error).context("点表和来源记录超过下位机消息大小限制")
        }
        _ => anyhow::anyhow!(error),
    }
}

pub(crate) fn check_template_table_revision(actual: u64, expected: Option<u64>) -> Result<()> {
    if actual == 0 {
        anyhow::bail!("当前下位机不支持模板来源记录和并发保护，请先升级下位机");
    }
    if expected != Some(actual) {
        anyhow::bail!("下位机点表已变化，请重新读取并核对更新");
    }
    Ok(())
}

#[cfg(test)]
mod template_revision_tests {
    use super::*;

    // 传输层不能向会忽略新增字段的旧下位机发送模板写入，也不能跳过预期版本。
    #[test]
    fn rejects_legacy_or_stale_template_writes() {
        assert!(check_template_table_revision(0, Some(1))
            .unwrap_err()
            .to_string()
            .contains("升级"));
        assert!(check_template_table_revision(4, Some(3)).is_err());
        assert!(check_template_table_revision(4, None).is_err());
        check_template_table_revision(u64::MAX, Some(u64::MAX)).unwrap();
    }
}
