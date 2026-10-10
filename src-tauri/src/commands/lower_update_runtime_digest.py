"""只读解析容器实际镜像归档，将 OCI 引用归一到经过验证的 config 摘要。"""

import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import time


MAX_METADATA_BYTES = 1024 * 1024
MAX_TOTAL_METADATA_BYTES = 8 * MAX_METADATA_BYTES
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
BLOB_PATTERN = re.compile(r"blobs/sha256/([0-9a-f]{64})\Z")
CLASSIC_CONFIG_PATTERN = re.compile(r"([0-9a-f]{64})\.json\Z")


def valid_digest(value):
    if not isinstance(value, str) or not DIGEST_PATTERN.fullmatch(value):
        raise RuntimeError("运行镜像摘要必须是完整的 SHA256")
    return value


def content_digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def resolve_config_digest(stream, runtime_digest):
    """仅读取有界 JSON 元数据，镜像层从 tar 流中跳过，不提取到文件系统。"""
    valid_digest(runtime_digest)
    objects = {}
    docker_manifest = None
    seen_paths = set()
    metadata_bytes = 0
    try:
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            for member in archive:
                name = member.name.removeprefix("./")
                blob_match = BLOB_PATTERN.fullmatch(name)
                config_match = CLASSIC_CONFIG_PATTERN.fullmatch(name)
                known_json = name in ("manifest.json", "index.json")
                if not (known_json or blob_match or config_match):
                    continue
                if name in seen_paths:
                    raise RuntimeError("镜像归档包含重复元数据路径")
                seen_paths.add(name)
                if not member.isfile():
                    raise RuntimeError("镜像归档元数据必须是普通文件")
                if member.size > MAX_METADATA_BYTES:
                    if known_json or config_match:
                        raise RuntimeError("镜像归档 JSON 元数据超过大小限制")
                    continue
                content = archive.extractfile(member).read()
                try:
                    value = json.loads(content)
                except (ValueError, UnicodeDecodeError):
                    if known_json or config_match:
                        raise RuntimeError("镜像归档 JSON 元数据不合法")
                    continue
                metadata_bytes += len(content)
                if metadata_bytes > MAX_TOTAL_METADATA_BYTES:
                    raise RuntimeError("镜像归档 JSON 元数据总大小超过限制")
                if blob_match or config_match:
                    file_digest = "sha256:" + (blob_match or config_match).group(1)
                    if content_digest(content) != file_digest:
                        raise RuntimeError("镜像归档元数据内容摘要与路径不一致")
                    if file_digest in objects and objects[file_digest] != value:
                        raise RuntimeError("镜像归档摘要关联存在歧义")
                    objects[file_digest] = value
                elif name == "manifest.json":
                    docker_manifest = value
        # tar 结束标记后仍可能有 padding；消费完流才能等待生产者退出。
        while stream.read(64 * 1024):
            pass
    except (tarfile.TarError, OSError) as error:
        raise RuntimeError("读取运行镜像归档失败") from error

    if not isinstance(docker_manifest, list) or not docker_manifest:
        raise RuntimeError("运行镜像归档缺少 Docker 配置关联清单")
    docker_configs = set()
    for item in docker_manifest:
        if not isinstance(item, dict):
            raise RuntimeError("镜像归档 Docker 清单不合法")
        config_path = item.get("Config", "")
        match = BLOB_PATTERN.fullmatch(config_path) or CLASSIC_CONFIG_PATTERN.fullmatch(config_path)
        if not match:
            raise RuntimeError("镜像归档配置路径不合法")
        docker_configs.add("sha256:" + match.group(1))

    def resolve(reference, visited):
        if reference in visited or len(visited) > 16:
            raise RuntimeError("运行镜像摘要关联存在循环或层级过深")
        value = objects.get(valid_digest(reference))
        if not isinstance(value, dict):
            raise RuntimeError("镜像归档无法证明运行镜像与配置的关联")
        if "rootfs" in value:
            rootfs = value["rootfs"]
            if not isinstance(rootfs, dict) or rootfs.get("type") != "layers" or not isinstance(rootfs.get("diff_ids"), list):
                raise RuntimeError("镜像配置 rootfs 不合法")
            if not isinstance(value.get("architecture"), str) or not isinstance(value.get("os"), str):
                raise RuntimeError("镜像配置缺少平台信息")
            if reference not in docker_configs:
                raise RuntimeError("运行镜像配置与 Docker 清单关联不一致")
            return {reference}
        visited = visited | {reference}
        if value.get("schemaVersion") != 2:
            raise RuntimeError("运行镜像 manifest 格式不合法")
        if "manifests" in value:
            descriptors = value["manifests"]
            if not isinstance(descriptors, list) or not descriptors:
                raise RuntimeError("运行镜像索引未包含平台 manifest")
            configs = set()
            for descriptor in descriptors:
                if not isinstance(descriptor, dict):
                    raise RuntimeError("运行镜像索引关联不合法")
                configs.update(resolve(descriptor.get("digest"), visited))
            if len(configs) != 1:
                raise RuntimeError("运行镜像索引包含多个平台配置，无法消除平台歧义")
            return configs
        descriptor = value.get("config")
        if not isinstance(descriptor, dict) or not isinstance(value.get("layers"), list):
            raise RuntimeError("运行镜像 manifest 缺少配置关联")
        config_reference = valid_digest(descriptor.get("digest"))
        config_value = objects.get(config_reference)
        if not isinstance(config_value, dict) or "rootfs" not in config_value:
            raise RuntimeError("运行镜像 manifest 关联的配置不存在")
        return resolve(config_reference, visited)

    configs = resolve(runtime_digest, set())
    if len(configs) != 1:
        raise RuntimeError("运行镜像配置关联存在歧义")
    return configs.pop()


def export_config_digest(runtime_digest, timeout=20):
    """按不可变摘要导出，不使用 tag；定时终止导出并回收进程。"""
    valid_digest(runtime_digest)
    if timeout <= 0 or timeout > 20:
        raise RuntimeError("运行镜像导出超时参数不合法")
    timed_out = threading.Event()
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(["docker", "image", "save", runtime_digest], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors)
        except OSError as error:
            raise RuntimeError("无法执行 Docker 运行镜像导出") from error

        def terminate():
            timed_out.set()
            try:
                process.kill()
            except OSError:
                pass

        timer = threading.Timer(timeout, terminate)
        timer.daemon = True
        timer.start()
        started_at = time.monotonic()
        try:
            parse_error = None
            try:
                result = resolve_config_digest(process.stdout, runtime_digest)
            except Exception as error:
                parse_error = error
                process.kill()
            try:
                exit_code = process.wait(timeout=max(0.01, timeout - (time.monotonic() - started_at)))
            except subprocess.TimeoutExpired as error:
                terminate()
                process.wait(timeout=3)
                raise RuntimeError("Docker 运行镜像导出超时") from error
            if timed_out.is_set():
                raise RuntimeError("Docker 运行镜像导出超时")
            if parse_error is not None:
                raise parse_error
            if exit_code != 0:
                errors.seek(0)
                detail = errors.read(4096).decode("utf-8", errors="replace").strip()
                raise RuntimeError("Docker 运行镜像导出失败" + (": " + detail if detail else ""))
            return result
        finally:
            timer.cancel()
            if process.poll() is None:
                terminate()
                process.wait(timeout=3)
            process.stdout.close()


def main(argv):
    if len(argv) != 1:
        raise RuntimeError("运行镜像摘要解析需要一个不可变镜像引用")
    print(export_config_digest(argv[0]))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        print("查询运行镜像配置摘要失败: " + str(error), file=sys.stderr)
        sys.exit(1)
