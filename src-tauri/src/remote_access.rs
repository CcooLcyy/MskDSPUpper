//! 有界环回适配器：平台只看到服务名称，不使用设备返回的现场地址。
use crate::platform_auth::PlatformAuthManager;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch, Mutex, Semaphore},
    task::JoinSet,
    time::{interval, timeout},
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{
    transport::{Channel, Endpoint},
    Request,
};

pub mod protocol {
    tonic::include_proto!("mskdsp.platform.remote.v1");
}
use protocol::{remote_access_service_client::RemoteAccessServiceClient, tunnel_frame::Payload, *};

pub const FRAME_LIMIT: usize = 65536;
pub(crate) const UPDATE_TUNNEL_INTERRUPTED: &str = "LOWER_UPDATE_TUNNEL_INTERRUPTED:";

/// 每条更新 SSH 会话独有的终止信号；释放时只取消这条隧道。
pub(crate) struct UpdateTunnelGuard {
    closed: watch::Receiver<Option<String>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for UpdateTunnelGuard {
    fn drop(&mut self) { self.task.abort(); }
}
impl UpdateTunnelGuard {
    pub(crate) async fn run<T>(
        &mut self,
        operation: impl std::future::Future<Output = std::result::Result<T, String>>,
        permanent: impl Fn() -> Option<String>,
    ) -> std::result::Result<T, String> {
        let mut closed = self.closed.clone();
        let ended = async move {
            loop {
                if let Some(reason) = closed.borrow().clone() { return reason; }
                if closed.changed().await.is_err() { return "更新 SSH 隧道观察已结束".into(); }
            }
        };
        tokio::pin!(operation, ended);
        let outcome = tokio::select! {
            biased;
            result = &mut operation => {
                match result {
                    Ok(value) => return Ok(value),
                    Err(error) => {
                        if let Some(reason) = permanent() { return Err(reason); }
                        // SSH 可能先观察到 EOF，稍后桥接任务才发布关闭原因。
                        let current = self.closed.borrow().clone();
                        let reason = match current {
                            Some(reason) => Some(reason),
                            None => timeout(Duration::from_millis(100), &mut ended).await.ok(),
                        };
                        return Err(permanent().or(reason).unwrap_or(error));
                    }
                }
            },
            reason = &mut ended => reason,
        };
        // 给已进入本地 socket 的完整终态或认证拒绝一个短暂排空窗口，不能被断线覆盖。
        match timeout(Duration::from_millis(100), &mut operation).await {
            Ok(Ok(value)) => Ok(value),
            _ => Err(permanent().unwrap_or(outcome)),
        }
    }
}

pub(crate) fn update_tunnel_end(result: Result<()>) -> String {
    match result {
        Ok(()) => format!("{UPDATE_TUNNEL_INTERRUPTED} 平台 SSH 隧道已关闭，等待连接恢复"),
        Err(error) => {
            let status = error.chain().find_map(|cause| cause.downcast_ref::<tonic::Status>());
            let transient = if let Some(status) = status {
                matches!(status.code(), tonic::Code::Cancelled | tonic::Code::Unavailable)
            } else { error.chain().any(|cause| {
                cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                    matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionRefused)
                })
            }) };
            if transient { format!("{UPDATE_TUNNEL_INTERRUPTED} 平台 SSH 隧道暂时中断，等待连接恢复") }
            else { format!("平台 SSH 隧道失败: {error}") }
        }
    }
}
const BLOCK_TIMEOUT: Duration = Duration::from_secs(30);
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn wait_canceled(mut canceled: watch::Receiver<bool>) {
    loop {
        if *canceled.borrow() {
            return;
        }
        if canceled.changed().await.is_err() {
            return;
        }
    }
}

#[derive(Clone, Serialize)]
pub struct RemoteDevice {
    pub device_id: String,
    pub display_name: String,
    pub online: bool,
    pub allow_grpc: bool,
    pub allow_ssh: bool,
    pub services: Vec<String>,
    pub agent_version: String,
}

#[cfg(test)]
#[path = "remote_access_tests.rs"]
mod tests;
impl From<Device> for RemoteDevice {
    fn from(d: Device) -> Self {
        Self {
            device_id: d.device_id,
            display_name: d.display_name,
            online: d.online,
            allow_grpc: d.allow_grpc,
            allow_ssh: d.allow_ssh,
            services: d.services,
            agent_version: d.agent_version,
        }
    }
}

fn validate_remote_endpoint(endpoint: &str) -> Result<()> {
    let endpoint =
        crate::platform_software::validate_endpoint(endpoint).map_err(|error| anyhow!(error))?;
    if !endpoint.starts_with("http://") {
        bail!("远程访问使用现有 HTTP gRPC 入口");
    }
    Ok(())
}

pub(crate) async fn client(endpoint: &str) -> Result<RemoteAccessServiceClient<Channel>> {
    validate_remote_endpoint(endpoint)?;
    let endpoint_builder =
        Endpoint::from_shared(endpoint.to_string())?.connect_timeout(Duration::from_secs(10));
    Ok(RemoteAccessServiceClient::new(
        endpoint_builder.connect().await?,
    ))
}
pub(crate) fn authorized<T>(body: T, token: &str) -> Result<Request<T>> {
    let mut request = Request::new(body);
    request
        .metadata_mut()
        .insert("authorization", format!("Bearer {token}").parse()?);
    Ok(request)
}
pub async fn list_devices(auth: &PlatformAuthManager) -> Result<Vec<RemoteDevice>> {
    let (endpoint, token, generation) = auth.remote_credentials().map_err(|e| anyhow!(e))?;
    let response = timeout(Duration::from_secs(10), async {
        client(&endpoint)
            .await?
            .list_devices(authorized(ListDevicesRequest {}, &token)?)
            .await
            .map_err(anyhow::Error::from)
    })
    .await??;
    if !auth.remote_generation_valid(generation) {
        bail!("平台登录已切换，请重新刷新设备");
    }
    Ok(response
        .into_inner()
        .devices
        .into_iter()
        .map(Into::into)
        .collect())
}

pub struct RemoteConnection {
    pub device: RemoteDevice,
    pub endpoint: String,
    auth: Arc<PlatformAuthManager>,
    generation: u64,
    cancel: watch::Sender<bool>,
    adapters: Mutex<HashMap<String, String>>,
    slots: Arc<Semaphore>,
}
impl Drop for RemoteConnection {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
impl RemoteConnection {
    /// 更新命令专用连接，不经过共享 adapter，避免旧会话关闭影响新查询。
    pub(crate) async fn update_ssh_socket(&self) -> Result<(TcpStream, UpdateTunnelGuard)> {
        if !self.active() { bail!("平台远程连接已失效，请恢复原平台登录后查询原任务"); }
        let (_, token, generation) = self.auth.remote_credentials().map_err(|error| anyhow!(error))?;
        if generation != self.generation { bail!("平台登录已切换"); }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let socket = TcpStream::connect(listener.local_addr()?).await?;
        let (peer, _) = listener.accept().await?;
        let endpoint = self.endpoint.clone();
        let device_id = self.device.device_id.clone();
        let canceled = self.subscribe();
        let (closed_tx, closed) = watch::channel(None);
        let task = tokio::spawn(async move {
            let reason = tokio::select! {
                biased;
                _ = wait_canceled(canceled) => "平台登录或远程连接已失效，请核验原设备身份".into(),
                result = tunnel(peer, &endpoint, &token, &device_id, "ssh") => update_tunnel_end(result),
            };
            tracing::info!(device_id, reason, "更新 SSH 会话隧道结束");
            let _ = closed_tx.send(Some(reason));
        });
        Ok((socket, UpdateTunnelGuard { closed, task }))
    }
    pub fn new(device: RemoteDevice, auth: Arc<PlatformAuthManager>) -> Result<Arc<Self>> {
        let (endpoint, _, generation) = auth.remote_credentials().map_err(|e| anyhow!(e))?;
        validate_remote_endpoint(&endpoint)?;
        let (cancel, mut canceled) = watch::channel(false);
        let monitor_auth = auth.clone();
        let monitor_cancel = cancel.clone();
        tokio::spawn(async move {
            let mut ticks = interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = canceled.changed() => break,
                    _ = ticks.tick() => if !monitor_auth.remote_generation_valid(generation) {
                        let _ = monitor_cancel.send(true); break;
                    }
                }
            }
        });
        Ok(Arc::new(Self {
            device,
            endpoint,
            auth,
            generation,
            cancel,
            adapters: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(16)),
        }))
    }
    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.cancel.subscribe()
    }
    pub fn active(&self) -> bool {
        !*self.cancel.borrow() && self.auth.remote_generation_valid(self.generation)
    }

    pub async fn adapter(&self, service: &str) -> Result<String> {
        if !self.active() {
            bail!("远程连接已失效，请重新选择设备");
        }
        // 服务和权限会随加载/撤销改变，由平台在每次 OpenTunnel 时实时校验。
        if service.is_empty()
            || service.len() > 128
            || !service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            bail!("服务名称无效");
        }
        let mut adapters = self.adapters.lock().await;
        if let Some(addr) = adapters.get(service) {
            return Ok(addr.clone());
        }
        if adapters.len() >= 32 {
            bail!("远程服务适配器数量已达到上限");
        }
        let (_, token, generation) = self.auth.remote_credentials().map_err(|e| anyhow!(e))?;
        if generation != self.generation {
            bail!("平台登录已切换");
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?.to_string();
        let endpoint = self.endpoint.clone();
        let device_id = self.device.device_id.clone();
        let service = service.to_string();
        let adapter_key = service.clone();
        let canceled = self.subscribe();
        let slots = self.slots.clone();
        tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = wait_canceled(canceled.clone()) => break,
                    _ = sessions.join_next(), if !sessions.is_empty() => {},
                    accepted = listener.accept(), if sessions.len() < 16 => {
                        let Ok((socket, _)) = accepted else { break; };
                        let Ok(slot) = slots.clone().try_acquire_owned() else { drop(socket); continue; };
                        let endpoint = endpoint.clone(); let token = token.clone();
                        let device_id = device_id.clone(); let service = service.clone();
                        let cancel_session = canceled.clone();
                        sessions.spawn(async move {
                            let _slot = slot;
                            tokio::select! {
                                _ = wait_canceled(cancel_session) => {},
                                result = tunnel(socket, &endpoint, &token, &device_id, &service) => {
                                    if let Err(error) = result { tracing::warn!(device_id, service, %error, "远程隧道已关闭"); }
                                }
                            }
                        });
                    }
                }
            }
            sessions.abort_all();
        });
        adapters.insert(adapter_key, address.clone());
        Ok(address)
    }
    pub async fn channel(&self, service: &str) -> Result<Channel> {
        let addr = self.adapter(service).await?;
        Ok(Endpoint::from_shared(format!("http://{addr}"))?
            .connect_timeout(OPEN_TIMEOUT)
            .connect()
            .await?)
    }

    /// 仅供纵密探测：等待下位机固定目标TCP真正就绪后才返回内部流。
    pub(crate) async fn vertical_security_socket(&self) -> Result<TcpStream> {
        if !self.active() {
            bail!("平台远程连接已失效");
        }
        let (_, token, generation) = self.auth.remote_credentials().map_err(|e| anyhow!(e))?;
        if generation != self.generation {
            bail!("平台登录已切换");
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let socket = TcpStream::connect(listener.local_addr()?).await?;
        let (peer, _) = listener.accept().await?;
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let endpoint = self.endpoint.clone();
        let device_id = self.device.device_id.clone();
        let canceled = self.subscribe();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = wait_canceled(canceled) => {},
                result = tunnel_with_ready(peer, &endpoint, &token, &device_id, "vertical-security", Some(ready_tx)) => {
                    if let Err(error) = result { tracing::warn!(device_id, %error, "纵密远程探测通道关闭"); }
                }
            }
        });
        struct PendingProbe(Option<tokio::task::JoinHandle<()>>);
        impl Drop for PendingProbe {
            fn drop(&mut self) {
                if let Some(task) = self.0.take() {
                    task.abort();
                }
            }
        }
        let mut pending = PendingProbe(Some(task));
        // 未取得就绪确认时释放任务；调用方连接守卫负责探测结束和取消时清理。
        match timeout(OPEN_TIMEOUT, ready_rx).await {
            Ok(Ok(())) if self.active() => {
                pending.0.take();
                Ok(socket)
            }
            _ => {
                bail!("远程通道未就绪；请检查平台授权、DSP在线状态及DSP到纵密管理端口的连接");
            }
        }
    }
}

fn frame(payload: Payload) -> TunnelFrame {
    TunnelFrame {
        payload: Some(payload),
    }
}
async fn send(tx: &mpsc::Sender<TunnelFrame>, payload: Payload) -> Result<()> {
    timeout(BLOCK_TIMEOUT, tx.send(frame(payload)))
        .await
        .map_err(|_| anyhow!("隧道发送阻塞超时"))?
        .map_err(|_| anyhow!("隧道发送端已关闭"))
}

pub(crate) async fn tunnel(
    socket: TcpStream,
    endpoint: &str,
    token: &str,
    device_id: &str,
    service: &str,
) -> Result<()> {
    tunnel_with_ready(socket, endpoint, token, device_id, service, None).await
}

async fn tunnel_with_ready(
    socket: TcpStream,
    endpoint: &str,
    token: &str,
    device_id: &str,
    service: &str,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<()> {
    let (tx, rx) = mpsc::channel(8);
    send(
        &tx,
        Payload::Open(TunnelOpen {
            device_id: device_id.into(),
            service: service.into(),
        }),
    )
    .await?;
    let mut inbound = timeout(OPEN_TIMEOUT, async {
        let mut response = client(endpoint)
            .await?
            .open_tunnel(authorized(ReceiverStream::new(rx), token)?)
            .await?
            .into_inner();
        if !matches!(
            response.message().await?.and_then(|f| f.payload),
            Some(Payload::Ready(_))
        ) {
            bail!("平台未确认隧道就绪");
        }
        Ok::<_, anyhow::Error>(response)
    })
    .await
    .map_err(|_| anyhow!("等待远程服务超时"))??;
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    let (mut read, mut write) = socket.into_split();
    let (half_tx, mut half_rx) = tokio::sync::oneshot::channel();
    let sender = async {
        let mut buffer = vec![0; FRAME_LIMIT];
        loop {
            let count = read.read(&mut buffer).await?;
            if count == 0 {
                send(&tx, Payload::HalfClose(TunnelHalfClose {})).await?;
                break;
            }
            send(&tx, Payload::Data(buffer[..count].to_vec())).await?;
        }
        Ok::<_, anyhow::Error>(())
    };
    let receiver = async {
        let mut half_closed = false;
        let mut half_tx = Some(half_tx);
        loop {
            let message = inbound.message().await?;
            if message
                .as_ref()
                .is_some_and(|frame| frame.payload.is_none())
            {
                bail!("隧道帧缺少内容");
            }
            match message.and_then(|f| f.payload) {
                Some(Payload::Data(data))
                    if !half_closed && !data.is_empty() && data.len() <= FRAME_LIMIT =>
                {
                    timeout(BLOCK_TIMEOUT, write.write_all(&data))
                        .await
                        .map_err(|_| anyhow!("本地服务写入超时"))??;
                }
                Some(Payload::HalfClose(_)) if !half_closed => {
                    write.shutdown().await?;
                    half_closed = true;
                    if let Some(tx) = half_tx.take() {
                        let _ = tx.send(());
                    }
                }
                Some(Payload::Close(_)) | None => {
                    write.shutdown().await?;
                    return Ok::<_, anyhow::Error>(());
                }
                _ => bail!("隧道帧顺序或大小无效"),
            }
        }
    };
    tokio::pin!(sender, receiver);
    let mut sent_half = false;
    let mut received_half = false;
    loop {
        tokio::select! {
            result = &mut sender, if !sent_half => { result?; sent_half = true; }
            result = &mut receiver => { result?; break; }
            result = &mut half_rx, if !received_half => { result?; received_half = true; }
        }
        if sent_half && received_half {
            break;
        }
    }
    Ok(())
}
