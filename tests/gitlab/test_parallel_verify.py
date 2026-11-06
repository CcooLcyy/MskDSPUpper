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
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]


def run_isolated_pipeline(stage="verify", fail_tool="", powershell="powershell.exe", branch="main"):
    # Reuse one real successful verify+package execution for independent read-only contracts.
    # Normalize defaults to positional cache keys; defensive copies prevent assertion interference.
    return deepcopy(_run_isolated_pipeline_cached(stage, fail_tool, powershell, branch))


@lru_cache(maxsize=16)
def _run_isolated_pipeline_cached(stage, fail_tool, powershell, branch):
    with tempfile.TemporaryDirectory(prefix="upper parallel test ") as temporary:
        workspace = Path(temporary)
        scripts = workspace / "scripts/gitlab"
        scripts.mkdir(parents=True)
        for name in ("pipeline.ps1", "verify.py", "release_policy.py", "cargo_cache.py", "cargo_workspace_wrapper.cmd"):
            shutil.copyfile(ROOT / "scripts/gitlab" / name, scripts / name)
        # 隔离夹具固定使用 0.8.0，版本线断言不随产品主干升级而漂移。
        (workspace / "package.json").write_text(json.dumps({"version": "0.8.0"}), encoding="utf-8")
        (workspace / "src-tauri").mkdir()
        (workspace / "src-tauri/Cargo.toml").write_text(
            '[package]\nname = "mskdsp-upper"\nversion = "0.8.0"\n', encoding="utf-8")
        driver = workspace / "stub.py"
        driver.write_text(r'''import json, os, subprocess, sys, time
from pathlib import Path
kind, *arguments = sys.argv[1:]
entry = {"kind": kind, "arguments": arguments, "started": time.time(),
         "incremental": os.environ.get("CARGO_INCREMENTAL"),
         "units": os.environ.get("CARGO_PROFILE_RELEASE_CODEGEN_UNITS"),
         "optimization": os.environ.get("CARGO_PROFILE_RELEASE_OPT_LEVEL"),
         "include": os.environ.get("INCLUDE"), "lib": os.environ.get("LIB"),
         "node_path_first": os.environ.get("PATH", "").split(os.pathsep)[0]}
if kind == "python" and arguments[-1:] == ["scripts/gitlab/verify.py"]:
    sys.exit(subprocess.run([sys.executable, *arguments]).returncode)
if kind == "python" and arguments[-1:] == ["scripts/gitlab/release_policy.py"]:
    sys.exit(subprocess.run([sys.executable, *arguments]).returncode)
if kind == "python" and "scripts/gitlab/cargo_cache.py" in arguments:
    # 此组只验证真实 shell/进程边界；缓存文件行为由 test_cargo_cache 独立覆盖。
    entry["kind"] = "cargo-cache"
    operation = arguments[arguments.index("scripts/gitlab/cargo_cache.py") + 1]
    entry["operation"] = operation
    target = Path(arguments[arguments.index("--target-dir") + 1])
    if operation == "prepare":
        stage = arguments[arguments.index("--stage") + 1]
        version = arguments[arguments.index("--version") + 1]
        print(json.dumps({"root": str(target / ".upper-cache"), "generation": stage + "-" + version,
                          "wrapper": str(target / ".upper-cache/bin/wrapper.cmd"),
                          "manifest_path": str(Path.cwd() / "src-tauri/Cargo.toml")}))
    elif operation == "record":
        assert Path(arguments[arguments.index("--log") + 1]).is_file()
        assert arguments[arguments.index("--generation") + 1] == os.environ["UPPER_CARGO_GENERATION"]
        print(json.dumps({"complete": True}))
    elif operation == "finish":
        print(json.dumps({"status": arguments[arguments.index("--status") + 1], "deleted": []}))
    else:
        raise ValueError("未知缓存命令")
if kind == "node" and arguments[:1] == ["scripts/workflow/emit-build-metadata.mjs"]:
    # 生成隔离夹具的真实元数据文件，缓存版本读取仍通过实际文件边界。
    destination = Path(arguments[arguments.index("--output") + 1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    version = os.environ.get("CI_COMMIT_TAG", "").removeprefix("v") or "0.8.0-ci.20261106t000000+sha.aaaaaaa"
    destination.write_text(json.dumps({"effectiveVersion": version}), encoding="utf-8")
is_runtime = kind == "python" and "scripts/gitlab/ensure_node_runtime.py" in arguments
if is_runtime:
    entry["kind"] = "node-runtime"
exit_code = 17 if entry["kind"] == os.environ.get("FAIL_TOOL") else 0
if is_runtime and not exit_code:
    print(json.dumps({"directory": str(Path.cwd() / "pinned-node"), "version": "v24.22.2", "source": "cache"}))
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
if kind == "cargo" or (kind == "node" and "--bundles" in arguments):
    # 模拟 Cargo 的 stdout 格式，检查脚本是否保留并传递原始构建输出。
    artifact = Path(os.environ["CARGO_TARGET_DIR"]) / "x86_64-pc-windows-msvc/release/deps" / (
        "libmskdsp_upper_lib-aaaaaaaaaaaaaaaa.rlib" if kind == "cargo" else "libmskdsp_upper_lib-bbbbbbbbbbbbbbbb.rlib")
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(b"isolated Rust artifact")
    print(json.dumps({"reason": "compiler-artifact", "package_id": "isolated#mskdsp-upper@0.8.0",
                      "manifest_path": str(Path.cwd() / "src-tauri/Cargo.toml"),
                      "target": {"name": "mskdsp_upper_lib"}, "filenames": [str(artifact)], "fresh": False}))
    print(json.dumps({"reason": "build-finished", "success": exit_code == 0}))
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
        pinned = workspace / "pinned-node"
        pinned.mkdir()
        for tool in ("npm", "node"):
            shutil.copyfile(workspace / f"{tool}.cmd", pinned / f"{tool}.cmd")
        (scripts / "ensure_node_modules.py").write_text(
            f'import subprocess, sys\nsys.exit(subprocess.run([sys.executable, {str(driver)!r}, "dependencies"]).returncode)\n',
            encoding="utf-8")
        # verify.py 使用 sys.executable 直接调用入口，也必须经过相同的隔离工具边界。
        (scripts / "cargo_cache.py").write_text(
            'import runpy, sys\n'
            f'sys.argv = [{str(driver)!r}, "python", "-B", "scripts/gitlab/cargo_cache.py", *sys.argv[1:]]\n'
            f'runpy.run_path({str(driver)!r}, run_name="__main__")\n', encoding="utf-8")
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
        try:
            result = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                 "-File", str(launcher), "-Workspace", str(workspace), "-Stage", stage],
                                capture_output=True, timeout=45,
                                env={**os.environ, "PYTHONUTF8": "1", "STUB_EVENTS": str(workspace / "events.jsonl"),
                                     "FAIL_TOOL": fail_tool, "CI_PIPELINE_SOURCE": "push",
                                     "CI_COMMIT_TAG": branch if branch.startswith("v") else "",
                                     "CI_COMMIT_BRANCH": "" if branch.startswith("v") else branch,
                                     "CI_COMMIT_REF_PROTECTED": "true",
                                     "CI_COMMIT_SHA": "a" * 40,
                                     "UPPER_RELEASE_CHANNEL": "stable" if branch.startswith("v") else "ci"})
        except subprocess.TimeoutExpired as error:
            def decode(value):
                return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""
            details = {"shell": powershell, "stage": stage, "timeout": 45,
                       "stdout": decode(error.stdout), "stderr": decode(error.stderr),
                       "events": [json.loads(path.read_text(encoding="utf-8"))
                                  for path in (workspace / "events").glob("*.json")]}
            destination = ROOT / "package/logs" / f"isolated-timeout-{time.time_ns()}.json"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")
            raise RuntimeError("隔离进程超过45秒，现场已保存：" + str(destination)
                               + "\n" + details["stdout"][-4000:] + "\n" + details["stderr"][-4000:]) from error
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
        self.assertEqual(cargo["arguments"], ["test", "--release", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--target", "x86_64-pc-windows-msvc", "--message-format=json-render-diagnostics"])
        self.assertEqual((cargo["incremental"], cargo["include"], cargo["lib"]), ("1", "mock-sdk", "mock-sdk"))
        self.assertTrue(any(event["kind"] == "node" for event in events))
        self.assertIn("END cargo-test: exit=0", logs["verify-rust.log"])
        self.assertIn("END lint: exit=0", logs["verify-frontend.log"])
        self.assertEqual(timing["exit_code"], 0)
        retention = json.loads(logs["cargo-cache-retention.json"].lstrip("\ufeff"))
        self.assertEqual(retention["status"], "success")
        self.assertEqual([entry["operation"] for entry in events if entry["kind"] == "cargo-cache"],
                         ["prepare", "record", "prepare", "record", "finish"])

    # 固定运行环境必须先于测试与打包，且只在当前作业的 PATH 生效。
    def test_pinned_node_precedes_verification_and_packaging(self):
        result, events, _ = run_isolated_pipeline()
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        runtime = [event for event in events if event["kind"] == "node-runtime"]
        self.assertEqual(len(runtime), 2)
        dependencies = next(event for event in events if event["kind"] == "dependencies")
        package = next(event for event in events if event["kind"] == "node")
        self.assertLess(runtime[0]["finished"], dependencies["started"])
        self.assertLess(runtime[1]["finished"], package["started"])
        for event in (event for event in events if event["kind"] in ("npm", "node")):
            self.assertEqual(Path(event["node_path_first"]).name, "pinned-node")
        self.assertIn("v24.22.2", result.stdout.decode("utf-8", errors="replace"))

    # 不能在固定运行环境准备失败后回退旧 Node 或继续执行其他分支。
    def test_pinned_node_failure_blocks_verification_and_packaging(self):
        result, events, logs = run_isolated_pipeline(fail_tool="node-runtime")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([event["kind"] for event in events if event["kind"] != "python"], ["node-runtime"])
        self.assertNotIn("verify-timing.json", logs)

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
