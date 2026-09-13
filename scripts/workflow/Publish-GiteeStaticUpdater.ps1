param(
    [Parameter(Mandatory = $true)]
    [string]$PackageOutputDir,

    [Parameter(Mandatory = $true)]
    [string]$ChannelPath,

    [Parameter(Mandatory = $true)]
    [string]$ReleaseTag,

    [Parameter(Mandatory = $true)]
    [string]$ReleaseTitle,

    [string]$GiteeOwner = $env:GITEE_OWNER,
    [string]$GiteeRepo = $env:GITEE_REPO,
    [string]$GiteeToken = $env:GITEE_TOKEN,
    [string]$SshHost = $env:STATIC_UPDATE_SSH_HOST,
    [string]$SshPort = $env:STATIC_UPDATE_SSH_PORT,
    [string]$SshUser = $env:STATIC_UPDATE_SSH_USER,
    [string]$SshKey = $env:STATIC_UPDATE_SSH_KEY,
    [string]$RemoteRoot = $env:STATIC_UPDATE_REMOTE_ROOT,
    [string]$Platform = $env:PLATFORM_ID,
    [switch]$Prerelease
)

$ErrorActionPreference = "Stop"

foreach ($entry in @{
    PackageOutputDir = $PackageOutputDir
    ChannelPath = $ChannelPath
    ReleaseTag = $ReleaseTag
    ReleaseTitle = $ReleaseTitle
    GiteeOwner = $GiteeOwner
    GiteeRepo = $GiteeRepo
    GiteeToken = $GiteeToken
    SshHost = $SshHost
    SshPort = $SshPort
    SshUser = $SshUser
    SshKey = $SshKey
    RemoteRoot = $RemoteRoot
    Platform = $Platform
}.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
        throw "$($entry.Key) 不能为空"
    }
}

if (-not (Test-Path -LiteralPath $PackageOutputDir -PathType Container)) {
    throw "Package output directory not found: $PackageOutputDir"
}

$assetFiles = @(Get-ChildItem -LiteralPath $PackageOutputDir -File)
if ($assetFiles.Count -eq 0) {
    throw "Package output directory is empty: $PackageOutputDir"
}

$scriptPath = Join-Path $PSScriptRoot "publish_gitee_release.py"
$arguments = @(
    $scriptPath,
    "--owner", $GiteeOwner,
    "--repo", $GiteeRepo,
    "--tag", $ReleaseTag,
    "--name", $ReleaseTitle,
    "--target-commitish", "master",
    "--product", "upper",
    "--channel", $ChannelPath,
    "--platform", $Platform,
    "--remote-root", $RemoteRoot,
    "--ssh-host", $SshHost,
    "--ssh-port", $SshPort,
    "--ssh-user", $SshUser,
    "--remote-script", "/home/daniel/update-server/relay/sync_gitee_release.py"
)
if ($Prerelease) {
    $arguments += "--prerelease"
}
foreach ($asset in $assetFiles) {
    $arguments += @("--asset", $asset.FullName)
}

$env:PYTHONUTF8 = "1"
python $arguments
if ($LASTEXITCODE -ne 0) {
    throw "Gitee Release 上传失败，退出码: $LASTEXITCODE"
}
