"""执行真实阶段脚本并替换外部工具，验证环境导入后生效的增量策略。"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "win32", "该流水线仅支持 Windows Runner")
class IncrementalPolicyTests(unittest.TestCase):
    def run_stage(self, stage, imported, expected):
        with tempfile.TemporaryDirectory(prefix="upper-incremental-test-") as temporary:
            workspace = Path(temporary)
            developer = workspace / "vsenv.cmd"
            developer.write_bytes((f'@echo off\r\nset "CARGO_INCREMENTAL={imported}"\r\n'
                                   'set "INCLUDE=mock-sdk"\r\nset "LIB=mock-sdk"\r\n').encode())
            (workspace / "cl.exe").write_bytes(b"")
            runner = workspace / "run-stage.ps1"
            runner.write_text("""param($Pipeline, $Stage, $Workspace, $Developer, $Expected)
$ErrorActionPreference='Stop'
$env:PATH=$Workspace+';'+$env:PATH
$env:VSDEVCMD=$Developer
$env:CARGO_INCREMENTAL='inherited-runner-value'
$env:CARGO_TARGET_DIR=Join-Path $Workspace 'target'
$env:TAURI_SIGNING_PRIVATE_KEY='isolated-stub-key'
$env:PLATFORM_PUBLIC_BASE_URL='http://127.0.0.1:8082'
$global:Observed=@()
function global:python { $global:LASTEXITCODE=0 }
function global:npm { $global:LASTEXITCODE=0 }
function global:node { $global:Observed+=$env:CARGO_INCREMENTAL; $global:LASTEXITCODE=0 }
function global:cargo { $global:Observed+=$env:CARGO_INCREMENTAL; $global:LASTEXITCODE=0 }
Set-Location -LiteralPath $Workspace
& $Pipeline -Stage $Stage
if(-not $global:Observed.Count){throw '未执行编译入口，测试无效'}
foreach($value in $global:Observed){if($value -cne $Expected){throw ('阶段增量策略错误，实际='+$value)}}
if($env:CARGO_INCREMENTAL -cne $Expected){throw '阶段结束后的增量策略不符'}
""", encoding="utf-8-sig")
            result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                     "-File", str(runner), "-Pipeline", str(ROOT / "scripts/gitlab/pipeline.ps1"),
                                     "-Stage", stage, "-Workspace", str(workspace), "-Developer", str(developer),
                                     "-Expected", expected], capture_output=True, timeout=30,
                                    env={**os.environ, "PYTHONUTF8": "1"})
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))

    def test_verify_enables_incremental_after_environment_import_disables_it(self):
        self.run_stage("verify", imported="0", expected="1")

    def test_release_package_disables_incremental_after_environment_import_enables_it(self):
        self.run_stage("package", imported="1", expected="0")


if __name__ == "__main__":
    unittest.main()
