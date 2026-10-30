"""以隔离 ZIP 和命令桩验证固定 Node 运行时，不下载或执行真实安装包。"""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("node_runtime", ROOT / "scripts/gitlab/ensure_node_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class NodeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="upper-node-runtime-")
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name) / "cache"
        self.payload = self.archive()
        self.downloads = []
        self.addCleanup(patch.stopall)
        patch.object(RUNTIME, "SHA256", hashlib.sha256(self.payload).hexdigest()).start()
        patch.object(RUNTIME, "download", side_effect=self.download).start()
        patch.object(RUNTIME, "runtime_version", return_value=RUNTIME.VERSION).start()

    def archive(self, extra=None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name in RUNTIME.REQUIRED_FILES:
                archive.writestr(f"{RUNTIME.DIRECTORY}/{name}", f"测试内容 {name}")
            if extra:
                archive.writestr(*extra)
        data = buffer.getvalue()
        if extra and isinstance(extra[0], str) and "\\" in extra[0]:
            data = data.replace(extra[0].replace("\\", "/").encode(), extra[0].encode())
        return data

    def download(self, destination):
        self.downloads.append(destination)
        destination.write_bytes(self.payload)

    # 首次校验安装后复用完整目录；不重新下载或修改其他版本。
    def test_installs_then_reuses_verified_cache(self):
        self.cache.mkdir()
        other = self.cache / "node-old"
        other.mkdir()
        (other / "keep").write_text("keep")
        first = RUNTIME.ensure(self.cache)
        second = RUNTIME.ensure(self.cache)
        self.assertEqual(first["source"], "download")
        self.assertEqual(second["source"], "cache")
        self.assertEqual(second["version"], RUNTIME.VERSION)
        self.assertEqual(Path(first["directory"]).parent, self.cache.resolve())
        self.assertEqual(len(self.downloads), 1)
        self.assertTrue((other / "keep").exists())

    # 错误下载或中断不得形成可复用版本目录。
    def test_hash_mismatch_or_failed_download_leaves_no_cache(self):
        with patch.object(RUNTIME, "SHA256", "0" * 64):
            with self.assertRaisesRegex(RuntimeError, "SHA256"):
                RUNTIME.ensure(self.cache)
        self.assertFalse((self.cache / RUNTIME.DIRECTORY).exists())
        with patch.object(RUNTIME, "download", side_effect=OSError("https://user:secret@example.invalid")):
            with self.assertRaisesRegex(RuntimeError, "下载") as caught:
                RUNTIME.ensure(self.cache)
        self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(list(self.cache.iterdir()), [])

    # 缓存核心文件、附加文件及归档污染均应被拒绝，不能悄悄执行。
    def test_modified_missing_and_extra_cache_files_are_rejected(self):
        for mutation in ("modified", "missing", "extra", "archive"):
            with self.subTest(mutation=mutation):
                cache = self.cache / mutation
                directory = Path(RUNTIME.ensure(cache)["directory"])
                if mutation == "modified":
                    (directory / "node.exe").write_bytes(b"bad")
                elif mutation == "missing":
                    (directory / "npm.cmd").unlink()
                elif mutation == "extra":
                    (directory / "extra.js").write_bytes(b"bad")
                else:
                    (directory / RUNTIME.ARCHIVE_CACHE).write_bytes(b"bad")
                with self.assertRaisesRegex(RuntimeError, "校验|完整"):
                    RUNTIME.ensure(cache)

    # 非目标版本的命令响应不能被当成固定版本。
    def test_wrong_runtime_version_does_not_publish_cache(self):
        with patch.object(RUNTIME, "runtime_version", return_value="v24.10.0"):
            with self.assertRaisesRegex(RuntimeError, "版本"):
                RUNTIME.ensure(self.cache)
        self.assertFalse((self.cache / RUNTIME.DIRECTORY).exists())

    # 命令失败不能以 stdout 冒充版本，也不能把 stderr 中的敏感内容回显。
    def test_runtime_command_requires_success_and_hides_stderr(self):
        patch.stopall()
        with patch.object(RUNTIME.subprocess, "run", return_value=subprocess.CompletedProcess([], 7, RUNTIME.VERSION, "secret")):
            with self.assertRaisesRegex(RuntimeError, "版本检查失败") as caught:
                RUNTIME.runtime_version(self.cache)
        self.assertNotIn("secret", str(caught.exception))
        with patch.object(RUNTIME.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, RUNTIME.VERSION + "\n", "")) as run:
            self.assertEqual(RUNTIME.runtime_version(self.cache), RUNTIME.VERSION)
            self.assertEqual(run.call_args.args[0], [str(self.cache / "node.exe"), "--version"])

    # 不允许缓存根经过链接，避免下载或解压写入其他目录。
    def test_linked_cache_root_is_rejected_before_download(self):
        with patch.object(Path, "is_symlink", lambda path: path == self.cache):
            with self.assertRaisesRegex(RuntimeError, "链接"):
                RUNTIME.ensure(self.cache)
        self.assertEqual(self.downloads, [])

    # ZIP 中的父级逃逸、绝对路径、Windows 路径及符号链接均在解压前拒绝。
    def test_unsafe_archive_members_are_rejected(self):
        link = zipfile.ZipInfo(f"{RUNTIME.DIRECTORY}/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entry in (("../escape", "bad"), ("/absolute", "bad"), (f"{RUNTIME.DIRECTORY}/C:/bad", "bad"), (f"{RUNTIME.DIRECTORY}/a\\b", "bad"), (link, "../../escape")):
            with self.subTest(entry=str(entry[0])):
                self.payload = self.archive(entry)
                with patch.object(RUNTIME, "SHA256", hashlib.sha256(self.payload).hexdigest()):
                    with self.assertRaisesRegex(RuntimeError, "路径|链接"):
                        RUNTIME.ensure(self.cache)
        self.assertFalse((self.cache.parent / "escape").exists())

    # 不完整归档即便校验和匹配也不能成为成功安装。
    def test_missing_required_files_are_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(f"{RUNTIME.DIRECTORY}/node.exe", "node")
        self.payload = buffer.getvalue()
        with patch.object(RUNTIME, "SHA256", hashlib.sha256(self.payload).hexdigest()):
            with self.assertRaisesRegex(RuntimeError, "完整"):
                RUNTIME.ensure(self.cache)

    # CLI 成功只输出 JSON，失败保持非零退出与中文安全错误。
    def test_cli_machine_output_and_failure_exit(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(RUNTIME.main(["--cache-root", str(self.cache)]), 0)
        self.assertEqual(json.loads(output.getvalue())["source"], "download")
        error = io.StringIO()
        with patch.object(RUNTIME, "ensure", side_effect=RuntimeError("缓存校验失败")), contextlib.redirect_stderr(error):
            self.assertEqual(RUNTIME.main(["--cache-root", str(self.cache)]), 1)
        self.assertIn("缓存校验失败", error.getvalue())


if __name__ == "__main__":
    unittest.main()
