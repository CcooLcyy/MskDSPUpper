param([ValidateSet('verify', 'package', 'publish')][string]$Stage)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败：$Program（退出码 $LASTEXITCODE）" }
}

if ($Stage -in @('verify', 'package')) {
    $developerCommand = $env:VSDEVCMD
    if (-not $developerCommand -and $env:RUNNER_ENV_ROOT) {
        $developerCommand = Join-Path $env:RUNNER_ENV_ROOT 'tools/vs2022/Common7/Tools/VsDevCmd.bat'
    }
    if (-not $developerCommand -or -not (Test-Path -LiteralPath $developerCommand -PathType Leaf)) {
        throw '找不到 MSVC 开发环境脚本，请配置 VSDEVCMD 或 RUNNER_ENV_ROOT'
    }
    if ($developerCommand.Contains('"') -or $developerCommand -match '[\r\n]') {
        throw 'MSVC 开发环境脚本路径不合法'
    }
    $commandLine = 'call "' + $developerCommand + '" -arch=x64 -host_arch=x64 >nul && set'
    $developerEnvironment = & $env:ComSpec /d /s /c $commandLine 2>$null
    if ($LASTEXITCODE -ne 0) { throw '导入 MSVC 与 Windows SDK 环境失败' }
    foreach ($entry in $developerEnvironment) {
        if ($entry -match '^([^=][^=]*)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
        }
    }
    $developerEnvironment = $null
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -or -not $env:INCLUDE -or -not $env:LIB) {
        throw 'MSVC 或 Windows SDK 环境不完整'
    }
    Write-Host '已导入 x64 MSVC 与 Windows SDK 环境'
}

if ($Stage -in @('verify', 'package')) {
    # Runner 与 MSVC 环境导入后再覆盖；仅 GitLab CI 启用测试与 Release 增量。
    $env:CARGO_INCREMENTAL = '1'
    if ($Stage -eq 'package') {
        # 保持原 Release 默认优化及代码生成并行度，避免增量默认切换为 256 个单元。
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
        $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = '3'
    }
    Write-Host "Rust 增量编译设置：stage=$Stage，CARGO_INCREMENTAL=$env:CARGO_INCREMENTAL"
}

if ($Stage -eq 'verify') {
    Invoke-Checked -Program 'python' -Arguments @('-B', '-m', 'unittest', 'discover', '-s', 'tests/gitlab', '-v')
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/verify.py')
    return
}
if ($Stage -eq 'package') {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw '缺少现有上位机 Tauri 签名私钥，停止发布构建' }
    if (-not $env:PLATFORM_PUBLIC_BASE_URL) { throw '缺少平台公开下载地址' }
    if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target' }
    New-Item -ItemType Directory -Path package/logs -Force | Out-Null
    Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/emit-build-metadata.mjs', '--channel', 'ci', '--ref', 'main', '--sha', $env:CI_COMMIT_SHA, '--output', 'package/metadata/ci.json')
    Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/apply-channel-version.mjs', '--metadata-file', 'package/metadata/ci.json', '--backup-dir', 'package/.manifest-backup')
    try {
        $endpoint = $env:PLATFORM_PUBLIC_BASE_URL.TrimEnd('/') + '/mskdsp-upper/ci/latest.json'
        Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/render-tauri-config.mjs', '--metadata-file', 'package/metadata/ci.json', '--output', 'package/generated/tauri.ci.conf.json', '--endpoint', $endpoint, '--bundle-targets', 'nsis', '--updater-artifacts', 'true')
        # 客户端更新经平台 gRPC；HTTP 清单仅用于发布后的兼容验收，不配置插件 HTTP 更新源。
        Invoke-Checked -Program 'node' -Arguments @('-e', 'const fs=require("fs");const p="package/generated/tauri.ci.conf.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.updater.endpoints=[];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");')
        Write-Host '上位机更新使用平台 gRPC，已禁用插件 HTTP 清单端点'
        # 独立作业目录只清理旧打包文件，编译依赖继续复用。
        $bundle = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/bundle/nsis'
        if (Test-Path -LiteralPath $bundle) {
            Get-ChildItem -LiteralPath $bundle -File | Where-Object { $_.Name -match '\.exe(\.sig)?$' } | Remove-Item
        }
        # Node 显式保留空密码环境变量，避免 PowerShell 5.1 将空字符串视为删除变量后触发密码交互。
        $tauriCommand = 'const {spawnSync}=require("child_process");const r=spawnSync(process.execPath,["node_modules/@tauri-apps/cli/tauri.js",...process.argv.slice(1)],{stdio:"inherit",env:{...process.env,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??""}});if(r.error)throw r.error;process.exit(r.status??1);'
        Invoke-Checked -Program 'node' -Arguments @('-e', $tauriCommand, 'build', '--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc', '--ci', '--config', 'package/generated/tauri.ci.conf.json')
        Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/stage-release.mjs', '--metadata-file', 'package/metadata/ci.json', '--target-dir', $env:CARGO_TARGET_DIR)
        Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/freeze_metadata.py')
    } finally {
        Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/restore-manifests.mjs', '--backup-dir', 'package/.manifest-backup')
    }
    return
}
if ($Stage -eq 'publish') {
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/init_platform_proto.py')
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/platform_client.py', '--metadata', 'package/platform/upload-metadata.json')
}
