param(
    [string]$ExecutablePath = "__INSTALL_DIR__\__BINARY_NAME__.exe"
)

$ErrorActionPreference = "Stop"
Write-Host "启动 __PRODUCT_NAME__: $ExecutablePath"

if (-not (Test-Path -LiteralPath $ExecutablePath)) {
    throw "未找到可执行文件: $ExecutablePath"
}

Start-Process -FilePath $ExecutablePath
