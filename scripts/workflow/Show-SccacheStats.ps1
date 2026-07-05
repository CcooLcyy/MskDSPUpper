$ErrorActionPreference = 'Continue'

$logDir = Join-Path 'package' 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$logFile = Join-Path $logDir 'sccache-stats.log'
$sccache = $env:SCCACHE_PATH

if (-not $sccache) {
  $command = Get-Command sccache -ErrorAction SilentlyContinue
  if ($command) {
    $sccache = $command.Source
  }
}

if (-not $sccache) {
  'sccache not available; skipping stats.' | Tee-Object -FilePath $logFile
  exit 0
}

& $sccache --show-stats 2>&1 | Tee-Object -FilePath $logFile
if ($LASTEXITCODE -ne 0) {
  Write-Warning "sccache stats failed with exit code $LASTEXITCODE"
}

exit 0
