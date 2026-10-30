"""验证真实 Node 子进程完整保留中文输出及测试结果，不依赖随机重试。"""
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


class NodeRuntimeProbeTests(unittest.TestCase):
    # 每次只运行一次原始探针；运行器异常或丢失整份测试结果必须失败。
    def test_chinese_stdout_does_not_corrupt_test_runner_messages(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "运行环境缺少 Node，无法验证测试消息边界")
        result = subprocess.run(
            [node, "--test", "--test-reporter=tap", "tests/gitlab/fixtures/node-test-stdout.mjs"],
            cwd=ROOT, capture_output=True, timeout=30,
        )
        output = (result.stdout + result.stderr).decode("utf-8", errors="replace")
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("中文标准输出与测试消息共存", output)
        self.assertIn("# pass 1", output)
        self.assertIn("# fail 0", output)


if __name__ == "__main__":
    unittest.main()
