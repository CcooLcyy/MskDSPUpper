//! 隧道运行状态解析；保留未知状态码及十进制计数，不推断未提供的算法。
use serde::Serialize;
use std::{borrow::Cow, collections::HashSet};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TunnelStatus {
    pub id: i32,
    pub state: i32,
    pub hot_state: i32,
    pub local_ip: String,
    pub peer_ip: String,
    pub encrypt_count: String,
    pub decrypt_count: String,
    pub encrypt_errors: String,
    pub decrypt_errors: String,
    pub error_info: Option<String>,
    pub algorithm: Option<String>,
}

// 原程序 ConfigModel.verfityTunnelId 的实际上限为102400，界面提示10240并不准确。
pub(super) fn valid_id(id: i32) -> bool {
    (1..=102400).contains(&id)
}

pub(super) fn parse(data: &[u8]) -> Result<Vec<TunnelStatus>, &'static str> {
    let text = match std::str::from_utf8(data) {
        Ok(text) => Cow::Borrowed(text),
        Err(_) => {
            let (text, errors) = encoding_rs::GBK.decode_without_bom_handling(data);
            if errors {
                return Err("隧道状态文件编码无效");
            }
            text
        }
    };
    let mut rows = Vec::new();
    let mut ids = HashSet::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 保留中间空字段，避免缺失错误信息时把算法向前移动。
        let line = line.strip_suffix(',').unwrap_or(line);
        let fields: Vec<_> = line.split(',').map(str::trim).collect();
        if !(14..=16).contains(&fields.len())
            || line.chars().any(char::is_control)
            || fields.iter().any(|field| field.len() > 4096)
        {
            return Err("隧道状态字段不完整或格式无效");
        }
        let number = |i: usize| fields[i].parse::<i32>().map_err(|_| "隧道状态数值无效");
        let id = number(0)?;
        if !valid_id(id) || !ids.insert(id) || rows.len() >= 10240 {
            return Err("隧道ID无效、重复或记录过多");
        }
        if fields[3].is_empty() || fields[4].is_empty() {
            return Err("隧道本端或对端地址缺失");
        }
        for count in &fields[5..9] {
            if count.is_empty() || !count.bytes().all(|b| b.is_ascii_digit()) {
                return Err("隧道加解密统计值无效");
            }
        }
        let optional = |i: usize| {
            fields
                .get(i)
                .filter(|s| !s.is_empty())
                .map(|s| (*s).to_owned())
        };
        rows.push(TunnelStatus {
            id,
            state: number(1)?,
            hot_state: number(2)?,
            local_ip: fields[3].into(),
            peer_ip: fields[4].into(),
            encrypt_count: fields[5].into(),
            decrypt_count: fields[6].into(),
            encrypt_errors: fields[7].into(),
            decrypt_errors: fields[8].into(),
            error_info: optional(14),
            algorithm: optional(15),
        });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    const BASE: &str = "1,3,1,10.0.0.1,10.0.0.2,9007199254740993,22,0,0,a,b,c,d,e";

    // 旧版缺少可选列仍可读取，计数保持超出JS安全整数的原始字符串。
    #[test]
    fn security_tunnels_legacy_and_large_counts() {
        let rows = parse(format!("# comment\r\n\r\n{BASE},\r\n").as_bytes()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].encrypt_count, "9007199254740993");
        assert_eq!(rows[0].error_info, None);
        assert_eq!(rows[0].algorithm, None);
        assert!(parse(b"# empty\r\n\n").unwrap().is_empty());
    }
    // 中间空字段不得移位，中文错误同时支持UTF-8与严格GBK。
    #[test]
    fn security_tunnels_optional_fields_and_encoding() {
        let row = parse(format!("{BASE},,SM2,\n").as_bytes())
            .unwrap()
            .remove(0);
        assert_eq!(row.error_info, None);
        assert_eq!(row.algorithm.as_deref(), Some("SM2"));
        let text = format!("{BASE},连接失败,SM2,\r\n");
        let (gbk, _, errors) = encoding_rs::GBK.encode(&text);
        assert!(!errors);
        for bytes in [text.as_bytes(), gbk.as_ref()] {
            let row = parse(bytes).unwrap().remove(0);
            assert_eq!(row.error_info.as_deref(), Some("连接失败"));
        }
        assert!(parse(&[0x81]).is_err());
    }
    // 保留未知连接及热备状态；实际ID检查采用原程序校验范围。
    #[test]
    fn security_tunnels_unknown_states_and_id_range() {
        let line = BASE.replacen("1,3,1,", "102400,99,-2,", 1);
        let row = parse(line.as_bytes()).unwrap().remove(0);
        assert_eq!((row.id, row.state, row.hot_state), (102400, 99, -2));
        for id in [0, -1, 102401] {
            assert!(!valid_id(id));
        }
    }
    // 坏行或重复ID拒绝整份结果，不能作为成功空列表或部分成功展示。
    #[test]
    fn security_tunnels_reject_corrupt_rows_and_duplicates() {
        for text in [
            format!("{BASE}\n{BASE}"),
            format!("{BASE}\nbroken"),
            BASE.replace("22,0,0", "-1,0,0"),
            BASE.replace("10.0.0.1", ""),
            format!("{BASE},error,algorithm,extra,"),
        ] {
            assert!(parse(text.as_bytes()).is_err(), "{text}");
        }
    }
}
