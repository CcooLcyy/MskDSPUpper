"""Exercise real PowerShell/subprocess boundaries using isolated executable tool stubs."""
import json
from copy import deepcopy
from functools import lru_cache
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def run_isolated_pipeline(stage="verify", fail_tool="", powershell="powershell.exe"):
    # Reuse one real successful verify+package execution for independent read-only contracts.
    # Normalize defaults to positional cache keys; defensive copies prevent assertion interference.
    return deepcopy(_run_isolated_pipeline_cached(stage, fail_tool, powershell))


@lru_cache(maxsize=8)
def _run_isolated_pipeline_cached(stage, fail_tool, powershell):
    with tempfile.TemporaryDirectory(prefix="upper parallel test ") as temporary:
        workspace = Path(temporary)
        scripts = workspace / "scripts/gitlab"
        scripts.mkdir(parents=True)
        for name in ("pipeline.ps1", "verify.py"):
            shutil.copyfile(ROOT / "scripts/gitlab" / name, scripts / name)
        driver = workspace / "stub.py"
        driver.write_text(r'''import json, os, subprocess, sys, time
from pathlib import Path
kind, *arguments = sys.argv[1:]
entry = {"kind": kind, "arguments": arguments, "started": time.time(),
         "incremental": os.environ.get("CARGO_INCREMENTAL"),
         "units": os.environ.get("CARGO_PROFILE_RELEASE_CODEGEN_UNITS"),
         "optimization": os.environ.get("CARGO_PROFILE_RELEASE_OPT_LEVEL"),
         "include": os.environ.get("INCLUDE"), "lib": os.environ.get("LIB")}
if kind == "python" and arguments[-1:] == ["scripts/gitlab/verify.py"]:
    sys.exit(subprocess.run([sys.executable, *arguments]).returncode)
exit_code = 17 if kind == os.environ.get("FAIL_TOOL") else 0
if kind in ("cargo", "dependencies"):
    # Synchronize real processes instead of assuming a VM starts both within a fixed sleep.
    events = Path(os.environ["STUB_EVENTS"])
    events.with_name(kind + ".started").write_text("started", encoding="utf-8")
    peer = events.with_name(("dependencies" if kind == "cargo" else "cargo") + ".started")
    deadline = time.monotonic() + 15
    while not peer.exists():
        if time.monotonic() >= deadline:
            entry["barrier_error"] = "Timed out waiting for the other verification process"
            exit_code = 124
            break
        time.sleep(0.01)
    entry["barrier_peer_observed"] = peer.exists()
entry["finished"] = time.time()
# Each process writes its own event file; simultaneous barrier release must not race on append.
event_directory = Path(os.environ["STUB_EVENTS"]).with_suffix("")
event_directory.mkdir(exist_ok=True)
(event_directory / f"{time.time_ns()}-{os.getpid()}.json").write_text(json.dumps(entry), encoding="utf-8")
sys.exit(exit_code)
''', encoding="utf-8")
        for tool in ("python", "npm", "node", "cargo"):
            (workspace / f"{tool}.cmd").write_text(
                f'@echo off\n"{sys.executable}" "{driver}" {tool} %*\nexit /b %errorlevel%\n',
                encoding="utf-8", newline="\r\n")
        (scripts / "ensure_node_modules.py").write_text(
            f'import subprocess, sys\nsys.exit(subprocess.run([sys.executable, {str(driver)!r}, "dependencies"]).returncode)\n',
            encoding="utf-8")
        (workspace / "cl.exe").write_bytes(b"")
        developer = workspace / "vsenv.cmd"
        developer.write_text('@echo off\nset "CARGO_INCREMENTAL=0"\n'
                             'set "CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256"\n'
                             'set "CARGO_PROFILE_RELEASE_OPT_LEVEL=0"\n'
                             'set "INCLUDE=mock-sdk"\nset "LIB=mock-sdk"\n',
                             encoding="utf-8", newline="\r\n")
        launcher = workspace / "run.ps1"
        launcher.write_text('''param($Workspace, $Stage)
$ErrorActionPreference='Stop'
$env:PATH=$Workspace+';'+$env:PATH
$env:VSDEVCMD=Join-Path $Workspace 'vsenv.cmd'
$env:CARGO_INCREMENTAL='inherited-runner-value'
$env:CARGO_TARGET_DIR=Join-Path $Workspace 'target'
$env:TAURI_SIGNING_PRIVATE_KEY='isolated-stub-key'
$env:PLATFORM_PUBLIC_BASE_URL='http://127.0.0.1:8082'
Set-Location -LiteralPath $Workspace
$pipeline=Join-Path $Workspace 'scripts/gitlab/pipeline.ps1'
& $pipeline -Stage $Stage
if ($Stage -eq 'verify') { & $pipeline -Stage package }
''', encoding="utf-8-sig")
        result = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                 "-File", str(launcher), "-Workspace", str(workspace), "-Stage", stage],
                                capture_output=True, timeout=45,
                                env={**os.environ, "PYTHONUTF8": "1", "STUB_EVENTS": str(workspace / "events.jsonl"),
                                     "FAIL_TOOL": fail_tool})
        events = sorted((json.loads(path.read_text(encoding="utf-8")) for path in (workspace / "events").glob("*.json")),
                        key=lambda event: event["started"])
        logs = workspace / "package/logs"
        output_logs = {path.name: path.read_text(encoding="utf-8") for path in logs.glob("*")}
        return result, events, output_logs


@unittest.skipUnless(sys.platform == "win32", "Windows Runner PowerShell process integration")
class ParallelVerificationTests(unittest.TestCase):
    def assert_successful_overlap(self, shell):
        result, events, logs = run_isolated_pipeline(powershell=shell)
        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", errors="replace")+result.stderr.decode("utf-8", errors="replace"))
        timing = json.loads(logs["verify-timing.json"])
        frontend, rust = (timing["branches"][name] for name in ("frontend", "rust"))
        self.assertLess(max(frontend["started_at"], rust["started_at"]),
                        min(frontend["finished_at"], rust["finished_at"]))
        cargo = next(event for event in events if event["kind"] == "cargo")
        dependencies = next(event for event in events if event["kind"] == "dependencies")
        self.assertTrue(cargo["barrier_peer_observed"])
        self.assertTrue(dependencies["barrier_peer_observed"])
        self.assertLess(max(cargo["started"], dependencies["started"]),
                        min(cargo["finished"], dependencies["finished"]))
        self.assertEqual([event["arguments"] for event in events if event["kind"] == "npm"],
                         [["run", "test:workflow"], ["run", "test:offline"], ["run", "lint"]])
        self.assertEqual(cargo["arguments"], ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--target", "x86_64-pc-windows-msvc"])
        self.assertEqual((cargo["incremental"], cargo["include"], cargo["lib"]), ("1", "mock-sdk", "mock-sdk"))
        self.assertTrue(any(event["kind"] == "node" for event in events))
        self.assertIn("END cargo-test: exit=0", logs["verify-rust.log"])
        self.assertIn("END lint: exit=0", logs["verify-frontend.log"])
        self.assertEqual(timing["exit_code"], 0)

    def test_windows_powershell_runs_overlapping_children(self):
        self.assert_successful_overlap("powershell.exe")

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell 7 not installed")
    def test_pwsh_runs_overlapping_children(self):
        self.assert_successful_overlap("pwsh")

    def test_either_branch_failure_prevents_package_and_waits_for_other_branch(self):
        for failed in ("dependencies", "cargo"):
            with self.subTest(failed=failed):
                result, events, logs = run_isolated_pipeline(fail_tool=failed)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(event["kind"] == "node" for event in events))
                timing = json.loads(logs["verify-timing.json"])
                self.assertEqual(timing["exit_code"], 1)
                failed_branch = "frontend" if failed == "dependencies" else "rust"
                other_branch = "rust" if failed == "dependencies" else "frontend"
                self.assertEqual(timing["branches"][failed_branch]["exit_code"], 17)
                self.assertEqual(timing["branches"][other_branch]["exit_code"], 0)
                if failed == "dependencies":
                    self.assertFalse(any(event["kind"] == "npm" for event in events))
                self.assertTrue(all(branch["finished_at"] <= timing["finished_at"]
                                    for branch in timing["branches"].values()))


if __name__ == "__main__":
    unittest.main()
