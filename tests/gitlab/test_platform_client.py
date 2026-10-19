"""验证上位机平台发布的冻结身份和边界条件。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
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

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
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
        payload[0] = b"tampered!"
        with self.assertRaises(self.client.ClientError):
            self.client.confirm_manifest(base, data)


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
                        patch.object(platform_client, "load_metadata", return_value=(Path("unused.exe"), {})), \
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
