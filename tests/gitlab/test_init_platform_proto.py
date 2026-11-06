"""验证公开平台协议的固定提交获取与认证隔离。"""
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/gitlab"))
import init_platform_proto as init


class PublicProtocolTests(unittest.TestCase):
    # 无 CI 认证变量也必须从 GitHub 获取原固定提交，不追踪默认分支。
    def test_fetches_pinned_public_protocol_without_gitlab_credentials(self):
        calls = []

        def run(arguments, **kwargs):
            calls.append((arguments, kwargs))
            if arguments[1] == "init":
                (kwargs["cwd"] / ".git").mkdir()
            return SimpleNamespace(returncode=0, stdout=init.PIN if arguments[1] == "rev-parse" else "")

        with tempfile.TemporaryDirectory() as temporary, patch.object(init.subprocess, "run", side_effect=run), \
                patch.object(init, "validate_protocol") as validate:
            destination = Path(temporary) / "protocol"
            self.assertEqual(init.initialize(destination, {}), destination)
            validate.assert_called_once_with(destination)
        fetch = next(arguments for arguments, _ in calls if arguments[1] == "fetch")
        self.assertEqual(fetch, ["git", "fetch", "--no-tags", "--depth=1",
                                 "https://github.com/CcooLcyy/MskDSPPlatformProto.git", init.PIN])
        self.assertTrue(all(kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0" for _, kwargs in calls))

    # 获取公共协议时清除继承认证头与作业令牌，不修改调用方环境。
    def test_public_environment_removes_inherited_authentication(self):
        original = dict(CI_JOB_TOKEN="secret", GIT_CONFIG_PARAMETERS="injected",
                        GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="http.extraHeader",
                        GIT_CONFIG_VALUE_0="Authorization: secret", GIT_CONFIG_KEY_1="credential.helper",
                        GIT_CONFIG_VALUE_1="injected", HTTPS_PROXY="http://proxy.example.com")
        snapshot = original.copy()
        environment = init.public_protocol_environment(original)
        self.assertEqual(original, snapshot)
        self.assertNotIn("CI_JOB_TOKEN", environment)
        self.assertNotIn("GIT_CONFIG_PARAMETERS", environment)
        self.assertNotIn("GIT_CONFIG_KEY_1", environment)
        self.assertNotIn("GIT_CONFIG_VALUE_1", environment)
        self.assertEqual(environment["GIT_CONFIG_COUNT"], "1")
        self.assertEqual(environment["GIT_CONFIG_KEY_0"], "http.https://github.com/.extraHeader")
        self.assertEqual(environment["GIT_CONFIG_VALUE_0"], "")
        self.assertEqual(environment["HTTPS_PROXY"], original["HTTPS_PROXY"])

    # 来源分支检查仍保留独立的 GitLab 认证，不因公开协议而移除。
    def test_gitlab_authentication_remains_available_for_release_source(self):
        server, environment = init.auth_environment(dict(CI_SERVER_URL="http://gitlab.test", CI_JOB_TOKEN="fixture"))
        self.assertEqual(server, "http://gitlab.test")
        self.assertEqual(environment["GIT_CONFIG_KEY_0"], "http.http://gitlab.test/.extraHeader")
        self.assertTrue(environment["GIT_CONFIG_VALUE_0"].startswith("Authorization: Basic "))


if __name__ == "__main__":
    unittest.main()
