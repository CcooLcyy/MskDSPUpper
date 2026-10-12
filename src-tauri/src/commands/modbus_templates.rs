use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const DIRECTORY_LIMIT: usize = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Template {
    schema_version: u32,
    id: String,
    name: String,
    manufacturer: String,
    models: Vec<String>,
    protocol_version: String,
    address_base: u32,
    notes: Vec<String>,
    sources: Vec<Source>,
    points: Vec<Point>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    file: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    id: String,
    tag: String,
    group: String,
    unit: String,
    function_code: u32,
    address: u32,
    data_type: String,
    reg_count: u32,
    scale: String,
    offset: String,
    deadband: String,
    word_order: String,
    byte_order: String,
    bit_index: Option<u32>,
    enum_value: Option<u32>,
    source_page: u32,
    description: String,
    default_selected: Option<bool>,
    condition: Option<String>,
}
fn valid_text(value: &str, max: usize, empty: bool) -> bool {
    value.chars().count() <= max && !value.contains('\0') && (empty || !value.trim().is_empty())
}
fn valid_decimal(value: &str) -> bool {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let exponent_parts: Vec<_> = value.split(['e', 'E']).collect();
    if exponent_parts.len() > 2 {
        return false;
    }
    let exponent = if exponent_parts.len() == 2 {
        match exponent_parts[1].parse::<i64>() {
            Ok(e) if (-100000..=100000).contains(&e) => e,
            _ => return false,
        }
    } else {
        0
    };
    let mantissa = exponent_parts[0].trim_start_matches(['+', '-']);
    let parts: Vec<_> = mantissa.split('.').collect();
    if parts.len() > 2
        || !parts
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
        || parts.iter().all(|part| part.is_empty())
    {
        return false;
    }
    let digits = parts.concat();
    let significant = digits.trim_start_matches('0');
    let fractional = parts.get(1).map(|part| part.len()).unwrap_or(0);
    if !significant.is_empty() && significant.len() as i64 + exponent - fractional as i64 > 100 {
        return false;
    }
    value
        .parse::<f64>()
        .map(|number| number.is_finite())
        .unwrap_or(false)
}
pub(crate) fn validate_template(value: &Value) -> Result<(), String> {
    if serde_json::to_vec(value)
        .map_err(|_| "Modbus 模板序列化失败".to_string())?
        .len()
        > FILE_LIMIT
    {
        return Err("模板文件不能超过 2 MiB".into());
    }
    let item: Template = serde_json::from_value(value.clone())
        .map_err(|_| "Modbus 模板格式不合法或包含未允许的字段".to_string())?;
    if item.schema_version != 1
        || item.address_base > 1
        || !valid_text(&item.id, 128, false)
        || !item
            .id
            .bytes()
            .next()
            .map(|b| b.is_ascii_alphanumeric())
            .unwrap_or(false)
        || !item
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        || !valid_text(&item.name, 256, false)
        || !valid_text(&item.manufacturer, 256, true)
        || !valid_text(&item.protocol_version, 256, true)
        || item.models.len() > 100
        || item.notes.len() > 100
        || item.sources.len() > 20
        || !item.models.iter().all(|v| valid_text(v, 256, false))
        || !item.notes.iter().all(|v| valid_text(v, 4096, false))
    {
        return Err("Modbus 模板元信息不合法".into());
    }
    for source in &item.sources {
        if !valid_text(&source.file, 512, false)
            || source.sha256.len() != 64
            || !source.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Modbus 模板来源不合法".into());
        }
    }
    if item.points.is_empty() || item.points.len() > 2000 {
        return Err("Modbus 模板点位数量必须在 1 到 2000 之间".into());
    }
    let mut ids = BTreeSet::new();
    let mut tags = BTreeSet::new();
    for point in &item.points {
        if !valid_text(&point.id, 128, false)
            || !valid_text(&point.tag, 256, false)
            || point.tag.trim() != point.tag
            || !valid_text(&point.group, 256, true)
            || !valid_text(&point.unit, 64, true)
            || !valid_text(&point.description, 4096, true)
            || point
                .condition
                .as_ref()
                .map(|v| !valid_text(v, 4096, true))
                .unwrap_or(false)
            || !ids.insert(&point.id)
            || !tags.insert(&point.tag)
        {
            return Err("Modbus 模板点位文本或重复 ID/标签不合法".into());
        }
        let _ = point.default_selected;
        let type_count = match point.data_type.as_str() {
            "BOOL" => point.reg_count == 1 || point.reg_count == 2,
            "UINT16" | "INT16" => point.reg_count == 1,
            "UINT32" | "INT32" => point.reg_count == 2,
            _ => false,
        };
        let function_type = match point.function_code {
            1 | 5 => point.data_type == "BOOL" && point.reg_count == 1 && point.bit_index.is_none(),
            3 | 4 => true,
            6 => {
                matches!(point.data_type.as_str(), "BOOL" | "UINT16" | "INT16")
                    && point.reg_count == 1
            }
            16 => point.data_type != "BOOL",
            _ => false,
        };
        if !type_count
            || !function_type
            || point
                .enum_value
                .map(|value| {
                    point.data_type != "BOOL"
                        || !matches!(point.function_code, 3 | 4)
                        || point.bit_index.is_some()
                        || (point.reg_count == 1 && value > 65535)
                })
                .unwrap_or(false)
            || point.address < item.address_base
            || point.address as u64 + point.reg_count as u64 > 65536 + item.address_base as u64
            || point
                .bit_index
                .map(|bit| point.data_type != "BOOL" || bit >= point.reg_count * 16)
                .unwrap_or(false)
            || !matches!(point.word_order.as_str(), "HL" | "LH")
            || !matches!(point.byte_order.as_str(), "AB" | "BA")
            || point.source_page > 100000
            || ![&point.scale, &point.offset, &point.deadband]
                .iter()
                .all(|v| valid_decimal(v))
        {
            return Err(format!("Modbus 模板点位参数不合法：{}", point.tag));
        }
    }
    for point in value["points"].as_array().unwrap() {
        if point.get("bit_index").is_none()
            || point
                .get("default_selected")
                .map(|v| !v.is_boolean())
                .unwrap_or(false)
            || point
                .get("condition")
                .map(|v| !v.is_string())
                .unwrap_or(false)
        {
            return Err("Modbus 模板位索引或可选条件格式不合法".into());
        }
    }
    Ok(())
}
pub(crate) fn validate_personal_templates(value: &Value) -> Result<(), String> {
    let items = value
        .as_array()
        .ok_or_else(|| "个人模板目录必须是数组".to_string())?;
    if items.len() > 100
        || serde_json::to_vec(value)
            .map_err(|_| "个人模板序列化失败".to_string())?
            .len()
            > DIRECTORY_LIMIT
    {
        return Err("个人模板目录超过数量或容量上限".into());
    }
    let mut ids = BTreeSet::new();
    for item in items {
        validate_template(item)?;
        if !ids.insert(item["id"].as_str().unwrap_or_default()) {
            return Err("个人模板 ID 重复".into());
        }
    }
    Ok(())
}
fn save_export(path: &Path, contents: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| !v.eq_ignore_ascii_case("json"))
            .unwrap_or(true)
    {
        return Err("模板导出路径必须是绝对路径且使用 .json 扩展名".into());
    }
    if contents.len() > FILE_LIMIT {
        return Err("模板文件不能超过 2 MiB".into());
    }
    let value: Value =
        serde_json::from_str(contents).map_err(|_| "模板导出内容不是合法 JSON".to_string())?;
    validate_template(&value)?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("json.tmp-{}-{unique}", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("创建模板临时文件失败：{e}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("写入模板临时文件失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("刷新模板临时文件失败：{e}"))?;
        drop(file);
        super::app_storage::atomic_replace(&temporary, path)
            .map_err(|e| format!("替换模板导出文件失败：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
#[tauri::command]
pub fn save_modbus_template_export(path: String, contents: String) -> Result<(), String> {
    tracing::info!(path=%path,"开始导出 Modbus 点表模板");
    let result = save_export(Path::new(&path), &contents);
    match &result {
        Ok(()) => tracing::info!(path=%path,bytes=contents.len(),"Modbus 点表模板导出完成"),
        Err(error) => tracing::error!(path=%path,%error,"Modbus 点表模板导出失败"),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn template() -> Value {
        json!({"schema_version":1,"id":"personal","name":"测试模板","manufacturer":"","models":[],"protocol_version":"",
            "address_base":0,"notes":[],"sources":[],"points":[{"id":"p1","tag":"电压","group":"","unit":"V","function_code":3,
            "address":1,"data_type":"UINT16","reg_count":1,"scale":"0.12345678901234567890","offset":"0","deadband":"0",
            "word_order":"HL","byte_order":"AB","bit_index":null,"source_page":1,"description":""}]})
    }

    // 模板校验拒绝重复标签、错误长度与倍率，条件元信息允许保存。
    #[test]
    fn validates_template_shape_and_point_boundaries() {
        let good = template();
        validate_template(&good).unwrap();
        for (field, value) in [
            ("reg_count", json!(2)),
            ("scale", json!("NaN")),
            ("address", json!(65536)),
            ("bit_index", json!(1)),
            ("function_code", json!(5)),
        ] {
            let mut invalid = good.clone();
            invalid["points"][0][field] = value;
            assert!(validate_template(&invalid).is_err(), "{field}");
        }
        let mut duplicate = good.clone();
        duplicate["points"]
            .as_array_mut()
            .unwrap()
            .push(good["points"][0].clone());
        assert!(validate_template(&duplicate).is_err());
        let mut conditional = good.clone();
        conditional["points"][0]["default_selected"] = json!(false);
        conditional["points"][0]["condition"] = json!("仅指定型号");
        validate_template(&conditional).unwrap();
    }

    // 个人模板目录拒绝损坏结构、重复 ID 及超量。
    #[test]
    fn validates_personal_directory_before_settings_write() {
        let one = template();
        validate_personal_templates(&json!([one.clone()])).unwrap();
        assert!(validate_personal_templates(&json!([one.clone(), one.clone()])).is_err());
        assert!(validate_personal_templates(&json!(vec![one; 101])).is_err());
        assert!(validate_personal_templates(&json!({})).is_err());
    }

    // 所有随软件发布的内置模板都必须通过桌面端同一结构和参数校验。
    #[test]
    fn validates_all_bundled_templates() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/modbus-templates/builtin");
        let mut count = 0;
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            validate_template(&value).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            count += 1;
        }
        assert!(count > 0);
    }

    // 枚举0是有效配置；仅只读寄存器BOOL允许等值选择器，不能同时配置bit。
    #[test]
    fn validates_enum_selector_and_boundaries() {
        let mut good = template();
        good["points"][0]["data_type"] = json!("BOOL");
        good["points"][0]["function_code"] = json!(4);
        good["points"][0]["enum_value"] = json!(0);
        validate_template(&good).unwrap();
        for (field, value) in [
            ("bit_index", json!(0)),
            ("data_type", json!("UINT16")),
            ("function_code", json!(6)),
            ("enum_value", json!(65536)),
            ("enum_value", json!(-1)),
            ("enum_value", json!(0.5)),
        ] {
            let mut invalid = good.clone();
            invalid["points"][0][field] = value;
            assert!(validate_template(&invalid).is_err(), "{field}");
        }
        good["points"][0]["reg_count"] = json!(2);
        good["points"][0]["enum_value"] = json!(u32::MAX);
        validate_template(&good).unwrap();
        good["points"][0]["enum_value"] = json!(4294967296_u64);
        assert!(validate_template(&good).is_err());
    }

    // 导出损坏内容时保持旧文件，正确导出保留十进制原文。
    #[test]
    fn export_rejects_bad_json_before_touching_existing_file() {
        let path = std::env::temp_dir().join(format!(
            "mskdsp-template-export-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, "旧模板").unwrap();
        assert!(save_export(&path, "{").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "旧模板");
        save_export(&path, &serde_json::to_string(&template()).unwrap()).unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("0.12345678901234567890"));
        std::fs::remove_file(path).unwrap();
    }
}
