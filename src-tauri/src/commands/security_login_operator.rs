//! 安全操作员配置：固定文件、会话内草稿版本及上传后的回读核对。
use super::{admin, operator_codec::{self as codec, Row}};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorRequest {
    pub session_id: String,
    pub action: String,
    pub kind: String,
    pub revision: Option<String>,
    pub rows: Option<Vec<Row>>,
}

#[derive(Debug, Serialize)]
pub struct OperatorResult {
    pub kind: String,
    pub revision: String,
    pub rows: Vec<Row>,
    pub interfaces: Vec<String>,
    pub certificates: Vec<String>,
    pub tunnel_ids: Vec<String>,
    pub bidirectional_allowed: bool,
    pub message: String,
    pub verified: bool,
}

struct Snapshot {
    revision: String,
    bytes: Vec<u8>,
}
#[derive(Default)]
pub(super) struct OperatorState {
    snapshots: HashMap<String, Snapshot>,
}

fn reject(message: impl Into<String>) -> admin::AdminError {
    admin::AdminError { message: message.into(), fatal: false }
}
fn filename(kind: &str) -> Result<&'static str, String> {
    match kind {
        "network" => Ok("ip.txt"),
        "routes" => Ok("route.txt"),
        "tunnels" => Ok("tunnel.txt"),
        "policies" => Ok("rule.txt"),
        _ => Err("不支持此纵密配置类型".into()),
    }
}
impl OperatorRequest {
    pub(super) fn validate(&self) -> Result<(), String> {
        filename(&self.kind)?;
        if self.session_id.is_empty() || self.session_id.len() > 128 {
            return Err("纵密会话标识无效".into());
        }
        match self.action.as_str() {
            "read" if self.revision.is_none() && self.rows.is_none() => Ok(()),
            "save" if self.revision.as_ref().is_some_and(|r| !r.is_empty() && r.len() <= 128)
                && self.rows.is_some() => codec::validate(&self.kind, self.rows.as_deref().unwrap()),
            _ => Err("配置操作参数无效；上传前必须先读取装置配置".into()),
        }
    }
}

fn revision() -> Result<String, admin::AdminError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| reject("无法建立配置版本，请重新读取"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn get<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}

async fn references<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    kind: &str,
    current: &[Row],
) -> Result<(Vec<String>, Vec<String>, Vec<String>), admin::AdminError> {
    let mut interfaces = Vec::new();
    let mut certificates = Vec::new();
    let mut tunnel_ids = Vec::new();
    if matches!(kind, "network" | "routes") {
        let networks = if kind == "network" {
            current.to_vec()
        } else {
            let bytes = admin::download(stream, "ip.txt", true).await?;
            codec::parse("network", &bytes).map_err(reject)?
        };
        for row in networks {
            let name = if get(&row, "interface") == "BRIDGE" {
                get(&row, "description")
            } else { get(&row, "interface") };
            if !name.is_empty() && !interfaces.iter().any(|s| s == name) {
                interfaces.push(name.to_string());
            }
        }
    }
    if kind == "tunnels" {
        let bytes = admin::download(stream, "certlist.txt", true).await?;
        let catalog = admin::parse_certificates(&bytes).map_err(reject)?;
        for cert in catalog.into_iter().filter(|c| c.certificate_type == 5) {
            let name = cert.name.rsplit('/').next().unwrap_or("").to_string();
            if !certificates.contains(&name) { certificates.push(name); }
        }
    }
    if kind == "policies" {
        let bytes = admin::download(stream, "tunnel.txt", true).await?;
        tunnel_ids = codec::parse("tunnels", &bytes).map_err(reject)?
            .iter().map(|row| get(row, "id").to_string()).collect();
    }
    Ok((interfaces, certificates, tunnel_ids))
}

fn validate_references(
    kind: &str, rows: &[Row], interfaces: &[String], certificates: &[String],
    tunnel_ids: &[String], bidirectional_allowed: bool,
) -> Result<(), admin::AdminError> {
    for row in rows {
        match kind {
            "routes" if !interfaces.iter().any(|i| i == get(row, "interface")) =>
                return Err(reject("路由引用的网络接口已不存在，请重新读取网络配置")),
            "tunnels" if get(row, "mode") != "2" => {
                let primary = get(row, "primary_certificate");
                let backup = get(row, "backup_certificate");
                if !certificates.iter().any(|c| c == primary)
                    || (get(row, "backup_ip") != "0.0.0.0" && !certificates.iter().any(|c| c == backup)) {
                    return Err(reject("隧道引用的加密网关证书已不存在，请由系统管理员核对证书"));
                }
            }
            "policies" => {
                if !tunnel_ids.iter().any(|id| id == get(row, "tunnel_id")) {
                    return Err(reject("策略引用的隧道已不存在，请先上传并重新读取隧道配置"));
                }
                if !bidirectional_allowed && get(row, "direction") == "0" {
                    return Err(reject("当前装置版本不支持双向策略，请配置两个单向策略"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub(super) async fn execute<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S, request: &OperatorRequest, state: &mut OperatorState,
    device_version: Option<&str>,
) -> Result<OperatorResult, admin::AdminError> {
    request.validate().map_err(reject)?;
    let file = filename(&request.kind).map_err(reject)?;
    let bidirectional_allowed = device_version.is_some_and(|v| !v.contains("rule-fix"));
    // 上传前重新读取整表并比对会话内原始快照，拒绝覆盖其他客户端的更新。
    if request.action == "save" {
        let snapshot = state.snapshots.get(&request.kind).ok_or_else(|| reject("配置版本已失效，请重新读取后再上传"))?;
        if request.revision.as_deref() != Some(snapshot.revision.as_str()) {
            return Err(reject("配置草稿与当前会话版本不匹配，请重新读取"));
        }
        let current = admin::download(stream, file, true).await?;
        if current != snapshot.bytes {
            state.snapshots.remove(&request.kind);
            return Err(reject("装置配置已被其他操作修改，未执行上传；请重新读取后合并"));
        }
    }
    let mut bytes = if request.action == "read" {
        admin::download(stream, file, true).await?
    } else { state.snapshots.get(&request.kind).unwrap().bytes.clone() };
    let mut rows = codec::parse(&request.kind, &bytes).map_err(reject)?;
    let (interfaces, certificates, tunnel_ids) = references(stream, &request.kind, &rows).await?;
    let mut verified = false;
    let mut message = "已读取装置配置，编辑仅保存在当前会话草稿中".to_string();
    if let Some(draft) = request.rows.as_ref() {
        validate_references(&request.kind, draft, &interfaces, &certificates, &tunnel_ids, bidirectional_allowed)?;
        let upload = codec::encode(&request.kind, draft).map_err(reject)?;
        // 从这一刻开始，任何失败都不得自动重放。废弃旧版本，要求重新读取。
        state.snapshots.remove(&request.kind);
        admin::upload(stream, file, &upload).await?;
        bytes = admin::download(stream, file, true).await.map_err(|_| admin::AdminError {
            message: "装置已接受上传，但回读未完成，结果未确认；请重新登录并读取核对，勿自动重试上传".into(),
            fatal: true,
        })?;
        rows = codec::parse(&request.kind, &bytes).map_err(|_| reject("装置已接受上传，但回读内容无法解析；请重新读取核对"))?;
        verified = codec::encode(&request.kind, &rows).map_err(reject)? == upload;
        message = if verified {
            "装置已接受上传，回读配置与草稿一致；实际业务效果请另行核实"
        } else { "装置已接受上传，但回读配置与草稿不一致；请保留草稿并重新读取核对" }.into();
    }
    let revision = revision()?;
    state.snapshots.insert(request.kind.clone(), Snapshot { revision: revision.clone(), bytes });
    tracing::info!(kind = request.kind, action = request.action, rows = rows.len(), verified,
        "纵密配置操作结束，不记录配置正文");
    Ok(OperatorResult { kind: request.kind.clone(), revision, rows, interfaces, certificates,
        tunnel_ids, bidirectional_allowed, message, verified })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn request(action: &str) -> OperatorRequest {
        OperatorRequest { session_id: "fixture".into(), action: action.into(), kind: "network".into(), revision: None, rows: None }
    }
    async fn serve_file(peer: &mut tokio::io::DuplexStream, name: &str, data: &[u8]) {
        assert_eq!(peer.read_i32().await.unwrap(), 4);
        let length = peer.read_i32().await.unwrap() as usize;
        let mut actual = vec![0; length]; peer.read_exact(&mut actual).await.unwrap();
        assert_eq!(actual, name.as_bytes());
        peer.write_i32(4).await.unwrap(); peer.write_i32(0).await.unwrap();
        peer.write_u8(name.len() as u8).await.unwrap(); peer.write_all(name.as_bytes()).await.unwrap();
        assert_eq!(peer.read_i32().await.unwrap(), 5);
        assert_eq!(peer.read_i32().await.unwrap(), name.len() as i32);
        peer.read_exact(&mut actual).await.unwrap();
        peer.write_i32(5).await.unwrap(); peer.write_i32(data.len() as i32).await.unwrap();
        peer.write_all(data).await.unwrap(); peer.write_i32(6).await.unwrap(); peer.write_i32(data.len() as i32).await.unwrap();
        assert_eq!(peer.read_i32().await.unwrap(), 6); assert_eq!(peer.read_i32().await.unwrap(), 0);
    }
    #[test]
    fn security_operator_request_whitelist_and_role_dependencies() {
        assert!(request("read").validate().is_ok());
        for kind in ["../ip.txt", "account.txt", "certificates"] {
            let mut req = request("read"); req.kind = kind.into(); assert!(req.validate().is_err());
        }
        assert!(request("save").validate().is_err());
        let mut req = request("read"); req.rows = Some(vec![]); assert!(req.validate().is_err());
        let mut policy = Row::new(); policy.insert("tunnel_id".into(), "7".into()); policy.insert("direction".into(), "0".into());
        assert!(validate_references("policies", &[policy.clone()], &[], &[], &["7".into()], false).is_err());
        assert!(validate_references("policies", &[policy.clone()], &[], &[], &["8".into()], true).is_err());
        assert!(validate_references("policies", &[policy], &[], &[], &["7".into()], true).is_ok());
    }
    #[tokio::test]
    async fn security_operator_read_and_conflicting_save_never_uploads() {
        let (mut client, mut peer) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            serve_file(&mut peer, "ip.txt", b"port,1,0,10.0.0.1,255.255.255.0,0,\n").await;
            serve_file(&mut peer, "ip.txt", b"port,1,0,10.0.0.2,255.255.255.0,0,\n").await;
            let mut rest = Vec::new(); peer.read_to_end(&mut rest).await.unwrap(); assert!(rest.is_empty());
        });
        let mut state = OperatorState::default();
        let result = execute(&mut client, &request("read"), &mut state, Some("fixture")).await.unwrap();
        assert_eq!(result.interfaces, ["eth1"]);
        let mut save = request("save"); save.revision = Some(result.revision); save.rows = Some(result.rows);
        let error = execute(&mut client, &save, &mut state, Some("fixture")).await.unwrap_err();
        assert!(!error.fatal); assert!(error.message.contains("未执行上传"));
        drop(client); server.await.unwrap();
    }
    #[tokio::test]
    async fn security_operator_upload_ack_and_readback_are_separate() {
        let original = b"port,1,0,10.0.0.1,255.255.255.0,0,\n";
        let expected = b"port,1,0,10.0.0.2,255.255.255.0,0,\n";
        let (mut client, mut peer) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            serve_file(&mut peer, "ip.txt", original).await;
            serve_file(&mut peer, "ip.txt", original).await;
            assert_eq!(peer.read_i32().await.unwrap(), 1);
            let n = peer.read_i32().await.unwrap(); let mut name = vec![0; n as usize]; peer.read_exact(&mut name).await.unwrap(); assert_eq!(name, b"ip.txt");
            peer.write_i32(1).await.unwrap(); peer.write_i32(0).await.unwrap();
            assert_eq!(peer.read_i32().await.unwrap(), 2);
            let n = peer.read_i32().await.unwrap(); let mut data = vec![0; n as usize]; peer.read_exact(&mut data).await.unwrap(); assert_eq!(data, expected);
            assert_eq!(peer.read_i32().await.unwrap(), 3); assert_eq!(peer.read_i32().await.unwrap(), 0);
            peer.write_i32(3).await.unwrap(); peer.write_i32(0).await.unwrap();
            // 装置仍返回原值：不能把传输受理当作核对成功。
            serve_file(&mut peer, "ip.txt", original).await;
        });
        let mut state = OperatorState::default();
        let result = execute(&mut client, &request("read"), &mut state, Some("fixture")).await.unwrap();
        let mut rows = result.rows; rows[0].insert("ip".into(), "10.0.0.2".into());
        let mut save = request("save"); save.revision = Some(result.revision); save.rows = Some(rows);
        let result = execute(&mut client, &save, &mut state, Some("fixture")).await.unwrap();
        assert!(!result.verified); assert!(result.message.contains("不一致"));
        server.await.unwrap();
    }
}
