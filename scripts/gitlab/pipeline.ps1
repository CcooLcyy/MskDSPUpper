param([ValidateSet('verify', 'package', 'publish', 'cache-finish')][string]$Stage)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败：$Program（退出码 $LASTEXITCODE）" }
}

function Initialize-CargoCache([string]$CacheStage, [string]$Version) {
    if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target' }
    $cacheJson = Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/cargo_cache.py', 'prepare', '--stage', $CacheStage, '--version', $Version, '--target-dir', $env:CARGO_TARGET_DIR)
    $cache = $cacheJson | ConvertFrom-Json
    if (-not $cache.wrapper -or -not $cache.root -or -not $cache.generation -or -not $cache.manifest_path) {
        throw 'Cargo 缓存归属初始化不完整，停止构建'
    }
    $env:RUSTC_WORKSPACE_WRAPPER = $cache.wrapper
    $env:UPPER_CARGO_CACHE_ROOT = $cache.root
    $env:UPPER_CARGO_GENERATION = $cache.generation
    $env:UPPER_CARGO_MANIFEST_PATH = $cache.manifest_path
    $env:UPPER_CARGO_PYTHON = (Get-Command python -ErrorAction Stop).Source
    Write-Host "已准备上位机 $CacheStage 编译缓存，version=$Version"
}

if ($Stage -eq 'cache-finish') {
    # 失败或取消不推进成功保留集；原始日志继续作为作业产物上传。
    if ($env:CI_JOB_STATUS -eq 'success' -or -not $env:CARGO_TARGET_DIR) { return }
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/cargo_cache.py', 'finish', '--target-dir', $env:CARGO_TARGET_DIR, '--status', 'failed')
    return
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

    # 仅当前作业使用包含测试运行器修复的固定 Node，不覆盖 Runner 全局工具。
    $previousNode = Get-Command node -ErrorAction SilentlyContinue
    if ($previousNode) {
        $previousVersion = (Get-Item -LiteralPath $previousNode.Source).VersionInfo.ProductVersion
        Write-Host "Runner 原有 Node：version=$previousVersion，path=$($previousNode.Source)"
    }
    $nodeCacheRoot = if ($env:RUNNER_ENV_ROOT) {
        Join-Path $env:RUNNER_ENV_ROOT 'cache/mskdsp-upper-node'
    } else {
        Join-Path $PWD '.ci-tools/node'
    }
    $nodeRuntimeJson = Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/ensure_node_runtime.py', '--cache-root', $nodeCacheRoot)
    $nodeRuntime = $nodeRuntimeJson | ConvertFrom-Json
    if (-not $nodeRuntime.directory -or -not (Test-Path -LiteralPath $nodeRuntime.directory -PathType Container)) {
        throw '固定 Node 运行环境返回的目录无效'
    }
    $env:PATH = $nodeRuntime.directory + [IO.Path]::PathSeparator + $env:PATH
    Write-Host "固定 Node 运行环境：version=$($nodeRuntime.version)，source=$($nodeRuntime.source)，path=$($nodeRuntime.directory)"
}

if ($Stage -in @('verify', 'package')) {
    # 测试与打包统一使用 Release；在环境导入后固定相同优化设置以复用依赖。
    $env:CARGO_INCREMENTAL = '1'
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
    $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = '3'
    Write-Host "Rust Release 编译设置：stage=$Stage，incremental=$env:CARGO_INCREMENTAL，codegen_units=16，opt_level=3"
}

if ($Stage -eq 'verify') {
    Invoke-Checked -Program 'python' -Arguments @('-B', '-m', 'unittest', 'discover', '-s', 'tests/gitlab', '-v')
    $version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
    Initialize-CargoCache -CacheStage verify -Version $version
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/verify.py')
    return
}
if ($Stage -eq 'package') {
    $releaseJson = Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/release_policy.py')
    $release = $releaseJson | ConvertFrom-Json
    if ($release.channel -notin @('ci', 'stable') -or -not $release.metadata -or -not $release.config -or -not $release.ref) {
        throw 'GitLab 发布渠道信息不完整，停止构建'
    }
    Write-Host "已确认发布来源：channel=$($release.channel)，branch=$($release.ref)"
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw '缺少现有上位机 Tauri 签名私钥，停止发布构建' }
    if (-not $env:PLATFORM_PUBLIC_BASE_URL) { throw '缺少平台公开下载地址' }
    if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target' }
    New-Item -ItemType Directory -Path package/logs -Force | Out-Null
    $metadataArguments = @('scripts/workflow/emit-build-metadata.mjs', '--channel', $release.channel, '--ref', $release.ref, '--sha', $env:CI_COMMIT_SHA, '--output', $release.metadata)
    if ($release.channel -eq 'stable') {
        if (-not $release.tag) { throw '正式构建缺少来源标签，停止打包' }
        $metadataArguments += @('--tag', $release.tag)
    }
    Invoke-Checked -Program 'node' -Arguments $metadataArguments
    Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/apply-channel-version.mjs', '--metadata-file', $release.metadata, '--backup-dir', 'package/.manifest-backup')
    try {
        $effectiveVersion = (Get-Content -LiteralPath $release.metadata -Raw | ConvertFrom-Json).effectiveVersion
        Initialize-CargoCache -CacheStage package -Version $effectiveVersion
        $endpoint = $env:PLATFORM_PUBLIC_BASE_URL.TrimEnd('/') + '/mskdsp-upper/' + $release.channel + '/latest.json'
        Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/render-tauri-config.mjs', '--metadata-file', $release.metadata, '--output', $release.config, '--endpoint', $endpoint, '--bundle-targets', 'nsis', '--updater-artifacts', 'true')
        # 客户端更新经平台 gRPC；HTTP 清单仅用于发布后的兼容验收，不配置插件 HTTP 更新源。
        Invoke-Checked -Program 'node' -Arguments @('-e', 'const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.updater.endpoints=[];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");', $release.config)
        Write-Host '上位机更新使用平台 gRPC，已禁用插件 HTTP 清单端点'
        # 独立作业目录只清理旧打包文件，编译依赖继续复用。
        $bundle = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/bundle/nsis'
        if (Test-Path -LiteralPath $bundle) {
            Get-ChildItem -LiteralPath $bundle -File | Where-Object { $_.Name -match '\.exe(\.sig)?$' } | Remove-Item
        }
        # Node 显式保留空密码环境变量，避免 PowerShell 5.1 将空字符串视为删除变量后触发密码交互。
        $tauriCommand = 'const {spawnSync}=require("child_process");const r=spawnSync(process.execPath,["node_modules/@tauri-apps/cli/tauri.js",...process.argv.slice(1)],{stdio:"inherit",env:{...process.env,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??""}});if(r.error)throw r.error;process.exit(r.status??1);'
        $cargoLog = Join-Path $PWD 'package/logs/package-cargo.jsonl'
        $buildLines = @()
        try {
            Invoke-Checked -Program 'node' -Arguments @('-e', $tauriCommand, 'build', '--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc', '--ci', '--config', $release.config, '--', '--message-format=json-render-diagnostics') | Tee-Object -Variable buildLines
        } finally {
            $buildLines | Out-File -LiteralPath $cargoLog -Encoding utf8
        }
        Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/cargo_cache.py', 'record', '--target-dir', $env:CARGO_TARGET_DIR, '--generation', $env:UPPER_CARGO_GENERATION, '--log', $cargoLog)
        Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/stage-release.mjs', '--metadata-file', $release.metadata, '--target-dir', $env:CARGO_TARGET_DIR)
        Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/freeze_metadata.py', '--metadata', $release.metadata)
    } finally {
        Invoke-Checked -Program 'node' -Arguments @('scripts/workflow/restore-manifests.mjs', '--backup-dir', 'package/.manifest-backup')
    }
    $report = Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/cargo_cache.py', 'finish', '--target-dir', $env:CARGO_TARGET_DIR, '--generation', $env:UPPER_CARGO_GENERATION, '--status', 'success')
    $report | Out-File -LiteralPath package/logs/cargo-cache-retention.json -Encoding utf8
    Write-Host $report
    return
}
if ($Stage -eq 'publish') {
    if ($env:CI_COMMIT_BRANCH -ne 'main' -and -not $env:CI_COMMIT_TAG) {
        throw '候选分支只保留流水线产物，不发布通道'
    }
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/init_platform_proto.py')
    Invoke-Checked -Program 'python' -Arguments @('-B', 'scripts/gitlab/platform_client.py', '--metadata', 'package/platform/upload-metadata.json')
}
