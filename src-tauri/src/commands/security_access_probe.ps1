# 固定目标的只读检查：不接受调用者参数，不写地址、路由或 NAT。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$target = '11.22.33.44'
$adapters = @(Get-NetAdapter -IncludeHidden)
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
    $address = $_
    $adapter = $adapters | Where-Object { $_.ifIndex -eq $address.InterfaceIndex } | Select-Object -First 1
    [pscustomobject]@{
        address = [string]$address.IPAddress
        prefix_length = [int]$address.PrefixLength
        interface_index = [int]$address.InterfaceIndex
        up = [bool]($adapter -and $adapter.Status -eq 'Up' -and $address.AddressState -eq 'Preferred')
    }
})
$routeIndex = $null
$routeSource = $null
try {
    $selection = @(Find-NetRoute -RemoteIPAddress $target)
    $source = $selection | Where-Object { $_.PSObject.Properties['IPAddress'] } | Select-Object -First 1
    $route = $selection | Where-Object { $_.PSObject.Properties['DestinationPrefix'] } | Select-Object -First 1
    if ($source -and $route) {
        $routeIndex = [int]$route.InterfaceIndex
        $routeSource = [string]$source.IPAddress
    }
} catch {
    # 无匹配路由时保留空值，由上层展示路由失败。
}
$eligible = @($addresses | Where-Object {
    $parts = $_.address.Split('.')
    $_.up -and $_.prefix_length -eq 24 -and $parts.Length -eq 4 -and
    ($parts[0..2] -join '.') -eq '11.22.33' -and
    [int]$parts[3] -notin @(0, 1, 2, 44, 255) -and
    $_.interface_index -eq $routeIndex -and $_.address -eq $routeSource
})
$pingSuccess = $false
if ($eligible.Count -gt 0) {
    $ping = New-Object System.Net.NetworkInformation.Ping
    try {
        for ($attempt = 0; $attempt -lt 2; $attempt++) {
            try {
                $reply = $ping.Send($target, 1200)
                if ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
                    $pingSuccess = $true
                    break
                }
            } catch {
                # ICMP 无响应不等同于业务不可用。
            }
        }
    } finally { $ping.Dispose() }
}
[pscustomobject]@{
    addresses = $addresses
    route_interface_index = $routeIndex
    route_source_address = $routeSource
    ping_success = $pingSuccess
} | ConvertTo-Json -Depth 4 -Compress
