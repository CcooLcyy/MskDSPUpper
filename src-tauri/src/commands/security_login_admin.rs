//! 系统管理员业务协议；复用已认证连接，不建立新身份。
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminRequest {
    pub session_id: String,
    pub action: String,
    pub certificate_type: Option<u8>,
    pub name: Option<String>,
    pub data: Option<Vec<u8>>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AdminCertificate {
    pub name: String,
    pub certificate_type: u8,
}
#[derive(Debug, Default, Serialize)]
pub struct AdminResult {
    pub message: String,
    pub status: Option<String>,
    pub certificates: Vec<AdminCertificate>,
    pub data: Option<Vec<u8>>,
}
fn parse_certificates(data: &[u8]) -> Result<Vec<AdminCertificate>, &'static str> {
    let text = std::str::from_utf8(data).map_err(|_| "证书列表编码无效")?;
    let mut result = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut fields = line.trim_end_matches('\r').split(',');
        let name = fields
            .next()
            .and_then(|s| s.strip_prefix("/log/"))
            .ok_or("证书列表路径未确认")?;
        let kind = fields
            .next()
            .and_then(|s| s.parse::<u8>().ok())
            .filter(|v| *v <= 5)
            .ok_or("证书列表类别无效")?;
        if !valid_catalog_name(name)
            || fields.next().is_none()
            || result.iter().any(|c: &AdminCertificate| c.name == name)
            || result.len() >= 1024
        {
            return Err("证书列表名称无效或重复");
        }
        result.push(AdminCertificate {
            name: name.into(),
            certificate_type: kind,
        });
    }
    Ok(result)
}
fn safe_certificate_name(name: &str, limit: usize) -> bool {
    !name.is_empty()
        && name.len() <= limit
        && name.is_ascii()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._- ".contains(&b))
        && !name.contains("..")
        && [".cer", ".pem", ".crt"]
            .iter()
            .any(|ext| name.to_ascii_lowercase().ends_with(ext))
}
fn valid_upload_name(name: &str) -> bool {
    safe_certificate_name(name, 28)
}
fn valid_catalog_name(name: &str) -> bool {
    name.len() <= 122
        && safe_certificate_name(name.strip_prefix("cert_files/").unwrap_or(name), 122)
}
fn safe_certificate_data(data: &[u8]) -> bool {
    !data.is_empty()
        && data.len() <= MAX_BYTES
        && ![b"PRIVATE KEY".as_slice(), b"CERTIFICATE REQUEST".as_slice()]
            .iter()
            .any(|marker| data.windows(marker.len()).any(|w| w == *marker))
}

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
const MAX_BYTES: usize = 4 * 1024 * 1024;
const BLOCK: usize = 1452;
const CSR_SUBJECT: &[u8] = b"2,LOCALNAME,1,COMMONNAME,1,OU,1,ZUZHI,1,0";
#[derive(Debug)]
pub(super) struct AdminError {
    pub message: String,
    pub fatal: bool,
}
impl From<&str> for AdminError {
    fn from(message: &str) -> Self {
        Self {
            message: message.into(),
            fatal: true,
        }
    }
}
fn rejected(message: &str) -> AdminError {
    AdminError {
        message: message.into(),
        fatal: false,
    }
}
impl AdminRequest {
    pub(super) fn validate(&self) -> Result<(), String> {
        let no_extra =
            self.certificate_type.is_none() && self.name.is_none() && self.data.is_none();
        let valid = match self.action.as_str() {
            "status" | "generate_sm2" | "export_csr" | "list_certificates" => no_extra,
            "read_certificate" | "delete_certificate" => {
                self.data.is_none()
                    && self.certificate_type.is_none_or(|n| n <= 5)
                    && self.name.as_deref().is_some_and(valid_catalog_name)
            }
            "import_certificate" => {
                self.certificate_type.is_some_and(|n| n <= 5)
                    && self.name.as_deref().is_some_and(valid_upload_name)
                    && self.data.as_ref().is_some_and(|d| safe_certificate_data(d))
            }
            _ => false,
        };
        if !valid {
            return Err("纵密管理员操作参数无效、证书过大或不在允许范围".into());
        }
        Ok(())
    }
}
async fn send<S: AsyncWrite + Unpin>(
    stream: &mut S,
    command: i32,
    value: i32,
    body: &[u8],
) -> Result<(), AdminError> {
    let mut packet = Vec::with_capacity(8 + body.len());
    packet.extend(command.to_be_bytes());
    packet.extend(value.to_be_bytes());
    packet.extend(body);
    tracing::info!(
        command,
        bytes = packet.len(),
        "发送纵密管理员协议帧，不记录证书正文"
    );
    stream
        .write_all(&packet)
        .await
        .map_err(|_| AdminError::from("管理员请求发送失败，结果未确认"))?;
    stream
        .flush()
        .await
        .map_err(|_| AdminError::from("管理员请求刷新失败，结果未确认"))
}
async fn pair<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(i32, i32), AdminError> {
    let command = stream
        .read_i32()
        .await
        .map_err(|_| AdminError::from("管理员应答不完整，结果未确认"))?;
    let value = stream
        .read_i32()
        .await
        .map_err(|_| AdminError::from("管理员应答不完整，结果未确认"))?;
    tracing::info!(command, value, "收到纵密管理员应答头");
    Ok((command, value))
}
async fn answer<S: AsyncRead + Unpin>(stream: &mut S, expected: i32) -> Result<i32, AdminError> {
    let (cmd, value) = pair(stream).await?;
    if cmd != expected {
        return Err("管理员应答命令不匹配".into());
    }
    Ok(value)
}
async fn download<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    name: &str,
    empty: bool,
) -> Result<Vec<u8>, AdminError> {
    let base = name.rsplit('/').next().ok_or("下载名称无效")?;
    send(stream, 4, base.len() as i32, base.as_bytes()).await?;
    let status = answer(stream, 4).await?;
    if !matches!(status, 0 | 1) {
        return Err("装置拒绝读取文件，连接状态未确认".into());
    }
    let length = stream
        .read_u8()
        .await
        .map_err(|_| AdminError::from("下载文件名不完整"))? as usize;
    if length == 0 || length > 127 {
        return Err("下载文件名长度无效".into());
    }
    let mut returned = vec![0; length];
    stream
        .read_exact(&mut returned)
        .await
        .map_err(|_| AdminError::from("下载文件名不完整"))?;
    let full = format!("/log/{name}");
    if returned != name.as_bytes() && returned != full.as_bytes() {
        return Err("下载文件名与固定请求不一致".into());
    }
    send(stream, 5, returned.len() as i32, &returned).await?;
    let mut body = Vec::new();
    loop {
        let (cmd, len) = pair(stream).await?;
        match cmd {
            5 => {
                if len < 0 || len as usize > BLOCK || body.len() + len as usize > MAX_BYTES {
                    return Err("下载分块或总长度无效".into());
                }
                let start = body.len();
                body.resize(start + len as usize, 0);
                stream
                    .read_exact(&mut body[start..])
                    .await
                    .map_err(|_| AdminError::from("下载正文不完整"))?;
            }
            6 => {
                if len < 0 || len as usize > MAX_BYTES || (!empty && body.is_empty()) {
                    return Err("下载结束字段无效".into());
                }
                send(stream, 6, 0, &[]).await?;
                return Ok(body);
            }
            _ => return Err("下载应答命令不匹配".into()),
        }
    }
}
async fn upload<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    name: &str,
    data: &[u8],
) -> Result<(), AdminError> {
    // ClientSendCert 的 flag=222 只控制提示；线上仍是通用 1/2/3 文件传输。
    send(stream, 1, name.len() as i32, name.as_bytes()).await?;
    match answer(stream, 1).await? {
        0 => {}
        1 => return Err(rejected("装置拒绝接收证书文件")),
        _ => return Err("证书上传准备状态未知".into()),
    }
    for chunk in data.chunks(BLOCK) {
        send(stream, 2, chunk.len() as i32, chunk).await?;
    }
    // 原厂 do/while 对恰好整块的文件追加零长度分块。
    if data.len() % BLOCK == 0 {
        send(stream, 2, 0, &[]).await?;
    }
    send(stream, 3, 0, &[]).await?;
    match answer(stream, 3).await? {
        0 => Ok(()),
        1 => Err(rejected("证书文件上传失败")),
        _ => Err("证书上传结束状态未知".into()),
    }
}
// 单独生成与CSR导出共用同一已核实的41应答语义，不自动重试或重建已有密钥。
async fn generate_sm2<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> Result<&'static str, AdminError> {
    send(stream, 41, 0, &[]).await?;
    match answer(stream, 41).await? {
        1 => Ok("SM2密钥生成成功"),
        3 => Ok("SM2密钥已经生成，继续使用现有密钥"),
        0 => Err(rejected("SM2密钥生成失败")),
        2 => Err(rejected("请插入系统密钥卡后重新生成SM2密钥")),
        _ => Err("SM2密钥生成应答未知".into()),
    }
}
pub(super) async fn execute<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    request: &AdminRequest,
    catalog: &mut Vec<AdminCertificate>,
) -> Result<AdminResult, AdminError> {
    request.validate().map_err(|m| rejected(&m))?;
    let mut result = AdminResult::default();
    match request.action.as_str() {
        "status" => {
            send(stream, 25, 0, &[]).await?;
            let value = answer(stream, 25).await?;
            match value {
                0 | 1 => {
                    result.status = Some(
                        if value == 1 {
                            "uninitialized"
                        } else {
                            "initialized"
                        }
                        .into(),
                    );
                    result.message = if value == 1 {
                        "网关尚未初始化"
                    } else {
                        "网关已初始化"
                    }
                    .into()
                }
                _ => return Err("初始化状态应答尚未确认".into()),
            }
        }
        "generate_sm2" => {
            result.message = generate_sm2(stream).await?.into();
        }
        "export_csr" => {
            // 同一会话单次操作内准备密钥，只有成功或已存在时才申请并下载CSR。
            generate_sm2(stream).await?;
            send(stream, 33, CSR_SUBJECT.len() as i32, CSR_SUBJECT).await?;
            match answer(stream, 33).await? {
                0 => return Err(rejected("SM2证书申请生成失败")),
                1 => {}
                _ => return Err("证书申请生成应答尚未确认".into()),
            }
            result.data = Some(download(stream, "device.csr", false).await?);
            result.message = "SM2证书申请文件已从网关读取".into()
        }
        "list_certificates" => {
            catalog.clear();
            let bytes = download(stream, "certlist.txt", true).await?;
            *catalog = parse_certificates(&bytes).map_err(AdminError::from)?;
            result.certificates = catalog.clone();
            result.message = "证书列表已刷新".into()
        }
        "read_certificate" | "delete_certificate" => {
            let name = request.name.as_deref().ok_or("缺少证书名")?;
            if !catalog.iter().any(|c| {
                c.name == name
                    && request
                        .certificate_type
                        .is_none_or(|t| t == c.certificate_type)
            }) {
                return Err(rejected("证书未在本会话已读取列表中，请先刷新证书列表"));
            }
            if request.action == "read_certificate" {
                result.data = Some(download(stream, name, false).await?);
                result.message = "证书内容已读取".into()
            } else {
                send(stream, 36, name.len() as i32, name.as_bytes()).await?;
                match answer(stream, 36).await? {
                    1 => {}
                    0 => return Err(rejected("装置拒绝删除证书")),
                    _ => return Err("删除证书应答未知，结果未确认".into()),
                }
                catalog.retain(|c| c.name != name);
                result.message = "证书已删除".into()
            }
        }
        "import_certificate" => {
            // 原厂先下载证书列表再允许上传；首次调用同样核对，防止同名覆盖。
            catalog.clear();
            let current = download(stream, "certlist.txt", true).await?;
            *catalog = parse_certificates(&current).map_err(AdminError::from)?;
            let name = request.name.as_deref().ok_or("缺少证书名")?;
            if catalog
                .iter()
                .any(|c| c.name.rsplit('/').next() == Some(name))
            {
                return Err(rejected("存在同名证书，请先核对证书列表"));
            }
            upload(stream, name, request.data.as_deref().ok_or("缺少证书内容")?).await?;
            send(
                stream,
                35,
                request.certificate_type.ok_or("缺少证书类别")? as i32,
                &[],
            )
            .await?;
            catalog.clear();
            match answer(stream, 35).await? {
                1 => result.message = "装置已确认导入证书，请刷新列表核对".into(),
                0 => return Err(rejected("装置证书验证失败")),
                _ => return Err("证书验证应答未知，结果未确认".into()),
            }
        }
        _ => return Err(rejected("不支持此管理员操作")),
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    // 原厂证书表去掉首字段五字节前缀，六种类别均保留。
    #[test]
    fn security_admin_certificate_catalog_fixture() {
        let result = parse_certificates(
            b"/log/cert_files/peer.cer,5,peer desc,\n/log/cert_files/manage.pem,4,manager,\n",
        )
        .unwrap();
        assert_eq!(
            result,
            vec![
                AdminCertificate {
                    name: "cert_files/peer.cer".into(),
                    certificate_type: 5
                },
                AdminCertificate {
                    name: "cert_files/manage.pem".into(),
                    certificate_type: 4
                }
            ]
        );
    }
    // 列表中的任意路径和未知类别不能获得后续读取或删除权限。
    #[test]
    fn security_admin_rejects_untrusted_catalog() {
        assert!(parse_certificates(b"/log/../secret,5,x,\n").is_err());
        assert!(parse_certificates(b"/log/cert_files/a.cer,6,x,\n").is_err());
    }
    fn request(action: &str) -> AdminRequest {
        AdminRequest {
            session_id: "fixture".into(),
            action: action.into(),
            certificate_type: None,
            name: None,
            data: None,
        }
    }
    async fn expect_frame(peer: &mut tokio::io::DuplexStream, cmd: i32, body: &[u8]) {
        assert_eq!(peer.read_i32().await.unwrap(), cmd);
        assert_eq!(peer.read_i32().await.unwrap(), body.len() as i32);
        let mut actual = vec![0; body.len()];
        peer.read_exact(&mut actual).await.unwrap();
        assert_eq!(actual, body);
    }
    async fn fixture_download(
        peer: &mut tokio::io::DuplexStream,
        base: &str,
        resolved: &str,
        data: &[u8],
    ) {
        expect_frame(peer, 4, base.as_bytes()).await;
        send(peer, 4, 0, &[]).await.unwrap();
        peer.write_u8(resolved.len() as u8).await.unwrap();
        peer.write_all(resolved.as_bytes()).await.unwrap();
        expect_frame(peer, 5, resolved.as_bytes()).await;
        send(peer, 5, data.len() as i32, data).await.unwrap();
        send(peer, 6, 0, &[]).await.unwrap();
        expect_frame(peer, 6, &[]).await;
    }
    // 密钥新生成或已存在时均先41再发送唯一33头，原样下载CSR并确认终止帧。
    #[tokio::test]
    async fn security_admin_csr_wire_fixture() {
        for key_result in [1, 3] {
            let (mut client, mut peer) = tokio::io::duplex(4096);
            let task = tokio::spawn(async move {
                expect_frame(&mut peer, 41, &[]).await;
                send(&mut peer, 41, key_result, &[]).await.unwrap();
                expect_frame(&mut peer, 33, CSR_SUBJECT).await;
                send(&mut peer, 33, 1, &[]).await.unwrap();
                fixture_download(&mut peer, "device.csr", "/log/device.csr", b"CSR fixture").await;
            });
            let result = execute(&mut client, &request("export_csr"), &mut vec![])
                .await
                .unwrap();
            assert_eq!(result.data.unwrap(), b"CSR fixture");
            task.await.unwrap();
        }
    }
    // 密钥生成失败、缺卡或未知结果立即停止，不能继续申请或下载CSR。
    #[tokio::test]
    async fn security_admin_csr_key_failure_stops_before_request() {
        for key_result in [0, 2, 99] {
            let (mut client, mut peer) = tokio::io::duplex(4096);
            let task = tokio::spawn(async move {
                expect_frame(&mut peer, 41, &[]).await;
                send(&mut peer, 41, key_result, &[]).await.unwrap();
                peer
            });
            let error = execute(&mut client, &request("export_csr"), &mut vec![])
                .await
                .unwrap_err();
            assert_eq!(error.fatal, key_result == 99);
            let mut peer = task.await.unwrap();
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), peer.read_u8())
                    .await
                    .is_err()
            );
        }
    }
    // 上传是1/2/3传输后35类别，222不得出现在网络上；整块需补零帧。
    #[tokio::test]
    async fn security_admin_import_wire_fixture() {
        let (mut client, mut peer) = tokio::io::duplex(8192);
        let task = tokio::spawn(async move {
            fixture_download(&mut peer, "certlist.txt", "/log/certlist.txt", b"").await;
            expect_frame(&mut peer, 1, b"peer.cer").await;
            send(&mut peer, 1, 0, &[]).await.unwrap();
            expect_frame(&mut peer, 2, &vec![0x5a; BLOCK]).await;
            expect_frame(&mut peer, 2, &[]).await;
            expect_frame(&mut peer, 3, &[]).await;
            send(&mut peer, 3, 0, &[]).await.unwrap();
            assert_eq!(peer.read_i32().await.unwrap(), 35);
            assert_eq!(peer.read_i32().await.unwrap(), 5);
            send(&mut peer, 35, 1, &[]).await.unwrap();
        });
        let mut req = request("import_certificate");
        req.name = Some("peer.cer".into());
        req.certificate_type = Some(5);
        req.data = Some(vec![0x5a; BLOCK]);
        execute(&mut client, &req, &mut vec![]).await.unwrap();
        task.await.unwrap();
    }
    // 只允许当前会话列表中的证书且类别一致，拒绝前不发送业务字节。
    #[tokio::test]
    async fn security_admin_read_delete_require_listed_identity() {
        let (mut client, mut peer) = tokio::io::duplex(1024);
        for action in ["read_certificate", "delete_certificate"] {
            let mut req = request(action);
            req.name = Some("cert_files/peer.cer".into());
            req.certificate_type = Some(4);
            let mut catalog = vec![AdminCertificate {
                name: "cert_files/peer.cer".into(),
                certificate_type: 5,
            }];
            assert!(
                !execute(&mut client, &req, &mut catalog)
                    .await
                    .unwrap_err()
                    .fatal
            );
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), peer.read_u8())
                .await
                .is_err()
        );
    }
    // 元信息返回任意登录资料路径或超限分块必须视为不可恢复协议错误。
    #[tokio::test]
    async fn security_admin_download_rejects_redirect_and_oversize() {
        for redirect in [true, false] {
            let (mut client, mut peer) = tokio::io::duplex(1024);
            let task = tokio::spawn(async move {
                expect_frame(&mut peer, 4, b"peer.cer").await;
                send(&mut peer, 4, 0, &[]).await.unwrap();
                let name = if redirect {
                    "/log/account.txt"
                } else {
                    "/log/cert_files/peer.cer"
                };
                peer.write_u8(name.len() as u8).await.unwrap();
                peer.write_all(name.as_bytes()).await.unwrap();
                if !redirect {
                    expect_frame(&mut peer, 5, name.as_bytes()).await;
                    send(&mut peer, 5, 1453, &[]).await.unwrap();
                }
            });
            assert!(
                download(&mut client, "cert_files/peer.cer", false)
                    .await
                    .unwrap_err()
                    .fatal
            );
            task.await.unwrap();
        }
    }
    // 原厂密钥已存在与缺卡应答不会混为成功，也不触发后续自动生成命令。
    #[tokio::test]
    async fn security_admin_sm2_response_branches() {
        for value in [0, 1, 2, 3, 99] {
            let (mut client, mut peer) = tokio::io::duplex(1024);
            let task = tokio::spawn(async move {
                expect_frame(&mut peer, 41, &[]).await;
                send(&mut peer, 41, value, &[]).await.unwrap();
            });
            let result = execute(&mut client, &request("generate_sm2"), &mut vec![]).await;
            if matches!(value, 1 | 3) {
                assert!(result.is_ok())
            } else {
                assert_eq!(result.unwrap_err().fatal, value == 99)
            }
            task.await.unwrap();
        }
    }
    // 六种证书角色和原设备较长名称均保留，不将导入长度限制套到存量证书。
    #[test]
    fn security_admin_all_categories_and_existing_long_names() {
        let mut data = String::new();
        for kind in 0..=5 {
            data.push_str(&format!(
                "/log/cert_files/long-existing-certificate-name-{kind}.CER,{kind},description,\n"
            ));
        }
        let catalog = parse_certificates(data.as_bytes()).unwrap();
        assert_eq!(
            catalog
                .iter()
                .map(|c| c.certificate_type)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4, 5]
        );
        assert!(!valid_upload_name("long-existing-certificate-name-0.CER"));
    }
    // IPC直接导入同样拒绝私钥和CSR、任意路径、非法类别和过大内容。
    #[test]
    fn security_admin_import_ipc_boundaries() {
        let mut req = request("import_certificate");
        req.name = Some("peer.CER".into());
        req.certificate_type = Some(5);
        req.data = Some(b"certificate fixture".to_vec());
        assert!(req.validate().is_ok());
        for data in [
            b"-----BEGIN PRIVATE KEY-----".as_slice(),
            b"-----BEGIN CERTIFICATE REQUEST-----".as_slice(),
            b"",
        ] {
            req.data = Some(data.to_vec());
            assert!(req.validate().is_err());
        }
        req.data = Some(vec![0; MAX_BYTES + 1]);
        assert!(req.validate().is_err());
        req.data = Some(vec![1]);
        req.name = Some("../peer.cer".into());
        assert!(req.validate().is_err());
        req.name = Some("peer.cer".into());
        req.certificate_type = Some(6);
        assert!(req.validate().is_err());
    }
    // 导入必须先刷新列表，在同名证书存在时不能发送文件上传帧。
    #[tokio::test]
    async fn security_admin_import_refresh_prevents_duplicate_overwrite() {
        let (mut client, mut peer) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move {
            fixture_download(
                &mut peer,
                "certlist.txt",
                "/log/certlist.txt",
                b"/log/cert_files/peer.cer,5,existing,\n",
            )
            .await;
            peer
        });
        let mut req = request("import_certificate");
        req.name = Some("peer.cer".into());
        req.certificate_type = Some(5);
        req.data = Some(vec![1]);
        let error = execute(&mut client, &req, &mut vec![]).await.unwrap_err();
        assert!(!error.fatal);
        assert!(error.message.contains("同名"));
        let mut peer = task.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), peer.read_u8())
                .await
                .is_err()
        );
    }
}
