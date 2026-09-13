param(
    [Parameter(Mandatory = $true)]
    [string]$PackageOutputDir,

    [Parameter(Mandatory = $true)]
    [string]$ChannelPath,

    [string]$Platform = "windows-x64",

    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$SshPort = "22",

    [Parameter(Mandatory = $true)]
    [string]$SshUser,

    [Parameter(Mandatory = $true)]
    [string]$RemoteRoot,

    [string]$SshKey = $env:STATIC_UPDATE_SSH_KEY
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($SshKey)) {
    throw "STATIC_UPDATE_SSH_KEY is required"
}

if (-not (Test-Path -LiteralPath $PackageOutputDir)) {
    throw "Package output directory not found: $PackageOutputDir"
}

$latestJsonPath = Join-Path $PackageOutputDir "latest.json"
if (-not (Test-Path -LiteralPath $latestJsonPath)) {
    throw "latest.json not found in package output: $latestJsonPath"
}

$assetFiles = @(Get-ChildItem -LiteralPath $PackageOutputDir -File | Where-Object { $_.Name -ne "latest.json" })
if ($assetFiles.Count -eq 0) {
    throw "No updater assets found in package output: $PackageOutputDir"
}

$normalizedBaseUrl = $BaseUrl.TrimEnd("/")
$remoteChannelDir = "$($RemoteRoot.TrimEnd('/'))/$ChannelPath"
$remoteAssetDir = "$remoteChannelDir/$Platform"
$manifestUrl = "$normalizedBaseUrl/$ChannelPath/latest.json"
$target = "$SshUser@$SshHost"

$tempRoot = $env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($tempRoot)) {
    $tempRoot = [System.IO.Path]::GetTempPath()
}

$keyPath = Join-Path $tempRoot "mskdsp-upper-static-update-key"
$normalizedSshKey = $SshKey -replace "`r`n", "`n"
if (-not $normalizedSshKey.EndsWith("`n")) {
    $normalizedSshKey = "$normalizedSshKey`n"
}
$normalizedSshKey | Set-Content -LiteralPath $keyPath -NoNewline -Encoding ascii

if ($IsWindows -or [System.Environment]::OSVersion.Platform -eq "Win32NT") {
    icacls $keyPath /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
} else {
    chmod 600 $keyPath
}

$sshOptions = @(
    "-i", $keyPath,
    "-p", $SshPort,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes"
)
$scpOptions = @(
    "-i", $keyPath,
    "-P", $SshPort,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes"
)

function Format-UploadBytes {
    param(
        [Parameter(Mandatory = $true)]
        [long]$Bytes
    )

    $units = @("B", "KiB", "MiB", "GiB", "TiB")
    [double]$value = [Math]::Max(0, $Bytes)
    [int]$unitIndex = 0
    while ($value -ge 1024 -and $unitIndex -lt ($units.Count - 1)) {
        $value /= 1024
        $unitIndex++
    }

    if ($unitIndex -eq 0) {
        return "{0:N0} {1}" -f $value, $units[$unitIndex]
    }

    return "{0:N2} {1}" -f $value, $units[$unitIndex]
}

function Format-UploadDuration {
    param(
        [Parameter(Mandatory = $true)]
        [long]$Seconds
    )

    $normalizedSeconds = [Math]::Max(0, [long]$Seconds)
    if ($normalizedSeconds -lt 60) {
        return "{0}s" -f $normalizedSeconds
    }

    $duration = [TimeSpan]::FromSeconds($normalizedSeconds)
    if ($duration.TotalHours -ge 1) {
        return "{0}h {1:00}m {2:00}s" -f [int]$duration.TotalHours, $duration.Minutes, $duration.Seconds
    }

    return "{0}m {1:00}s" -f $duration.Minutes, $duration.Seconds
}

function ConvertTo-ProcessArgument {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    return '"' + ($Value -replace '"', '\\"') + '"'
}

function Get-RemoteUploadSize {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RemotePath,

        [Parameter(Mandatory = $true)]
        [string[]]$ProgressSshOptions,

        [Parameter(Mandatory = $true)]
        [string]$RemoteTarget
    )

    $remoteSizeText = & ssh @ProgressSshOptions $RemoteTarget "stat -c %s -- '$RemotePath' 2>/dev/null || true" 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    [long]$remoteSize = 0
    $normalizedSizeText = ($remoteSizeText -join "").Trim()
    $parsed = [long]::TryParse(
        $normalizedSizeText,
        [Globalization.NumberStyles]::Integer,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$remoteSize
    )
    if (-not $parsed -or $remoteSize -lt 0) {
        return $null
    }

    return $remoteSize
}

function Wait-ScpUploadWithProgress {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,

        [Parameter(Mandatory = $true)]
        [string]$RemotePath,

        [Parameter(Mandatory = $true)]
        [long]$TotalBytes,

        [Parameter(Mandatory = $true)]
        [datetime]$StartedAt,

        [Parameter(Mandatory = $true)]
        [string[]]$ProgressSshOptions,

        [Parameter(Mandatory = $true)]
        [string]$RemoteTarget
    )

    while (-not $Process.HasExited) {
        Start-Sleep -Seconds 10
        $Process.Refresh()
        if ($Process.HasExited) {
            break
        }

        $uploadedBytes = Get-RemoteUploadSize `
            -RemotePath $RemotePath `
            -ProgressSshOptions $ProgressSshOptions `
            -RemoteTarget $RemoteTarget
        $elapsedSeconds = [Math]::Max(1, [long](([DateTime]::UtcNow - $StartedAt).TotalSeconds))

        if ($null -eq $uploadedBytes) {
            Write-Host "上传进度: 远端文件尚未可读，已等待 $(Format-UploadDuration -Seconds $elapsedSeconds)"
            continue
        }

        $uploadedBytes = [Math]::Min($uploadedBytes, $TotalBytes)
        $speedBytes = [long]($uploadedBytes / $elapsedSeconds)
        $remainingBytes = [Math]::Max(0, $TotalBytes - $uploadedBytes)
        $etaSeconds = if ($speedBytes -gt 0) {
            [long][Math]::Ceiling($remainingBytes / $speedBytes)
        } else {
            0
        }
        $percent = if ($TotalBytes -gt 0) {
            [Math]::Min(100, ($uploadedBytes * 100.0 / $TotalBytes))
        } else {
            0
        }

        Write-Host ("上传进度: {0} / {1} ({2:N1}%)，速度 {3}/s，预计剩余 {4}" -f `
            (Format-UploadBytes -Bytes $uploadedBytes),
            (Format-UploadBytes -Bytes $TotalBytes),
            $percent,
            (Format-UploadBytes -Bytes $speedBytes),
            (Format-UploadDuration -Seconds $etaSeconds))
    }

    $Process.WaitForExit()
    return $Process.ExitCode
}

$progressSshOptions = @($sshOptions) + @("-o", "ConnectTimeout=8")

Write-Host "Preparing remote static updater directory: $remoteAssetDir"
& ssh @sshOptions $target "mkdir -p '$remoteAssetDir' '$remoteChannelDir'"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create remote static updater directory"
}

$assetPaths = @($assetFiles | ForEach-Object { $_.FullName })
$progressAsset = $assetFiles | Sort-Object -Property Length -Descending | Select-Object -First 1
$remoteAssetPath = "$remoteAssetDir/$($progressAsset.Name)"
$totalBytes = [long]$progressAsset.Length
Write-Host "上传更新资产（主资产大小: $(Format-UploadBytes -Bytes $totalBytes)，每 10 秒显示一次进度；latest.json 将最后上传）"
$scpArguments = @($scpOptions + $assetPaths + "$target`:$remoteAssetDir/")
$scpArgumentLine = ($scpArguments | ForEach-Object { ConvertTo-ProcessArgument -Value ([string]$_) }) -join " "
$uploadStartedAt = [DateTime]::UtcNow
$scpProcess = Start-Process -FilePath "scp" -ArgumentList $scpArgumentLine -NoNewWindow -PassThru
$scpExitCode = Wait-ScpUploadWithProgress `
    -Process $scpProcess `
    -RemotePath $remoteAssetPath `
    -TotalBytes $totalBytes `
    -StartedAt $uploadStartedAt `
    -ProgressSshOptions $progressSshOptions `
    -RemoteTarget $target
if ($scpExitCode -ne 0) {
    throw "更新资产上传失败，scp 退出码: $scpExitCode"
}
Write-Host "更新资产上传完成"

Write-Host "最后上传 latest.json"
& scp @scpOptions $latestJsonPath "$target`:$remoteChannelDir/latest.json"
if ($LASTEXITCODE -ne 0) {
    throw "latest.json 上传失败"
}

Write-Host "Verifying static updater manifest: $manifestUrl"
$manifestResponse = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing
if ($manifestResponse.StatusCode -lt 200 -or $manifestResponse.StatusCode -ge 300) {
    throw "Static updater manifest verification failed: $($manifestResponse.StatusCode)"
}

$manifest = $manifestResponse.Content | ConvertFrom-Json
$platformEntries = @($manifest.platforms.PSObject.Properties)
if ($platformEntries.Count -eq 0) {
    throw "Static updater manifest has no platform entries"
}

$downloadUrl = [string]$platformEntries[0].Value.url
if ([string]::IsNullOrWhiteSpace($downloadUrl)) {
    throw "Static updater manifest first platform entry has no url"
}

Write-Host "Verifying first updater asset URL: $downloadUrl"
$assetResponse = Invoke-WebRequest -Uri $downloadUrl -Method Head -UseBasicParsing
if ($assetResponse.StatusCode -lt 200 -or $assetResponse.StatusCode -ge 300) {
    throw "Static updater asset verification failed: $($assetResponse.StatusCode)"
}

Write-Host "Static updater sync completed for $ChannelPath/$Platform"
