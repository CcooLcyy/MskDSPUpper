param(
    [string]$GitHubHost = "github.com"
)

$ErrorActionPreference = "Stop"
$mode = "anonymous"

Write-Host "[workflow] 准备 submodule 访问凭据"

if ($env:SUBMODULE_TOKEN) {
    git config --global url."https://x-access-token:$($env:SUBMODULE_TOKEN)@$GitHubHost/".insteadOf "https://$GitHubHost/"
    $mode = "token"
}
elseif ($env:SUBMODULE_SSH_KEY) {
    $sshDir = Join-Path $HOME ".ssh"
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    $privateKeyPath = Join-Path $sshDir "codex_submodule_key"
    Set-Content -Path $privateKeyPath -Value $env:SUBMODULE_SSH_KEY -NoNewline
    icacls $privateKeyPath /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
    Set-Content -Path (Join-Path $sshDir "known_hosts") -Value "" -NoNewline
    ssh-keyscan $GitHubHost | Out-File -FilePath (Join-Path $sshDir "known_hosts") -Encoding ascii -Append

    if ((Get-Service ssh-agent).Status -ne "Running") {
        Start-Service ssh-agent
    }

    ssh-add $privateKeyPath | Out-Null
    git config --global url."git@$GitHubHost:".insteadOf "https://$GitHubHost/"
    $mode = "ssh"
}

Write-Host "[workflow] submodule 访问模式: $mode"
if ($env:GITHUB_OUTPUT) {
    Add-Content -Path $env:GITHUB_OUTPUT -Value "auth_mode=$mode"
}
