use super::{protocol, PasswordChangeResult, SecurityLoginManager};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
    sync::{mpsc, oneshot, watch},
};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectionKind {
    Challenge,
    Changing,
    Authenticated,
}

pub(super) struct ConnectionContext {
    pub request_id: String,
    pub username: String,
    pub role: u8,
    pub generation: u64,
    pub kind: ConnectionKind,
    pub expires_at: Instant,
}

pub(super) struct StoredConnection {
    pub context: ConnectionContext,
    cancel: watch::Sender<bool>,
    commands: mpsc::Sender<PasswordCommand>,
}

struct PasswordCommand {
    password: Zeroizing<String>,
    result: oneshot::Sender<Result<(), &'static str>>,
}

impl StoredConnection {
    pub(super) fn close(&self) {
        let _ = self.cancel.send(true);
    }
}

fn connection_id() -> Result<String, &'static str> {
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|_| "无法生成纵密会话标识")?;
    Ok(format!(
        "vertical-{}",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

impl SecurityLoginManager {
    pub(super) fn retain_connection<S>(
        self: &Arc<Self>,
        context: ConnectionContext,
        stream: S,
        old_digest: Option<Zeroizing<String>>,
    ) -> Result<String, &'static str>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        if !(1..=3).contains(&context.role)
            || context.expires_at <= Instant::now()
            || (context.kind == ConnectionKind::Challenge) != old_digest.is_some()
        {
            return Err("纵密连接身份或临时改密资料无效");
        }
        let id = connection_id()?;
        let (cancel, mut cancelled) = watch::channel(false);
        let (commands, mut receiver) = mpsc::channel::<PasswordCommand>(1);
        let username = context.username.clone();
        let kind = context.kind;
        let deadline = context.expires_at;
        {
            let mut inner = self.inner.lock();
            Self::prune(&mut inner);
            if context.generation != inner.config_generation
                || inner
                    .pending
                    .get(&context.request_id)
                    .is_none_or(|sender| *sender.borrow())
            {
                return Err("登录请求已取消或证书配置已改变");
            }
            if inner.connections.len() >= 4 {
                return Err("纵密连接数量已达上限，请先退出已有连接");
            }
            inner.connections.insert(
                id.clone(),
                StoredConnection {
                    context,
                    cancel,
                    commands,
                },
            );
        }
        let weak = Arc::downgrade(self);
        let actor_id = id.clone();
        tokio::spawn(async move {
            let mut stream = stream;
            let mut unexpected = [0_u8; 1];
            tokio::select! { biased;
                _ = async { if !*cancelled.borrow() { let _ = cancelled.changed().await; } } => {}
                _ = tokio::time::sleep_until(deadline.into()) => { tracing::info!("纵密连接已到期，清除登录身份或临时改密资料"); }
                _ = stream.read(&mut unexpected) => { tracing::info!("纵密连接已断开或收到未预期数据，清除当前身份"); }
                command = receiver.recv() => {
                    if let Some(command) = command {
                        let outcome = if kind != ConnectionKind::Challenge {
                            Err("当前连接不允许修改密码")
                        } else if let Some(old) = old_digest.as_ref() {
                            let operation = async {
                                protocol::validate_new_password(&command.password, old, &username)?;
                                protocol::change_password(&mut stream, &username, old, &command.password).await
                            };
                            tokio::select! { biased;
                                _ = async { if !*cancelled.borrow() { let _ = cancelled.changed().await; } } => Err("改密连接已取消；若请求已发出，请先核实装置密码状态") ,
                                _ = tokio::time::sleep_until(deadline.into()) => Err("改密连接已到期；若请求已发出，请先核实装置密码状态"),
                                outcome = tokio::time::timeout(Duration::from_secs(8), operation) => outcome.unwrap_or(Err("改密应答超时，结果尚未确认，请先核实装置密码状态")),
                            }
                        } else { Err("临时改密资料已失效，请重新登录") };
                        tracing::info!(changed = outcome.is_ok(), "纵密单次改密处理结束，关闭连接并要求重新登录");
                        let _ = command.result.send(outcome);
                    }
                }
            }
            // 先关闭连接和清除旧摘要，再撤销可查询身份；不发送退出或其他维护命令。
            drop(stream);
            drop(old_digest);
            if let Some(manager) = weak.upgrade() {
                manager.inner.lock().connections.remove(&actor_id);
            }
        });
        Ok(id)
    }

    pub(super) fn connection_active(&self, id: &str) -> bool {
        let mut inner = self.inner.lock();
        Self::prune(&mut inner);
        inner.connections.contains_key(id)
    }

    pub(super) fn close_session(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        if !inner
            .connections
            .get(id)
            .is_some_and(|entry| entry.context.kind == ConnectionKind::Authenticated)
        {
            return Err("纵密登录会话已失效或不存在".into());
        }
        if let Some(entry) = inner.connections.remove(id) {
            entry.close();
        }
        tracing::info!("已关闭纵密登录连接并撤销身份");
        Ok(())
    }

    pub(super) async fn change_password(
        &self,
        id: &str,
        password: Zeroizing<String>,
    ) -> PasswordChangeResult {
        let commands = {
            let mut inner = self.inner.lock();
            Self::prune(&mut inner);
            match inner.connections.get_mut(id) {
                Some(entry) if entry.context.kind == ConnectionKind::Challenge => {
                    entry.context.kind = ConnectionKind::Changing;
                    entry.commands.clone()
                }
                _ => {
                    return PasswordChangeResult {
                        changed: false,
                        message: "临时改密会话已使用、已过期或不存在，请重新登录",
                    }
                }
            }
        };
        let (result, reply) = oneshot::channel();
        let outcome = if commands
            .send(PasswordCommand { password, result })
            .await
            .is_err()
        {
            Err("临时改密连接已关闭，请重新登录")
        } else {
            reply
                .await
                .unwrap_or(Err("改密结果未确认，请先核实装置密码状态"))
        };
        if let Some(entry) = self.inner.lock().connections.remove(id) {
            entry.close();
        }
        match outcome {
            Ok(()) => PasswordChangeResult {
                changed: true,
                message: "密码已修改，连接已关闭，请使用新密码重新登录",
            },
            Err(message) => PasswordChangeResult {
                changed: false,
                message,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::security_login::SecurityLoginManager;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    use tokio::io::AsyncReadExt;

    fn context(kind: ConnectionKind) -> ConnectionContext {
        ConnectionContext {
            request_id: "fixture-owner".into(),
            username: "fixture".into(),
            role: 1,
            generation: 0,
            kind,
            expires_at: Instant::now() + Duration::from_secs(60),
        }
    }

    // 已建立的会话必须持有真实连接，取消原请求会关闭该连接且不发送业务命令。
    #[tokio::test]
    async fn security_login_session_cancel_closes_owned_connection() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancellation, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let id = manager
            .retain_connection(context(ConnectionKind::Authenticated), client, None)
            .unwrap();
        assert!(manager.connection_active(&id));
        manager.cancel("fixture-owner").unwrap();
        assert!(!manager.connection_active(&id));
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), peer.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(bytes.is_empty());
    }

    // 临时改密会话到期后由后台关闭，不依赖再次调用接口触发清理。
    #[tokio::test]
    async fn security_login_challenge_expiration_closes_connection() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancellation, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let mut ctx = context(ConnectionKind::Challenge);
        ctx.expires_at = Instant::now() + Duration::from_millis(20);
        let id = manager
            .retain_connection(
                ctx,
                client,
                Some(zeroize::Zeroizing::new("fixture-old-digest".into())),
            )
            .unwrap();
        let mut buf = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), peer.read(&mut buf))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(!manager.connection_active(&id));
    }

    // 对端断开或证书配置代次变化后，不得继续报告存在可使用的登录身份。
    #[tokio::test]
    async fn security_login_session_disconnect_and_generation_are_isolated() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancellation, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, peer) = tokio::io::duplex(1024);
        let id = manager
            .retain_connection(context(ConnectionKind::Authenticated), client, None)
            .unwrap();
        drop(peer);
        tokio::time::timeout(Duration::from_secs(1), async {
            while manager.connection_active(&id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let (client, _peer) = tokio::io::duplex(1024);
        manager.inner.lock().config_generation += 1;
        assert!(manager
            .retain_connection(context(ConnectionKind::Authenticated), client, None)
            .is_err());
    }

    // 全部取消必须清理已完成登录后保留的连接，而不只是正在进行的登录请求。
    #[tokio::test]
    async fn security_login_cancel_all_clears_retained_sessions() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancellation, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let id = manager
            .retain_connection(context(ConnectionKind::Authenticated), client, None)
            .unwrap();
        manager.cancel_all();
        assert!(!manager.connection_active(&id));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), peer.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    // 切换证书一开始就撤销已有连接，不能等新证书加载完成后才取消旧改密连接。
    #[tokio::test]
    async fn security_login_configuration_change_immediately_closes_connections() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (cancellation, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let id = manager
            .retain_connection(
                context(ConnectionKind::Challenge),
                client,
                Some(Zeroizing::new("fixture-old-digest".into())),
            )
            .unwrap();
        SecurityLoginManager::advance_configuration(&mut manager.inner.lock());
        assert!(*cancellation.borrow());
        assert!(!manager.connection_active(&id));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), peer.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
}
