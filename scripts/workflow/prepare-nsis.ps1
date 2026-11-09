$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Get-VerifiedDownload([string]$Url, [string]$Path, [string]$Sha1) {
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and
        (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash -eq $Sha1) {
        Write-Host "复用已校验的 NSIS 下载文件：$Path"
        return
    }

    Write-Host "下载 NSIS 打包依赖：$Url"
    curl.exe --fail --location --retry 4 --retry-connrefused --connect-timeout 15 --max-time 60 --output $Path $Url
    if ($LASTEXITCODE -ne 0) { throw "NSIS 依赖下载失败：$Url（退出码 $LASTEXITCODE）" }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash -ne $Sha1) {
        throw "NSIS 依赖校验失败：$Path"
    }
}

# Tauri 可能复用旧版 NSIS，升级 CLI 时先同步下方的下载地址与哈希。
$lock = Get-Content -LiteralPath package-lock.json -Raw | ConvertFrom-Json -AsHashtable
$cliVersion = $lock.packages.'node_modules/@tauri-apps/cli'.version
if ($cliVersion -ne '2.10.1') {
    throw "Tauri CLI 已变更为 $cliVersion，请核对 NSIS 版本与校验值后更新脚本"
}

$downloadDir = Join-Path $env:RUNNER_TEMP 'upper-nsis-downloads'
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
$archive = Join-Path $downloadDir 'nsis-3.11.zip'
$plugin = Join-Path $downloadDir 'nsis_tauri_utils.dll'

# 版本与 SHA-1 取自 @tauri-apps/cli 2.10.1 的 NSIS 打包器。
Get-VerifiedDownload 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip' `
    $archive 'EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D'
Get-VerifiedDownload 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll' `
    $plugin '75197FEE3C6A814FE035788D1C34EAD39349B860'

$extractDir = Join-Path $env:RUNNER_TEMP 'upper-nsis-extract'
Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
$nsisDir = Join-Path $env:LOCALAPPDATA 'tauri/NSIS'
New-Item -ItemType Directory -Path $nsisDir -Force | Out-Null
Copy-Item -Path (Join-Path $extractDir 'nsis-3.11/*') -Destination $nsisDir -Recurse -Force
$pluginDir = Join-Path $nsisDir 'Plugins/x86-unicode/additional'
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Copy-Item -LiteralPath $plugin -Destination $pluginDir -Force
