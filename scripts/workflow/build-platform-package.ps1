$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败：$Program（退出码 $LASTEXITCODE）" }
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw '缺少现有上位机 Tauri 签名私钥，停止打包'
}

$releaseJson = Invoke-Checked 'python' @('-B', 'scripts/gitlab/release_policy.py')
$release = $releaseJson | ConvertFrom-Json
$target = 'x86_64-pc-windows-msvc'
$backupDir = 'package/.manifest-backup'
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target'
}
New-Item -ItemType Directory -Path package/logs -Force | Out-Null

Write-Host "上位机打包来源：$($release.ref)，通道：$($release.channel)，提交：$env:GITHUB_SHA"
$metadataArguments = @(
    'scripts/workflow/emit-build-metadata.mjs', '--channel', $release.channel,
    '--ref', $release.ref, '--sha', $env:GITHUB_SHA, '--output', $release.metadata,
    '--target-triple', $target
)
if ($release.channel -eq 'stable') {
    $metadataArguments += @('--tag', $release.tag)
}
Invoke-Checked 'node' $metadataArguments

try {
    Invoke-Checked 'node' @('scripts/workflow/apply-channel-version.mjs', '--metadata-file', $release.metadata, '--backup-dir', $backupDir)
    Invoke-Checked 'node' @(
        'scripts/workflow/render-tauri-config.mjs', '--metadata-file', $release.metadata,
        '--output', $release.config, '--bundle-targets', 'nsis', '--updater-artifacts', 'true'
    )
    $tauriConfig = Get-Content -LiteralPath $release.config -Raw | ConvertFrom-Json -AsHashtable
    $tauriConfig.plugins.updater.endpoints = @()
    $tauriConfig | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $release.config -Encoding utf8NoBOM
    Write-Host '上位机更新使用平台 gRPC'

    # 已恢复的 Cargo 缓存可能包含其他版本的安装包，仅保留本次构建结果。
    $bundleDir = Join-Path $env:CARGO_TARGET_DIR "$target/release/bundle/nsis"
    if (Test-Path -LiteralPath $bundleDir -PathType Container) {
        Get-ChildItem -LiteralPath $bundleDir -File | Where-Object { $_.Name -match '\.exe(\.sig)?$' } | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName
        }
    }

    # 在子进程显式传入空密码，避免无密码的签名密钥触发交互提示。
    $tauriBuild = @'
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [
    'node_modules/@tauri-apps/cli/tauri.js', ...process.argv.slice(1),
], {
    stdio: 'inherit',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
'@
    $buildLog = 'package/logs/tauri-release-build.log'
    Invoke-Checked 'node' @('-e', $tauriBuild, 'build', '--bundles', 'nsis', '--target', $target, '--ci', '--config', $release.config, '--', '--timings') 2>&1 |
        Tee-Object -FilePath $buildLog

    Invoke-Checked 'node' @(
        'scripts/workflow/stage-release.mjs', '--metadata-file', $release.metadata,
        '--target-dir', $env:CARGO_TARGET_DIR, '--build-log', $buildLog
    )
    Invoke-Checked 'python' @('-B', 'scripts/gitlab/freeze_metadata.py', '--metadata', $release.metadata)
} finally {
    Invoke-Checked 'node' @('scripts/workflow/restore-manifests.mjs', '--backup-dir', $backupDir)
}
