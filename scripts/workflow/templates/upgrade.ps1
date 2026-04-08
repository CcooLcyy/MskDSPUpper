param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot "payload\__INSTALLER_NAME__")
)

$ErrorActionPreference = "Stop"
Write-Host "升级 __PRODUCT_NAME__，复用安装脚本"

& (Join-Path $PSScriptRoot "stop.ps1")
& (Join-Path $PSScriptRoot "install.ps1") -InstallerPath $InstallerPath
& (Join-Path $PSScriptRoot "start.ps1")
