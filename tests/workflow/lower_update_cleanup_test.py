import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "src-tauri/src/commands/lower_update_cleanup.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("lower_update_cleanup", SCRIPT_PATH)
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)
IMAGE_ID = "sha256:" + "a" * 64
CURRENT = "mskdsp-0.3.0-main-ci-20261011-abcdef0-linux-arm64"
PACKAGE_CONTENT = b'#!/usr/bin/env bash\nCONTAINER_NAME="mskdsp"\n__ARCHIVE_BELOW__\n' + b"tar payload"


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mskdsp-cleanup-test-")
        self.directory = Path(self.temporary.name)
        self.current = self.make_package(CURRENT)

    def tearDown(self):
        self.temporary.cleanup()

    def make_package(self, name, content=PACKAGE_CONTENT, directory=None):
        path = (directory or self.directory) / name
        path.write_bytes(content)
        return path

    def run_cleanup(self, **kwargs):
        return cleanup.cleanup_packages(
            str(self.directory), CURRENT, IMAGE_ID,
            runtime_query=kwargs.pop("runtime_query", lambda: (True, IMAGE_ID)), **kwargs,
        )

    # 验证跨通道、跨架构历史安装包删除，当前包和空间统计正确且重复调用幂等。
    def test_removes_official_old_packages_and_is_idempotent(self):
        names = [
            "mskdsp-v0.2.9-linux-arm64",
            "mskdsp-0.3.0-beta-0.3-20261010-120000-abcdef0-linux-arm64",
            "mskdsp-0.3.0-main-ci-20261010-abcdef0-linux-arm64",
            "mskdsp-0.3.0-main-ci-20261010-abcdef0-linux-x64",
        ]
        for name in names:
            self.make_package(name)
        result = self.run_cleanup()
        self.assertEqual(result, {"removed_files": 4, "reclaimed_bytes": 4 * len(PACKAGE_CONTENT)})
        self.assertTrue(self.current.exists())
        for name in names:
            self.assertFalse((self.directory / name).exists())
        self.assertEqual(list(self.directory.glob(".mskdsp-package-cleanup-*")), [])
        self.assertEqual(self.run_cleanup(), {"removed_files": 0, "reclaimed_bytes": 0})

    # 验证其他业务文件、半包、归档、普通脚本、目录和符号链接保持不变。
    def test_preserves_unrelated_files_incomplete_packages_and_links(self):
        names = [
            "mskdsp-v0.2.9-linux-arm64.uploading", "mskdsp-v0.2.9-linux-arm64.download",
            "mskdsp-v0.2.9-linux-arm64.tar", "mskdsp-v0.2.9-debugsymbols-linux-arm64.tar.gz",
            "mskdsp-other-business-linux-arm64", "other-v0.2.9-linux-arm64", "config.json",
        ]
        for name in names:
            self.make_package(name)
        ordinary_script = self.make_package("mskdsp-v0.2.8-linux-arm64", b"#!/bin/sh\necho ready\n")
        empty_payload = self.make_package("mskdsp-v0.2.7-linux-arm64", PACKAGE_CONTENT.split(b"tar payload")[0])
        marker_in_payload = self.make_package(
            "mskdsp-v0.2.7-other-linux-arm64",
            b'#!/usr/bin/env bash\n__ARCHIVE_BELOW__\nCONTAINER_NAME="mskdsp"\npayload',
        )
        nested = self.directory / "mskdsp-v0.2.6-linux-arm64"
        nested.mkdir()
        nested_package = self.make_package("mskdsp-v0.2.5-linux-arm64", directory=nested)
        outside = self.directory / "outside"
        outside.mkdir()
        linked_target = self.make_package("mskdsp-v0.2.4-linux-arm64", directory=outside)
        package_link = self.directory / "mskdsp-v0.2.3-linux-arm64"
        package_link.symlink_to(linked_target)
        self.assertEqual(self.run_cleanup()["removed_files"], 0)
        self.assertTrue(all((self.directory / name).exists() for name in names))
        self.assertTrue(ordinary_script.exists())
        self.assertTrue(empty_payload.exists())
        self.assertTrue(marker_in_payload.exists())
        self.assertTrue(nested_package.exists())
        self.assertTrue(package_link.is_symlink())
        self.assertTrue(linked_target.exists())

    # 验证当前安装包缺失时，在删除任意历史包之前拒绝执行。
    def test_refuses_missing_current_package(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        self.current.unlink()
        with self.assertRaisesRegex(RuntimeError, "当前安装包"):
            self.run_cleanup()
        self.assertTrue(old.exists())

    # 验证当前安装包为链接、非安装脚本或空 payload 时，历史包不会删除。
    def test_refuses_invalid_current_package(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        for content in (b"unrelated", PACKAGE_CONTENT.split(b"tar payload")[0]):
            with self.subTest(content=content):
                self.current.write_bytes(content)
                with self.assertRaisesRegex(RuntimeError, "当前安装包"):
                    self.run_cleanup()
                self.assertTrue(old.exists())
        self.current.unlink()
        self.current.symlink_to(old)
        with self.assertRaisesRegex(RuntimeError, "当前安装包"):
            self.run_cleanup()
        self.assertTrue(old.exists())

    # 验证清理目录为根目录或最终路径是符号链接时拒绝执行。
    def test_refuses_root_directory_and_directory_symlink(self):
        with self.assertRaisesRegex(RuntimeError, "根目录"):
            cleanup.cleanup_packages("/", CURRENT, IMAGE_ID, runtime_query=lambda: (True, IMAGE_ID))
        with self.assertRaisesRegex(RuntimeError, "根目录"):
            cleanup.cleanup_packages("/./", CURRENT, IMAGE_ID, runtime_query=lambda: (True, IMAGE_ID))
        directory_link = self.directory / "directory-link"
        directory_link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "清理目录"):
            cleanup.cleanup_packages(str(directory_link), CURRENT, IMAGE_ID, runtime_query=lambda: (True, IMAGE_ID))

    # 验证安装目录的任意祖先路径是符号链接时拒绝，不删除链接目标中的包。
    def test_refuses_ancestor_directory_symlink(self):
        real_directory = self.directory / "real"
        nested = real_directory / "sub"
        nested.mkdir(parents=True)
        self.make_package(CURRENT, directory=nested)
        old = self.make_package("mskdsp-v0.2.9-linux-arm64", directory=nested)
        alias = self.directory / "alias"
        alias.symlink_to(real_directory, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "清理目录"):
            cleanup.cleanup_packages(str(alias / "sub"), CURRENT, IMAGE_ID, runtime_query=lambda: (True, IMAGE_ID))
        self.assertTrue(old.exists())

    # 验证未运行、镜像不符和运行查询失败都会在删除前失败。
    def test_refuses_unverified_runtime_and_accepts_hex_case(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        for runtime in [(False, IMAGE_ID), (True, "sha256:" + "b" * 64), (True, None)]:
            with self.subTest(runtime=runtime):
                with self.assertRaisesRegex(RuntimeError, "运行|镜像"):
                    self.run_cleanup(runtime_query=lambda: runtime)
                self.assertTrue(old.exists())
        with self.assertRaisesRegex(RuntimeError, "查询"):
            self.run_cleanup(runtime_query=lambda: (_ for _ in ()).throw(RuntimeError("查询失败")))
        self.assertTrue(old.exists())
        self.assertEqual(self.run_cleanup(runtime_query=lambda: (True, "sha256:" + "A" * 64))["removed_files"], 1)

    # 验证包名路径穿越、非版本包名和无效镜像 ID 均在枚举删除前拒绝。
    def test_refuses_invalid_request(self):
        for name in ["../" + CURRENT, "mskdsp-config-linux-arm64", CURRENT + ".uploading", "/" + CURRENT]:
            with self.subTest(name=name):
                with self.assertRaisesRegex(RuntimeError, "安装包名称"):
                    cleanup.cleanup_packages(str(self.directory), name, IMAGE_ID, runtime_query=lambda: (True, IMAGE_ID))
        with self.assertRaisesRegex(RuntimeError, "期望镜像"):
            cleanup.cleanup_packages(str(self.directory), CURRENT, "sha256:bad", runtime_query=lambda: (True, IMAGE_ID))

    # 验证查询运行状态后当前包被替换时，不会删除历史包。
    def test_refuses_current_package_changed_after_runtime_check(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        def replace_current():
            self.current.unlink()
            self.current.write_bytes(PACKAGE_CONTENT + b"new")
            return (True, IMAGE_ID)
        with self.assertRaisesRegex(RuntimeError, "当前安装包.*变化"):
            self.run_cleanup(runtime_query=replace_current)
        self.assertTrue(old.exists())

    # 验证删除前候选包被替换为链接时不跟随链接，也不删除替换后的链接。
    def test_refuses_changed_candidate_identity(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        real_delete = cleanup._delete_package
        def replace_candidate(directory_fd, name, identity):
            old.unlink()
            old.symlink_to(self.current)
            return real_delete(directory_fd, name, identity)
        with patch.object(cleanup, "_delete_package", side_effect=replace_candidate):
            with self.assertRaisesRegex(RuntimeError, "变化"):
                self.run_cleanup()
        self.assertTrue(old.is_symlink())
        self.assertTrue(self.current.exists())

    # 验证最终移动前候选被同名无关文件替换时，不删除替换对象并恢复原名。
    def test_restores_unrelated_replacement_before_quarantine_rename(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        backup = self.directory / "original-package-backup"
        real_rename = cleanup.os.rename
        def replace_before_rename(source, destination, **kwargs):
            real_rename(old, backup)
            old.write_bytes(b"unrelated replacement")
            return real_rename(source, destination, **kwargs)
        with patch.object(cleanup.os, "rename", side_effect=replace_before_rename):
            with self.assertRaisesRegex(RuntimeError, "变化"):
                self.run_cleanup()
        self.assertEqual(old.read_bytes(), b"unrelated replacement")
        self.assertEqual(backup.read_bytes(), PACKAGE_CONTENT)
        self.assertTrue(self.current.exists())
        self.assertEqual(list(self.directory.glob(".mskdsp-package-cleanup-*")), [])

    # 验证隔离前竞态替换的链接安全恢复，链接指向的当前安装包不受影响。
    def test_restores_symlink_replacement_without_following_target(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        backup = self.directory / "original-package-backup"
        real_rename = cleanup.os.rename
        def replace_with_symlink(source, destination, **kwargs):
            real_rename(old, backup)
            old.symlink_to(self.current)
            return real_rename(source, destination, **kwargs)
        with patch.object(cleanup.os, "rename", side_effect=replace_with_symlink):
            with self.assertRaisesRegex(RuntimeError, "变化"):
                self.run_cleanup()
        self.assertTrue(old.is_symlink())
        self.assertEqual(self.current.read_bytes(), PACKAGE_CONTENT)
        self.assertEqual(backup.read_bytes(), PACKAGE_CONTENT)
        self.assertEqual(list(self.directory.glob(".mskdsp-package-cleanup-*")), [])

    # 验证最终 unlink 前上传目录中同名被新无关文件占用时，新文件不会被删除。
    def test_preserves_new_occupant_at_final_unlink_boundary(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        backup = self.directory / "original-package-backup"
        real_rename = cleanup.os.rename
        real_unlink = cleanup.os.unlink
        def replace_original_name_before_unlink(name, **kwargs):
            if name == old.name:
                if old.exists():
                    real_rename(old, backup)
                old.write_bytes(b"unrelated latest occupant")
            return real_unlink(name, **kwargs)
        with patch.object(cleanup.os, "unlink", side_effect=replace_original_name_before_unlink):
            self.run_cleanup()
        self.assertEqual(old.read_bytes(), b"unrelated latest occupant")
        self.assertTrue(self.current.exists())

    # 验证恢复时原名又被占用，不覆盖新文件，替换对象留在隔离目录供恢复。
    def test_preserves_quarantined_replacement_when_original_name_is_occupied(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        backup = self.directory / "original-package-backup"
        real_rename = cleanup.os.rename
        def replace_and_occupy_name(source, destination, **kwargs):
            real_rename(old, backup)
            old.write_bytes(b"first unrelated replacement")
            result = real_rename(source, destination, **kwargs)
            old.write_bytes(b"new unrelated occupant")
            return result
        with patch.object(cleanup.os, "rename", side_effect=replace_and_occupy_name):
            with self.assertRaisesRegex(RuntimeError, "保留.*mskdsp-package-cleanup"):
                self.run_cleanup()
        self.assertEqual(old.read_bytes(), b"new unrelated occupant")
        quarantine = list(self.directory.glob(".mskdsp-package-cleanup-*"))
        self.assertEqual(len(quarantine), 1)
        self.assertEqual((quarantine[0] / old.name).read_bytes(), b"first unrelated replacement")
        self.assertEqual(backup.read_bytes(), PACKAGE_CONTENT)

    # 验证最终移动前候选变成目录时，完整保留隔离目录内对象且不递归删除。
    def test_preserves_directory_replacement_inside_quarantine(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        backup = self.directory / "original-package-backup"
        real_rename = cleanup.os.rename
        def replace_with_directory(source, destination, **kwargs):
            real_rename(old, backup)
            old.mkdir()
            (old / "business.txt").write_text("business data")
            return real_rename(source, destination, **kwargs)
        with patch.object(cleanup.os, "rename", side_effect=replace_with_directory):
            with self.assertRaisesRegex(RuntimeError, "保留.*mskdsp-package-cleanup"):
                self.run_cleanup()
        quarantine = list(self.directory.glob(".mskdsp-package-cleanup-*"))
        self.assertEqual(len(quarantine), 1)
        self.assertEqual((quarantine[0] / old.name / "business.txt").read_text(), "business data")
        self.assertEqual(backup.read_bytes(), PACKAGE_CONTENT)

    # 验证隔离中 unlink 失败时，普通包安全恢复原名且空隔离目录清理。
    def test_restores_package_after_quarantine_unlink_failure(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        real_unlink = cleanup.os.unlink
        attempts = 0
        def refuse_first_unlink(name, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise PermissionError("Permission denied")
            return real_unlink(name, **kwargs)
        with patch.object(cleanup.os, "unlink", side_effect=refuse_first_unlink):
            with self.assertRaisesRegex(RuntimeError, "删除历史安装包失败"):
                self.run_cleanup()
        self.assertEqual(old.read_bytes(), PACKAGE_CONTENT)
        self.assertEqual(list(self.directory.glob(".mskdsp-package-cleanup-*")), [])

    # 验证删除权限错误返回中文错误且保留尚未删除的安装包。
    def test_reports_delete_permission_error_in_chinese(self):
        old = self.make_package("mskdsp-v0.2.9-linux-arm64")
        with patch.object(cleanup.os, "unlink", side_effect=PermissionError("Permission denied")):
            with self.assertRaisesRegex(RuntimeError, "删除历史安装包失败"):
                self.run_cleanup()
        self.assertTrue(old.exists())

    # 验证实际 docker 查询使用固定容器，不通过 shell 拼接，且查询错误阻止清理。
    def test_queries_docker_container_in_same_script(self):
        completed = subprocess.CompletedProcess([], 0, "true " + IMAGE_ID + "\n", "")
        with patch.object(cleanup.subprocess, "run", return_value=completed) as run:
            self.assertEqual(cleanup.query_runtime(), (True, IMAGE_ID))
        args = run.call_args.args[0]
        self.assertEqual(args[0], "docker")
        self.assertEqual(args[-1], "mskdsp")
        self.assertIn("--type=container", args)
        self.assertNotIn("shell", run.call_args.kwargs)
        with patch.object(cleanup.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "No such container")):
            with self.assertRaisesRegex(RuntimeError, "查询.*容器"):
                cleanup.query_runtime()

    # 验证命令入口只输出 JSON 统计，错误通过中文标准错误与非零退出码返回。
    def test_command_entrypoint_outputs_parseable_json(self):
        with patch.object(cleanup, "query_runtime", return_value=(True, IMAGE_ID)):
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(cleanup.main([str(self.directory), CURRENT, IMAGE_ID]), 0)
                self.assertEqual(json.loads(output.getvalue())["removed_files"], 0)
        with patch("sys.stderr", new_callable=io.StringIO) as output:
            self.assertEqual(cleanup.main([str(self.directory), CURRENT, "bad"]), 1)
            self.assertIn("历史安装包清理失败", output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
