$ErrorActionPreference = "Stop"
$candidates = @(
    "__INSTALL_DIR__\logs",
    "$env:LOCALAPPDATA\__PRODUCT_NAME__\logs",
    "$env:APPDATA\__PRODUCT_NAME__\logs"
)

Write-Host "__PRODUCT_NAME__ 日志目录探测结果:"
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
        Write-Host "FOUND  $candidate"
    }
    else {
        Write-Host "MISS   $candidate"
    }
}
