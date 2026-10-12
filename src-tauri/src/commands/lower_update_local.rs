use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

const MAX_METADATA_BYTES: usize = 1024 * 1024;

// tar 的 Seek 坐标必须从归档开始计算，不能包含前面的安装脚本字节。
struct ArchiveReader<'a, R> {
    reader: &'a mut R,
    offset: u64,
    end: u64,
}
impl<R: Read> Read for ArchiveReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.reader.read(buffer)
    }
}
impl<R: Seek> Seek for ArchiveReader<'_, R> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let position = match position {
            SeekFrom::Start(value) => SeekFrom::Start(
                self.offset
                    .checked_add(value)
                    .ok_or_else(|| std::io::Error::other("归档偏移溢出"))?,
            ),
            other => other,
        };
        let absolute = self.reader.seek(position)?;
        if absolute > self.end {
            return Err(std::io::Error::other("安装包归档被截断"));
        }
        absolute
            .checked_sub(self.offset)
            .ok_or_else(|| std::io::Error::other("归档偏移超出有效范围"))
    }
}

#[derive(Debug)]
pub(super) struct LocalPackageInfo {
    pub version: String,
    pub package_version: String,
    pub platform: String,
    pub image_id: String,
}

pub(super) fn inspect_package(path: &Path) -> Result<LocalPackageInfo, String> {
    let mut file = File::open(path).map_err(|e| format!("读取本地安装包失败: {e}"))?;
    inspect_reader(&mut file)
}

fn read_archive<R: Read + Seek>(
    reader: &mut R,
    offset: u64,
    wanted: &[&str],
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let end = reader
        .seek(SeekFrom::End(0))
        .map_err(|e| format!("读取归档长度失败: {e}"))?;
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| format!("定位安装包归档失败: {e}"))?;
    let mut archive = tar::Archive::new(ArchiveReader {
        reader,
        offset,
        end,
    });
    let mut found = BTreeMap::new();
    let mut names = BTreeSet::new();
    for entry in archive
        .entries_with_seek()
        .map_err(|e| format!("读取安装包归档失败: {e}"))?
        // 原始遍历避免 tar 在检查大小前自动分配 GNU/PAX 扩展元数据。
        .raw(true)
    {
        let mut entry = entry.map_err(|e| format!("读取安装包归档条目失败: {e}"))?;
        let bytes = entry.path_bytes();
        let path = std::str::from_utf8(&bytes).map_err(|_| "安装包归档路径编码不合法")?;
        let name = path.trim_end_matches('/').to_string();
        if name.is_empty()
            || name.contains(['\\', ':'])
            || name.starts_with('/')
            || name
                .split('/')
                .any(|part| part == ".." || part.is_empty() || part == ".")
        {
            return Err("安装包归档包含不安全路径".into());
        }
        if !names.insert(name.clone()) {
            return Err(format!("安装包归档包含重复路径: {name}"));
        }
        if names.len() > 100_000 {
            return Err("安装包归档条目数量超过限制".into());
        }
        if wanted.contains(&name.as_str()) {
            if !entry.header().entry_type().is_file() {
                return Err(format!("安装包元数据不是普通文件: {name}"));
            }
            if entry.size() > MAX_METADATA_BYTES as u64 {
                return Err(format!("安装包元数据大小超过 1 MiB: {name}"));
            }
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|e| format!("读取安装包元数据失败: {e}"))?;
            found.insert(name, data);
        }
    }
    Ok(found)
}

fn parse_json(data: &BTreeMap<String, Vec<u8>>, path: &str) -> Result<Value, String> {
    let bytes = data
        .get(path)
        .ok_or_else(|| format!("安装包缺少元数据: {path}"))?;
    serde_json::from_slice(bytes).map_err(|e| format!("安装包元数据格式错误: {path}: {e}"))
}

fn digest(value: &str) -> Option<&str> {
    let hash = value.strip_prefix("sha256:")?;
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hash)
}

fn inspect_reader<R: Read + Seek>(reader: &mut R) -> Result<LocalPackageInfo, String> {
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|e| format!("读取安装包失败: {e}"))?;
    let offset;
    {
        let mut header = BufReader::new((&mut *reader).take(MAX_METADATA_BYTES as u64 + 1));
        let mut read = 0;
        let mut first = true;
        loop {
            let mut line = Vec::new();
            let count = header
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("读取安装包脚本头失败: {e}"))?;
            read += count;
            if count == 0 || read > MAX_METADATA_BYTES {
                return Err("安装包缺少归档标记或脚本头超过大小限制".into());
            }
            if first && line != b"#!/usr/bin/env bash\n" && line != b"#!/bin/bash\n" {
                return Err("文件不是支持的 MskDSP Bash 安装包".into());
            }
            first = false;
            if line == b"__ARCHIVE_BELOW__\n" {
                offset = read as u64;
                break;
            }
        }
    }
    let metadata = read_archive(reader, offset, &["manifest.json", "index.json"])?;
    let manifest = parse_json(&metadata, "manifest.json")?;
    let entries = manifest
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or("安装包必须包含单个镜像")?;
    let config_path = entries[0]["Config"]
        .as_str()
        .ok_or("安装包缺少镜像配置路径")?;
    let hash = config_path
        .strip_prefix("blobs/sha256/")
        .or_else(|| config_path.strip_suffix(".json"))
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("安装包镜像配置摘要路径不合法")?;
    let tags = entries[0]["RepoTags"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("安装包缺少 MskDSP 镜像标签")?;
    let mut versions = BTreeSet::new();
    for tag in tags {
        let tag = tag.as_str().ok_or("安装包 MskDSP 镜像标签不合法")?;
        let version = tag
            .strip_prefix("mskdsp:")
            .filter(|v| {
                !v.is_empty()
                    && v.len() <= 256
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
            .ok_or("安装包不是合法的 MskDSP 镜像")?;
        versions.insert(version);
    }
    if versions.len() != 1 {
        return Err("安装包包含多个不同版本的 MskDSP 标签".into());
    }
    let package_version = (*versions.first().unwrap()).to_string();
    let index = metadata
        .get("index.json")
        .map(|_| parse_json(&metadata, "index.json"))
        .transpose()?;
    let descriptor_path = if let Some(index) = &index {
        if index["schemaVersion"] != 2 {
            return Err("安装包 OCI 索引版本不支持".into());
        }
        let descriptors = index["manifests"]
            .as_array()
            .filter(|v| v.len() == 1)
            .ok_or("安装包 OCI 索引必须关联单个镜像")?;
        let hash = descriptors[0]["digest"]
            .as_str()
            .and_then(digest)
            .ok_or("安装包 OCI manifest 摘要不合法")?;
        Some(format!("blobs/sha256/{hash}"))
    } else {
        None
    };
    let mut wanted = vec![config_path];
    if let Some(path) = &descriptor_path {
        wanted.push(path);
    }
    let content = read_archive(reader, offset, &wanted)?;
    let config_raw = content.get(config_path).ok_or("安装包缺少镜像配置内容")?;
    let actual_hash = format!("{:x}", Sha256::digest(config_raw));
    if !actual_hash.eq_ignore_ascii_case(hash) {
        return Err("安装包镜像配置内容与路径摘要不一致".into());
    }
    let config = parse_json(&content, config_path)?;
    if config["os"] != "linux" {
        return Err("安装包镜像系统必须为 Linux".into());
    }
    let platform = match config["architecture"].as_str() {
        Some("arm64") => "linux-arm64",
        Some("amd64") => "linux-x64",
        _ => return Err("安装包镜像架构不支持".into()),
    };
    if let Some(path) = descriptor_path {
        let raw = content.get(&path).ok_or("安装包缺少 OCI manifest 内容")?;
        if format!("{:x}", Sha256::digest(raw)) != path[13..] {
            return Err("安装包 OCI manifest 内容摘要不一致".into());
        }
        let image_manifest = parse_json(&content, &path)?;
        if image_manifest["schemaVersion"] != 2
            || image_manifest["config"]["digest"] != format!("sha256:{actual_hash}")
        {
            return Err("安装包 OCI manifest 与配置关联不一致".into());
        }
        let indexed = &index.as_ref().unwrap()["manifests"][0]["platform"];
        for field in ["os", "architecture", "variant"] {
            if let Some(value) = indexed.get(field) {
                if field == "variant" && config.get(field).is_none() {
                    continue;
                }
                if Some(value) != config.get(field) {
                    return Err("安装包 OCI 平台与配置不一致".into());
                }
            }
        }
    }
    let version = package_version
        .strip_suffix(&format!("-{platform}"))
        .unwrap_or(&package_version);
    let version =
        if version.starts_with('v') && version.as_bytes().get(1).is_some_and(u8::is_ascii_digit) {
            &version[1..]
        } else {
            version
        };
    Ok(LocalPackageInfo {
        version: version.to_string(),
        package_version,
        platform: platform.into(),
        image_id: format!("sha256:{actual_hash}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn archive(files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, name, data.as_slice())
                .unwrap();
        }
        builder.into_inner().unwrap()
    }

    fn files(oci: bool, arch: &str) -> Vec<(String, Vec<u8>)> {
        let config = format!("{{\"architecture\":\"{arch}\",\"os\":\"linux\"}}").into_bytes();
        let hash = format!("{:x}", Sha256::digest(&config));
        let config_path = if oci {
            format!("blobs/sha256/{hash}")
        } else {
            format!("{hash}.json")
        };
        let manifest = serde_json::json!([{"Config": config_path, "RepoTags": ["mskdsp:v1.2.3-linux-arm64"], "Layers": []}]);
        let mut result = vec![
            (
                "manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
            (config_path, config),
        ];
        if oci {
            let descriptor = serde_json::to_vec(&serde_json::json!({"schemaVersion":2,"config":{"digest":format!("sha256:{hash}")},"layers":[]})).unwrap();
            let descriptor_hash = format!("{:x}", Sha256::digest(&descriptor));
            result.push((format!("blobs/sha256/{descriptor_hash}"), descriptor));
            result.push(("index.json".into(), serde_json::to_vec(&serde_json::json!({"schemaVersion":2,"manifests":[{"digest":format!("sha256:{descriptor_hash}"),"platform":{"os":"linux","architecture":arch}}]})).unwrap()));
        }
        result
    }

    fn inspect(files: &[(String, Vec<u8>)]) -> Result<LocalPackageInfo, String> {
        let mut data = b"#!/usr/bin/env bash\nexit 0\n__ARCHIVE_BELOW__\n".to_vec();
        data.extend(archive(files));
        inspect_reader(&mut Cursor::new(data))
    }

    // 验证经典及 OCI 包可识别真实版本、架构及配置内容摘要。
    #[test]
    fn reads_classic_and_oci_metadata() {
        for oci in [false, true] {
            let input = files(oci, "arm64");
            let info = inspect(&input).unwrap();
            assert_eq!(info.version, "1.2.3");
            assert_eq!(info.package_version, "v1.2.3-linux-arm64");
            assert_eq!(info.platform, "linux-arm64");
            assert_eq!(
                info.image_id,
                format!("sha256:{:x}", Sha256::digest(&input[1].1))
            );
        }
        let mut input = files(false, "amd64");
        input[0].1 = String::from_utf8(input[0].1.clone())
            .unwrap()
            .replace("linux-arm64", "linux-x64")
            .into_bytes();
        assert_eq!(inspect(&input).unwrap().platform, "linux-x64");
    }

    // 验证损坏摘要、重复元数据、其他产品、多镜像及未知平台均拒绝导入。
    #[test]
    fn rejects_invalid_identity_and_ambiguity() {
        let mut corrupted = files(false, "arm64");
        corrupted[1].1.push(b' ');
        assert!(inspect(&corrupted).unwrap_err().contains("摘要"));
        let mut duplicated = files(false, "arm64");
        duplicated.push(duplicated[1].clone());
        assert!(inspect(&duplicated).unwrap_err().contains("重复"));
        let mut foreign = files(false, "arm64");
        foreign[0].1 = String::from_utf8(foreign[0].1.clone())
            .unwrap()
            .replace("mskdsp:", "other:")
            .into_bytes();
        assert!(inspect(&foreign).unwrap_err().contains("MskDSP"));
        let mut multiple = files(false, "arm64");
        let entry: serde_json::Value = serde_json::from_slice(&multiple[0].1).unwrap();
        multiple[0].1 = serde_json::to_vec(&serde_json::json!([entry[0], entry[0]])).unwrap();
        assert!(inspect(&multiple).unwrap_err().contains("单个"));
        assert!(inspect(&files(false, "mips")).unwrap_err().contains("架构"));
    }

    // 验证 OCI manifest 损坏及配置关联错误不能产生可安装身份。
    #[test]
    fn rejects_broken_oci_digest_chain() {
        let mut input = files(true, "arm64");
        input[2].1.push(b' ');
        assert!(inspect(&input).unwrap_err().contains("摘要"));
        let mut input = files(true, "arm64");
        let mut manifest: serde_json::Value = serde_json::from_slice(&input[2].1).unwrap();
        manifest["config"]["digest"] =
            serde_json::Value::String(format!("sha256:{}", "a".repeat(64)));
        input[2].1 = serde_json::to_vec(&manifest).unwrap();
        let hash = format!("{:x}", Sha256::digest(&input[2].1));
        input[2].0 = format!("blobs/sha256/{hash}");
        let mut index: serde_json::Value = serde_json::from_slice(&input[3].1).unwrap();
        index["manifests"][0]["digest"] = serde_json::Value::String(format!("sha256:{hash}"));
        input[3].1 = serde_json::to_vec(&index).unwrap();
        assert!(inspect(&input).unwrap_err().contains("关联"));
    }

    // 验证裸 tar、超长安装头与超大元数据均有界拒绝。
    #[test]
    fn rejects_missing_marker_and_oversized_metadata() {
        assert!(inspect_reader(&mut Cursor::new(archive(&files(false, "arm64")))).is_err());
        assert!(inspect_reader(&mut Cursor::new(vec![b'a'; MAX_METADATA_BYTES + 1])).is_err());
        let mut input = files(false, "arm64");
        input[0].1 = vec![b' '; MAX_METADATA_BYTES + 1];
        assert!(inspect(&input).unwrap_err().contains("大小"));
    }

    // 验证路径穿越和 OCI 平台伪声明均不能通过静态检查。
    #[test]
    fn rejects_unsafe_path_and_wrong_oci_platform() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        header.as_mut_bytes()[..9].copy_from_slice(b"../escape");
        header.set_cksum();
        builder.append(&header, b"x".as_slice()).unwrap();
        let mut bytes = b"#!/bin/bash\n__ARCHIVE_BELOW__\n".to_vec();
        bytes.extend(builder.into_inner().unwrap());
        assert!(inspect_reader(&mut Cursor::new(bytes))
            .unwrap_err()
            .contains("路径"));
        let mut input = files(true, "arm64");
        input[3].1 = String::from_utf8(input[3].1.clone())
            .unwrap()
            .replace("arm64", "amd64")
            .into_bytes();
        assert!(inspect(&input).unwrap_err().contains("平台"));
    }

    // 验证大镜像层跨越 Seek 偏移后仍正确读取元数据，兼容仅 OCI 描述含 v8 变体。
    #[test]
    fn skips_large_layers_and_accepts_descriptor_only_arm_variant() {
        let mut input = files(true, "arm64");
        let mut index: serde_json::Value = serde_json::from_slice(&input[3].1).unwrap();
        index["manifests"][0]["platform"]["variant"] = serde_json::Value::String("v8".into());
        input[3].1 = serde_json::to_vec(&index).unwrap();
        input.insert(
            1,
            ("layer/layer.tar".into(), vec![b'x'; 2 * MAX_METADATA_BYTES]),
        );
        assert_eq!(inspect(&input).unwrap().platform, "linux-arm64");
    }

    // 验证无法因 Seek 跳过数据而接受声明完整、实际被截断的镜像层。
    #[test]
    fn rejects_truncated_layer_even_when_metadata_is_complete() {
        let mut input = files(false, "arm64");
        input.push(("layer/layer.tar".into(), vec![b'x'; 2 * MAX_METADATA_BYTES]));
        let mut payload = archive(&input);
        payload.truncate(payload.len() - MAX_METADATA_BYTES);
        let mut bytes = b"#!/bin/bash\n__ARCHIVE_BELOW__\n".to_vec();
        bytes.extend(payload);
        assert!(inspect_reader(&mut Cursor::new(bytes)).is_err());
    }
}
