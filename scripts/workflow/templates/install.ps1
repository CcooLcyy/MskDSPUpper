param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot "payload\__INSTALLER_NAME__")
)

$ErrorActionPreference = "Stop"
Write-Host "安装 __PRODUCT_NAME__，安装包: $InstallerPath"

if (-not (Test-Path -LiteralPath $InstallerPath)) {
    throw "未找到安装包: $InstallerPath"
}

Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait -NoNewWindow
Write-Host "安装完成，默认安装目录: __INSTALL_DIR__"
