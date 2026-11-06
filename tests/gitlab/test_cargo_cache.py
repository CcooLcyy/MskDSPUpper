"""在隔离目录中验证 Cargo 缓存归属和回收边界，不执行编译。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cargo_cache", ROOT / "scripts/gitlab/cargo_cache.py")
CACHE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CACHE
SPEC.loader.exec_module(CACHE)


class CargoCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="upper-cargo-cache-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "cargo-target"
        self.manifest = self.root / "workspace/src-tauri/Cargo.toml"
        self.manifest.parent.mkdir(parents=True)
        self.manifest.write_text('[package]\nname = "mskdsp-upper"\nversion = "0.9.0"\n', encoding="utf-8")
        environment = patch.dict(os.environ, {"CI_JOB_ID": "901", "CI_PIPELINE_ID": "801"})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("RUSTC_WORKSPACE_WRAPPER", None)

    def prepare(self, stage="verify", version="0.9.0"):
        return CACHE.prepare(self.target, stage, version, manifest_path=self.manifest)

    def artifact(self, name):
        output = self.target / "x86_64-pc-windows-msvc/release/deps" / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"isolated compiler output")
        return output

    def log(self, name, messages):
        log = self.root / name
        log.write_text("\n".join(json.dumps(message) for message in messages) + "\n", encoding="utf-8")
        return log

    def message(self, output, manifest=None, package_id=None):
        manifest = self.manifest if manifest is None else manifest
        return {
            "reason": "compiler-artifact",
            "package_id": package_id or "path+file:///workspace/src-tauri#mskdsp-upper@0.9.0",
            "manifest_path": str(manifest),
            "target": {"name": "mskdsp_upper_lib", "kind": ["lib"], "crate_types": ["lib"]},
            "profile": {"opt_level": "3", "debuginfo": 0, "test": False},
            "features": [],
            "filenames": [str(output)],
            "executable": None,
            "fresh": True,
        }

    def record_output(self, generation, output, name="cargo.log"):
        log = self.log(name, [self.message(output), {"reason": "build-finished", "success": True}])
        return CACHE.record(self.target, generation, [log])

    def prepare_run(self, job):
        os.environ["CI_JOB_ID"] = str(job)
        verify = self.prepare()
        shared = self.artifact("libmskdsp_upper_lib-1111111111111111.rlib")
        self.record_output(verify["generation"], shared, str(job) + "-verify.log")
        package = self.prepare("package", "0.9.0-ci." + str(job) + "+sha.abcdef0")
        output = self.artifact("libmskdsp_upper_lib-" + format(job, "016x") + ".rlib")
        self.record_output(package["generation"], output, str(job) + "-package.log")
        return package, output, shared

    # 未经允许的外部编译包装器不能被覆盖后继续构建。
    def test_prepare_rejects_external_workspace_wrapper(self):
        os.environ["RUSTC_WORKSPACE_WRAPPER"] = str(self.root / "foreign-wrapper.py")
        with self.assertRaises(ValueError):
            self.prepare()

    # 版本和代次只能作为缓存内的标识，不能通过相对路径逃出受管目录。
    def test_rejects_traversal_in_version_and_generation(self):
        with self.assertRaises(ValueError):
            self.prepare(version="../outside")
        prepared = self.prepare()
        with self.assertRaises(ValueError):
            CACHE.finish(self.target, "../outside", "success")
        self.assertTrue(Path(prepared["manifest_path"]).is_file())

    # 缓存目录链接不得把后续回收引向确认目录以外。
    def test_prepare_rejects_symlink_target(self):
        outside = self.root / "outside"
        outside.mkdir()
        marker = outside / "keep.txt"
        marker.write_text("不得删除", encoding="utf-8")
        try:
            self.target.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest("当前系统不允许创建测试目录链接：" + str(error))
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(marker.read_text(encoding="utf-8"), "不得删除")

    # Cargo 的 Fresh 消息同样代表本轮使用的产物，不能误当成旧缓存。
    def test_record_includes_fresh_current_project_and_excludes_other_manifests(self):
        prepared = self.prepare()
        current = self.artifact("libmskdsp_upper_lib-aaaaaaaaaaaaaaaa.rlib")
        dependency = self.artifact("libdependency-keep.rlib")
        foreign = self.artifact("libmskdsp_upper_lib-bbbbbbbbbbbbbbbb.rlib")
        log = self.log("mixed.log", [
            self.message(current),
            self.message(dependency, self.root / "registry/dependency/Cargo.toml", "registry+example#dependency@1.0.0"),
            self.message(foreign, self.root / "other/src-tauri/Cargo.toml"),
            {"reason": "build-finished", "success": True},
        ])
        recorded = CACHE.record(self.target, prepared["generation"], [log])
        artifacts = [Path(item).name for item in recorded["artifacts"]]
        self.assertIn(current.name, artifacts)
        self.assertNotIn(dependency.name, artifacts)
        self.assertNotIn(foreign.name, artifacts)
        self.assertTrue(recorded["complete"])

    # 中断日志或失败结束消息不能成为可以回收旧缓存的完整成功记录。
    def test_record_requires_successful_build_finished_message(self):
        prepared = self.prepare()
        output = self.artifact("libmskdsp_upper_lib-ffffffffffffffff.rlib")
        for ending in ([], [{"reason": "build-finished", "success": False}]):
            with self.subTest(ending=ending):
                log = self.log("incomplete.log", [self.message(output)] + ending)
                result = CACHE.record(self.target, prepared["generation"], [log])
                self.assertFalse(result["complete"])

    # 测试阶段完整也不能代替缺少完整打包记录的成功判定。
    def test_success_rejects_incomplete_package_record(self):
        verify = self.prepare()
        output = self.artifact("libmskdsp_upper_lib-aaaaaaaaaaaaaaab.rlib")
        self.record_output(verify["generation"], output)
        package = self.prepare("package", "0.9.0-ci.901+sha.abcdef0")
        log = self.log("interrupted-package.log", [self.message(output)])
        CACHE.record(self.target, package["generation"], [log])
        state_file = self.target / ".upper-cache/state.json"
        successes = json.loads(state_file.read_text(encoding="utf-8"))["successes"]
        with self.assertRaises(ValueError):
            CACHE.finish(self.target, package["generation"], "success")
        self.assertEqual(json.loads(state_file.read_text(encoding="utf-8"))["successes"], successes)
        self.assertTrue(output.is_file())

    # 失败任务不回收产物或依赖，保留原始失败现场。
    def test_failed_finish_does_not_delete_recorded_or_dependency_outputs(self):
        prepared = self.prepare()
        current = self.artifact("libmskdsp_upper_lib-cccccccccccccccc.rlib")
        dependency = self.artifact("libdependency-keep.rlib")
        self.record_output(prepared["generation"], current)
        result = CACHE.finish(self.target, prepared["generation"], "failed")
        self.assertEqual(result["deleted"], [])
        self.assertTrue(current.is_file())
        self.assertTrue(dependency.is_file())

    # 预览不得删除文件或改变下一次回收使用的状态记录。
    def test_dry_run_does_not_change_metadata_or_delete_outputs(self):
        first, oldest, _ = self.prepare_run(901)
        CACHE.finish(self.target, first["generation"], "success")
        second, _, _ = self.prepare_run(902)
        CACHE.finish(self.target, second["generation"], "success")
        prepared, current, _ = self.prepare_run(903)
        dependency = self.artifact("libdependency-keep.rlib")
        metadata = self.target / ".upper-cache"
        before = {str(path.relative_to(metadata)): path.read_bytes() for path in metadata.rglob("*") if path.is_file()}
        result = CACHE.finish(self.target, prepared["generation"], "success", dry_run=True)
        after = {str(path.relative_to(metadata)): path.read_bytes() for path in metadata.rglob("*") if path.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(result["deleted"], [])
        self.assertIn(oldest.relative_to(self.target).as_posix(), result["planned"])
        self.assertTrue(oldest.is_file())
        self.assertTrue(current.is_file())
        self.assertTrue(dependency.is_file())

    # 失败构建不能挤掉最近成功记录，否则下一轮可能误删可复用产物。
    def test_failed_run_does_not_advance_success_history(self):
        first, successful, _ = self.prepare_run(901)
        CACHE.finish(self.target, first["generation"], "success")
        state_file = self.target / ".upper-cache/state.json"
        successes = json.loads(state_file.read_text(encoding="utf-8"))["successes"]
        failed, output, _ = self.prepare_run(902)
        result = CACHE.finish(self.target, failed["generation"], "failed")
        self.assertEqual(json.loads(state_file.read_text(encoding="utf-8"))["successes"], successes)
        self.assertEqual(result["deleted"], [])
        self.assertIn("801:901", result["protected_runs"])
        self.assertTrue(successful.is_file())
        self.assertTrue(output.is_file())

    # 第三次成功才回收最早成功的独占文件，当前和上次成功及未知依赖继续保留。
    def test_success_retains_current_and_previous_success_without_deleting_dependencies(self):
        dependency = self.artifact("libserde-dddddddddddddddd.rlib")
        unknown = self.artifact("libmskdsp_upper_lib-eeeeeeeeeeeeeeee.rlib")
        first, oldest, _ = self.prepare_run(901)
        CACHE.finish(self.target, first["generation"], "success")
        second, previous, _ = self.prepare_run(902)
        CACHE.finish(self.target, second["generation"], "success")
        self.assertTrue(oldest.is_file())
        current, output, shared = self.prepare_run(903)
        result = CACHE.finish(self.target, current["generation"], "success")
        self.assertEqual(set(result["protected_runs"]), {"801:902", "801:903"})
        self.assertIn(oldest.relative_to(self.target).as_posix(), result["deleted"])
        self.assertFalse(oldest.exists())
        for retained in (previous, output, shared, dependency, unknown):
            self.assertTrue(retained.is_file(), str(retained))

    # 两种 rustc 参数拼写都应指向受管增量目录，其他参数保持原样。
    def test_wrapper_redirects_primary_incremental_arguments(self):
        prepared = self.prepare()
        os.environ.update({
            "CARGO_PKG_NAME": "mskdsp-upper",
            "CARGO_MANIFEST_DIR": str(self.manifest.parent),
            "UPPER_CARGO_CACHE_ROOT": prepared["root"],
            "UPPER_CARGO_MANIFEST_PATH": str(self.manifest),
            "UPPER_CARGO_GENERATION": prepared["generation"],
        })
        managed = str(Path(prepared["root"]) / "generations" / prepared["generation"])
        prefix = ["rustc.exe", "--crate-name", "mskdsp_upper_lib", "--edition=2021"]
        variants = [
            (["-C", "incremental=" + str(self.target / "release/incremental")], ["-C", "incremental=" + managed]),
            (["-Cincremental=" + str(self.target / "release/incremental")], ["-Cincremental=" + managed]),
        ]
        for original, expected in variants:
            with self.subTest(arguments=original), patch.object(CACHE.subprocess, "call", return_value=0) as compiler:
                self.assertEqual(CACHE.wrapper(prefix + original), 0)
                compiler.assert_called_once_with(prefix + expected)

    # rustc 的失败退出码必须原样返回，不能把失败编译记录成成功产物。
    def test_wrapper_preserves_primary_compiler_failure(self):
        prepared = self.prepare()
        os.environ.update({
            "CARGO_PKG_NAME": "mskdsp-upper",
            "CARGO_MANIFEST_DIR": str(self.manifest.parent),
            "UPPER_CARGO_CACHE_ROOT": prepared["root"],
            "UPPER_CARGO_MANIFEST_PATH": str(self.manifest),
            "UPPER_CARGO_GENERATION": prepared["generation"],
        })
        command = ["rustc.exe", "--crate-name", "mskdsp_upper_lib", "-C", "incremental=original"]
        with patch.object(CACHE.subprocess, "call", return_value=37):
            self.assertEqual(CACHE.wrapper(command), 37)
        invocation = Path(prepared["root"]) / "invocations"
        self.assertEqual(list(invocation.rglob("*.json")) if invocation.exists() else [], [])

    # 第三方依赖不改增量目录，也不依赖主项目缓存环境。
    def test_wrapper_forwards_dependency_without_changing_arguments(self):
        os.environ["CARGO_PKG_NAME"] = "serde"
        command = ["rustc.exe", "--crate-name", "serde", "-C", "incremental=dependency-cache"]
        with patch.object(CACHE.subprocess, "call", return_value=23) as compiler:
            self.assertEqual(CACHE.wrapper(command), 23)
            compiler.assert_called_once_with(command)


if __name__ == "__main__":
    unittest.main()
