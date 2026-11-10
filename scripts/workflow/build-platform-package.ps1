param(
    [switch]$Prebuild,
    [switch]$BundlePrebuilt
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败：$Program（退出码 $LASTEXITCODE）" }
}

if ($Prebuild -and $BundlePrebuilt) {
    throw '-Prebuild 和 -BundlePrebuilt 不能同时使用'
}
if ($Prebuild -and ($env:TAURI_SIGNING_PRIVATE_KEY -or $env:TAURI_SIGNING_PRIVATE_KEY_FILE -or $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
    throw '预构建步骤禁止注入 Tauri 签名凭据'
}
if (-not $Prebuild -and -not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw '缺少现有上位机 Tauri 签名私钥，停止打包'
}

$releaseJson = Invoke-Checked 'python' @('-B', 'scripts/gitlab/release_policy.py')
$release = $releaseJson | ConvertFrom-Json
$target = 'x86_64-pc-windows-msvc'
$backupDir = 'package/.manifest-backup'
$prebuiltDir = 'package/prebuilt'
$prebuiltManifest = Join-Path $prebuiltDir 'manifest.json'
$prebuiltExe = Join-Path $prebuiltDir 'app.exe'
$prebuiltDist = Join-Path $prebuiltDir 'dist'
if ($Prebuild -and (Test-Path -LiteralPath $prebuiltDir)) {
    throw "预构建产物目录已存在：$prebuiltDir"
}
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target'
}
$releaseDir = Join-Path $env:CARGO_TARGET_DIR "$target/release"
New-Item -ItemType Directory -Path package/logs -Force | Out-Null

function Get-PrebuiltFile([string]$Path) {
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "预构建产物必须是普通文件：$Path"
    }
    return $file
}

function Get-PrebuiltHashes {
    $exe = Get-PrebuiltFile $prebuiltExe
    $dist = Get-Item -LiteralPath $prebuiltDist -Force
    if ($exe.Length -eq 0 -or -not $dist.PSIsContainer -or ($dist.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw '预构建 EXE 或 dist 无效'
    }
    $hashes = [ordered]@{ 'app.exe' = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash }
    foreach ($entry in Get-ChildItem -LiteralPath $dist.FullName -Force -Recurse) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "预构建 dist 不允许链接：$($entry.FullName)"
        }
        if (-not $entry.PSIsContainer) {
            $relativePath = [IO.Path]::GetRelativePath($dist.FullName, $entry.FullName).Replace('\', '/')
            $hashes["dist/$relativePath"] = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash
        }
    }
    if (-not $hashes.Contains('dist/index.html')) {
        throw '预构建产物缺少 dist/index.html'
    }
    return $hashes
}

if ($Prebuild -or $BundlePrebuilt) {
    $identity = [ordered]@{
        sha = $env:GITHUB_SHA
        ref = $env:GITHUB_REF
        run_id = $env:GITHUB_RUN_ID
        run_attempt = $env:GITHUB_RUN_ATTEMPT
        target = $target
    }
    $head = Invoke-Checked 'git' @('rev-parse', 'HEAD')
    if ($identity.sha -cnotmatch '^[a-f0-9]{40}$' -or $head -cne $identity.sha -or
        $identity.run_id -notmatch '^[1-9][0-9]*$' -or $identity.run_attempt -notmatch '^[1-9][0-9]*$') {
        throw '预构建步骤的 GitHub 运行身份或检出提交无效'
    }
}

if ($BundlePrebuilt) {
    $artifactDir = Get-Item -LiteralPath $prebuiltDir -Force
    if (-not $artifactDir.PSIsContainer -or ($artifactDir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw '预构建产物目录无效'
    }
    $manifestFile = Get-PrebuiltFile $prebuiltManifest
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json -AsHashtable
    foreach ($field in $identity.Keys) {
        if ($manifest[$field] -isnot [string] -or $manifest[$field] -cne $identity[$field]) {
            throw "预构建产物与当前 GitHub 运行不匹配：$field"
        }
    }
    if ($manifest.timestamp -isnot [string] -or $manifest.timestamp -cnotmatch '^[0-9]{8}t[0-9]{6}z$') {
        throw '预构建产物的构建时间无效'
    }
    $hashes = Get-PrebuiltHashes
    if ($manifest.files -isnot [System.Collections.IDictionary] -or $manifest.files.Count -ne $hashes.Count) {
        throw '预构建产物文件清单不匹配'
    }
    foreach ($file in $hashes.Keys) {
        if ($hashes[$file] -cne $manifest.files[$file]) {
            throw "预构建产物校验失败：$file"
        }
    }
}

Write-Host "上位机打包来源：$($release.ref)，通道：$($release.channel)，提交：$env:GITHUB_SHA"
$metadataArguments = @(
    'scripts/workflow/emit-build-metadata.mjs', '--channel', $release.channel,
    '--ref', $release.ref, '--sha', $env:GITHUB_SHA, '--output', $release.metadata,
    '--target-triple', $target
)
if ($release.channel -eq 'stable') {
    $metadataArguments += @('--tag', $release.tag)
}
if ($BundlePrebuilt) {
    $metadataArguments += @('--timestamp', $manifest.timestamp)
}
Invoke-Checked 'node' $metadataArguments

if ($BundlePrebuilt -and (Get-FileHash -LiteralPath $release.metadata -Algorithm SHA256).Hash -cne $manifest.metadata_sha256) {
    throw '重新生成的构建元数据与预构建产物不一致'
}

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

    if ($Prebuild -or $BundlePrebuilt) {
        $metadata = Get-Content -LiteralPath $release.metadata -Raw | ConvertFrom-Json
        $appExe = Join-Path $releaseDir "$($metadata.binaryName).exe"
        $configHash = (Get-FileHash -LiteralPath $release.config -Algorithm SHA256).Hash
    }

    if ($Prebuild) {
        if (Test-Path -LiteralPath $appExe -PathType Leaf) {
            Remove-Item -LiteralPath $appExe
        }
        $buildLog = 'package/logs/tauri-release-prebuild.log'
        Invoke-Checked 'node' @('node_modules/@tauri-apps/cli/tauri.js', 'build', '--no-bundle', '--target', $target, '--ci', '--config', $release.config, '--', '--timings') 2>&1 |
            Tee-Object -FilePath $buildLog

        New-Item -ItemType Directory -Path $prebuiltDir | Out-Null
        Copy-Item -LiteralPath $appExe -Destination $prebuiltExe
        Copy-Item -LiteralPath 'dist' -Destination $prebuiltDist -Recurse
        $identity['timestamp'] = $metadata.timestamp
        $identity['metadata_sha256'] = (Get-FileHash -LiteralPath $release.metadata -Algorithm SHA256).Hash
        $identity['config_sha256'] = $configHash
        $identity['files'] = Get-PrebuiltHashes
        $identity | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $prebuiltManifest -Encoding utf8NoBOM
        return
    }

    if ($BundlePrebuilt) {
        if ($configHash -cne $manifest.config_sha256) {
            throw '重新生成的 Tauri 配置与预构建产物不一致'
        }
        New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
        Copy-Item -LiteralPath $prebuiltExe -Destination $appExe
    }

    # 已恢复的 Cargo 缓存可能包含其他版本的安装包，仅保留本次构建结果。
    $bundleDir = Join-Path $releaseDir 'bundle/nsis'
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
    $tauriArguments = @('build', '--bundles', 'nsis', '--target', $target, '--ci', '--config', $release.config, '--', '--timings')
    if ($BundlePrebuilt) {
        $buildLog = 'package/logs/tauri-release-bundle.log'
        $tauriArguments = @('bundle', '--bundles', 'nsis', '--target', $target, '--ci', '--config', $release.config)
    }
    Invoke-Checked 'node' (@('-e', $tauriBuild) + $tauriArguments) 2>&1 |
        Tee-Object -FilePath $buildLog

    $stageArguments = @(
        'scripts/workflow/stage-release.mjs', '--metadata-file', $release.metadata,
        '--target-dir', $env:CARGO_TARGET_DIR, '--build-log', $buildLog
    )
    if ($BundlePrebuilt) {
        $stageArguments += @('--dist-dir', $prebuiltDist)
    }
    Invoke-Checked 'node' $stageArguments
    Invoke-Checked 'python' @('-B', 'scripts/gitlab/freeze_metadata.py', '--metadata', $release.metadata)
} finally {
    Invoke-Checked 'node' @('scripts/workflow/restore-manifests.mjs', '--backup-dir', $backupDir)
}
