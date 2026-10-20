use crate::{
    remote_access::{self, RemoteConnection, RemoteDevice},
    state::AppState,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tokio::{
    sync::{mpsc, oneshot, Semaphore},
    task::JoinHandle,
    time::timeout,
};

#[derive(Serialize)]
pub struct ConnectionStatus {
    remote: bool,
    device_id: Option<String>,
    active: bool,
}
#[tauri::command]
pub async fn remote_list_devices(state: State<'_, AppState>) -> Result<Vec<RemoteDevice>, String> {
    remote_access::list_devices(&state.platform_auth)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn remote_connection_status(state: State<'_, AppState>) -> ConnectionStatus {
    let remote = state.conn_manager.remote_connection();
    ConnectionStatus {
        remote: remote.is_some(),
        device_id: remote.as_ref().map(|r| r.device.device_id.clone()),
        active: remote.as_ref().is_some_and(|r| r.active()),
    }
}
#[tauri::command]
pub async fn remote_select_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    let device = remote_access::list_devices(&state.platform_auth)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|d| d.device_id == device_id)
        .ok_or("设备无访问权限")?;
    if !device.online {
        return Err("设备当前离线".into());
    }
    let remote =
        RemoteConnection::new(device, state.platform_auth.clone()).map_err(|e| e.to_string())?;
    state.remote_ssh.close_all();
    state.conn_manager.select_remote(Some(remote)).await;
    tracing::info!(device_id, "已选择平台远程设备，旧连接已取消");
    Ok(())
}
#[tauri::command]
pub async fn remote_use_direct(state: State<'_, AppState>, address: String) -> Result<(), String> {
    // 先校验，再切模式，避免错误输入中断当前远程任务。
    let address = super::module_ops::validate_manager_addr(&address)?;
    state.remote_ssh.close_all();
    state.conn_manager.select_remote(None).await;
    state.conn_manager.set_manager_addr(address);
    tracing::info!("已返回现场直连，远程会话已取消");
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SshEvent {
    HostKey {
        fingerprint: String,
        device_id: String,
    },
    Connected,
    Data {
        bytes: Vec<u8>,
    },
    Closed {
        message: String,
    },
}
enum SshInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}
type Confirmation = Arc<Mutex<Option<oneshot::Sender<bool>>>>;
struct SshSession {
    input: mpsc::Sender<SshInput>,
    confirmation: Confirmation,
    task: JoinHandle<()>,
    output_budget: Arc<Semaphore>,
}
pub struct RemoteSshManager {
    sessions: Mutex<HashMap<String, SshSession>>,
    next_id: AtomicU64,
    pins: tokio::sync::Mutex<()>,
    pins_path: PathBuf,
}
impl RemoteSshManager {
    pub fn new(path: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            pins: tokio::sync::Mutex::new(()),
            pins_path: path,
        }
    }
    pub fn close_all(&self) {
        for (session_id, session) in self.sessions.lock().drain() {
            session.task.abort();
            tracing::info!(session_id, "SSH 会话已主动关闭");
        }
    }
    fn close(&self, id: &str) {
        if let Some(session) = self.sessions.lock().remove(id) {
            session.task.abort();
            tracing::info!(session_id = id, "SSH 会话已主动关闭");
        }
    }
}
impl Drop for RemoteSshManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn host_identity(endpoint: &str, device_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{endpoint}\0{device_id}").as_bytes())
    )
}
struct HostVerifier {
    manager: Arc<RemoteSshManager>,
    identity: String,
    device_id: String,
    confirmation: Confirmation,
    events: Channel<SshEvent>,
}
impl russh::client::Handler for HostVerifier {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let _guard = self.manager.pins.lock().await;
        let mut pins: HashMap<String, String> = match tokio::fs::read(&self.manager.pins_path).await
        {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(pins) => pins,
                Err(_) => return Ok(false),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(_) => return Ok(false),
        };
        if let Some(expected) = pins.get(&self.identity) {
            if expected != &fingerprint {
                tracing::warn!(device_id = self.device_id, "SSH 主机指纹变化，已拒绝连接");
                let _ = self.events.send(SshEvent::Closed {
                    message: "设备 SSH 主机密钥已变化，已拒绝连接；请核实设备身份后再处理信任记录"
                        .into(),
                });
                return Ok(false);
            }
            return Ok(true);
        }
        let (reply, answer) = oneshot::channel();
        *self.confirmation.lock() = Some(reply);
        if self
            .events
            .send(SshEvent::HostKey {
                fingerprint: fingerprint.clone(),
                device_id: self.device_id.clone(),
            })
            .is_err()
        {
            return Ok(false);
        }
        if !matches!(
            timeout(Duration::from_secs(120), answer).await,
            Ok(Ok(true))
        ) {
            tracing::info!(device_id = self.device_id, "SSH 首次主机身份未获确认");
            return Ok(false);
        }
        pins.insert(self.identity.clone(), fingerprint);
        let Some(parent) = self.manager.pins_path.parent() else {
            return Ok(false);
        };
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return Ok(false);
        }
        let Ok(bytes) = serde_json::to_vec_pretty(&pins) else {
            return Ok(false);
        };
        // 文件只包含已明确确认的主机指纹，无账号密码或终端正文。
        let temporary = self
            .manager
            .pins_path
            .with_extension(format!("tmp.{}", std::process::id()));
        if tokio::fs::write(&temporary, bytes).await.is_err() {
            return Ok(false);
        }
        Ok(tokio::fs::rename(temporary, &self.manager.pins_path)
            .await
            .is_ok())
    }
}

#[tauri::command]
pub async fn remote_ssh_open(
    state: State<'_, AppState>,
    username: String,
    password: String,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<String, String> {
    if username.trim().is_empty() || username.len() > 128 || password.is_empty() {
        return Err("请输入 SSH 账号和密码".into());
    }
    let remote = state
        .conn_manager
        .remote_connection()
        .ok_or("请先选择远程设备")?;
    let address = remote.adapter("ssh").await.map_err(|e| e.to_string())?;
    let manager = state.remote_ssh.clone();
    let confirmation = Arc::new(Mutex::new(None));
    let handler = HostVerifier {
        manager: manager.clone(),
        identity: host_identity(&remote.endpoint, &remote.device.device_id),
        device_id: remote.device.device_id.clone(),
        confirmation: confirmation.clone(),
        events: events.clone(),
    };
    let (input, receiver) = mpsc::channel(8);
    let output_budget = Arc::new(Semaphore::new(8));
    let worker_budget = output_budget.clone();
    let id = format!("ssh-{}", manager.next_id.fetch_add(1, Ordering::SeqCst));
    tracing::info!(
        device_id = remote.device.device_id,
        session_id = id,
        "正在打开远程 SSH 终端"
    );
    let mut sessions = manager.sessions.lock();
    if sessions.len() >= 4 {
        return Err("终端数量已达到上限，请先关闭现有终端".into());
    }
    let worker_manager = manager.clone();
    let worker_id = id.clone();
    let task = tokio::spawn(async move {
        let canceled = remote.subscribe();
        let result = tokio::select! {
            _ = remote_access::wait_canceled(canceled) => Err("设备连接已切换或平台登录已失效".to_string()),
            result = ssh_session(address, username, password, cols, rows, handler, receiver, events.clone(), worker_budget) => result,
        };
        tracing::info!(
            device_id = remote.device.device_id,
            session_id = worker_id,
            success = result.is_ok(),
            "远程 SSH 会话已结束"
        );
        let _ = events.send(SshEvent::Closed {
            message: result.err().unwrap_or_else(|| "SSH 会话已结束".into()),
        });
        worker_manager.sessions.lock().remove(&worker_id);
    });
    sessions.insert(
        id.clone(),
        SshSession {
            input,
            confirmation,
            task,
            output_budget,
        },
    );
    Ok(id)
}

async fn ssh_session(
    address: String,
    username: String,
    password: String,
    cols: u32,
    rows: u32,
    handler: HostVerifier,
    mut input: mpsc::Receiver<SshInput>,
    events: Channel<SshEvent>,
    output_budget: Arc<Semaphore>,
) -> Result<(), String> {
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(180)),
        ..Default::default()
    });
    let mut session = timeout(
        Duration::from_secs(150),
        russh::client::connect(config, address, handler),
    )
    .await
    .map_err(|_| "SSH 握手超时")?
    .map_err(|_| "SSH 握手失败或主机身份未确认")?;
    let authenticated = timeout(
        Duration::from_secs(15),
        session.authenticate_password(username, password),
    )
    .await
    .map_err(|_| "SSH 认证超时")?
    .map_err(|_| "SSH 认证失败")?;
    if !authenticated.success() {
        return Err("SSH 账号或密码错误".into());
    }
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|_| "无法打开 SSH 会话")?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            cols.clamp(1, 1000),
            rows.clamp(1, 1000),
            0,
            0,
            &[],
        )
        .await
        .map_err(|_| "无法申请 SSH 终端")?;
    channel
        .request_shell(true)
        .await
        .map_err(|_| "无法启动 SSH Shell")?;
    events
        .send(SshEvent::Connected)
        .map_err(|_| "终端窗口已关闭")?;
    loop {
        tokio::select! {
            command = input.recv() => match command {
                Some(SshInput::Data(bytes)) => timeout(Duration::from_secs(30), channel.data(bytes.as_slice())).await.map_err(|_| "SSH 输入阻塞超时")?.map_err(|_| "SSH 输入失败")?,
                Some(SshInput::Resize(cols, rows)) => channel.window_change(cols, rows, 0, 0).await.map_err(|_| "SSH 窗口调整失败")?,
                None => break,
            },
            response = channel.wait() => match response {
                Some(russh::ChannelMsg::Data { data }) | Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                    let credit = timeout(Duration::from_secs(30), output_budget.acquire()).await.map_err(|_| "终端输出消费超时")?.map_err(|_| "终端窗口已关闭")?;
                    credit.forget();
                    events.send(SshEvent::Data { bytes: data.to_vec() }).map_err(|_| "终端窗口已关闭")?;
                },
                Some(russh::ChannelMsg::Close) | None => break,
                Some(russh::ChannelMsg::Failure) => return Err("设备拒绝终端请求".into()),
                _ => {},
            }
        }
    }
    let _ = timeout(
        Duration::from_secs(3),
        session.disconnect(russh::Disconnect::ByApplication, "", "en"),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub fn remote_ssh_trust(
    state: State<'_, AppState>,
    session_id: String,
    accept: bool,
) -> Result<(), String> {
    let sessions = state.remote_ssh.sessions.lock();
    let session = sessions.get(&session_id).ok_or("SSH 会话不存在")?;
    let reply = session
        .confirmation
        .lock()
        .take()
        .ok_or("没有待确认的 SSH 主机")?;
    reply.send(accept).map_err(|_| "SSH 身份确认已超时".into())
}
#[tauri::command]
pub async fn remote_ssh_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > remote_access::FRAME_LIMIT {
        return Err("单次终端输入过大".into());
    }
    let input = state
        .remote_ssh
        .sessions
        .lock()
        .get(&session_id)
        .map(|s| s.input.clone())
        .ok_or("SSH 会话不存在")?;
    timeout(
        Duration::from_secs(30),
        input.send(SshInput::Data(data.into_bytes())),
    )
    .await
    .map_err(|_| "终端输入队列超时")?
    .map_err(|_| "终端已关闭".into())
}
#[tauri::command]
pub async fn remote_ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let input = state
        .remote_ssh
        .sessions
        .lock()
        .get(&session_id)
        .map(|s| s.input.clone())
        .ok_or("SSH 会话不存在")?;
    timeout(
        Duration::from_secs(30),
        input.send(SshInput::Resize(cols.clamp(1, 1000), rows.clamp(1, 1000))),
    )
    .await
    .map_err(|_| "终端调整队列超时")?
    .map_err(|_| "终端已关闭".into())
}
#[tauri::command]
pub fn remote_ssh_close(state: State<'_, AppState>, session_id: String) {
    state.remote_ssh.close(&session_id);
}

/// xterm 消费一个输出块后返还额度，避免 IPC 将高速终端输出无限积压。
#[tauri::command]
pub fn remote_ssh_ack(state: State<'_, AppState>, session_id: String) {
    if let Some(session) = state.remote_ssh.sessions.lock().get(&session_id) {
        if session.output_budget.available_permits() < 8 {
            session.output_budget.add_permits(1);
        }
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
