"""Verify stage settings at actual child process boundaries after MSVC import."""
import sys
import unittest

from test_parallel_verify import run_isolated_pipeline


@unittest.skipUnless(sys.platform == "win32", "Windows Runner only")
class IncrementalPolicyTests(unittest.TestCase):
    def test_verify_enables_incremental_after_environment_import_disables_it(self):
        result, events, _ = run_isolated_pipeline()
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        cargo = [entry for entry in events if entry["kind"] == "cargo"]
        self.assertEqual(len(cargo), 1)
        self.assertEqual(cargo[0]["incremental"], "1")

    def test_release_enables_incremental_and_keeps_original_optimization_after_import(self):
        # The shared successful execution runs verify and then package; inspect its real node children.
        result, events, _ = run_isolated_pipeline()
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        nodes = [entry for entry in events if entry["kind"] == "node"]
        self.assertTrue(nodes, "No package tool executed")
        for node in nodes:
            self.assertEqual((node["incremental"], node["units"], node["optimization"]), ("1", "16", "3"))
            self.assertEqual((node["include"], node["lib"]), ("mock-sdk", "mock-sdk"))


if __name__ == "__main__":
    unittest.main()
