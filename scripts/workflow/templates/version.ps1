param(
    [string]$ExecutablePath = "__INSTALL_DIR__\__BINARY_NAME__.exe"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $ExecutablePath)) {
    throw "未找到可执行文件: $ExecutablePath"
}

$version = (Get-Item -LiteralPath $ExecutablePath).VersionInfo.ProductVersion
Write-Host "__PRODUCT_NAME__ 当前安装版本: $version"
