use anyhow::Result;
use tonic::GrpcMethod;

use crate::grpc::connection::ConnectionManager;
use crate::proto::data_center_proto::{
    data_center_service_client::DataCenterServiceClient, ConnTags, ConnectionInfo, ConnectionKey,
    Empty, GetConnTagsRequest, GetLatestRequest, GetLatestResponse, GetOrCreateConnectionRequest,
    GetSourceLatestRequest, GetSourceLatestResponse, ListConnectionsResponse, ListRoutesRequest,
    PointUpdate, SubscribeRequest,
    UpsertConnTagsRequest,
};

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct StableRouteEndpoint {
    #[prost(uint32, tag = "1")]
    pub conn_id: u32,
    #[prost(string, tag = "2")]
    pub tag: String,
    #[prost(string, tag = "3")]
    pub module_name: String,
    #[prost(string, tag = "4")]
    pub conn_name: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct StableRoute {
    #[prost(message, optional, tag = "1")]
    pub src: Option<StableRouteEndpoint>,
    #[prost(message, optional, tag = "2")]
    pub dst: Option<StableRouteEndpoint>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct StableUpsertRoutesRequest {
    #[prost(message, repeated, tag = "1")]
    routes: Vec<StableRoute>,
    #[prost(bool, tag = "2")]
    replace: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct StableDeleteRoutesRequest {
    #[prost(message, repeated, tag = "1")]
    routes: Vec<StableRoute>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct StableListRoutesResponse {
    #[prost(message, repeated, tag = "1")]
    pub routes: Vec<StableRoute>,
}

const DATA_CENTER_SERVICE: &str = "DataCenterProto.DataCenterService";

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

    async fn route_unary<Req, Resp>(
        &self,
        path: &'static str,
        method: &'static str,
        request: Req,
    ) -> Result<Resp>
    where
        Req: prost::Message + Default + Send + 'static,
        Resp: prost::Message + Default + Send + 'static,
    {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = tonic::client::Grpc::new(channel);
        client
            .ready()
            .await
            .map_err(|e| anyhow::anyhow!("Service was not ready: {e}"))?;

        let codec = tonic::codec::ProstCodec::default();
        let path = tonic::codegen::http::uri::PathAndQuery::from_static(path);
        let mut req = tonic::Request::new(request);
        req.extensions_mut()
            .insert(GrpcMethod::new(DATA_CENTER_SERVICE, method));

        let resp = client.unary(req, path, codec).await?;
        Ok(resp.into_inner())
    }

    pub async fn list_routes(
        &self,
        request: ListRoutesRequest,
    ) -> Result<StableListRoutesResponse> {
        self.route_unary(
            "/DataCenterProto.DataCenterService/ListRoutes",
            "ListRoutes",
            request,
        )
        .await
    }

    pub async fn upsert_routes(&self, routes: Vec<StableRoute>, replace: bool) -> Result<()> {
        self.route_unary::<_, Empty>(
            "/DataCenterProto.DataCenterService/UpsertRoutes",
            "UpsertRoutes",
            StableUpsertRoutesRequest { routes, replace },
        )
        .await?;
        Ok(())
    }

    pub async fn delete_routes(&self, routes: Vec<StableRoute>) -> Result<()> {
        self.route_unary::<_, Empty>(
            "/DataCenterProto.DataCenterService/DeleteRoutes",
            "DeleteRoutes",
            StableDeleteRoutesRequest { routes },
        )
        .await?;
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

    pub async fn get_source_latest(
        &self,
        request: GetSourceLatestRequest,
    ) -> Result<GetSourceLatestResponse> {
        let channel = self.conn.module_channel("DataCenter").await?;
        let mut client = DataCenterServiceClient::new(channel);
        let resp = client.get_source_latest(request).await?;
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

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::{
        StableListRoutesResponse, StableRoute, StableRouteEndpoint, StableUpsertRoutesRequest,
    };

    #[test]
    fn stable_route_wire_format_remains_legacy_endpoint_compatible() {
        let request = StableUpsertRoutesRequest {
            routes: vec![StableRoute {
                src: Some(StableRouteEndpoint {
                    conn_id: 11,
                    tag: "P_CMD_SRC".to_string(),
                    module_name: "IEC104".to_string(),
                    conn_name: "line-1".to_string(),
                }),
                dst: Some(StableRouteEndpoint {
                    conn_id: 22,
                    tag: "P_CMD".to_string(),
                    module_name: "AGC".to_string(),
                    conn_name: "g-1".to_string(),
                }),
            }],
            replace: true,
        };

        let mut bytes = Vec::new();
        request.encode(&mut bytes).unwrap();

        let legacy =
            crate::proto::data_center_proto::UpsertRoutesRequest::decode(bytes.as_slice()).unwrap();
        let legacy_route = legacy.routes.first().unwrap();
        let legacy_src = legacy_route.src.as_ref().unwrap();
        let legacy_dst = legacy_route.dst.as_ref().unwrap();
        assert_eq!(legacy_src.conn_id, 11);
        assert_eq!(legacy_src.tag, "P_CMD_SRC");
        assert_eq!(legacy_dst.conn_id, 22);
        assert_eq!(legacy_dst.tag, "P_CMD");

        let stable = StableUpsertRoutesRequest::decode(bytes.as_slice()).unwrap();
        let stable_route = stable.routes.first().unwrap();
        assert_eq!(stable_route.src.as_ref().unwrap().module_name, "IEC104");
        assert_eq!(stable_route.src.as_ref().unwrap().conn_name, "line-1");
        assert_eq!(stable_route.dst.as_ref().unwrap().module_name, "AGC");
        assert_eq!(stable_route.dst.as_ref().unwrap().conn_name, "g-1");
    }

    #[test]
    fn stable_list_routes_response_decodes_returned_connection_keys() {
        let response = StableListRoutesResponse {
            routes: vec![StableRoute {
                src: Some(StableRouteEndpoint {
                    conn_id: 11,
                    tag: "P_CMD_SRC".to_string(),
                    module_name: "IEC104".to_string(),
                    conn_name: "line-1".to_string(),
                }),
                dst: Some(StableRouteEndpoint {
                    conn_id: 22,
                    tag: "P_CMD".to_string(),
                    module_name: "AGC".to_string(),
                    conn_name: "g-1".to_string(),
                }),
            }],
        };

        let mut bytes = Vec::new();
        response.encode(&mut bytes).unwrap();

        let legacy =
            crate::proto::data_center_proto::ListRoutesResponse::decode(bytes.as_slice()).unwrap();
        assert_eq!(legacy.routes[0].src.as_ref().unwrap().conn_id, 11);
        assert_eq!(legacy.routes[0].dst.as_ref().unwrap().tag, "P_CMD");

        let stable = StableListRoutesResponse::decode(bytes.as_slice()).unwrap();
        assert_eq!(stable.routes[0].src.as_ref().unwrap().module_name, "IEC104");
        assert_eq!(stable.routes[0].src.as_ref().unwrap().conn_name, "line-1");
        assert_eq!(stable.routes[0].dst.as_ref().unwrap().module_name, "AGC");
        assert_eq!(stable.routes[0].dst.as_ref().unwrap().conn_name, "g-1");
    }
}
