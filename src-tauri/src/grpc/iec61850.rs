use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::iec61850_proto::{
    iec61850_service_client::Iec61850ServiceClient, ApplyTargetConfigRequest,
    ApplyTargetConfigResponse, DeleteIedRequest, DeleteModelRequest, Empty, GetIedRequest,
    GetModelSummaryRequest, GetPointMappingsRequest, GetRuntimeStatisticsRequest, IedConfig,
    IedInfo, ImportSclRequest, ImportSclResponse, ListIedsResponse, ListModelsResponse,
    PointMapping, PointMappings, RuntimeStatistics, SclModelSummary, StartIedRequest,
    StopIedRequest, UpsertIedRequest, UpsertPointMappingsRequest,
};

pub struct Iec61850Client<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> Iec61850Client<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    async fn client(&self) -> Result<Iec61850ServiceClient<tonic::transport::Channel>> {
        Ok(Iec61850ServiceClient::new(
            self.conn.module_channel("IEC61850").await?,
        ))
    }

    pub async fn import_scl(&self, request: ImportSclRequest) -> Result<ImportSclResponse> {
        Ok(self.client().await?.import_scl(request).await?.into_inner())
    }
    pub async fn get_model_summary(&self, model_name: String) -> Result<SclModelSummary> {
        Ok(self
            .client()
            .await?
            .get_model_summary(GetModelSummaryRequest { model_name })
            .await?
            .into_inner())
    }
    pub async fn list_models(&self) -> Result<ListModelsResponse> {
        Ok(self
            .client()
            .await?
            .list_models(Empty {})
            .await?
            .into_inner())
    }
    pub async fn delete_model(&self, model_name: String) -> Result<()> {
        self.client()
            .await?
            .delete_model(DeleteModelRequest { model_name })
            .await?;
        Ok(())
    }
    pub async fn apply_target_config(
        &self,
        request: ApplyTargetConfigRequest,
    ) -> Result<ApplyTargetConfigResponse> {
        Ok(self
            .client()
            .await?
            .apply_target_config(request)
            .await?
            .into_inner())
    }

    pub async fn upsert_ied(&self, config: IedConfig, create_only: bool) -> Result<IedInfo> {
        Ok(self
            .client()
            .await?
            .upsert_ied(UpsertIedRequest {
                config: Some(config),
                create_only,
            })
            .await?
            .into_inner())
    }
    pub async fn get_ied(&self, conn_name: String) -> Result<IedInfo> {
        Ok(self
            .client()
            .await?
            .get_ied(GetIedRequest { conn_name })
            .await?
            .into_inner())
    }
    pub async fn list_ieds(&self) -> Result<ListIedsResponse> {
        Ok(self.client().await?.list_ieds(Empty {}).await?.into_inner())
    }
    pub async fn delete_ied(&self, conn_name: String) -> Result<()> {
        self.client()
            .await?
            .delete_ied(DeleteIedRequest { conn_name })
            .await?;
        Ok(())
    }
    pub async fn start_ied(&self, conn_name: String) -> Result<()> {
        self.client()
            .await?
            .start_ied(StartIedRequest { conn_name })
            .await?;
        Ok(())
    }
    pub async fn stop_ied(&self, conn_name: String) -> Result<()> {
        self.client()
            .await?
            .stop_ied(StopIedRequest { conn_name })
            .await?;
        Ok(())
    }
    pub async fn upsert_point_mappings(
        &self,
        conn_name: String,
        points: Vec<PointMapping>,
        replace: bool,
    ) -> Result<()> {
        self.client()
            .await?
            .upsert_point_mappings(UpsertPointMappingsRequest {
                conn_name,
                points,
                replace,
            })
            .await?;
        Ok(())
    }
    pub async fn get_point_mappings(&self, conn_name: String) -> Result<PointMappings> {
        Ok(self
            .client()
            .await?
            .get_point_mappings(GetPointMappingsRequest { conn_name })
            .await?
            .into_inner())
    }
    pub async fn get_runtime_statistics(&self, conn_name: String) -> Result<RuntimeStatistics> {
        Ok(self
            .client()
            .await?
            .get_runtime_statistics(GetRuntimeStatisticsRequest { conn_name })
            .await?
            .into_inner())
    }
}
