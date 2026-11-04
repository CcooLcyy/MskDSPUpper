use super::{
    admin, protocol, AdminRequest, AdminResult, PasswordChangeResult, SecurityLoginManager,
};
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
    pub device_version: Option<String>,
    pub generation: u64,
    pub kind: ConnectionKind,
    pub expires_at: Instant,
}

pub(super) struct StoredConnection {
    pub context: ConnectionContext,
    cancel: watch::Sender<bool>,
    commands: mpsc::Sender<ConnectionCommand>,
    admin_busy: bool,
}

enum ConnectionCommand {
    Password(PasswordCommand),
    Admin {
        request: AdminRequest,
        result: oneshot::Sender<Result<AdminResult, String>>,
    },
    Operator {
        request: super::operator::OperatorRequest,
        result: oneshot::Sender<Result<super::operator::OperatorResult, String>>,
    },
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
        let (commands, mut receiver) = mpsc::channel::<ConnectionCommand>(1);
        let username = context.username.clone();
        let kind = context.kind;
        let device_version = context.device_version.clone();
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
                    admin_busy: false,
                },
            );
        }
        let weak = Arc::downgrade(self);
        let actor_id = id.clone();
        tokio::spawn(async move {
            let mut stream = stream;
            let mut unexpected = [0_u8; 1];
            let mut catalog = Vec::new();
            let mut operator_state = super::operator::OperatorState::default();
            loop {
                let command = tokio::select! { biased;
                  _ = async { if !*cancelled.borrow() { let _ = cancelled.changed().await; } } => break,
                  _ = tokio::time::sleep_until(deadline.into()) => { tracing::info!("纵密连接已到期，清除身份"); break; }
                  _ = stream.read(&mut unexpected) => { tracing::info!("纵密连接断开或收到未预期数据，清除身份"); break; }
                  command = receiver.recv() => match command {Some(command)=>command,None=>break},
                };
                match command {
                    ConnectionCommand::Password(command) => {
                        let outcome = if kind != ConnectionKind::Challenge {
                            Err("当前连接不允许修改密码")
                        } else if let Some(old) = old_digest.as_ref() {
                            let operation = async {
                                protocol::validate_new_password(&command.password, old, &username)?;
                                protocol::change_password(
                                    &mut stream,
                                    &username,
                                    old,
                                    &command.password,
                                )
                                .await
                            };
                            tokio::select! { biased;
                              _ = async {if !*cancelled.borrow(){let _=cancelled.changed().await;}} => Err("改密连接已取消；若请求已发出，请先核实装置密码状态"),
                              _ = tokio::time::sleep_until(deadline.into()) => Err("改密连接已到期；请先核实装置密码状态"),
                              outcome=tokio::time::timeout(Duration::from_secs(8),operation)=>outcome.unwrap_or(Err("改密应答超时，结果尚未确认，请先核实装置密码状态")),
                            }
                        } else {
                            Err("临时改密资料已失效，请重新登录")
                        };
                        let _ = command.result.send(outcome);
                        break;
                    }
                    ConnectionCommand::Operator { request, mut result } => {
                        let permitted = kind == ConnectionKind::Authenticated
                            && weak.upgrade().is_some_and(|m| {
                                let mut inner = m.inner.lock();
                                SecurityLoginManager::prune(&mut inner);
                                inner.connections.get(&actor_id).is_some_and(|c| {
                                    c.context.kind == ConnectionKind::Authenticated && c.context.role == 2
                                })
                            });
                        if result.is_closed() || !permitted {
                            let _ = result.send(Err("安全操作员会话已失效或权限不足".into()));
                            break;
                        }
                        let outcome = tokio::select! { biased;
                          _ = async {if !*cancelled.borrow(){let _=cancelled.changed().await;}} => Err(admin::AdminError{message:"配置操作已取消；若上传已发送，请重新读取装置核对".into(),fatal:true}),
                          _ = tokio::time::sleep_until(deadline.into()) => Err(admin::AdminError{message:"配置会话已到期，结果未确认，请重新登录后读取核对".into(),fatal:true}),
                          _ = result.closed() => Err(admin::AdminError{message:"配置调用方已取消，关闭会话".into(),fatal:true}),
                          outcome=tokio::time::timeout(Duration::from_secs(60),super::operator::execute(&mut stream,&request,&mut operator_state,device_version.as_deref()))=>outcome.unwrap_or(Err(admin::AdminError{message:"配置操作超时，结果未确认；请重新登录读取核对，不自动重试上传".into(),fatal:true})),
                        };
                        let fatal = outcome.as_ref().is_err_and(|e| e.fatal);
                        if fatal {
                            if let Some(m) = weak.upgrade() {
                                if let Some(entry) = m.inner.lock().connections.remove(&actor_id) { entry.close(); }
                            }
                        }
                        let delivered = result.send(outcome.map_err(|e| e.message)).is_ok();
                        if fatal || !delivered { break; }
                    }
                    ConnectionCommand::Admin {
                        request,
                        mut result,
                    } => {
                        if result.is_closed() {
                            break;
                        }
                        // 派发前和实际执行前均核验权限，不能把改密挑战升级为管理员身份。
                        let permitted = kind == ConnectionKind::Authenticated
                            && weak.upgrade().is_some_and(|m| {
                                let mut inner = m.inner.lock();
                                SecurityLoginManager::prune(&mut inner);
                                inner.connections.get(&actor_id).is_some_and(|c| {
                                    c.context.kind == ConnectionKind::Authenticated
                                        && c.context.role == 1
                                })
                            });
                        if !permitted {
                            let _ = result.send(Err("系统管理员会话已失效或权限不足".into()));
                            break;
                        }
                        let outcome = tokio::select! { biased;
                          _ = async {if !*cancelled.borrow(){let _=cancelled.changed().await;}} => Err(admin::AdminError{message:"管理员操作已取消；若请求已发送，请核对装置状态".into(),fatal:true}),
                          _ = tokio::time::sleep_until(deadline.into()) => Err(admin::AdminError{message:"管理员会话已到期；请核对装置状态".into(),fatal:true}),
                          _ = result.closed() => Err(admin::AdminError{message:"管理员调用方已取消，关闭会话".into(),fatal:true}),
                          outcome=tokio::time::timeout(Duration::from_secs(20),admin::execute(&mut stream,&request,&mut catalog))=>outcome.unwrap_or(Err(admin::AdminError{message:"管理员应答超时，结果未确认，请重新登录后核实".into(),fatal:true})),
                        };
                        let fatal = outcome.as_ref().is_err_and(|e| e.fatal);
                        tracing::info!(
                            action = request.action,
                            success = outcome.is_ok(),
                            fatal,
                            "纵密管理员操作结束"
                        );
                        // 不确定结果先撤销身份，再返回，防止调用方立即重放。
                        if fatal {
                            if let Some(m) = weak.upgrade() {
                                if let Some(entry) = m.inner.lock().connections.remove(&actor_id) {
                                    entry.close();
                                }
                            }
                        }
                        let delivered = result.send(outcome.map_err(|e| e.message)).is_ok();
                        if fatal || !delivered {
                            break;
                        }
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

    pub(super) async fn run_admin(&self, request: AdminRequest) -> Result<AdminResult, String> {
        request.validate()?;
        let id = request.session_id.clone();
        let commands = {
            let mut inner = self.inner.lock();
            Self::prune(&mut inner);
            let entry = inner
                .connections
                .get_mut(&id)
                .ok_or("纵密会话已失效，请重新登录")?;
            if entry.context.kind != ConnectionKind::Authenticated || entry.context.role != 1 {
                return Err("此操作只允许已认证的系统管理员".into());
            }
            if entry.admin_busy {
                return Err("当前管理员操作尚未结束，请勿重复提交".into());
            }
            entry.admin_busy = true;
            entry.commands.clone()
        };
        // 调用方中断也会关闭真实连接；不能遗留无人接收的写操作或队列重放。
        struct Guard<'a> {
            manager: &'a SecurityLoginManager,
            id: String,
            completed: bool,
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                let mut inner = self.manager.inner.lock();
                if self.completed {
                    if let Some(e) = inner.connections.get_mut(&self.id) {
                        e.admin_busy = false;
                    }
                } else if let Some(e) = inner.connections.remove(&self.id) {
                    e.close();
                }
            }
        }
        let mut guard = Guard {
            manager: self,
            id,
            completed: false,
        };
        let (result, reply) = oneshot::channel();
        commands
            .try_send(ConnectionCommand::Admin { request, result })
            .map_err(|_| "管理员会话不可用，请重新登录")?;
        let outcome = reply
            .await
            .map_err(|_| "管理员操作结果未确认，请重新登录后核实".to_string())?;
        guard.completed = true;
        outcome
    }

    pub(super) async fn run_operator(&self, request: super::operator::OperatorRequest) -> Result<super::operator::OperatorResult, String> {
        request.validate()?;
        let id = request.session_id.clone();
        let commands = {
            let mut inner = self.inner.lock();
            Self::prune(&mut inner);
            let entry = inner.connections.get_mut(&id).ok_or("纵密会话已失效，请重新登录")?;
            if entry.context.kind != ConnectionKind::Authenticated || entry.context.role != 2 {
                return Err("此操作只允许已认证的安全操作员".into());
            }
            if entry.admin_busy { return Err("当前配置操作尚未结束，请勿重复提交".into()); }
            entry.admin_busy = true;
            entry.commands.clone()
        };
        struct Guard<'a> { manager: &'a SecurityLoginManager, id: String, completed: bool }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                let mut inner = self.manager.inner.lock();
                if self.completed {
                    if let Some(entry) = inner.connections.get_mut(&self.id) { entry.admin_busy = false; }
                } else if let Some(entry) = inner.connections.remove(&self.id) { entry.close(); }
            }
        }
        let mut guard = Guard { manager: self, id, completed: false };
        let (result, reply) = oneshot::channel();
        commands.try_send(ConnectionCommand::Operator { request, result }).map_err(|_| "安全操作员会话不可用，请重新登录")?;
        let outcome = reply.await.map_err(|_| "配置操作结果未确认，请重新登录并读取核对".to_string())?;
        guard.completed = true;
        outcome
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
            .send(ConnectionCommand::Password(PasswordCommand {
                password,
                result,
            }))
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
            device_version: Some("fixture".into()),
            generation: 0,
            kind,
            expires_at: Instant::now() + Duration::from_secs(60),
        }
    }

    fn operator_request(id: &str) -> super::super::operator::OperatorRequest {
        super::super::operator::OperatorRequest {
            session_id: id.into(), action: "read".into(), kind: "network".into(), revision: None, rows: None,
        }
    }

    #[tokio::test]
    async fn security_operator_session_rejects_wrong_roles_and_challenges_without_io() {
        for (role, kind) in [(1, ConnectionKind::Authenticated), (3, ConnectionKind::Authenticated), (2, ConnectionKind::Challenge)] {
            let manager = Arc::new(SecurityLoginManager::default());
            let (_cancellation, _guard) = manager.begin("fixture-owner").unwrap();
            let (client, mut peer) = tokio::io::duplex(1024);
            let mut ctx = context(kind); ctx.role = role;
            let old = (kind == ConnectionKind::Challenge).then(|| Zeroizing::new("fixture".into()));
            let id = manager.retain_connection(ctx, client, old).unwrap();
            assert!(manager.run_operator(operator_request(&id)).await.is_err());
            manager.cancel("fixture-owner").unwrap();
            let mut bytes = Vec::new(); peer.read_to_end(&mut bytes).await.unwrap(); assert!(bytes.is_empty());
        }
    }

    #[tokio::test]
    async fn security_operator_session_serializes_and_cancellation_closes_connection() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancellation, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let mut ctx = context(ConnectionKind::Authenticated); ctx.role = 2;
        let id = manager.retain_connection(ctx, client, None).unwrap();
        let owner = manager.clone(); let req = operator_request(&id);
        let task = tokio::spawn(async move { owner.run_operator(req).await });
        assert_eq!(peer.read_i32().await.unwrap(), 4);
        assert!(manager.run_operator(operator_request(&id)).await.is_err());
        assert!(manager.close_session(&id).is_err());
        manager.cancel("fixture-owner").unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!manager.connection_active(&id));
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
    fn admin_request(id: &str) -> AdminRequest {
        AdminRequest {
            session_id: id.into(),
            action: "status".into(),
            certificate_type: None,
            name: None,
            data: None,
            tunnel_id: None,
        }
    }
    // 非管理员及改密挑战不能借用同一TLS连接执行管理协议。
    #[tokio::test]
    async fn security_admin_rejects_wrong_role_and_challenge() {
        for (role, kind) in [
            (2, ConnectionKind::Authenticated),
            (3, ConnectionKind::Authenticated),
            (1, ConnectionKind::Challenge),
        ] {
            let manager = Arc::new(SecurityLoginManager::default());
            let (_cancel, _guard) = manager.begin("fixture-owner").unwrap();
            let (client, mut peer) = tokio::io::duplex(1024);
            let mut ctx = context(kind);
            ctx.role = role;
            let old = if kind == ConnectionKind::Challenge {
                Some(Zeroizing::new("old".into()))
            } else {
                None
            };
            let id = manager.retain_connection(ctx, client, old).unwrap();
            assert!(manager.run_admin(admin_request(&id)).await.is_err());
            assert!(
                tokio::time::timeout(Duration::from_millis(10), peer.read_u8())
                    .await
                    .is_err()
            );
        }
    }
    // 同一会话复用连接并串行执行，忙时拒绝重复提交；中断调用会关闭连接。
    #[tokio::test]
    async fn security_admin_serial_session_and_caller_cancellation() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancel, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let id = manager
            .retain_connection(context(ConnectionKind::Authenticated), client, None)
            .unwrap();
        for _ in 0..2 {
            let m = manager.clone();
            let req = admin_request(&id);
            let task = tokio::spawn(async move { m.run_admin(req).await });
            assert_eq!(peer.read_i32().await.unwrap(), 25);
            assert_eq!(peer.read_i32().await.unwrap(), 0);
            assert!(manager
                .run_admin(admin_request(&id))
                .await
                .unwrap_err()
                .contains("尚未结束"));
            tokio::io::AsyncWriteExt::write_all(&mut peer, &[0, 0, 0, 25, 0, 0, 0, 1])
                .await
                .unwrap();
            assert_eq!(
                task.await.unwrap().unwrap().status.as_deref(),
                Some("uninitialized")
            );
            assert!(manager.connection_active(&id));
        }
        let m = manager.clone();
        let req = admin_request(&id);
        let task = tokio::spawn(async move { m.run_admin(req).await });
        assert_eq!(peer.read_i32().await.unwrap(), 25);
        assert_eq!(peer.read_i32().await.unwrap(), 0);
        task.abort();
        let _ = task.await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), peer.read_u8())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::UnexpectedEof
        );
        assert!(!manager.connection_active(&id));
    }
    // 命令不匹配是协议失步，先撤销会话再返回错误，禁止自动重放。
    #[tokio::test]
    async fn security_admin_unknown_response_revokes_session() {
        let manager = Arc::new(SecurityLoginManager::default());
        let (_cancel, _guard) = manager.begin("fixture-owner").unwrap();
        let (client, mut peer) = tokio::io::duplex(1024);
        let id = manager
            .retain_connection(context(ConnectionKind::Authenticated), client, None)
            .unwrap();
        let m = manager.clone();
        let req = admin_request(&id);
        let task = tokio::spawn(async move { m.run_admin(req).await });
        assert_eq!(peer.read_i32().await.unwrap(), 25);
        assert_eq!(peer.read_i32().await.unwrap(), 0);
        tokio::io::AsyncWriteExt::write_all(&mut peer, &[0, 0, 0, 99, 0, 0, 0, 1])
            .await
            .unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!manager.connection_active(&id));
    }
    // 已发出的管理员请求在用户取消或会话到期时不得续用，也不等待装置迟到应答。
    #[tokio::test]
    async fn security_admin_inflight_cancel_and_expiration_close_connection() {
        for expire in [false, true] {
            let manager = Arc::new(SecurityLoginManager::default());
            let (_cancel, _guard) = manager.begin("fixture-owner").unwrap();
            let (client, mut peer) = tokio::io::duplex(1024);
            let mut ctx = context(ConnectionKind::Authenticated);
            if expire {
                ctx.expires_at = Instant::now() + Duration::from_millis(80);
            }
            let id = manager.retain_connection(ctx, client, None).unwrap();
            let m = manager.clone();
            let req = admin_request(&id);
            let task = tokio::spawn(async move { m.run_admin(req).await });
            assert_eq!(peer.read_i32().await.unwrap(), 25);
            assert_eq!(peer.read_i32().await.unwrap(), 0);
            if !expire {
                manager.cancel("fixture-owner").unwrap();
            }
            assert!(tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert!(!manager.connection_active(&id));
            assert!(tokio::time::timeout(Duration::from_secs(1), peer.read_u8())
                .await
                .unwrap()
                .is_err());
        }
    }
}
