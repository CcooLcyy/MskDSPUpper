use super::*;
use protocol::software_catalog_service_server::{
    SoftwareCatalogService, SoftwareCatalogServiceServer,
};
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::{Request, Response, Status};

#[derive(Clone)]
struct Catalog {
    package: Package,
    bytes: Vec<u8>,
    offsets: Arc<Mutex<Vec<u64>>>,
    mode: &'static str,
}

#[tonic::async_trait]
impl SoftwareCatalogService for Catalog {
    async fn list_packages(
        &self,
        _: Request<protocol::ListPackagesRequest>,
    ) -> Result<Response<protocol::ListPackagesResponse>, Status> {
        Ok(Response::new(protocol::ListPackagesResponse {
            packages: vec![self.package.clone()],
        }))
    }
    async fn get_package(
        &self,
        _: Request<protocol::GetPackageRequest>,
    ) -> Result<Response<protocol::GetPackageResponse>, Status> {
        Ok(Response::new(protocol::GetPackageResponse {
            package: Some(self.package.clone()),
        }))
    }
    type DownloadPackageStream = ReceiverStream<Result<protocol::DownloadPackageChunk, Status>>;
    async fn download_package(
        &self,
        request: Request<protocol::DownloadPackageRequest>,
    ) -> Result<Response<Self::DownloadPackageStream>, Status> {
        let offset = request.into_inner().offset;
        let first = {
            let mut offsets = self.offsets.lock().unwrap();
            offsets.push(offset);
            offsets.len() == 1
        };
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        let metadata = self.package.metadata.as_ref().unwrap();
        let mut chunk = protocol::DownloadPackageChunk {
            offset,
            data: self.bytes[offset as usize..].to_vec(),
            total_size: metadata.size,
            sha256: metadata.sha256.clone(),
            eof: true,
        };
        match self.mode {
            "resume" if first => {
                chunk.data.truncate(3);
                chunk.eof = false;
            }
            "offset" => chunk.offset += 1,
            "size" => chunk.total_size += 1,
            "hash" => chunk.sha256 = "b".repeat(64),
            "corrupt" => chunk.data[0] ^= 1,
            "missing-eof" => chunk.eof = false,
            _ => {}
        }
        sender.send(Ok(chunk)).await.unwrap();
        if self.mode == "resume" && first {
            sender
                .send(Err(Status::unavailable("模拟断线")))
                .await
                .unwrap();
        }
        drop(sender);
        Ok(Response::new(ReceiverStream::new(receiver)))
    }
}

async fn service(mode: &'static str) -> (PlatformCatalog, Catalog, tokio::task::JoinHandle<()>) {
    let bytes = b"signed installer data".to_vec();
    let catalog = Catalog {
        package: Package {
            id: "test-package".into(),
            metadata: Some(protocol::PackageMetadata {
                product: "mskdsp-upper".into(),
                version: "0.7.1-ci.test+sha.abcdef0".into(),
                platform: "windows-x86_64-nsis".into(),
                file_name: "upper.exe".into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                signature: "测试签名".into(),
                ..Default::default()
            }),
            channels: vec!["ci".into()],
            ever_published: true,
            ..Default::default()
        },
        bytes,
        offsets: Arc::default(),
        mode,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = catalog.clone();
    let task = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(SoftwareCatalogServiceServer::new(server))
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    (PlatformCatalog::new(&endpoint).unwrap(), catalog, task)
}

fn temporary_file() -> PathBuf {
    std::env::temp_dir().join(format!(
        "upper-grpc-test-{}-{}.part",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

// 验证真实 tonic 目录与数据流的完整身份和下载摘要。
#[tokio::test]
async fn real_catalog_and_stream_download_match_identity() {
    let (client, catalog, task) = service("normal").await;
    let package = client
        .latest("mskdsp-upper", "windows-x86_64-nsis", "ci")
        .await
        .unwrap()
        .unwrap();
    let fetched = client
        .get_expected(&package.id, "mskdsp-upper", "windows-x86_64-nsis", "ci")
        .await
        .unwrap();
    let path = temporary_file();
    client.download(&fetched, &path, |_, _| {}).await.unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), catalog.bytes);
    tokio::fs::remove_file(path).await.unwrap();
    task.abort();
}

// 验证断线保留落盘偏移，下一次 RPC 从服务端确认的字节位置续传。
#[tokio::test]
async fn interrupted_stream_resumes_from_written_offset() {
    let (client, catalog, task) = service("resume").await;
    let path = temporary_file();
    client
        .download(&catalog.package, &path, |_, _| {})
        .await
        .unwrap();
    assert_eq!(*catalog.offsets.lock().unwrap(), vec![0, 3]);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), catalog.bytes);
    tokio::fs::remove_file(path).await.unwrap();
    task.abort();
}

// 验证连续偏移、恒定大小与摘要、最后 EOF 以及实际文件内容均不可绕过。
#[tokio::test]
async fn malformed_streams_cannot_become_installable() {
    for mode in ["offset", "size", "hash", "corrupt", "missing-eof"] {
        let (client, catalog, task) = service(mode).await;
        let path = temporary_file();
        assert!(
            client
                .download(&catalog.package, &path, |_, _| {})
                .await
                .is_err(),
            "{mode}"
        );
        let _ = tokio::fs::remove_file(path).await;
        task.abort();
    }
}

// 验证错误产品身份和公共明文地址在传输前即被拒绝。
#[tokio::test]
async fn mismatched_catalog_and_public_plaintext_are_rejected() {
    assert!(PlatformCatalog::new("http://8.8.8.8:50000").is_err());
    assert!(PlatformCatalog::new("http://user:secret@127.0.0.1:50000").is_err());
    assert!(PlatformCatalog::new("https://platform.example.com:50000").is_ok());
    assert_eq!(
        validate_endpoint(" HTTPS://PLATFORM.EXAMPLE.COM:50000/ ").unwrap(),
        "https://platform.example.com:50000"
    );
    let (client, _, task) = service("normal").await;
    assert!(client
        .get_expected("test-package", "mskdsp-lower", "linux-x64", "ci")
        .await
        .is_err());
    task.abort();
}
