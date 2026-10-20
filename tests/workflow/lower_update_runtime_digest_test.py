import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import time
import unittest
from unittest.mock import Mock, patch


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "src-tauri/src/commands/lower_update_runtime_digest.py"
SPEC = importlib.util.spec_from_file_location("lower_update_runtime_digest", SCRIPT_PATH)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def json_bytes(value):
    return json.dumps(value, separators=(",", ":")).encode()


def digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as output:
        for name, content in entries:
            member = tarfile.TarInfo(name)
            member.size = len(content)
            output.addfile(member, io.BytesIO(content))
    stream.seek(0)
    return stream


def image(architecture="amd64", marker="current"):
    config = json_bytes({"architecture": architecture, "os": "linux", "rootfs": {"type": "layers", "diff_ids": []}, "config": {"Labels": {"build": marker}}})
    config_id = digest(config)
    manifest = json_bytes({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_id, "size": len(config)}, "layers": []})
    manifest_id = digest(manifest)
    return config_id, manifest_id, [
        ("blobs/sha256/" + config_id[7:], config),
        ("blobs/sha256/" + manifest_id[7:], manifest),
    ]


def image_archive(config_id, manifest_id, entries):
    return archive(entries + [
        ("manifest.json", json_bytes([{"Config": "blobs/sha256/" + config_id[7:], "RepoTags": [], "Layers": []}])),
        ("index.json", json_bytes({"schemaVersion": 2, "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manifest_id}]})),
    ])


class RuntimeDigestTest(unittest.TestCase):
    # 验证原故障：容器引用 manifest 摘要，清单使用其 config 摘要，二者必须归一为同一 config。
    def test_resolves_manifest_to_its_verified_config(self):
        config_id, manifest_id, entries = image()
        self.assertNotEqual(config_id, manifest_id)
        self.assertEqual(runtime.resolve_config_digest(image_archive(config_id, manifest_id, entries), manifest_id), config_id)

    # 验证经典 Docker 配置路径以及配置原始字节摘要。
    def test_resolves_classic_config_path(self):
        config_id, _, entries = image()
        stream = archive([(config_id[7:] + ".json", entries[0][1]), ("manifest.json", json_bytes([{"Config": config_id[7:] + ".json", "Layers": []}]))])
        self.assertEqual(runtime.resolve_config_digest(stream, config_id), config_id)

    # 验证不能将其他镜像的 manifest 或 config 误认为运行镜像。
    def test_rejects_unrelated_runtime_reference(self):
        config_id, manifest_id, entries = image()
        with self.assertRaisesRegex(RuntimeError, "运行镜像|关联"):
            runtime.resolve_config_digest(image_archive(config_id, manifest_id, entries), "sha256:" + "f" * 64)

    # 验证配置内容发生变化时，不能沿用配置文件名里的摘要。
    def test_rejects_config_digest_mismatch(self):
        config_id, manifest_id, entries = image()
        entries[0] = (entries[0][0], entries[0][1] + b" ")
        with self.assertRaisesRegex(RuntimeError, "摘要"):
            runtime.resolve_config_digest(image_archive(config_id, manifest_id, entries), manifest_id)

    # 验证 manifest 内容发生变化时，不能沿用 blob 路径里的摘要。
    def test_rejects_manifest_digest_mismatch(self):
        config_id, manifest_id, entries = image()
        entries[1] = (entries[1][0], entries[1][1] + b" ")
        with self.assertRaisesRegex(RuntimeError, "摘要"):
            runtime.resolve_config_digest(image_archive(config_id, manifest_id, entries), manifest_id)

    # 验证 manifest 关联的 config 必须属于导出归档的 Docker 清单。
    def test_rejects_unrelated_docker_manifest(self):
        config_id, manifest_id, entries = image()
        stream = archive(entries + [("manifest.json", json_bytes([{"Config": "blobs/sha256/" + "a" * 64, "Layers": []}]))])
        with self.assertRaisesRegex(RuntimeError, "关联|配置"):
            runtime.resolve_config_digest(stream, manifest_id)

    # 验证多个架构不可任取一个配置作为运行构建身份。
    def test_rejects_ambiguous_multi_platform_index(self):
        config_a, manifest_a, entries_a = image("amd64")
        config_b, manifest_b, entries_b = image("arm64")
        index = json_bytes({"schemaVersion": 2, "manifests": [{"digest": manifest_a}, {"digest": manifest_b}]})
        index_id = digest(index)
        stream = archive(entries_a + entries_b + [("blobs/sha256/" + index_id[7:], index), ("manifest.json", json_bytes([{"Config": "blobs/sha256/" + value[7:], "Layers": []} for value in (config_a, config_b)]))])
        with self.assertRaisesRegex(RuntimeError, "平台|歧义"):
            runtime.resolve_config_digest(stream, index_id)

    # 验证单配置索引可以安全解析，且不受归档元数据顺序影响。
    def test_resolves_unambiguous_index(self):
        config_id, manifest_id, entries = image()
        index = json_bytes({"schemaVersion": 2, "manifests": [{"digest": manifest_id}]})
        index_id = digest(index)
        entries += [("blobs/sha256/" + index_id[7:], index)]
        stream = image_archive(config_id, manifest_id, list(reversed(entries)))
        self.assertEqual(runtime.resolve_config_digest(stream, index_id), config_id)

    # 验证镜像层仅从流中跳过，不解析为 JSON 元数据或落盘。
    def test_skips_layer_payload(self):
        config_id, manifest_id, entries = image()
        entries.insert(0, ("blobs/sha256/" + "0" * 64, b"x" * (1024 * 1024 + 1)))
        self.assertEqual(runtime.resolve_config_digest(image_archive(config_id, manifest_id, entries), manifest_id), config_id)

    # 验证配置和关联文件不能通过符号链接或重复路径覆盖。
    def test_rejects_duplicate_metadata_path(self):
        config_id, manifest_id, entries = image()
        with self.assertRaisesRegex(RuntimeError, "重复"):
            runtime.resolve_config_digest(image_archive(config_id, manifest_id, entries + entries[:1]), manifest_id)

    # 验证无效运行摘要不能被传给 Docker 命令。
    def test_refuses_invalid_digest_without_starting_docker(self):
        with patch.object(runtime.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(RuntimeError, "摘要"):
                runtime.export_config_digest("tag:latest")
            popen.assert_not_called()

    # 验证导出只使用容器实际不可变摘要，失败时拒绝结果并清理子进程。
    def test_export_failure_is_reported_and_process_is_reaped(self):
        config_id, manifest_id, entries = image()
        process = Mock(stdout=image_archive(config_id, manifest_id, entries), returncode=1)
        process.wait.return_value = 1
        with patch.object(runtime.subprocess, "Popen", return_value=process) as popen:
            with self.assertRaisesRegex(RuntimeError, "导出"):
                runtime.export_config_digest(manifest_id)
            self.assertEqual(popen.call_args.args[0], ["docker", "image", "save", manifest_id])
            process.wait.assert_called()

    # 验证超时会终止并回收 Docker 导出进程，不遗留后台导出。
    def test_export_timeout_terminates_and_reaps_process(self):
        config_id, manifest_id, entries = image()
        process = Mock(stdout=image_archive(config_id, manifest_id, entries))
        process.wait.side_effect = [subprocess.TimeoutExpired("docker", 1), -9]
        with patch.object(runtime.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "超时"):
                runtime.export_config_digest(manifest_id, timeout=1)
            process.kill.assert_called_once()
            self.assertEqual(process.wait.call_count, 2)

    # 验证 tar 读取阻塞期间的真实子进程也受 watchdog 限制，而非仅限制导出完成后的 wait。
    def test_watchdog_interrupts_blocked_tar_stream(self):
        real_popen = subprocess.Popen
        processes = []
        ready_at = []

        def start_blocked_export(_command, **kwargs):
            script = "import sys,time;sys.stdout.buffer.write(b'R');sys.stdout.buffer.flush();time.sleep(30)"
            process = real_popen([sys.executable, "-c", script], **kwargs)
            processes.append(process)
            # Windows 冷启动或并行编译可能延迟进程创建；等待替身就绪，
            # 再测生产代码 watchdog 实际覆盖的区间，不把启动调度算成终止延迟。
            self.assertEqual(process.stdout.read(1), b"R")
            ready_at.append(time.monotonic())
            return process

        with patch.object(runtime.subprocess, "Popen", side_effect=start_blocked_export):
            with self.assertRaisesRegex(RuntimeError, "超时"):
                runtime.export_config_digest("sha256:" + "a" * 64, timeout=0.1)
        self.assertLess(time.monotonic() - ready_at[0], 3)
        self.assertIsNotNone(processes[0].poll())

    # 验证读完 tar 结束标记后仍消费尾部 padding，避免 Docker 被管道背压卡住。
    def test_drains_trailing_bytes_before_waiting_for_export(self):
        config_id, manifest_id, entries = image()
        payload = image_archive(config_id, manifest_id, entries).getvalue() + b"\0" * (1024 * 1024)
        stream = io.BytesIO(payload)
        process = Mock(stdout=stream, returncode=0)

        def wait_after_drain(**_kwargs):
            # 精确验证 read→wait 的先后关系；未消费尾部时立即失败，
            # 不再用 Python 子进程须在一秒内启动并写完管道来间接判断。
            self.assertEqual(stream.tell(), len(payload), "等待导出进程前必须消费全部尾部字节")
            return 0

        process.wait.side_effect = wait_after_drain
        with patch.object(runtime.subprocess, "Popen", return_value=process):
            self.assertEqual(runtime.export_config_digest(manifest_id, timeout=1), config_id)
        process.wait.assert_called_once()


if __name__ == "__main__":
    unittest.main()
