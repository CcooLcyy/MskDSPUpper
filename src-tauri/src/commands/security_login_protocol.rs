//! 纵密登录后的最小协议边界；敏感报文及账号表只在内存中短暂保留。
use sm3::{Digest, Sm3};
use std::collections::HashSet;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::{Zeroize, Zeroizing};

const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_BLOCK_BYTES: usize = 1452;
const ADMIN_DEFAULT_HASH: &str = "3CCC0DAEEA873236CD1FEDCC87F6370A8330064F8F0C72B19879C0779FF695F0";
const SECURE_DEFAULT_HASH: &str =
    "FB6D77EBDD7AF2C4BF60A44367CEE57B069DDE6C6BF6F96206680B39CD78C695";

#[derive(Debug, PartialEq, Eq)]
pub(super) struct LoginInfo {
    pub(super) count: u8,
    pub(super) password_expired: bool,
    pub(super) last_login: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Reply {
    CredentialsRejected,
    Locked(Option<u32>),
    UkeyUnavailable,
    PinRejected,
    UkeyLimit,
    LicenseRequired,
    Unverified,
    Accepted(LoginInfo),
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct DeviceInfo {
    pub(super) version: String,
}

pub(super) async fn read_login_reply<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Reply, &'static str> {
    let command = reader.read_i32().await.map_err(|_| "登录应答不完整")?;
    if command != 12 {
        return Err("登录应答命令不匹配");
    }
    let result = reader.read_i32().await.map_err(|_| "登录应答不完整")?;
    tracing::info!(command, bytes = 8, "收到纵密登录应答头，按已核实边界解析");
    match result {
        0 => {
            let length = reader.read_u8().await.map_err(|_| "失败应答不完整")?;
            if length == 0 {
                return Ok(Reply::CredentialsRejected);
            }
            if length > 127 {
                return Err("锁定应答长度无效");
            }
            let mut seconds = vec![0; length as usize];
            reader
                .read_exact(&mut seconds)
                .await
                .map_err(|_| "锁定应答不完整")?;
            let seconds = std::str::from_utf8(&seconds)
                .ok()
                .filter(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|text| text.parse().ok());
            Ok(Reply::Locked(seconds))
        }
        -2 => Ok(Reply::UkeyUnavailable),
        -1 => Ok(Reply::PinRejected),
        -4 => Ok(Reply::UkeyLimit),
        1 => Ok(Reply::LicenseRequired),
        17 => {
            let count = reader.read_u8().await.map_err(|_| "登录资料不完整")?;
            let update = reader.read_u8().await.map_err(|_| "登录资料不完整")?;
            let length = reader.read_u8().await.map_err(|_| "登录资料不完整")?;
            if !matches!(update, 0 | 2) || length != 14 {
                return Err("登录资料标志或时间长度无效");
            }
            let mut time = [0; 14];
            reader
                .read_exact(&mut time)
                .await
                .map_err(|_| "登录资料不完整")?;
            if !valid_timestamp(&time) {
                return Err("登录资料时间无效");
            }
            let last_login = String::from_utf8(time.to_vec()).map_err(|_| "登录资料编码无效")?;
            tracing::info!(command, bytes = 25, "纵密登录应答结构通过校验");
            Ok(Reply::Accepted(LoginInfo {
                count,
                password_expired: update == 2,
                last_login,
            }))
        }
        // 未知返回字段不读取推测尾部，也不能据其中的过期位创建改密挑战。
        _ => Ok(Reply::Unverified),
    }
}

fn valid_timestamp(value: &[u8]) -> bool {
    if value.len() != 14 || !value.iter().all(u8::is_ascii_digit) {
        return false;
    }
    let number = |start: usize, end: usize| {
        value[start..end]
            .iter()
            .fold(0u32, |sum, byte| sum * 10 + u32::from(byte - b'0'))
    };
    let year = number(0, 4);
    let month = number(4, 6);
    let day = number(6, 8);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return false,
    };
    year > 0
        && (1..=days).contains(&day)
        && number(8, 10) < 24
        && number(10, 12) < 60
        && number(12, 14) < 60
}

fn is_default_hash(username: &str, digest: &str) -> bool {
    let expected = match username {
        "admin" | "audit" => ADMIN_DEFAULT_HASH,
        "secure" => SECURE_DEFAULT_HASH,
        _ => return false,
    };
    expected.eq_ignore_ascii_case(digest)
}

pub(super) fn default_password(username: &str, password: &str) -> bool {
    // nuc980 的账号认证模式与使用哪组 TLS 证书无关；这里不接入旧 UKey PIN 分支。
    is_default_hash(username, &password_digest("", password))
}

pub(super) fn password_digest(username: &str, password: &str) -> Zeroizing<String> {
    let mut hasher = Sm3::new();
    hasher.update(username.as_bytes());
    hasher.update(password.as_bytes());
    let mut digest = hasher.finalize();
    let mut encoded = Zeroizing::new(String::with_capacity(64));
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in digest.iter() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 15) as usize] as char);
    }
    digest.as_mut_slice().zeroize();
    encoded
}

fn valid_username(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 32
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!@#$_-+.=*?".contains(&byte))
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn validate_new_password(
    new_password: &str,
    old_digest: &str,
    username: &str,
) -> Result<(), &'static str> {
    if !valid_username(username) || !valid_digest(old_digest) {
        return Err("改密账号或原密码摘要无效，请重新登录");
    }
    if !(8..=16).contains(&new_password.len()) {
        return Err("新密码长度必须为 8 至 16 位");
    }
    let mut categories = 0u8;
    for byte in new_password.bytes() {
        categories |= match byte {
            b'a'..=b'z' => 1,
            b'A'..=b'Z' => 2,
            b'0'..=b'9' => 4,
            // 严格采用 XOPUtil.str2；提示文本中的百分号不在实际允许集合中。
            b'!' | b'@' | b'#' | b'$' | b'_' | b'.' | b'-' | b'+' | b'=' | b'*' | b'?' => 8,
            _ => return Err("新密码只能使用英文字母、数字和 !@#$_.-+=*?，不能包含空格"),
        };
    }
    if categories.count_ones() < 3 {
        return Err("新密码必须包含大写字母、小写字母、数字、允许特殊字符中的至少三类");
    }
    if new_password.contains(username) {
        return Err("新密码不能包含用户名");
    }
    if password_digest(username, new_password).eq_ignore_ascii_case(old_digest) {
        return Err("新旧密码不能相同");
    }
    if default_password(username, new_password) {
        return Err("新密码不能仍为默认密码");
    }
    Ok(())
}

pub(super) fn encode_password_change(
    username: &str,
    old_digest: &str,
    new_password: &str,
) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    validate_new_password(new_password, old_digest, username)?;
    let new_digest = password_digest(username, new_password);
    let mut packet = Zeroizing::new(Vec::with_capacity(144 + username.len()));
    packet.extend_from_slice(&14i32.to_be_bytes());
    for field in [username, old_digest, new_digest.as_str()] {
        packet.extend_from_slice(&(field.len() as i32).to_be_bytes());
        packet.extend_from_slice(field.as_bytes());
    }
    Ok(packet)
}

pub(super) async fn change_password<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    username: &str,
    old_digest: &str,
    new_password: &str,
) -> Result<(), &'static str> {
    let packet = encode_password_change(username, old_digest, new_password)?;
    tracing::info!(
        command = 14,
        bytes = packet.len(),
        "发送纵密改密请求，不记录敏感报文"
    );
    // 写入可能已经部分到达装置；所有错误均交给上层消费挑战，禁止自动重试。
    stream
        .write_all(&packet)
        .await
        .map_err(|_| "改密请求发送失败，结果未确认，请先核实装置状态")?;
    stream
        .flush()
        .await
        .map_err(|_| "改密请求发送失败，结果未确认，请先核实装置状态")?;
    drop(packet);
    let command = stream
        .read_i32()
        .await
        .map_err(|_| "改密应答不完整，结果未确认，请先核实装置状态")?;
    if command != 14 {
        return Err("改密应答命令不匹配，结果未确认，请先核实装置状态");
    }
    let result = stream
        .read_i32()
        .await
        .map_err(|_| "改密应答不完整，结果未确认，请先核实装置状态")?;
    if result != 1 {
        tracing::warn!(command, bytes = 8, "纵密未确认改密成功");
        return Err("装置拒绝修改密码，请重新登录后核实");
    }
    tracing::info!(
        command,
        bytes = 8,
        "纵密已确认改密成功，必须关闭连接后重新登录"
    );
    Ok(())
}

pub(super) async fn initialize<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    username: &str,
    role: u8,
) -> Result<DeviceInfo, &'static str> {
    if !valid_username(username) || !(1..=3).contains(&role) {
        return Err("登录资料校验的账号或角色无效");
    }
    let accounts = read_fixed_file(stream, "account.txt").await?;
    validate_account(&accounts, username, role)?;
    drop(accounts);
    let bytes = read_fixed_file(stream, "version.txt").await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "装置版本编码无效")?;
    let (first, _) = text.split_once('\n').ok_or("装置版本缺少完整首行")?;
    let version = first.trim_end_matches('\r');
    if version.is_empty()
        || version.len() > 128
        || !version.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    {
        return Err("装置版本内容无效");
    }
    let version = version.replace("wireless", "").trim().to_string();
    if version.is_empty() {
        return Err("装置版本内容无效");
    }
    tracing::info!("纵密固定登录资料及账号角色校验通过");
    Ok(DeviceInfo { version })
}

async fn send_read_command<S: AsyncWrite + Unpin>(
    stream: &mut S,
    command: i32,
    filename: &str,
) -> Result<(), &'static str> {
    let mut packet = Vec::with_capacity(8 + filename.len());
    packet.extend_from_slice(&command.to_be_bytes());
    packet.extend_from_slice(&(filename.len() as i32).to_be_bytes());
    packet.extend_from_slice(filename.as_bytes());
    tracing::info!(command, bytes = packet.len(), "发送纵密固定资料读取命令");
    stream
        .write_all(&packet)
        .await
        .map_err(|_| "登录资料读取请求发送失败")?;
    stream.flush().await.map_err(|_| "登录资料读取请求发送失败")
}

async fn read_fixed_file<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    filename: &str,
) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    if !matches!(filename, "account.txt" | "version.txt") {
        return Err("登录资料文件不在固定允许范围内");
    }
    send_read_command(stream, 4, filename).await?;
    let command = stream
        .read_i32()
        .await
        .map_err(|_| "登录资料元信息不完整")?;
    if command != 4 {
        return Err("登录资料元信息命令不匹配");
    }
    let status = stream
        .read_i32()
        .await
        .map_err(|_| "登录资料元信息不完整")?;
    // 原客户端状态1允许用户另选备份，本流程始终读取当前固定文件。
    if !matches!(status, 0 | 1) {
        return Err("装置拒绝读取固定登录资料");
    }
    let length = stream.read_u8().await.map_err(|_| "登录资料文件名不完整")? as usize;
    if length == 0 || length > 127 {
        return Err("登录资料文件名长度无效");
    }
    let mut name = vec![0; length];
    stream
        .read_exact(&mut name)
        .await
        .map_err(|_| "登录资料文件名不完整")?;
    if name != filename.as_bytes() {
        return Err("登录资料文件名与固定请求不一致");
    }
    send_read_command(stream, 5, filename).await?;
    let mut body = Zeroizing::new(Vec::new());
    loop {
        let command = stream
            .read_i32()
            .await
            .map_err(|_| "登录资料数据帧不完整")?;
        let value = stream
            .read_i32()
            .await
            .map_err(|_| "登录资料数据帧不完整")?;
        match command {
            5 => {
                if value <= 0
                    || value as usize > MAX_BLOCK_BYTES
                    || body.len() + value as usize > MAX_FILE_BYTES
                {
                    return Err("登录资料分块长度无效或文件超出上限");
                }
                let start = body.len();
                body.resize(start + value as usize, 0);
                stream
                    .read_exact(&mut body[start..])
                    .await
                    .map_err(|_| "登录资料数据分块不完整")?;
                tracing::info!(command, bytes = value, "收到纵密登录资料分块，不记录正文");
            }
            6 => {
                // 终止第二字段未证实为长度；仅按原程序的非负及版本非零条件校验。
                if value < 0
                    || value as usize > MAX_FILE_BYTES
                    || (filename == "version.txt" && value == 0)
                    || body.is_empty()
                {
                    return Err("登录资料终止字段无效");
                }
                send_read_command(stream, 6, "").await?;
                tracing::info!(
                    command,
                    bytes = body.len(),
                    "纵密固定资料读取完成，不记录正文"
                );
                return Ok(body);
            }
            _ => return Err("登录资料数据帧命令不匹配"),
        }
    }
}

fn validate_account(data: &[u8], username: &str, role: u8) -> Result<(), &'static str> {
    // 原 Windows 客户端按系统代码页读取，兼容 UTF-8 及严格 GBK，禁止替换损坏字符。
    let text = match std::str::from_utf8(data) {
        Ok(text) => Zeroizing::new(text.to_string()),
        Err(_) => {
            let (decoded, errors) = encoding_rs::GBK.decode_without_bom_handling(data);
            if errors {
                return Err("账号资料编码无效");
            }
            Zeroizing::new(decoded.into_owned())
        }
    };
    let mut names = HashSet::new();
    let mut matched = false;
    for line in text
        .trim_start_matches('\u{feff}')
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let fields: Vec<_> = line.trim_end_matches('\r').split(',').collect();
        if fields.len() != 8
            || !valid_username(fields[0])
            || !matches!(fields[1], "1" | "2" | "3")
            || fields
                .iter()
                .any(|field| field.chars().any(char::is_control))
            || !names.insert(fields[0])
        {
            return Err("账号资料结构无效");
        }
        if fields[0] == username {
            // 原 UserVo 仅将错误次数及第八列用于告警展示，不据其决定登录身份。
            if fields[1].as_bytes()[0] - b'0' != role {
                return Err("账号资料角色不匹配");
            }
            matched = true;
        }
    }
    if !matched {
        return Err("账号资料未包含当前登录身份");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Cursor,
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::ReadBuf;

    fn pair(command: i32, second: i32) -> Vec<u8> {
        [command.to_be_bytes(), second.to_be_bytes()].concat()
    }

    fn login(ret: i32, update: u8, time: &[u8]) -> Vec<u8> {
        let mut bytes = pair(12, ret);
        bytes.extend_from_slice(&[0, update, time.len() as u8]);
        bytes.extend_from_slice(time);
        bytes
    }

    fn transfer(name: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = pair(4, 0);
        bytes.push(name.len() as u8);
        bytes.extend_from_slice(name.as_bytes());
        for block in body.chunks(MAX_BLOCK_BYTES) {
            bytes.extend(pair(5, block.len() as i32));
            bytes.extend_from_slice(block);
        }
        bytes.extend(pair(6, body.len() as i32));
        bytes
    }

    fn account(username: &str, role: u8) -> Vec<u8> {
        format!("{username},{role},fixture,0,fixture,0,20261026143040,1\n").into_bytes()
    }

    fn initialization(username: &str, role: u8) -> Vec<u8> {
        let mut bytes = transfer("account.txt", &account(username, role));
        bytes.extend(transfer("version.txt", b"NSS3000 V1.1.E.4242\nfixture\n"));
        bytes
    }

    struct Fixture {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
        fragment: usize,
        flushes: usize,
        fail_write_after: Option<usize>,
        fail_flush: bool,
    }
    impl Fixture {
        fn new(input: Vec<u8>) -> Self {
            Self {
                input: Cursor::new(input),
                output: Vec::new(),
                fragment: 1,
                flushes: 0,
                fail_write_after: None,
                fail_flush: false,
            }
        }
    }
    impl AsyncRead for Fixture {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let pos = self.input.position() as usize;
            let count = self
                .fragment
                .min(buf.remaining())
                .min(self.input.get_ref().len() - pos);
            buf.put_slice(&self.input.get_ref()[pos..pos + count]);
            self.input.set_position((pos + count) as u64);
            Poll::Ready(Ok(()))
        }
    }
    impl AsyncWrite for Fixture {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self
                .fail_write_after
                .is_some_and(|limit| self.output.len() >= limit)
            {
                return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
            }
            let count = self.fragment.min(bytes.len());
            self.output.extend_from_slice(&bytes[..count]);
            Poll::Ready(Ok(count))
        }
        fn poll_flush(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            self.flushes += 1;
            if self.fail_flush {
                return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
            }
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    // 实测返回码及完整时间允许逐字节分片，过期标志保留为待改密信息。
    #[tokio::test]
    async fn accepts_only_verified_login_structure() {
        for update in [0, 2] {
            let mut stream = Fixture::new(login(17, update, b"19700101032313"));
            assert!(
                matches!(read_login_reply(&mut stream).await.unwrap(), Reply::Accepted(LoginInfo { count: 0, password_expired, last_login }) if password_expired == (update == 2) && last_login == "19700101032313")
            );
            assert!(stream.output.is_empty());
        }
    }

    // 未知返回码即使附有过期标志也不能建立身份或开放改密。
    #[tokio::test]
    async fn unknown_return_never_becomes_accepted() {
        for ret in [-9, 2, 16, 18, i32::MAX] {
            let mut bytes = Cursor::new(login(ret, 2, b"20261026143040"));
            assert_eq!(
                read_login_reply(&mut bytes).await.unwrap(),
                Reply::Unverified
            );
        }
    }

    // 已知拒绝、锁定与硬件许可分支不发送后续命令。
    #[tokio::test]
    async fn recognizes_known_rejection_branches() {
        for (ret, expected) in [
            (-2, Reply::UkeyUnavailable),
            (-1, Reply::PinRejected),
            (-4, Reply::UkeyLimit),
            (1, Reply::LicenseRequired),
        ] {
            let mut stream = Fixture::new(pair(12, ret));
            assert_eq!(read_login_reply(&mut stream).await.unwrap(), expected);
            assert!(stream.output.is_empty());
        }
        let mut rejected = Fixture::new([pair(12, 0), vec![0]].concat());
        assert_eq!(
            read_login_reply(&mut rejected).await.unwrap(),
            Reply::CredentialsRejected
        );
        let mut locked = Fixture::new([pair(12, 0), vec![2], b"60".to_vec()].concat());
        assert_eq!(
            read_login_reply(&mut locked).await.unwrap(),
            Reply::Locked(Some(60))
        );
    }

    // 锁定秒数字段损坏仍保持锁定，超长字段不继续解析。
    #[tokio::test]
    async fn rejects_malformed_lock_fields() {
        for text in ["xx", "42949672960"] {
            let mut bytes = Cursor::new(
                [
                    pair(12, 0),
                    vec![text.len() as u8],
                    text.as_bytes().to_vec(),
                ]
                .concat(),
            );
            assert_eq!(
                read_login_reply(&mut bytes).await.unwrap(),
                Reply::Locked(None)
            );
        }
        let mut bytes = Cursor::new([pair(12, 0), vec![128]].concat());
        assert!(read_login_reply(&mut bytes).await.is_err());
    }

    // 截断、错误命令、非法日期与未知标志均不能作为正常登录。
    #[tokio::test]
    async fn rejects_truncated_and_malformed_login() {
        let valid = login(17, 0, b"20261026143040");
        for length in 0..valid.len() {
            assert!(read_login_reply(&mut Cursor::new(&valid[..length]))
                .await
                .is_err());
        }
        for time in [
            b"20260230143040".as_slice(),
            b"20261301143040",
            b"20261026243040",
            b"00000101000000",
            b"20261026146000",
            b"2026102614306x",
            b"2026102614304",
        ] {
            assert!(read_login_reply(&mut Cursor::new(login(17, 0, time)))
                .await
                .is_err());
        }
        assert!(
            read_login_reply(&mut Cursor::new(login(17, 1, b"20261026143040")))
                .await
                .is_err()
        );
        assert!(read_login_reply(&mut Cursor::new(pair(99, 17)))
            .await
            .is_err());
    }

    // 默认摘要按实际用户名隔离，只纳入核实的两个摘要，不保留默认明文。
    #[test]
    fn default_hashes_are_bound_to_nuc980_roles() {
        assert!(is_default_hash("admin", ADMIN_DEFAULT_HASH));
        assert!(is_default_hash("audit", ADMIN_DEFAULT_HASH));
        assert!(is_default_hash("secure", SECURE_DEFAULT_HASH));
        assert!(!is_default_hash("secure", ADMIN_DEFAULT_HASH));
        assert!(!is_default_hash("admin", SECURE_DEFAULT_HASH));
        assert!(!is_default_hash("operator", ADMIN_DEFAULT_HASH));
        assert!(!default_password("admin", "Fixture9!"));
    }

    // 摘要按用户名与密码依次计算，输出原程序使用的大写十六进制。
    #[test]
    fn digest_matches_sm3_concatenation() {
        assert!(
            *password_digest("a", "bc")
                == "66C7F0F462EEEDD9D1F2D46BDC10E4E24167C4875CF2F7A2297DA02B8F4BA8E0"
        );
    }

    // 密码长度、允许字符及至少三类复杂度与原改密面板一致。
    #[test]
    fn password_rules_cover_boundaries_and_username() {
        let old = password_digest("admin", "Fixture8!");
        for valid in [
            "Abcdef12",
            "abcdef1!",
            "ABCDEF1!",
            "Abcde!xy",
            "Abcdef1234567890",
        ] {
            assert!(validate_new_password(valid, &old, "admin").is_ok());
        }
        for invalid in [
            "Abc123!",
            "Abcdef12345678901",
            "abcdefgh",
            "ABCDEFGH",
            "Abcdefgh",
            "Abc123%*",
            "Abc123()",
            "Abc123 !",
            "Abc123中",
            "admin12!A",
            "Fixture8!",
        ] {
            assert!(validate_new_password(invalid, &old, "admin").is_err());
        }
    }

    // 命令14的用户名和新旧摘要均使用大端长度，包中不保留明文密码。
    #[test]
    fn change_packet_uses_exact_big_endian_fields() {
        let old = password_digest("admin", "Fixture8!");
        let packet = encode_password_change("admin", &old, "Fixture9!").unwrap();
        let new = password_digest("admin", "Fixture9!");
        let expected = [
            pair(14, 5),
            b"admin".to_vec(),
            64i32.to_be_bytes().to_vec(),
            old.as_bytes().to_vec(),
            64i32.to_be_bytes().to_vec(),
            new.as_bytes().to_vec(),
        ]
        .concat();
        assert!(packet.as_slice() == expected.as_slice());
        assert!(!packet.windows(9).any(|part| part == b"Fixture9!"));
        assert!(encode_password_change("", &old, "Fixture9!").is_err());
        assert!(encode_password_change("admin", "invalid", "Fixture9!").is_err());
    }

    // 改密只发送一次并仅在命令14及结果1匹配时确认成功。
    #[tokio::test]
    async fn change_requires_matching_success_and_flushes_once() {
        let old = password_digest("admin", "Fixture8!");
        for (command, result, ok) in [
            (14, 1, true),
            (14, 0, false),
            (14, -1, false),
            (13, 1, false),
        ] {
            let mut stream = Fixture::new(pair(command, result));
            assert_eq!(
                change_password(&mut stream, "admin", &old, "Fixture9!")
                    .await
                    .is_ok(),
                ok
            );
            assert_eq!(stream.output.len(), 149);
            assert_eq!(stream.flushes, 1);
        }
        let mut stream = Fixture::new(vec![]);
        assert!(change_password(&mut stream, "admin", &old, "Fixture9!")
            .await
            .is_err());
        assert_eq!(stream.output.len(), 149);
        assert_eq!(stream.flushes, 1);
    }

    // 本地校验失败时不能向装置发送任何改密命令。
    #[tokio::test]
    async fn invalid_password_is_never_sent() {
        let mut stream = Fixture::new(pair(14, 1));
        let old = password_digest("admin", "Fixture8!");
        assert!(change_password(&mut stream, "admin", &old, "weak")
            .await
            .is_err());
        assert!(stream.output.is_empty());
        assert_eq!(stream.flushes, 0);
    }

    // 初始化严格只读两个固定文件，完成后仅暴露版本信息。
    #[tokio::test]
    async fn initializes_each_role_using_only_fixed_read_commands() {
        for (username, role) in [("admin", 1), ("secure", 2), ("audit", 3)] {
            let mut stream = Fixture::new(initialization(username, role));
            assert_eq!(
                initialize(&mut stream, username, role)
                    .await
                    .unwrap()
                    .version,
                "NSS3000 V1.1.E.4242"
            );
            let mut expected = Vec::new();
            for name in ["account.txt", "version.txt"] {
                for command in [4, 5] {
                    expected.extend(pair(command, name.len() as i32));
                    expected.extend_from_slice(name.as_bytes());
                }
                expected.extend(pair(6, 0));
            }
            assert!(stream.output == expected);
            assert_eq!(
                stream.input.position() as usize,
                stream.input.get_ref().len()
            );
        }
    }

    // 账号与角色必须准确匹配，重复账号和畸形必要字段失败关闭。
    #[tokio::test]
    async fn account_validation_prevents_role_or_identity_mismatch() {
        for bytes in [
            account("admin", 2),
            account("audit", 3),
            [account("admin", 1), account("admin", 1)].concat(),
            b"admin,1\n".to_vec(),
            b"admin,1,fixture,0,x\x00,0,20261026143040,1\n".to_vec(),
            b"admin,4,fixture,0,x,0,20261026143040,1\n".to_vec(),
            vec![0xff],
        ] {
            let mut stream = Fixture::new(transfer("account.txt", &bytes));
            assert!(initialize(&mut stream, "admin", 1).await.is_err());
            assert!(!stream.output.windows(11).any(|part| part == b"version.txt"));
        }
        let mut stream = Fixture::new(initialization("admin", 1));
        assert!(initialize(&mut stream, "admin", 4).await.is_err());
        assert!(stream.output.is_empty());
    }

    // 服务端不能将固定读取重定向为其他路径或备份列表。
    #[tokio::test]
    async fn refuses_metadata_redirection_and_failure() {
        for (command, status, name) in [
            (4, 0, "other.txt"),
            (4, 1, "account.txt,backup"),
            (99, 0, "account.txt"),
            (4, 2, "account.txt"),
        ] {
            let mut bytes = pair(command, status);
            bytes.push(name.len() as u8);
            bytes.extend_from_slice(name.as_bytes());
            let mut stream = Fixture::new(bytes);
            assert!(initialize(&mut stream, "admin", 1).await.is_err());
            assert_eq!(stream.output.len(), 19);
        }
        let mut stream = Fixture::new(pair(4, -1));
        assert!(initialize(&mut stream, "admin", 1).await.is_err());
        assert_eq!(stream.output.len(), 19);
    }

    // 分块长度、终止命令和总长度必须受限，空块不能造成无限循环。
    #[tokio::test]
    async fn rejects_malformed_or_oversized_file_blocks() {
        for (command, size) in [
            (5, -1),
            (5, 1453),
            (5, 0),
            (99, 1),
            (6, -1),
            (6, MAX_FILE_BYTES as i32 + 1),
        ] {
            let mut bytes = pair(4, 0);
            bytes.push(11);
            bytes.extend_from_slice(b"account.txt");
            bytes.extend(pair(command, size));
            assert!(initialize(&mut Fixture::new(bytes), "admin", 1)
                .await
                .is_err());
        }
        let oversized = vec![b'x'; MAX_FILE_BYTES + 1];
        assert!(initialize(
            &mut Fixture::new(transfer("account.txt", &oversized)),
            "admin",
            1
        )
        .await
        .is_err());
    }

    // 每个截断位置均失败，错误版本不能建立已登录会话。
    #[tokio::test]
    async fn rejects_truncated_initialization_and_invalid_versions() {
        let valid = initialization("admin", 1);
        for length in 0..valid.len() {
            assert!(
                initialize(&mut Fixture::new(valid[..length].to_vec()), "admin", 1)
                    .await
                    .is_err()
            );
        }
        for version in [
            b"".as_slice(),
            b"\n",
            b"bad\x00version\n",
            b"\xff\n",
            b"version without newline",
        ] {
            let mut bytes = transfer("account.txt", &account("admin", 1));
            bytes.extend(transfer("version.txt", version));
            assert!(initialize(&mut Fixture::new(bytes), "admin", 1)
                .await
                .is_err());
        }
    }

    // 多个短分块不会提前结束读取，UTF-8账号描述仅作内存校验。
    #[test]
    fn parses_account_metadata_without_exposing_it() {
        let text = "admin,1,fixture,0,管理员,0,19700101032313,1\r\n";
        assert!(validate_account(text.as_bytes(), "admin", 1).is_ok());
    }

    // 旧Windows客户端的GBK描述可以读取，损坏代码页必须失败。
    #[test]
    fn accepts_strict_gbk_but_rejects_corrupt_encoding() {
        let text = "admin,1,fixture,0,管理员,0,19700101032313,1\r\n";
        let (encoded, _, errors) = encoding_rs::GBK.encode(text);
        assert!(!errors);
        assert!(validate_account(&encoded, "admin", 1).is_ok());
        assert!(
            validate_account(b"admin,1,fixture,0,\xff,0,19700101032313,1\n", "admin", 1).is_err()
        );
    }

    // 登录已通过后，第八列为0不改变当前账号与角色的资料匹配结果。
    #[tokio::test]
    async fn zero_eighth_field_does_not_override_accepted_login() {
        let mut stream = Fixture::new(
            [
                login(17, 0, b"20261026143040"),
                transfer("account.txt", b"admin,1,fixture,0,x,0,20261026143040,0\n"),
                transfer("version.txt", b"NSS3000 V1.1.E.4242\n"),
            ]
            .concat(),
        );
        assert!(matches!(
            read_login_reply(&mut stream).await.unwrap(),
            Reply::Accepted(_)
        ));
        assert!(initialize(&mut stream, "admin", 1).await.is_ok());
    }

    // 辅助列不参与身份授权，空摘要、显示用时间和告警字段不能推翻已接受的登录。
    #[tokio::test]
    async fn auxiliary_account_fields_do_not_determine_authorization() {
        for row in [
            "admin,1,,0,x,0,20261026143040,1\n",
            "admin,1,fixture,0,x,未锁定,首次登录,0\n",
            "admin,1,fixture,未知,x,,,其他\n",
        ] {
            let mut bytes = transfer("account.txt", row.as_bytes());
            bytes.extend(transfer("version.txt", b"NSS3000 V1.1.E.4242\n"));
            assert!(initialize(&mut Fixture::new(bytes), "admin", 1)
                .await
                .is_ok());
            assert!(validate_account(row.as_bytes(), "admin", 2).is_err());
        }
    }

    // 总长刚好256KiB允许接收，不将终止第二字段误认为真实总长。
    #[tokio::test]
    async fn accepts_exact_file_limit_and_independent_terminal_field() {
        let body = vec![b'x'; MAX_FILE_BYTES];
        let mut stream = Fixture::new(transfer("account.txt", &body));
        stream.fragment = MAX_BLOCK_BYTES;
        assert_eq!(
            read_fixed_file(&mut stream, "account.txt")
                .await
                .unwrap()
                .len(),
            MAX_FILE_BYTES
        );
        for terminal in [0i32, 1] {
            let mut bytes = transfer("account.txt", b"abc");
            let length = bytes.len();
            bytes[length - 4..].copy_from_slice(&terminal.to_be_bytes());
            assert!(read_fixed_file(&mut Fixture::new(bytes), "account.txt")
                .await
                .is_ok());
        }
    }

    // 多个短块必须读到命令6；版本终止0按原客户端要求拒绝。
    #[tokio::test]
    async fn short_chunks_do_not_terminate_the_transfer() {
        let mut bytes = pair(4, 0);
        bytes.push(11);
        bytes.extend_from_slice(b"account.txt");
        for part in [b"a".as_slice(), b"bc"] {
            bytes.extend(pair(5, part.len() as i32));
            bytes.extend_from_slice(part);
        }
        bytes.extend(pair(6, 0));
        assert!(
            read_fixed_file(&mut Fixture::new(bytes), "account.txt")
                .await
                .unwrap()
                .as_slice()
                == b"abc"
        );
        let mut version = transfer("version.txt", b"NSS3000\n");
        let length = version.len();
        version[length - 4..].copy_from_slice(&0i32.to_be_bytes());
        assert!(read_fixed_file(&mut Fixture::new(version), "version.txt")
            .await
            .is_err());
    }

    // 改密部分写入和刷新失败均不得重试或读取成功应答。
    #[tokio::test]
    async fn partial_write_and_flush_errors_never_retry_change() {
        let old = password_digest("admin", "Fixture8!");
        let mut partial = Fixture::new(pair(14, 1));
        partial.fail_write_after = Some(10);
        assert!(change_password(&mut partial, "admin", &old, "Fixture9!")
            .await
            .is_err());
        assert_eq!(partial.output.len(), 10);
        assert_eq!(partial.flushes, 0);
        assert_eq!(partial.input.position(), 0);
        let mut failed_flush = Fixture::new(pair(14, 1));
        failed_flush.fail_flush = true;
        assert!(
            change_password(&mut failed_flush, "admin", &old, "Fixture9!")
                .await
                .is_err()
        );
        assert_eq!(failed_flush.output.len(), 149);
        assert_eq!(failed_flush.flushes, 1);
        assert_eq!(failed_flush.input.position(), 0);
    }

    // 非闰年2月29日拒绝，闰年与世纪规则按基本日历处理。
    #[test]
    fn timestamps_validate_leap_years_and_ranges() {
        for time in [b"20240229000000", b"20000229235959"] {
            assert!(valid_timestamp(time));
        }
        for time in [
            b"20230229000000",
            b"19000229000000",
            b"20261000000000",
            b"20261001235960",
        ] {
            assert!(!valid_timestamp(time));
        }
    }
}
