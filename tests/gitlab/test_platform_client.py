"""验证上位机平台发布的冻结身份和边界条件。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import redirect_stderr, redirect_stdout
import io
import hashlib
import json
import os
from pathlib import Path
from subprocess import CompletedProcess
import sys
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/gitlab"))


class UpperIdentityTests(unittest.TestCase):
    def setUp(self):
        import platform_client
        self.client = platform_client
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "upper.exe").write_bytes(b"installer")
        self.environment = dict(CI_PIPELINE_SOURCE="push", CI_COMMIT_BRANCH="main", CI_COMMIT_SHA="a" * 40,
                                CI_PIPELINE_ID="20", CI_PROJECT_URL="http://192.168.10.198:8929/mskdsp/mskdspupper")
        self.data = dict(product="mskdsp-upper", version="0.7.1-ci.20261019t000000+sha.aaaaaaa",
                         platform="windows-x86_64-nsis", file_name="upper.exe", size=9,
                         sha256=self.client.sha256_file(self.root / "upper.exe"), signature="real-signature-fixture",
                         notes="CI", source_repository=self.environment["CI_PROJECT_URL"], source_ref="main",
                         source_sha="a" * 40, channel="ci", pipeline_id="20")

    def load(self):
        target = self.root / "upload-metadata.json"
        target.write_text(json.dumps(self.data), encoding="utf-8")
        return self.client.load_metadata(target, self.environment)

    def test_valid_identity_preserves_signature(self):
        archive, identity = self.load()
        self.assertEqual(archive.name, "upper.exe")
        self.assertEqual(identity["signature"], "real-signature-fixture")
        self.assertNotIn("pipeline_id", identity)

    def test_unsigned_is_rejected(self):
        self.data["signature"] = ""
        with self.assertRaises(self.client.ClientError):
            self.load()

    def test_changed_installer_is_rejected(self):
        (self.root / "upper.exe").write_bytes(b"tampered!")
        with self.assertRaises(self.client.ClientError):
            self.load()

    def test_other_channel_or_pipeline_is_rejected(self):
        for field, value in (("channel", "stable"), ("source_sha", "b" * 40), ("pipeline_id", "21")):
            original = self.data[field]
            self.data[field] = value
            with self.assertRaises(self.client.ClientError):
                self.load()
            self.data[field] = original

    def test_plaintext_public_endpoint_is_rejected(self):
        with self.assertRaises(self.client.ClientError):
            self.client.validate_endpoint("8.8.8.8:50000", plaintext=True)

    def test_public_manifest_download_checks_actual_bytes(self):
        data = self.data
        payload = [b"installer"]
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                if self.path.endswith("latest.json"):
                    body = json.dumps(dict(version=data["version"], platforms={data["platform"]: dict(
                        signature=data["signature"], url=base + "/software/packages/package-id/upper.exe")})).encode()
                else:
                    body = payload[0]
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_arguments):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:" + str(server.server_port)
        self.client.confirm_manifest(base, data)
        self.assertEqual(requests[0], "/mskdsp-upper/" + data["channel"] + "/latest.json")
        payload[0] = b"tampered!"
        with self.assertRaises(self.client.ClientError):
            self.client.confirm_manifest(base, data)


class GitHubIdentityTests(UpperIdentityTests):
    def setUp(self):
        super().setUp()
        # 混入 GitLab 变量，确认 Actions 只使用自身的运行身份。
        self.environment.update(GITHUB_ACTIONS="true", GITHUB_EVENT_NAME="push",
                                GITHUB_REF="refs/heads/main", GITHUB_REF_TYPE="branch",
                                GITHUB_REF_PROTECTED="false", GITHUB_SHA="a" * 40, GITHUB_RUN_ID="120",
                                GITHUB_SERVER_URL="https://github.com", GITHUB_REPOSITORY="CcooLcyy/MskDSPUpper")
        self.data.update(source_repository="https://github.com/CcooLcyy/MskDSPUpper", pipeline_id="120")

    # 人工触发仍需选中受保护的正式标签，并核对远端的完整发布历史。
    def test_stable_uses_protected_tag_and_anonymous_source_verification(self):
        self.environment.update(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/tags/v0.7.1",
                                GITHUB_REF_TYPE="tag", GITHUB_REF_PROTECTED="true", CI_JOB_TOKEN="unused")
        self.data.update(channel="stable", source_ref="v0.7.1", version="0.7.1")
        _, identity = self.load()
        with patch.object(self.client, "verify_stable_source") as verify:
            self.client.check_current_head(identity, self.environment)
        repository, ref, sha, git_environment = verify.call_args.args
        self.assertEqual((repository, ref, sha), (self.data["source_repository"] + ".git", "v0.7.1", "a" * 40))
        self.assertNotIn("CI_JOB_TOKEN", git_environment)
        self.assertEqual(git_environment["GIT_CONFIG_VALUE_0"], "")
        self.environment["GITHUB_REF_PROTECTED"] = "false"
        with self.assertRaises(self.client.ClientError):
            self.load()

    # PR、引用类型伪造和产物提供的第三方仓库不能转为发布来源。
    def test_rejects_other_source_identities(self):
        for changes in (dict(GITHUB_EVENT_NAME="pull_request"), dict(GITHUB_REF_TYPE="tag"),
                        dict(GITHUB_SERVER_URL="https://example.invalid")):
            with self.subTest(changes=changes), patch.dict(self.environment, changes), \
                    self.assertRaises(self.client.ClientError):
                self.load()
        self.data["source_repository"] = "https://github.com/other/upper"
        with self.assertRaises(self.client.ClientError):
            self.load()

    # 维护分支只在受保护且匹配版本线时生成 CI 产物身份。
    def test_release_branch_requires_protection_and_matching_version(self):
        from release_policy import release_context
        (self.root / "package.json").write_text('{"version":"0.7.1"}', encoding="utf-8")
        self.environment.update(GITHUB_REF="refs/heads/release/0.7", GITHUB_REF_PROTECTED="true")
        self.assertEqual(release_context(self.root, self.environment)["channel"], "ci")
        for changes in (dict(GITHUB_REF_PROTECTED="false"), dict(GITHUB_REF="refs/heads/release/0.8")):
            with self.subTest(changes=changes), patch.dict(self.environment, changes), self.assertRaises(ValueError):
                release_context(self.root, self.environment)

    # 冻结元数据必须来自 Actions 运行身份与真实检出的 SHA，而不是构建元数据里的来源字段。
    def test_freeze_uses_checked_out_github_identity(self):
        import freeze_metadata
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(self.root)
        (self.root / "package.json").write_text(json.dumps(dict(version=self.data["version"])), encoding="utf-8")
        stage = self.root / "package/staging/ci/windows-x64"
        stage.mkdir(parents=True)
        (stage / "upper.exe").write_bytes(b"installer")
        (stage / "upper.exe.sig").write_text(self.data["signature"], encoding="utf-8")
        (stage / "staging-manifest.json").write_text(json.dumps(dict(installers=["upper.exe"])), encoding="utf-8")
        source = self.root / "metadata.json"
        source.write_text(json.dumps(dict(channel="ci", channelLabel="ci", platform="windows-x64",
                                         shortSha="aaaaaaa", effectiveVersion=self.data["version"], baseVersion="0.7.1",
                                         releaseTitle="CI", repository="other/upper")), encoding="utf-8")
        with patch.dict(os.environ, self.environment, clear=True), patch.object(freeze_metadata.subprocess, "run",
                return_value=CompletedProcess([], 0, "a" * 40 + "\n")), redirect_stdout(io.StringIO()):
            freeze_metadata.freeze(source, self.root / "frozen")
        frozen = json.loads((self.root / "frozen/upload-metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(frozen, self.data)


class ProtocolSnapshotTests(unittest.TestCase):
    # 构建时固定的发布协议与桌面协议快照使用相同来源，摘要按协议仓库的 LF 文本计算，兼容 Windows 检出换行。
    def test_protocol_pin_matches_snapshot_commit_and_content(self):
        import init_platform_proto
        source = json.loads((ROOT / "proto-platform/SOURCE.json").read_text(encoding="utf-8"))
        pin = (ROOT / "scripts/gitlab/platform-proto.ref").read_text(encoding="utf-8").strip()
        self.assertEqual(init_platform_proto.PIN, pin)
        self.assertEqual(source["commit"], pin)
        self.assertEqual(source["repository"], "https://github.com/CcooLcyy/MskDSPPlatformProto.git")
        self.assertEqual(init_platform_proto.REPOSITORY, source["repository"])
        protocol = ROOT / "proto-platform" / source["path"]
        self.assertEqual(hashlib.sha256(protocol.read_text(encoding="utf-8").encode("utf-8")).hexdigest(), source["sha256"])


class SafeDiagnosticsTests(unittest.TestCase):
    def test_upload_safe_error_is_visible(self):
        import platform_client
        output = io.StringIO()
        with patch.object(platform_client, "upload", side_effect=platform_client.ClientError("平台 RPC 失败：UNAVAILABLE")), redirect_stderr(output):
            self.assertEqual(platform_client.main(["--metadata", "unused"]), 1)
        self.assertIn("UNAVAILABLE", output.getvalue())

    def test_upload_unexpected_details_and_token_are_hidden(self):
        import platform_client
        output = io.StringIO()
        secret = "Bearer test-token-do-not-log; grpc details internal path"
        with patch.object(platform_client, "upload", side_effect=RuntimeError(secret)), redirect_stderr(output):
            self.assertEqual(platform_client.main(["--metadata", "unused"]), 1)
        self.assertIn("RuntimeError", output.getvalue())
        self.assertNotIn("test-token-do-not-log", output.getvalue())
        self.assertNotIn("grpc details", output.getvalue())

    def test_protocol_safe_error_is_visible(self):
        import init_platform_proto
        output = io.StringIO()
        with patch.object(init_platform_proto, "initialize", side_effect=init_platform_proto.InitError("平台协议固定提交不一致")), redirect_stderr(output):
            self.assertEqual(init_platform_proto.main([]), 1)
        self.assertIn("固定提交不一致", output.getvalue())

    def test_protocol_unexpected_details_and_token_are_hidden(self):
        import init_platform_proto
        output = io.StringIO()
        with patch.object(init_platform_proto, "initialize", side_effect=RuntimeError("Authorization Basic secret-token")), redirect_stderr(output):
            self.assertEqual(init_platform_proto.main([]), 1)
        self.assertIn("RuntimeError", output.getvalue())
        self.assertNotIn("secret-token", output.getvalue())
        self.assertNotIn("Authorization", output.getvalue())


class UploadTransportTests(unittest.TestCase):
    def test_private_plaintext_bypasses_proxy_while_tls_keeps_default_transport(self):
        import platform_client
        for plaintext, endpoint in ((True, "192.168.10.198:50000"), (False, "platform.example.com:443")):
            with self.subTest(plaintext=plaintext):
                grpc = MagicMock()
                bindings = MagicMock()
                bindings.__enter__.return_value = (MagicMock(), MagicMock())
                environment = dict(PLATFORM_GRPC_PLAINTEXT="1" if plaintext else "0",
                                   PLATFORM_GRPC_ENDPOINT=endpoint, PLATFORM_PUBLIC_BASE_URL="https://platform.example.com",
                                   HTTPS_PROXY="http://proxy.example.com:8080")
                with patch.dict("os.environ", environment, clear=True), patch.dict(sys.modules, {"grpc": grpc}), \
                        patch.object(platform_client, "load_metadata", return_value=(Path("unused.exe"), {"channel": "ci", "source_ref": "main"})), \
                        patch.object(platform_client, "check_current_head"), patch.object(platform_client, "generate_bindings"), \
                        patch.object(platform_client, "load_bindings", return_value=bindings), \
                        patch.object(platform_client, "transfer", return_value="published"):
                    self.assertEqual(platform_client.upload("unused.json"), "published")
                    if plaintext:
                        grpc.insecure_channel.assert_called_once_with(endpoint, options=(("grpc.enable_http_proxy", 0),))
                        grpc.secure_channel.assert_not_called()
                    else:
                        grpc.secure_channel.assert_called_once_with(endpoint, grpc.ssl_channel_credentials.return_value)
                        grpc.ssl_channel_credentials.assert_called_once_with(None)
                        grpc.insecure_channel.assert_not_called()


if __name__ == "__main__":
    unittest.main()
