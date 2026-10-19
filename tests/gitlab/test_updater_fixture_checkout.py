"""用真实 Git Windows 换行策略检出，确保验签输入不被文本转换修改。"""
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path("src-tauri/testdata/updater/fixture.bin")


@unittest.skipUnless(shutil.which("git"), "需要 Git 执行真实检出回归")
class SignedFixtureCheckoutTests(unittest.TestCase):
    # 模拟 Runner 的 core.autocrlf=true；签名针对原始字节，不能转换 LF。
    def test_autocrlf_checkout_preserves_signed_payload_bytes(self):
        expected = (ROOT / FIXTURE).read_bytes()
        environment = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                       "GIT_TERMINAL_PROMPT": "0"}
        with tempfile.TemporaryDirectory(prefix="upper-signed-checkout-") as temporary:
            repository = Path(temporary) / "source"
            checkout = Path(temporary) / "checkout"
            repository.mkdir()

            def git(*arguments, cwd=repository):
                result = subprocess.run(["git", *arguments], cwd=cwd, env=environment,
                                        capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
                return result.stdout

            git("init", "-q", "-b", "main")
            git("config", "core.autocrlf", "false")
            destination = repository / FIXTURE
            destination.parent.mkdir(parents=True)
            destination.write_bytes(expected)
            attributes = ROOT / ".gitattributes"
            if attributes.is_file():
                shutil.copyfile(attributes, repository / ".gitattributes")
            git("add", "--all")
            git("-c", "user.name=Fixture Test", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture")
            git("-c", "core.autocrlf=true", "clone", "-q", "--no-hardlinks",
                str(repository), str(checkout), cwd=Path(temporary))
            self.assertEqual((checkout / FIXTURE).read_bytes(), expected,
                             "签名输入在 Git 检出时发生了换行转换")

    # 已有工作区不会因新增属性自动重写未改内容的文件，执行真实 CI 恢复步骤后必须还原。
    def test_existing_runner_checkout_restores_original_signed_bytes(self):
        expected = (ROOT / FIXTURE).read_bytes()
        environment = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                       "GIT_TERMINAL_PROMPT": "0"}
        with tempfile.TemporaryDirectory(prefix="upper-signed-existing-") as temporary:
            repository = Path(temporary) / "source"
            checkout = Path(temporary) / "checkout"
            repository.mkdir()

            def git(*arguments, cwd=repository):
                result = subprocess.run(["git", *arguments], cwd=cwd, env=environment,
                                        capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))

            def commit(message):
                git("add", "--all")
                git("-c", "user.name=Fixture Test", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "-q", "-m", message)

            git("init", "-q", "-b", "main")
            git("config", "core.autocrlf", "false")
            destination = repository / FIXTURE
            destination.parent.mkdir(parents=True)
            destination.write_bytes(expected)
            commit("original")
            git("-c", "core.autocrlf=true", "clone", "-q", str(repository), str(checkout),
                cwd=Path(temporary))
            self.assertNotEqual((checkout / FIXTURE).read_bytes(), expected, "必须先复现旧工作区换行转换")
            shutil.copyfile(ROOT / ".gitattributes", repository / ".gitattributes")
            commit("protect")
            git("fetch", "-q", "origin", "main", cwd=checkout)
            git("-c", "core.autocrlf=true", "checkout", "-q", "--force", "--detach", "FETCH_HEAD", cwd=checkout)
            for line in (ROOT / ".gitlab-ci.yml").read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("- git restore "):
                    command = shlex.split(line.strip()[2:])
                    git("-c", "core.autocrlf=true", *command[1:], cwd=checkout)
            self.assertEqual((checkout / FIXTURE).read_bytes(), expected,
                             "CI 必须从 HEAD 恢复旧工作区的签名输入，不能只依赖属性变化")


if __name__ == "__main__":
    unittest.main()
