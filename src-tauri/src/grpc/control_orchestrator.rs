use anyhow::Result;

use crate::grpc::connection::ConnectionManager;
use crate::proto::control_orchestrator_proto::{
    control_orchestrator_service_client::ControlOrchestratorServiceClient, DeleteSequenceRequest,
    ExecuteSequenceRequest, ExecuteSequenceResponse, GetSequenceRequest, ListSequencesRequest,
    ListSequencesResponse, UpsertSequenceRequest, WorkflowConfig,
};
use crate::proto::data_center_proto::{Endpoint, PointValue};

pub struct ControlOrchestratorClient<'a> {
    conn: &'a ConnectionManager,
}

impl<'a> ControlOrchestratorClient<'a> {
    pub fn new(conn: &'a ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn upsert_sequence(&self, config: WorkflowConfig, create_only: bool) -> Result<WorkflowConfig> {
        let channel = self.conn.module_channel("ControlOrchestrator").await?;
        let mut client = ControlOrchestratorServiceClient::new(channel);
        Ok(client
            .upsert_sequence(UpsertSequenceRequest { config: Some(config), create_only })
            .await?
            .into_inner())
    }

    pub async fn get_sequence(&self, sequence_name: String) -> Result<WorkflowConfig> {
        let channel = self.conn.module_channel("ControlOrchestrator").await?;
        let mut client = ControlOrchestratorServiceClient::new(channel);
        Ok(client
            .get_sequence(GetSequenceRequest { sequence_name })
            .await?
            .into_inner())
    }

    pub async fn list_sequences(&self) -> Result<ListSequencesResponse> {
        let channel = self.conn.module_channel("ControlOrchestrator").await?;
        let mut client = ControlOrchestratorServiceClient::new(channel);
        Ok(client.list_sequences(ListSequencesRequest {}).await?.into_inner())
    }

    pub async fn delete_sequence(&self, sequence_name: String) -> Result<()> {
        let channel = self.conn.module_channel("ControlOrchestrator").await?;
        let mut client = ControlOrchestratorServiceClient::new(channel);
        client.delete_sequence(DeleteSequenceRequest { sequence_name }).await?;
        Ok(())
    }

    pub async fn execute_sequence(
        &self,
        sequence_name: String,
        trigger: Option<Endpoint>,
        trigger_value: Option<PointValue>,
        request_id: String,
        timeout_ms: u32,
    ) -> Result<ExecuteSequenceResponse> {
        let channel = self.conn.module_channel("ControlOrchestrator").await?;
        let mut client = ControlOrchestratorServiceClient::new(channel);
        Ok(client
            .execute_sequence(ExecuteSequenceRequest {
                sequence_name,
                trigger,
                trigger_value,
                request_id,
                timeout_ms,
            })
            .await?
            .into_inner())
    }
}
