//! 安全操作员配置的明文设备格式；本地 XOR 导出格式不属于设备协议。
use std::{borrow::Cow, collections::{BTreeMap, HashSet}, net::Ipv4Addr};

pub(super) type Row = BTreeMap<String, String>;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const NETWORK: &[&str] = &["description", "interface", "interface_type", "ip", "netmask", "vlan"];
const ROUTES: &[&str] = &["name", "interface", "vlan", "destination", "netmask", "gateway", "table_id", "source", "source_mask"];
const TUNNELS: &[&str] = &["name", "id", "mode", "local_ip", "primary_ip", "primary_certificate", "backup_ip", "backup_certificate", "lifetime", "capacity"];
const POLICIES: &[&str] = &["id", "tunnel_id", "mode", "source_start", "source_end", "destination_start", "destination_end", "protocol", "direction", "source_port_start", "source_port_end", "destination_port_start", "destination_port_end", "description"];

fn fields(kind: &str) -> Result<&'static [&'static str], String> {
    match kind {
        "network" => Ok(NETWORK), "routes" => Ok(ROUTES),
        "tunnels" => Ok(TUNNELS), "policies" => Ok(POLICIES),
        _ => Err("不支持此配置类别".into()),
    }
}
fn value<'a>(row: &'a Row, key: &str) -> &'a str { row.get(key).map(String::as_str).unwrap_or("") }
fn number(text: &str, min: u64, max: u64) -> Result<u64, String> {
    if text.is_empty() || !text.bytes().all(|c| c.is_ascii_digit()) {
        return Err("配置数值必须是十进制整数".into());
    }
    let n = text.parse::<u64>().map_err(|_| "配置整数超出范围")?;
    if !(min..=max).contains(&n) { return Err("配置整数超出范围".into()); }
    Ok(n)
}
fn ip(text: &str) -> Result<u32, String> {
    text.parse::<Ipv4Addr>().map(u32::from).map_err(|_| "配置 IPv4 地址无效".into())
}
fn prefix(text: &str) -> Result<u32, String> {
    let bits = ip(text)?;
    if bits != 0 && (bits | bits.wrapping_sub(1)) != u32::MAX {
        return Err("子网掩码必须连续".into());
    }
    Ok(bits.count_ones())
}
fn network_code(text: &str, types: bool) -> String {
    if types {
        match text { "0" => "PRIVATE", "1" => "PUBLIC", "2" => "BACKUP", "3" => "CONFIG", "4" => "BRIDGE", _ => text }.into()
    } else {
        match text { "0" => "eth0", "1" => "eth1", "2" => "eth2", "3" => "eth3", "4" => "eth4", "5" => "eth5", "6" => "eth6", "7" => "BRIDGE", _ => text }.into()
    }
}
fn mapped_code(text: &str, types: bool) -> Result<&str, String> {
    let mapped = if types {
        match text { "PRIVATE" => "0", "PUBLIC" => "1", "BACKUP" => "2", "CONFIG" => "3", "BRIDGE" => "4", _ => return Err("未知网络接口类型，禁止上传".into()) }
    } else {
        match text { "eth0" => "0", "eth1" => "1", "eth2" => "2", "eth3" => "3", "eth4" => "4", "eth5" => "5", "eth6" => "6", "BRIDGE" => "7", _ => return Err("未知网络接口，禁止上传".into()) }
    };
    Ok(mapped)
}
fn split_cidr(text: &str, mask: &str) -> Result<String, String> {
    let (address, bits) = text.split_once('/').ok_or("路由网络缺少前缀")?;
    ip(address)?;
    if number(bits, 0, 32)? != u64::from(prefix(mask)?) {
        return Err("路由前缀与掩码不一致".into());
    }
    Ok(address.into())
}

pub(super) fn parse(kind: &str, data: &[u8]) -> Result<Vec<Row>, String> {
    let keys = fields(kind)?;
    if data.len() > MAX_BYTES { return Err("配置文件超过 4 MiB".into()); }
    let decoded = match std::str::from_utf8(data) {
        Ok(text) => Cow::Borrowed(text),
        Err(_) => {
            let (text, errors) = encoding_rs::GBK.decode_without_bom_handling(data);
            if errors { return Err("配置文件编码无效".into()); }
            text
        }
    };
    let mut rows = Vec::new();
    for (index, line) in decoded.trim_start_matches('\u{feff}').lines().enumerate() {
        if line.trim().is_empty() || line.starts_with('#') { continue; }
        if line.chars().any(char::is_control) { return Err(format!("第 {} 行包含控制字符", index + 1)); }
        let mut parts: Vec<_> = line.strip_suffix(',').unwrap_or(line).split(',').map(str::to_owned).collect();
        let row = if kind == "routes" {
            if parts.len() != 5 && parts.len() != 9 { return Err(format!("第 {} 行路由结构未知", index + 1)); }
            let mut row = Row::new();
            row.insert("name".into(), parts[0].clone());
            row.insert("destination".into(), split_cidr(&parts[1], &parts[2])?);
            row.insert("netmask".into(), parts[2].clone());
            row.insert("gateway".into(), parts[3].clone());
            let (nic, vlan) = parts[4].rsplit_once('.').unwrap_or((&parts[4], "0"));
            row.insert("interface".into(), nic.into());
            row.insert("vlan".into(), vlan.into());
            if parts.len() == 9 {
                if parts[5] != "table" { return Err("未知策略路由标志".into()); }
                row.insert("table_id".into(), parts[6].clone());
                row.insert("source".into(), split_cidr(&parts[7], &parts[8])?);
                row.insert("source_mask".into(), parts[8].clone());
            } else {
                for key in ["table_id", "source", "source_mask"] { row.insert(key.into(), String::new()); }
            }
            row
        } else {
            // 原厂策略允许缺少末尾说明列；中间空列必须原位保留。
            if kind == "policies" && parts.len() == keys.len() - 1 { parts.push(String::new()); }
            if parts.len() != keys.len() { return Err(format!("第 {} 行配置列数不匹配", index + 1)); }
            let mut row: Row = keys.iter().zip(parts).map(|(key, val)| ((*key).into(), val)).collect();
            if kind == "network" {
                number(value(&row, "interface"), 0, u32::MAX.into())?;
                number(value(&row, "interface_type"), 0, u32::MAX.into())?;
                row.insert("interface".into(), network_code(value(&row, "interface"), false));
                row.insert("interface_type".into(), network_code(value(&row, "interface_type"), true));
            }
            row
        };
        rows.push(row);
        if rows.len() > limit(kind) { return Err("配置条目过多".into()); }
    }
    check(kind, &rows, false)?;
    Ok(rows)
}
fn limit(kind: &str) -> usize { if kind == "tunnels" { 10240 } else { 102400 } }

fn check(kind: &str, rows: &[Row], writing: bool) -> Result<(), String> {
    let keys = fields(kind)?;
    if rows.len() > limit(kind) { return Err("配置条目过多".into()); }
    let mut ids = HashSet::new();
    let mut duplicates = HashSet::new();
    let mut size = 0usize;
    for row in rows {
        if row.len() != keys.len() || keys.iter().any(|key| !row.contains_key(*key)) {
            return Err("配置字段缺失或包含额外字段".into());
        }
        for (key, val) in row {
            if val.len() > 4096 || val.chars().any(|c| c.is_control() || c == ',') {
                return Err(format!("配置字段 {key} 包含非法字符或过长"));
            }
            size = size.saturating_add(val.len() + 1);
            let optional = (kind == "routes" && ["table_id", "source", "source_mask"].contains(&key.as_str()))
                || (kind == "policies" && key == "description");
            if !optional && val.trim().is_empty() { return Err(format!("配置字段 {key} 不可为空")); }
        }
        if size > MAX_BYTES { return Err("配置内容超过 4 MiB".into()); }
        let v = |key| value(row, key);
        let enum_value = |key: &str, allowed: &[&str]| -> Result<(), String> {
            if writing && !allowed.contains(&v(key)) { return Err(format!("字段 {key} 包含未知枚举，禁止上传")); }
            // 未知数字枚举可只读展示；任意文本不是有效的协议枚举。
            number(v(key), 0, u32::MAX.into())?;
            Ok(())
        };
        match kind {
            "network" => {
                ip(v("ip"))?; prefix(v("netmask"))?; number(v("vlan"), 0, 4094)?;
                if writing { mapped_code(v("interface"), false)?; mapped_code(v("interface_type"), true)?; }
                if v("description").chars().count() > 10 || !v("description").is_ascii() {
                    return Err("接口描述或桥名称须为不超过10位的非中文文本".into());
                }
                if !duplicates.insert(row.clone()) { return Err("网络配置包含重复条目".into()); }
            }
            "routes" => {
                ip(v("destination"))?; prefix(v("netmask"))?; ip(v("gateway"))?; number(v("vlan"), 0, 4094)?;
                // 路由接口也可为网络配置中定义的桥名称，不限于eth接口。
                if v("interface").contains('.') || v("interface").contains('/') {
                    return Err("路由接口名称无效".into());
                }
                let optional: Vec<_> = ["table_id", "source", "source_mask"].iter().map(|key| v(key).is_empty()).collect();
                if optional.iter().any(|empty| *empty) && !optional.iter().all(|empty| *empty) {
                    return Err("策略路由ID、源网络与源掩码必须同时填写".into());
                }
                if !v("table_id").is_empty() { number(v("table_id"), 0, u32::MAX.into())?; ip(v("source"))?; prefix(v("source_mask"))?; }
                let mut identity = row.clone(); identity.remove("name");
                if !duplicates.insert(identity) { return Err("路由配置包含重复条目".into()); }
            }
            "tunnels" => {
                let id = number(v("id"), 1, 102400)?;
                if !ids.insert(id) { return Err("隧道ID重复".into()); }
                enum_value("mode", &["0", "1", "2"])?;
                for key in ["local_ip", "primary_ip", "backup_ip"] { ip(v(key))?; }
                // 原厂新建备地址为0.0.0.0、备证书为cert2.pem；不擅自把空值转换为该哨兵。
                number(v("lifetime"), 1, 10000)?; number(v("capacity"), 10240, 2147493647)?;
            }
            "policies" => {
                let id = number(v("id"), 1, 102400)?;
                if !ids.insert(id) { return Err("策略ID重复".into()); }
                number(v("tunnel_id"), 1, 102400)?;
                enum_value("mode", &["0", "1", "2"])?;
                enum_value("protocol", &["0", "1", "2", "3"])?;
                enum_value("direction", &["0", "1", "2"])?;
                for (start, end) in [("source_start", "source_end"), ("destination_start", "destination_end")] {
                    if ip(v(start))? > ip(v(end))? { return Err("策略IP起始地址大于结束地址".into()); }
                }
                for (start, end) in [("source_port_start", "source_port_end"), ("destination_port_start", "destination_port_end")] {
                    if number(v(start), 0, 65535)? > number(v(end), 0, 65535)? { return Err("策略端口起始值大于结束值".into()); }
                }
                let mut identity = row.clone();
                identity.remove("id");
                identity.remove("description");
                if !duplicates.insert(identity) { return Err("策略配置包含重复条件".into()); }
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}
pub(super) fn validate(kind: &str, rows: &[Row]) -> Result<(), String> { check(kind, rows, true) }

pub(super) fn encode(kind: &str, rows: &[Row]) -> Result<Vec<u8>, String> {
    validate(kind, rows)?;
    let keys = fields(kind)?;
    let mut output = String::new();
    for row in rows {
        let v = |key| value(row, key);
        let line = match kind {
            "network" => format!("{},{},{},{},{},{}", v("description"), mapped_code(v("interface"), false)?, mapped_code(v("interface_type"), true)?, v("ip"), v("netmask"), v("vlan")),
            "routes" => {
                let nic = if v("vlan") == "0" { v("interface").to_owned() } else { format!("{}.{}", v("interface"), v("vlan")) };
                let mut line = format!("{},{}/{},{},{},{}", v("name"), v("destination"), prefix(v("netmask"))?, v("netmask"), v("gateway"), nic);
                if !v("table_id").is_empty() { line.push_str(&format!(",table,{},{}/{},{}", v("table_id"), v("source"), prefix(v("source_mask"))?, v("source_mask"))); }
                line
            }
            _ => keys.iter().map(|key| v(key)).collect::<Vec<_>>().join(","),
        };
        output.push_str(&line); output.push_str(",\n");
        if output.len() > MAX_BYTES { return Err("配置文件超过4 MiB".into()); }
    }
    Ok(output.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    const NET: &str = "config,0,3,11.22.33.44,255.255.255.0,0,\nbackup,6,2,10.0.0.1,255.255.255.0,12,\nbridge,7,4,10.1.0.1,255.255.255.0,0,\n";
    const ROUTE: &str = "default,0.0.0.0/0,0.0.0.0,10.0.0.2,bridge,\npolicy,10.2.0.0/16,255.255.0.0,10.0.0.3,eth6.12,table,100,10.3.0.0/16,255.255.0.0,\n";
    const TUN: &str = "test,102400,1,10.0.0.1,10.0.0.2,cert1.pem,0.0.0.0,cert2.pem,10000,2147493647,\n";
    const RULE: &str = "102400,102400,2,0.0.0.0,255.255.255.255,10.0.0.1,10.0.0.2,2,1,0,65535,104,104,,\n";
    #[test]
    fn security_operator_codec_exact_plaintext_roundtrip_all_kinds() {
        for (kind, text) in [("network", NET), ("routes", ROUTE), ("tunnels", TUN), ("policies", RULE)] {
            let rows = parse(kind, text.as_bytes()).unwrap();
            assert_eq!(encode(kind, &rows).unwrap(), text.as_bytes());
        }
        let rows = parse("network", NET.as_bytes()).unwrap();
        assert_eq!(rows[0]["interface_type"], "CONFIG");
        assert_eq!(rows[1]["interface"], "eth6");
        assert_eq!(rows[2]["interface"], "BRIDGE");
    }
    #[test]
    fn security_operator_codec_unknown_enums_readable_but_not_writable() {
        for (kind, text) in [("network", NET.replace(",0,3,", ",99,98,")), ("tunnels", TUN.replace(",1,10.", ",99,10.")), ("policies", RULE.replace(",2,1,0,", ",99,1,0,"))] {
            let rows = parse(kind, text.as_bytes()).unwrap();
            assert!(validate(kind, &rows).is_err());
            assert!(encode(kind, &rows).is_err());
        }
    }
    #[test]
    fn security_operator_codec_encoding_and_empty_policy_description() {
        let text = RULE.replace(",,\n", ",测试策略,\r\n");
        let (gbk, _, errors) = encoding_rs::GBK.encode(&text);
        assert!(!errors);
        assert_eq!(parse("policies", &gbk).unwrap()[0]["description"], "测试策略");
        assert_eq!(parse("policies", RULE.as_bytes()).unwrap()[0]["description"], "");
        let legacy = RULE.trim_end_matches('\n').trim_end_matches(',');
        assert_eq!(parse("policies", legacy.as_bytes()).unwrap()[0]["description"], "");
        assert!(parse("policies", &[0x81]).is_err());
        assert!(parse("tunnels", b"\xef\xbb\xbf\r\n# comment\r\n").unwrap().is_empty());
    }
    #[test]
    fn security_operator_codec_bad_rows_are_not_partial_success() {
        for text in [format!("{TUN}broken\n"), TUN.replace(",cert2.pem,", ",,"), TUN.replace("10.0.0.1", "999.0.0.1"), TUN.replace(",10000,", ",10001,"), format!("{TUN}{TUN}")] {
            assert!(parse("tunnels", text.as_bytes()).is_err());
        }
        assert!(parse("routes", ROUTE.replace("/16", "/24").as_bytes()).is_err());
        assert!(parse("network", NET.replace("255.255.255.0", "255.0.255.0").as_bytes()).is_err());
        assert!(parse("policies", RULE.replace(",0,65535,", ",65535,0,").as_bytes()).is_err());
        assert!(parse("policies", RULE.replace("0.0.0.0,255.255.255.255", "10.0.0.2,10.0.0.1").as_bytes()).is_err());
    }
    #[test]
    fn security_operator_codec_rejects_extra_fields_and_injection() {
        let original = parse("tunnels", TUN.as_bytes()).unwrap();
        for bad in ["bad,name", "bad\nname", "bad\0name"] {
            let mut rows = original.clone(); rows[0].insert("name".into(), bad.into());
            assert!(encode("tunnels", &rows).is_err());
        }
        let mut rows = original;
        rows[0].insert("command".into(), "18".into());
        assert!(validate("tunnels", &rows).is_err());
        assert!(parse("unknown", b"").is_err());
        assert!(parse("network", &vec![b'x'; MAX_BYTES + 1]).is_err());
    }
    #[test]
    fn security_operator_codec_limits_and_incomplete_policy_routes() {
        let row = parse("tunnels", TUN.as_bytes()).unwrap().remove(0);
        assert!(validate("tunnels", &vec![row; 10241]).is_err());
        let mut routes = parse("routes", ROUTE.as_bytes()).unwrap();
        routes[0].insert("table_id".into(), "100".into());
        assert!(validate("routes", &routes).is_err());
        let mut policies = parse("policies", RULE.as_bytes()).unwrap();
        policies.push(policies[0].clone());
        assert!(validate("policies", &policies).is_err());
        assert!(validate("policies", &vec![policies[0].clone(); 102401]).is_err());
    }
    #[test]
    fn security_operator_codec_policy_duplicate_conditions_ignore_id_and_description() {
        let first = parse("policies", RULE.as_bytes()).unwrap().remove(0);
        let mut second = first.clone();
        second.insert("id".into(), "1".into());
        second.insert("description".into(), "different label".into());
        let mut rows = vec![first, second];
        assert!(validate("policies", &rows).unwrap_err().contains("重复条件"));
        assert!(encode("policies", &rows).is_err());
        let duplicate_file = format!("{RULE}{}", RULE.replacen("102400,", "1,", 1));
        assert!(parse("policies", duplicate_file.as_bytes()).is_err());
        // 真实匹配条件或动作发生变化时不是重复，说明文字不影响判定。
        rows[1].insert("direction".into(), "0".into());
        assert!(validate("policies", &rows).is_ok());
    }
}
