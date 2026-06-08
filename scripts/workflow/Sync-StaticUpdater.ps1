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

Write-Host "Preparing remote static updater directory: $remoteAssetDir"
& ssh @sshOptions $target "mkdir -p '$remoteAssetDir' '$remoteChannelDir'"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create remote static updater directory"
}

Write-Host "Uploading updater assets before latest.json"
$assetPaths = @($assetFiles | ForEach-Object { $_.FullName })
& scp @scpOptions @assetPaths "$target`:$remoteAssetDir/"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload updater assets"
}

Write-Host "Uploading latest.json last"
& scp @scpOptions $latestJsonPath "$target`:$remoteChannelDir/latest.json"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload latest.json"
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
