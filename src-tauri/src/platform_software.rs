//! 平台公开软件目录与有界、可续传的数据流；不使用 HTTP 下载或静态清单。
use sha2::{Digest, Sha256};
use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

pub mod protocol {
    tonic::include_proto!("mskdsp.platform.software.v1");
}
use protocol::software_catalog_service_client::SoftwareCatalogServiceClient;
pub use protocol::{Package, PackageMetadata};

pub const DEFAULT_ENDPOINT: &str = "http://192.168.10.198:50000";
pub const ENDPOINT_SETTING: &str = "softwarePlatformGrpcEndpoint";
const MAX_CHUNK: usize = 256 * 1024;
const MAX_SIZE: u64 = 8 * 1024 * 1024 * 1024;

pub fn configured_catalog(state: &crate::state::AppState) -> Result<PlatformCatalog, String> {
    let saved = state.settings_store.load()?;
    let endpoint = saved
        .get(ENDPOINT_SETTING)
        .and_then(serde_json::Value::as_str)
        .unwrap_or(DEFAULT_ENDPOINT);
    PlatformCatalog::new(endpoint)
}

pub fn configured_endpoint(state: &crate::state::AppState) -> Result<String, String> {
    Ok(configured_catalog(state)?.endpoint)
}

pub fn validate_endpoint(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "平台 gRPC 地址格式不合法".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host_str().is_none()
        || !matches!(url.scheme(), "http" | "https")
    {
        return Err("平台 gRPC 地址只能包含 HTTP(S) 协议、主机和端口".into());
    }
    if url.scheme() == "http" {
        let host = url
            .host_str()
            .unwrap()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let private = match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
            Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
            Err(_) => false,
        };
        if !private {
            return Err("明文平台 gRPC 地址只允许回环或私有 IP".into());
        }
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub fn metadata(package: &Package) -> Result<&PackageMetadata, String> {
    let m = package.metadata.as_ref().ok_or("平台包缺少文件身份")?;
    if package.id.is_empty()
        || !package.ever_published
        || !matches!(m.product.as_str(), "mskdsp-upper" | "mskdsp-lower")
        || m.version.is_empty()
        || m.size == 0
        || m.size > MAX_SIZE
        || m.sha256.len() != 64
        || !m.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || !safe_filename(&m.file_name)
        || (m.product == "mskdsp-upper"
            && (m.signature.trim().is_empty() || m.size > 512 * 1024 * 1024))
    {
        return Err("平台软件包身份、大小、摘要或签名不合法".into());
    }
    Ok(m)
}

fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && !matches!(value, "." | "..")
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
}

pub fn matches_selection(
    package: &Package,
    product: &str,
    platform: &str,
    channel: &str,
) -> Result<(), String> {
    let m = metadata(package)?;
    if m.product != product
        || m.platform != platform
        || !package.channels.iter().any(|c| c == channel)
    {
        return Err("平台软件包与所选产品、架构或通道不一致".into());
    }
    Ok(())
}

pub fn same_identity(left: &Package, right: &Package) -> bool {
    left.id == right.id && left.metadata == right.metadata
}

#[derive(Clone)]
pub struct PlatformCatalog {
    endpoint: String,
}

impl PlatformCatalog {
    pub fn new(endpoint: &str) -> Result<Self, String> {
        Ok(Self {
            endpoint: validate_endpoint(endpoint)?,
        })
    }

    async fn client(&self) -> Result<SoftwareCatalogServiceClient<Channel>, String> {
        let mut endpoint = Endpoint::from_shared(self.endpoint.clone())
            .map_err(|_| "平台 gRPC 地址不合法".to_string())?
            .connect_timeout(Duration::from_secs(8));
        if self.endpoint.starts_with("https://") {
            endpoint = endpoint
                .tls_config(ClientTlsConfig::new().with_native_roots())
                .map_err(|_| "配置平台 TLS 校验失败".to_string())?;
        }
        let channel = endpoint
            .connect()
            .await
            .map_err(|_| "连接平台软件仓库失败，请检查地址与 TLS".to_string())?;
        Ok(SoftwareCatalogServiceClient::new(channel))
    }

    pub async fn latest(
        &self,
        product: &str,
        platform: &str,
        channel: &str,
    ) -> Result<Option<Package>, String> {
        let mut client = self.client().await?;
        let mut request = tonic::Request::new(protocol::ListPackagesRequest {
            product: product.into(),
            platform: platform.into(),
            channel: channel.into(),
        });
        request.set_timeout(Duration::from_secs(15));
        let mut packages = client
            .list_packages(request)
            .await
            .map_err(|s| format!("查询平台软件目录失败：{:?}", s.code()))?
            .into_inner()
            .packages;
        for package in &packages {
            matches_selection(package, product, platform, channel)?;
        }
        packages.sort_by(|a, b| {
            a.published_at
                .cmp(&b.published_at)
                .then(a.created_at.cmp(&b.created_at))
                .then(a.id.cmp(&b.id))
        });
        Ok(packages.pop())
    }

    pub async fn get_expected(
        &self,
        id: &str,
        product: &str,
        platform: &str,
        channel: &str,
    ) -> Result<Package, String> {
        let mut client = self.client().await?;
        let mut request = tonic::Request::new(protocol::GetPackageRequest {
            package_id: id.into(),
        });
        request.set_timeout(Duration::from_secs(15));
        let package = client
            .get_package(request)
            .await
            .map_err(|s| format!("核对平台软件包失败：{:?}", s.code()))?
            .into_inner()
            .package
            .ok_or("平台未返回软件包")?;
        if package.id != id {
            return Err("平台返回了其他软件包身份".into());
        }
        matches_selection(&package, product, platform, channel)?;
        Ok(package)
    }

    pub async fn download(
        &self,
        package: &Package,
        partial: &Path,
        progress: impl FnMut(u64, u64) + Send,
    ) -> Result<PathBuf, String> {
        tokio::time::timeout(
            Duration::from_secs(30 * 60),
            self.download_inner(package, partial, progress),
        )
        .await
        .map_err(|_| "软件包下载超过总时限".to_string())?
    }

    async fn download_inner(
        &self,
        package: &Package,
        partial: &Path,
        mut progress: impl FnMut(u64, u64) + Send,
    ) -> Result<PathBuf, String> {
        let m = metadata(package)?;
        if let Some(parent) = partial.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建软件包缓存目录失败：{e}"))?;
        }
        if let Ok(info) = fs::symlink_metadata(partial).await {
            if !info.is_file() || info.file_type().is_symlink() {
                return Err("软件包临时路径不是普通文件".into());
            }
            if info.len() > m.size {
                return Err("软件包续传偏移超过完整大小".into());
            }
        }
        let started = tokio::time::Instant::now();
        for attempt in 0..3 {
            if started.elapsed() > Duration::from_secs(30 * 60) {
                return Err("软件包下载超过总时限".into());
            }
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(partial)
                .await
                .map_err(|e| format!("打开软件包续传文件失败：{e}"))?;
            let mut offset = file
                .metadata()
                .await
                .map_err(|e| format!("读取续传偏移失败：{e}"))?
                .len();
            progress(offset, m.size);
            let mut client = self.client().await?;
            tracing::info!(package_id = %package.id, offset, attempt, "开始平台软件包流式下载");
            let response = client
                .download_package(protocol::DownloadPackageRequest {
                    package_id: package.id.clone(),
                    offset,
                })
                .await;
            let mut stream = match response {
                Ok(response) => response.into_inner(),
                Err(status) if retryable(status.code()) && attempt < 2 => {
                    continue;
                }
                Err(status) => return Err(format!("请求软件包数据流失败：{:?}", status.code())),
            };
            let mut eof = false;
            let mut retry = false;
            loop {
                let next = tokio::time::timeout(Duration::from_secs(60), stream.message()).await;
                let chunk = match next {
                    Ok(Ok(Some(chunk))) => chunk,
                    Ok(Ok(None)) => break,
                    Ok(Err(status)) if retryable(status.code()) && attempt < 2 => {
                        retry = true;
                        break;
                    }
                    Err(_) if attempt < 2 => {
                        retry = true;
                        break;
                    }
                    Ok(Err(status)) => {
                        return Err(format!("读取软件包数据流失败：{:?}", status.code()))
                    }
                    Err(_) => return Err("软件包数据流空闲超时".into()),
                };
                if eof
                    || chunk.offset != offset
                    || chunk.total_size != m.size
                    || !chunk.sha256.eq_ignore_ascii_case(&m.sha256)
                    || chunk.data.len() > MAX_CHUNK
                    || (chunk.data.is_empty() && !chunk.eof)
                    || offset.saturating_add(chunk.data.len() as u64) > m.size
                    || (chunk.eof && offset + chunk.data.len() as u64 != m.size)
                {
                    return Err("软件包数据流偏移、大小、摘要或 EOF 不合法".into());
                }
                file.write_all(&chunk.data)
                    .await
                    .map_err(|e| format!("写入软件包数据失败：{e}"))?;
                offset += chunk.data.len() as u64;
                eof = chunk.eof;
                progress(offset, m.size);
                if started.elapsed() > Duration::from_secs(30 * 60) {
                    return Err("软件包下载超过总时限".into());
                }
            }
            file.flush()
                .await
                .map_err(|e| format!("刷新软件包续传数据失败：{e}"))?;
            drop(file);
            if retry {
                continue;
            }
            if !eof || offset != m.size {
                return Err("软件包数据流缺少完整 EOF".into());
            }
            if !file_matches(partial, m.size, &m.sha256).await? {
                let _ = fs::remove_file(partial).await;
                return Err("软件包完整大小或 SHA256 校验失败".into());
            }
            tracing::info!(package_id = %package.id, bytes = offset, "平台软件包下载与完整性校验完成");
            return Ok(partial.to_path_buf());
        }
        Err("软件包流式下载重试次数已耗尽".into())
    }
}

fn retryable(code: tonic::Code) -> bool {
    matches!(
        code,
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
    )
}

pub async fn file_matches(path: &Path, size: u64, hash: &str) -> Result<bool, String> {
    let info = match fs::symlink_metadata(path).await {
        Ok(info) => info,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("读取软件包文件信息失败：{e}")),
    };
    if !info.is_file() || info.file_type().is_symlink() || info.len() != size {
        return Ok(false);
    }
    let mut file = fs::File::open(path)
        .await
        .map_err(|e| format!("读取软件包校验内容失败：{e}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取软件包摘要失败：{e}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()).eq_ignore_ascii_case(hash))
}

#[cfg(test)]
#[path = "platform_software_tests.rs"]
mod tests;
