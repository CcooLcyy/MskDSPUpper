$ErrorActionPreference = "Stop"
$processName = "__PROCESS_NAME__"
Write-Host "停止 __PRODUCT_NAME__ 进程: $processName"

$matched = Get-Process | Where-Object { $_.ProcessName -eq $processName -or $_.ProcessName -eq "__BINARY_NAME__" }
if (-not $matched) {
    Write-Host "未发现正在运行的目标进程"
    exit 0
}

$matched | Stop-Process -Force
Write-Host "已停止目标进程"
