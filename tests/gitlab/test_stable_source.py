"""在 CI 中使用临时真实 Git 仓库验证远端引用和完整祖先关系。"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import test_platform_client  # 初始化仓库脚本导入路径
from verify_stable_source import verify_stable_source


class StableHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name) / "source"
        self.repository.mkdir()
        self.environment = {**os.environ, "GIT_AUTHOR_NAME": "Release fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test",
                            "GIT_COMMITTER_NAME": "Release fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test"}
        self.git("init", "-b", "main")
        self.git("commit", "--allow-empty", "-m", "first")
        self.sha = self.git("rev-parse", "HEAD")
        self.git("commit", "--allow-empty", "-m", "advanced")
        self.head = self.git("rev-parse", "HEAD")
        self.git("tag", "v0.9.0", self.sha)

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.repository, env=self.environment,
                              capture_output=True, text=True, check=True).stdout.strip()

    def verify(self):
        verify_stable_source(str(self.repository), "v0.9.0", self.sha, self.environment)

    def test_lightweight_and_annotated_tags_accept_advanced_main(self):
        self.assertNotEqual(self.sha, self.head)
        self.verify()
        self.git("tag", "-d", "v0.9.0")
        self.git("tag", "-a", "v0.9.0", self.sha, "-m", "release")
        self.verify()

    def test_matching_release_history_accepts_advanced_head_without_main(self):
        self.git("update-ref", "refs/heads/release/0.9", self.head)
        self.git("update-ref", "-d", "refs/heads/main")
        self.verify()

    def test_missing_moved_tag_and_wrong_release_line_are_rejected(self):
        self.git("tag", "-f", "v0.9.0", self.head)
        with self.assertRaises(ValueError):
            self.verify()
        self.git("tag", "-f", "v0.9.0", self.sha)
        self.git("update-ref", "refs/heads/release/0.8", self.head)
        self.git("update-ref", "-d", "refs/heads/main")
        with self.assertRaises(ValueError):
            self.verify()
        self.git("tag", "-d", "v0.9.0")
        with self.assertRaises(ValueError):
            self.verify()

    def test_tag_changed_during_history_fetch_is_rejected(self):
        original_run = subprocess.run
        for change in ("moved", "deleted", "same_commit_new_annotated_object"):
            with self.subTest(change=change):
                self.git("tag", "-f", "v0.9.0", self.sha)
                mutated = []

                def run_then_change_tag(arguments, **options):
                    result = original_run(arguments, **options)
                    if arguments[1] == "fetch" and not mutated:
                        mutated.append(change)
                        if change == "deleted":
                            self.git("tag", "-d", "v0.9.0")
                        elif change == "moved":
                            self.git("tag", "-f", "v0.9.0", self.head)
                        else:
                            self.git("tag", "-f", "-a", "v0.9.0", self.sha, "-m", "replacement object")
                    return result

                with patch("verify_stable_source.subprocess.run", side_effect=run_then_change_tag), \
                        self.assertRaises(ValueError):
                    self.verify()
                self.assertEqual(mutated, [change])

    def test_unrelated_main_history_is_rejected(self):
        tree = self.git("rev-parse", "HEAD^{tree}")
        unrelated = self.git("commit-tree", tree, "-m", "unrelated root")
        self.git("update-ref", "refs/heads/main", unrelated)
        with self.assertRaises(ValueError):
            self.verify()


if __name__ == "__main__":
    unittest.main()
