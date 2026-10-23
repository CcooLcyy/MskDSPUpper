use super::*;
use protocol::template_catalog_server::{TemplateCatalog, TemplateCatalogServer};
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Response, Status};

fn template_json() -> String {
    serde_json::json!({
        "schema_version":1,"id":"test-source","name":"测试点表","manufacturer":"测试厂家",
        "models":["测试型号"],"protocol_version":"V1","address_base":0,"notes":[],"sources":[],
        "points":[{"id":"power","tag":"有功功率","group":"测量","unit":"kW","function_code":3,
            "address":32080,"data_type":"INT32","reg_count":2,"scale":"0.001","offset":"0","deadband":"0",
            "word_order":"HL","byte_order":"AB","bit_index":null,"source_page":1,"description":""}]
    }).to_string()
}

#[derive(Clone)]
struct Catalog {
    record: protocol::TemplateRecord,
    requested: Arc<Mutex<Vec<protocol::GetTemplateRequest>>>,
    wait: Option<Arc<tokio::sync::Notify>>,
    entered: Arc<tokio::sync::Notify>,
}

#[tonic::async_trait]
impl TemplateCatalog for Catalog {
    async fn list_templates(
        &self,
        request: Request<protocol::ListTemplatesRequest>,
    ) -> Result<Response<protocol::ListTemplatesResponse>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer test-session"
        );
        Ok(Response::new(protocol::ListTemplatesResponse {
            templates: vec![protocol::TemplateSummary {
                id: self.record.id.clone(),
                revision: self.record.revision.clone(),
                name: "测试点表".into(),
                manufacturer: "测试厂家".into(),
                models: vec!["测试型号".into()],
                protocol_version: "V1".into(),
                point_count: 1,
                updated_at: 2,
            }],
        }))
    }
    async fn get_template(
        &self,
        request: Request<protocol::GetTemplateRequest>,
    ) -> Result<Response<protocol::TemplateRecord>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer test-session"
        );
        self.requested.lock().unwrap().push(request.into_inner());
        self.entered.notify_one();
        if let Some(wait) = &self.wait {
            wait.notified().await;
        }
        Ok(Response::new(self.record.clone()))
    }
}

async fn server(
    record: protocol::TemplateRecord,
    wait: Option<Arc<tokio::sync::Notify>>,
) -> (
    crate::platform_auth::PlatformAuthManager,
    Catalog,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let catalog = Catalog {
        record,
        requested: Arc::default(),
        wait,
        entered: Arc::default(),
    };
    let service = catalog.clone();
    let task = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(TemplateCatalogServer::new(service))
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    (
        crate::platform_auth::PlatformAuthManager::test_session(endpoint),
        catalog,
        task,
    )
}

fn record() -> protocol::TemplateRecord {
    protocol::TemplateRecord {
        id: "platform-record".into(),
        revision: "9007199254740993".into(),
        template_json: template_json(),
        created_at: 1,
        updated_at: 2,
    }
}

// 大版本号保持十进制字符串，目录与历史详情沿用当前平台 Bearer 会话。
#[tokio::test]
async fn authenticated_catalog_and_exact_history_revision() {
    let (auth, catalog, task) = server(record(), None).await;
    let list = list(&auth).await.unwrap();
    assert_eq!(list[0].revision, "9007199254740993");
    let details = get(
        &auth,
        "platform-record".into(),
        Some("9007199254740993".into()),
    )
    .await
    .unwrap();
    assert_eq!(details.revision, "9007199254740993");
    assert_eq!(
        catalog.requested.lock().unwrap()[0].revision,
        "9007199254740993"
    );
    task.abort();
}

// 身份错配、历史版本错配及非法模板均不能作为平台快照交给前端缓存。
#[tokio::test]
async fn rejects_mismatched_or_invalid_records() {
    for mode in ["identity", "revision", "json"] {
        let mut value = record();
        match mode {
            "identity" => value.id = "other".into(),
            "revision" => value.revision = "2".into(),
            _ => value.template_json = "{}".into(),
        };
        let (auth, _, task) = server(value, None).await;
        assert!(
            get(
                &auth,
                "platform-record".into(),
                Some("9007199254740993".into())
            )
            .await
            .is_err(),
            "{mode}"
        );
        task.abort();
    }
}

// 请求期间退出登录后，迟到响应不能流入下一次登录会话或平台缓存。
#[tokio::test]
async fn discards_inflight_response_after_logout() {
    let release = Arc::new(tokio::sync::Notify::new());
    let (auth, catalog, task) = server(record(), Some(release.clone())).await;
    let request_auth = auth.clone();
    let pending =
        tokio::spawn(async move { get(&request_auth, "platform-record".into(), None).await });
    catalog.entered.notified().await;
    auth.logout().await.unwrap();
    release.notify_one();
    assert!(pending.await.unwrap().unwrap_err().contains("登录"));
    task.abort();
}

// 零版本、溢出和有歧义的非规范十进制版本在发出请求前即被拒绝。
#[test]
fn rejects_invalid_revisions() {
    for revision in ["0", "-1", "01", "1.0", "18446744073709551616"] {
        assert!(validate_revision(revision).is_err(), "{revision}");
    }
    assert_eq!(validate_revision("18446744073709551615").unwrap(), u64::MAX);
}
