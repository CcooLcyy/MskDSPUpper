param(
    [string]$GitHubHost = "github.com"
)

$ErrorActionPreference = "Stop"
$mode = "anonymous"

function Assert-LastExitCode {
    param(
        [string]$CommandName
    )

    if ($LASTEXITCODE -ne 0) {
        throw "$CommandName failed with exit code $LASTEXITCODE."
    }
}

Write-Host "[workflow] 准备 submodule 访问凭据"

$checkoutExtraHeaderKey = "http.https://$GitHubHost/.extraheader"
$localGitConfig = git config --local --list
Assert-LastExitCode "git config --local --list"
if ($localGitConfig | Select-String -SimpleMatch "$checkoutExtraHeaderKey=") {
    git config --local --unset-all $checkoutExtraHeaderKey
    Assert-LastExitCode "git config --local --unset-all checkout extraheader"
}

if ($env:SUBMODULE_TOKEN) {
    git config --global url."https://x-access-token:$($env:SUBMODULE_TOKEN)@$GitHubHost/".insteadOf "https://$GitHubHost/"
    Assert-LastExitCode "git config --global token rewrite"
    $mode = "token"
}
elseif ($env:SUBMODULE_SSH_KEY) {
    $sshDir = Join-Path $HOME ".ssh"
    $privateKeyPath = Join-Path $sshDir "codex_submodule_key"
    $knownHostsPath = Join-Path $sshDir "known_hosts"

    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    Set-Content -Path $privateKeyPath -Value $env:SUBMODULE_SSH_KEY -NoNewline
    icacls $privateKeyPath /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
    Assert-LastExitCode "icacls $privateKeyPath"

    Set-Content -Path $knownHostsPath -Value "" -NoNewline
    ssh-keyscan $GitHubHost | Out-File -FilePath $knownHostsPath -Encoding ascii -Append
    Assert-LastExitCode "ssh-keyscan $GitHubHost"

    if ((Get-Service ssh-agent).Status -ne "Running") {
        Start-Service ssh-agent
    }

    ssh-add $privateKeyPath | Out-Null
    Assert-LastExitCode "ssh-add $privateKeyPath"

    git config --global url."git@${GitHubHost}:".insteadOf "https://$GitHubHost/"
    Assert-LastExitCode "git config --global ssh rewrite"
    $mode = "ssh"
}

Write-Host "[workflow] submodule 访问模式: $mode"
if ($env:GITHUB_OUTPUT) {
    Add-Content -Path $env:GITHUB_OUTPUT -Value "auth_mode=$mode"
}
