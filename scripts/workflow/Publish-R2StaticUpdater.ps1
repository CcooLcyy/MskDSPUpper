param(
    [Parameter(Mandatory = $true)]
    [string]$PackageOutputDir,

    [Parameter(Mandatory = $true)]
    [string]$ChannelPath,

    [string]$Platform = $env:PLATFORM_ID,
    [string]$R2Bucket = $env:R2_BUCKET,
    [string]$R2Prefix = $env:R2_PREFIX,
    [string]$R2Endpoint = $env:R2_ENDPOINT,
    [string]$R2AccountId = $env:R2_ACCOUNT_ID,
    [string]$PublicBaseUrl = $env:STATIC_UPDATE_BASE_URL
)

$ErrorActionPreference = "Stop"

function Assert-NonEmpty {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Name 不能为空"
    }
}

function Assert-SafePathPart {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    Assert-NonEmpty -Name $Name -Value $Value
    if ($Value -match '(^|[\\/])\.\.?([\\/]|$)' -or $Value -match '[\\/]') {
        throw "$Name 只能包含单个路径段: $Value"
    }
}

function Assert-SafePrefix {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    Assert-NonEmpty -Name $Name -Value $Value
    $segments = $Value.Trim('/').Replace('\', '/').Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)
    $unsafeSegments = @($segments | Where-Object { $_ -in @('.', '..') -or $_ -match '[\x00-\x1F]' })
    if ($segments.Count -eq 0 -or $unsafeSegments.Count -gt 0) {
        throw "$Name 包含不安全的路径段: $Value"
    }
}

Assert-NonEmpty -Name "PackageOutputDir" -Value $PackageOutputDir
Assert-SafePathPart -Name "ChannelPath" -Value $ChannelPath
Assert-SafePathPart -Name "Platform" -Value $Platform
Assert-NonEmpty -Name "R2Bucket" -Value $R2Bucket
if ([string]::IsNullOrWhiteSpace($R2Prefix)) {
    $R2Prefix = "mskdsp-upper"
}
Assert-SafePrefix -Name "R2Prefix" -Value $R2Prefix
if ([string]::IsNullOrWhiteSpace($R2Endpoint)) {
    Assert-NonEmpty -Name "R2AccountId" -Value $R2AccountId
    if ($R2AccountId -notmatch '^[a-z0-9]{16,64}$') {
        throw "R2AccountId 格式不正确"
    }
    $R2Endpoint = "https://$R2AccountId.r2.cloudflarestorage.com"
}
Assert-NonEmpty -Name "R2Endpoint" -Value $R2Endpoint
Assert-NonEmpty -Name "PublicBaseUrl" -Value $PublicBaseUrl

if (-not (Test-Path -LiteralPath $PackageOutputDir -PathType Container)) {
    throw "Package output directory 不存在: $PackageOutputDir"
}

$latestJsonPath = Join-Path $PackageOutputDir "latest.json"
if (-not (Test-Path -LiteralPath $latestJsonPath -PathType Leaf)) {
    throw "Package output directory 中缺少 latest.json: $latestJsonPath"
}

$assetFiles = @(Get-ChildItem -LiteralPath $PackageOutputDir -File | Where-Object { $_.Name -ne "latest.json" })
if ($assetFiles.Count -eq 0) {
    throw "Package output directory 中没有可上传的更新资产: $PackageOutputDir"
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw "未找到 AWS CLI，请先在 GitHub Actions runner 中安装 aws 命令"
}

Assert-NonEmpty -Name "AWS_ACCESS_KEY_ID" -Value $env:AWS_ACCESS_KEY_ID
Assert-NonEmpty -Name "AWS_SECRET_ACCESS_KEY" -Value $env:AWS_SECRET_ACCESS_KEY

$normalizedEndpoint = $R2Endpoint.TrimEnd('/')
$normalizedPrefix = $R2Prefix.Trim('/').Replace('\', '/')
$normalizedChannel = $ChannelPath.Trim('/').Replace('\', '/')
$normalizedPlatform = $Platform.Trim('/').Replace('\', '/')
$objectRoot = "$normalizedPrefix/$normalizedChannel/$normalizedPlatform"
$channelRoot = "$normalizedPrefix/$normalizedChannel"
$bucketUri = "s3://$R2Bucket"
$assetUri = "$bucketUri/$objectRoot/"
$manifestUri = "$bucketUri/$channelRoot/latest.json"
$normalizedPublicBaseUrl = $PublicBaseUrl.TrimEnd('/')
$manifestUrl = "$normalizedPublicBaseUrl/$normalizedChannel/latest.json"

function Invoke-R2Aws {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & aws @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "AWS CLI 执行失败，退出码: $LASTEXITCODE"
    }
}

$commonArguments = @(
    "--endpoint-url", $normalizedEndpoint,
    "--region", "auto"
)

Write-Host "上传 R2 更新资产: $objectRoot（共 $($assetFiles.Count) 个文件）"
foreach ($asset in $assetFiles) {
    $destination = "$assetUri$($asset.Name)"
    Write-Host "上传资产: $($asset.Name)"
    Invoke-R2Aws -Arguments (@(
        "s3", "cp", $asset.FullName, $destination,
        "--cache-control", "public,max-age=31536000,immutable",
        "--only-show-errors"
    ) + $commonArguments)
}

# latest.json 必须最后上传，避免客户端读取到尚未准备好的资产清单。
Write-Host "最后上传 latest.json: $manifestUri"
Invoke-R2Aws -Arguments (@(
    "s3", "cp", $latestJsonPath, $manifestUri,
    "--cache-control", "no-store,max-age=0,must-revalidate",
    "--content-type", "application/json",
    "--only-show-errors"
) + $commonArguments)

Write-Host "验证 R2 更新清单: $manifestUrl"
$manifestResponse = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing
if ($manifestResponse.StatusCode -lt 200 -or $manifestResponse.StatusCode -ge 300) {
    throw "R2 更新清单验证失败，HTTP 状态码: $($manifestResponse.StatusCode)"
}

$manifest = $manifestResponse.Content | ConvertFrom-Json
$platformEntries = @($manifest.platforms.PSObject.Properties)
if ($platformEntries.Count -eq 0) {
    throw "R2 更新清单中没有 platforms 条目"
}

$downloadUrl = [string]$platformEntries[0].Value.url
if ([string]::IsNullOrWhiteSpace($downloadUrl)) {
    throw "R2 更新清单首个平台条目缺少下载地址"
}

Write-Host "验证首个更新资产: $downloadUrl"
$assetResponse = Invoke-WebRequest -Uri $downloadUrl -Method Head -UseBasicParsing
if ($assetResponse.StatusCode -lt 200 -or $assetResponse.StatusCode -ge 300) {
    throw "R2 更新资产验证失败，HTTP 状态码: $($assetResponse.StatusCode)"
}

# 只有清单和首个资产验证成功后才删除旧对象，避免发布失败时破坏当前可用版本。
# 仅删除不同文件名的对象，保留刚刚上传且仍被 latest.json 引用的资产。
$currentNames = @($assetFiles | ForEach-Object { $_.Name })
$listedObjects = & aws s3api list-objects-v2 `
    --bucket $R2Bucket `
    --prefix "$objectRoot/" `
    --query "Contents[].Key" `
    --output text `
    @commonArguments
if ($LASTEXITCODE -ne 0) {
    throw "列出 R2 旧对象失败，退出码: $LASTEXITCODE"
}
foreach ($key in ([string]$listedObjects -split "`t|`r?`n" | Where-Object { $_ -and $_ -ne "None" })) {
    $name = Split-Path -Leaf $key
    if ($currentNames -notcontains $name) {
        Write-Host "清理 R2 旧对象: $key"
        Invoke-R2Aws -Arguments (@("s3", "rm", "$bucketUri/$key", "--only-show-errors") + $commonArguments)
    }
}

Write-Host "R2 更新包发布完成: $normalizedChannel/$normalizedPlatform"
