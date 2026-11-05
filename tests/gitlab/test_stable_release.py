"""验证正式标签来源、纯版本及main/release 历史的发布门禁。"""
from contextlib import redirect_stdout
import io
import json
import os
import subprocess
import unittest
from unittest.mock import patch

import test_release_candidate
from test_platform_client import UpperIdentityTests


class StableIdentityTests(UpperIdentityTests):
    def setUp(self):
        super().setUp()
        self.environment.update(CI_COMMIT_BRANCH="", CI_COMMIT_TAG="v0.7.1", CI_COMMIT_REF_PROTECTED="true")
        self.data.update(channel="stable", source_ref="v0.7.1", version="0.7.1", notes="Stable")

    # CI 基类将 Stable 视为非法渠道；此处保持同等断言但使用 Beta 作为错误渠道。
    def test_other_channel_or_pipeline_is_rejected(self):
        for field, value in (("channel", "beta"), ("source_sha", "b" * 40), ("pipeline_id", "21")):
            original = self.data[field]
            self.data[field] = value
            with self.subTest(field=field), self.assertRaises(self.client.ClientError):
                self.load()
            self.data[field] = original

    # 正式包必须匹配纯版本、标签和受保护的流水线来源。
    def test_stable_rejects_prerelease_wrong_tag_and_unprotected_source(self):
        for changes in (dict(version="0.7.2"), dict(version="0.7.1-ci.20261019t000000+sha.aaaaaaa"),
                        dict(source_ref="beta/0.7.1"), dict(source_ref="v00.7.1"), dict(channel="beta")):
            original = dict(self.data)
            self.data.update(changes)
            with self.subTest(changes=changes), self.assertRaises(self.client.ClientError):
                self.load()
            self.data = original
        for changes in (dict(CI_COMMIT_REF_PROTECTED="false"), dict(CI_COMMIT_BRANCH="main"),
                        dict(CI_COMMIT_TAG="v0.7.2"), dict(CI_PIPELINE_SOURCE="merge_request_event")):
            original = dict(self.environment)
            self.environment.update(changes)
            with self.subTest(changes=changes), self.assertRaises(self.client.ClientError):
                self.load()
            self.environment = original

    def test_stable_uses_remote_history_gate(self):
        _, identity = self.load()
        environment = {**self.environment, "CI_SERVER_URL": "http://gitlab.test", "CI_JOB_TOKEN": "fixture"}
        with patch.object(self.client, "verify_stable_source") as verify:
            self.client.check_current_head(identity, environment)
        self.assertEqual(verify.call_args.args[:3],
                         (identity["source_repository"] + ".git", "v0.7.1", "a" * 40))
        with patch.object(self.client, "verify_stable_source", side_effect=ValueError("moved")), self.assertRaises(self.client.ClientError):
            self.client.check_current_head(identity, environment)

    # 正式冻结保留纯版本及标签身份，不写入 Beta 的版本线。
    def test_stable_freeze_preserves_tag_and_pure_version(self):
        import freeze_metadata
        original_cwd = os.getcwd()
        self.addCleanup(os.chdir, original_cwd)
        os.chdir(self.root)
        (self.root / "package.json").write_text(json.dumps(dict(version="0.7.1")), encoding="utf-8")
        stage = self.root / "package/staging/stable/windows-x64"
        stage.mkdir(parents=True)
        (stage / "upper.exe").write_bytes(b"installer")
        (stage / "upper.exe.sig").write_text("real-signature-fixture", encoding="utf-8")
        (stage / "staging-manifest.json").write_text(json.dumps(dict(installers=["upper.exe"])), encoding="utf-8")
        source = self.root / "metadata.json"
        source.write_text(json.dumps(dict(channel="stable", channelLabel="stable", platform="windows-x64",
                          shortSha="aaaaaaa", effectiveVersion="0.7.1", baseVersion="0.7.1", betaLine=None,
                          releaseTitle="Stable")), encoding="utf-8")
        with patch.dict(os.environ, self.environment, clear=True), patch.object(freeze_metadata.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0, "a" * 40 + "\n")), redirect_stdout(io.StringIO()):
            freeze_metadata.freeze(source, self.root / "frozen")
        frozen = json.loads((self.root / "frozen/upload-metadata.json").read_text(encoding="utf-8"))
        self.assertEqual((frozen["version"], frozen["channel"], frozen["source_ref"]), ("0.7.1", "stable", "v0.7.1"))

    # 正式发布与回执丢失沿用同一套匿名目录验证，不能转去 CI/Beta。
    def test_stable_transfer_confirms_only_stable(self):
        test_release_candidate.ReleaseCandidateIdentityTests.assert_transfer_publishes_and_confirms_only_frozen_channel(self)


class StableSourceTests(unittest.TestCase):
    # 正式标签必须与基础版本完全匹配；不接受次版本线或预发布后缀。
    def test_tag_matches_source_base_version(self):
        from release_policy import resolve_source
        self.assertEqual(resolve_source("v0.8.0", "0.8.0"), "stable")
        for tag in ("v0.8.1", "v0.8", "v00.8.0", "v0.8.0-beta", "0.8.0"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                resolve_source(tag, "0.8.0")


@unittest.skipUnless(os.name == "nt", "需要 Windows Runner 的隔离 PowerShell 进程")
class StablePackagingTests(unittest.TestCase):
    # 真正执行 PowerShell 调度，正式标签传给现有生成器并贯穿打包和冻结。
    def test_stable_package_passes_tag_and_stable_metadata(self):
        from test_parallel_verify import run_isolated_pipeline
        result, events, _ = run_isolated_pipeline(stage="package", branch="v0.8.0")
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        commands = [entry["arguments"] for entry in events if entry["kind"] == "node"]
        emitted = next(args for args in commands if "scripts/workflow/emit-build-metadata.mjs" in args)
        self.assertEqual(emitted[emitted.index("--channel") + 1], "stable")
        self.assertEqual(emitted[emitted.index("--tag") + 1], "v0.8.0")
        self.assertEqual(emitted[emitted.index("--ref") + 1], "v0.8.0")
        self.assertEqual(emitted[emitted.index("--output") + 1], "package/metadata/stable.json")
        rendered = next(args for args in commands if "scripts/workflow/render-tauri-config.mjs" in args)
        self.assertEqual(rendered[rendered.index("--endpoint") + 1],
                         "http://127.0.0.1:8082/mskdsp-upper/stable/latest.json")
        built = next(args for args in commands if "build" in args)
        self.assertEqual(built[built.index("--config") + 1], "package/generated/tauri.stable.conf.json")
        frozen = next(entry["arguments"] for entry in events
                      if "scripts/gitlab/freeze_metadata.py" in entry["arguments"])
        self.assertEqual(frozen[-2:], ["--metadata", "package/metadata/stable.json"])

    # 正式标签与当前基础版本不符时不能执行任何 Node 打包命令。
    def test_wrong_stable_tag_blocks_package_commands(self):
        from test_parallel_verify import run_isolated_pipeline
        result, events, _ = run_isolated_pipeline(stage="package", branch="v0.8.1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(entry["kind"] == "node" for entry in events))


if __name__ == "__main__":
    unittest.main()
