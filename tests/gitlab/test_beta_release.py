"""验证真实 Beta 身份、渠道隔离和分支变动时的发布保护。"""
from contextlib import redirect_stdout
import io
import json
import os
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from test_platform_client import UpperIdentityTests


class BetaIdentityTests(UpperIdentityTests):
    def setUp(self):
        super().setUp()
        self.environment.update(CI_COMMIT_BRANCH="beta/0.7.1", CI_COMMIT_REF_PROTECTED="true")
        self.data.update(channel="beta", source_ref="beta/0.7.1",
                         version="0.7.1-beta.0.7.1.20261019t000000+sha.aaaaaaa", notes="Beta")

    # Beta 使用重新打包的真实版本，保留已有签名而非直接改 CI 包通道。
    def test_beta_version_channel_and_source_are_bound(self):
        _, identity = self.load()
        self.assertEqual((identity["channel"], identity["source_ref"]), ("beta", "beta/0.7.1"))
        for changes in (dict(channel="ci"), dict(version="0.7.1-ci.20261019t000000+sha.aaaaaaa"),
                        dict(version="0.7.2-beta.0.7.1.20261019t000000+sha.aaaaaaa"),
                        dict(version="0.7.1-beta.0.7.1.20261019t000000+sha.bbbbbbb"),
                        dict(version="0.7.1-beta.0.7.20261019t000000+sha.aaaaaaa")):
            original = dict(self.data)
            self.data.update(changes)
            with self.subTest(changes=changes), self.assertRaises(self.client.ClientError):
                self.load()
            self.data = original

    # 未保护分支及非 push/web 来源不能取得发布资格。
    def test_unprotected_beta_and_foreign_pipeline_are_rejected(self):
        for changes in (dict(CI_COMMIT_REF_PROTECTED="false"), dict(CI_PIPELINE_SOURCE="merge_request_event"),
                        dict(CI_COMMIT_TAG="v0.7.1"), dict(CI_COMMIT_BRANCH="main")):
            original = dict(self.environment)
            self.environment.update(changes)
            with self.subTest(changes=changes), self.assertRaises(self.client.ClientError):
                self.load()
            self.environment = original

    # 过期 Beta 源提交在发布前被拒绝，并查询对应 Beta 而非 main。
    def test_changed_beta_head_blocks_publish(self):
        _, identity = self.load()
        environment = {**self.environment, "CI_SERVER_URL": "http://gitlab.test", "CI_JOB_TOKEN": "fixture"}
        with patch.object(self.client.subprocess, "run", return_value=subprocess.CompletedProcess([], 0,
                          "b" * 40 + "\trefs/heads/beta/0.7.1\n")) as run:
            with self.assertRaises(self.client.ClientError):
                self.client.check_current_head(identity, environment)
        self.assertEqual(run.call_args.args[0][-1], "refs/heads/beta/0.7.1")

    # 发布及匿名回读使用冻结渠道，入库已完成时不重新传输。
    def test_transfer_publishes_and_confirms_only_frozen_channel(self):
        archive, identity = self.load()
        channel = identity["channel"]
        expected = SimpleNamespace(**identity)
        package = SimpleNamespace(id="package", metadata=expected, channels=[channel], ever_published=True)
        upload = SimpleNamespace(id="upload", metadata=expected, received_bytes=identity["size"],
                                 state="completed", package_id="package")
        publisher, catalog, messages, grpc = (MagicMock() for _ in range(4))
        grpc.RpcError = type("RpcError", (Exception,), {})
        messages.PackageMetadata.side_effect = lambda **data: SimpleNamespace(**data)
        publisher.CreateUpload.return_value.upload = upload
        publisher.GetUpload.return_value.upload = upload
        publisher.PublishRelease.return_value.package = package
        catalog.GetPackage.return_value.package = package
        catalog.ListPackages.return_value.packages = [package]
        before, after = MagicMock(), MagicMock()
        with patch.dict(sys.modules, {"grpc": grpc}), redirect_stdout(io.StringIO()):
            self.client.transfer(publisher, catalog, messages, archive, identity, "fixture-token",
                                 before_publish=before, after_publish=after)
        messages.PublishReleaseRequest.assert_called_once_with(package_id="package", channel=channel)
        messages.ListPackagesRequest.assert_called_once_with(product="mskdsp-upper", channel=channel,
                                                              platform="windows-x86_64-nsis")
        publisher.UploadPackage.assert_not_called()
        before.assert_called_once()
        after.assert_called_once()

        # 发布回执丢失时只查询同一 Beta 包，不回退 CI，也不重新上传。
        lost = grpc.RpcError()
        lost.code = lambda: grpc.StatusCode.UNAVAILABLE
        publisher.PublishRelease.side_effect = lost
        publisher.PublishRelease.reset_mock()
        catalog.ListPackages.reset_mock()
        messages.ListPackagesRequest.reset_mock()
        with patch.dict(sys.modules, {"grpc": grpc}), redirect_stdout(io.StringIO()):
            result = self.client.transfer(publisher, catalog, messages, archive, identity, "fixture-token",
                                          before_publish=before, after_publish=after)
        self.assertEqual(result["package_id"], "package")
        publisher.PublishRelease.assert_called_once()
        messages.ListPackagesRequest.assert_called_once_with(product="mskdsp-upper", channel=channel,
                                                              platform="windows-x86_64-nsis")
        publisher.UploadPackage.assert_not_called()

        # 完成入库后源分支已变化，发布请求必须保持零次。
        before.side_effect = self.client.ClientError("远端来源分支已变化")
        publisher.PublishRelease.reset_mock()
        with patch.dict(sys.modules, {"grpc": grpc}), redirect_stdout(io.StringIO()), self.assertRaises(self.client.ClientError):
            self.client.transfer(publisher, catalog, messages, archive, identity, "fixture-token",
                                 before_publish=before)
        publisher.PublishRelease.assert_not_called()

    # main 继续发布 CI，不能因增加 Beta 而向 Beta 清单或目录写入。
    def test_main_transfer_keeps_ci_channel(self):
        self.environment["CI_COMMIT_BRANCH"] = "main"
        self.data.update(channel="ci", source_ref="main", version="0.7.1-ci.20261019t000000+sha.aaaaaaa")
        self.test_transfer_publishes_and_confirms_only_frozen_channel()

    # 冻结发生在临时替换版本之后，不能把已写入 package.json 的 Beta 版本当成基础版本。
    def test_freeze_uses_build_base_and_preserves_the_real_beta_identity(self):
        import freeze_metadata
        original_cwd = os.getcwd()
        self.addCleanup(os.chdir, original_cwd)
        os.chdir(self.root)
        version = self.data["version"]
        (self.root / "package.json").write_text(json.dumps(dict(version=version)), encoding="utf-8")
        stage = self.root / "package/staging/beta-0.7.1/windows-x64"
        stage.mkdir(parents=True)
        (stage / "upper.exe").write_bytes(b"installer")
        (stage / "upper.exe.sig").write_text("real-signature-fixture", encoding="utf-8")
        (stage / "staging-manifest.json").write_text(json.dumps(dict(installers=["upper.exe"])), encoding="utf-8")
        metadata = dict(channel="beta", channelLabel="beta-0.7.1", platform="windows-x64", shortSha="aaaaaaa",
                        effectiveVersion=version, baseVersion="0.7.1", betaLine="0.7.1", releaseTitle="Beta")
        source = self.root / "metadata.json"
        source.write_text(json.dumps(metadata), encoding="utf-8")
        with patch.dict(os.environ, self.environment, clear=True), patch.object(freeze_metadata.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0, "a" * 40 + "\n")), redirect_stdout(io.StringIO()):
            freeze_metadata.freeze(source, self.root / "frozen")
        frozen = json.loads((self.root / "frozen/upload-metadata.json").read_text(encoding="utf-8"))
        for key in ("channel", "source_ref", "source_sha", "version", "signature", "sha256"):
            self.assertEqual(frozen[key], self.data[key])


class ReleaseSourceTests(unittest.TestCase):
    # Beta 完整版本线或次版本线必须与基础版本一致，拒绝前导零和额外路径。
    def test_base_version_and_branch_validation(self):
        from release_policy import resolve_source
        self.assertEqual(resolve_source("main", "0.8.0"), "ci")
        for branch in ("beta/0.8", "beta/0.8.0"):
            self.assertEqual(resolve_source(branch, "0.8.0"), "beta")
        for branch in ("beta/0.7.0", "beta/0.8.1", "beta/00.8", "beta/0.8/extra", "feature/beta", "v0.8.0"):
            with self.subTest(branch=branch), self.assertRaises(ValueError):
                resolve_source(branch, "0.8.0")


@unittest.skipUnless(sys.platform == "win32", "需要 Windows Runner 的隔离 PowerShell 进程")
class BetaPackagingTests(unittest.TestCase):
    # 实际执行 PowerShell 与渠道选择器，检查传给既有生成器、打包器和冻结器的参数。
    def test_main_and_beta_pass_their_own_source_and_metadata_to_packaging(self):
        from test_parallel_verify import run_isolated_pipeline
        for branch, channel in (("main", "ci"), ("beta/0.8.0", "beta")):
            result, events, _ = run_isolated_pipeline(stage="package", branch=branch)
            with self.subTest(branch=branch):
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
                commands = [entry["arguments"] for entry in events if entry["kind"] == "node"]
                metadata = f"package/metadata/{channel}.json"
                config = f"package/generated/tauri.{channel}.conf.json"
                emitted = next(args for args in commands if "scripts/workflow/emit-build-metadata.mjs" in args)
                self.assertEqual(emitted[emitted.index("--channel") + 1], channel)
                self.assertEqual(emitted[emitted.index("--ref") + 1], branch)
                self.assertEqual(emitted[emitted.index("--output") + 1], metadata)
                rendered = next(args for args in commands if "scripts/workflow/render-tauri-config.mjs" in args)
                self.assertEqual(rendered[rendered.index("--output") + 1], config)
                self.assertEqual(rendered[rendered.index("--endpoint") + 1],
                                 f"http://127.0.0.1:8082/mskdsp-upper/{channel}/latest.json")
                built = next(args for args in commands if "build" in args)
                self.assertEqual(built[built.index("--config") + 1], config)
                frozen = next(entry["arguments"] for entry in events
                              if "scripts/gitlab/freeze_metadata.py" in entry["arguments"])
                self.assertEqual(frozen[-2:], ["--metadata", metadata])

    # 错误 Beta 版本线在真实打包命令之前失败，不能上传冒充的版本。
    def test_wrong_beta_line_blocks_package_commands(self):
        from test_parallel_verify import run_isolated_pipeline
        result, events, _ = run_isolated_pipeline(stage="package", branch="beta/0.7.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(entry["kind"] == "node" for entry in events))


if __name__ == "__main__":
    unittest.main()
