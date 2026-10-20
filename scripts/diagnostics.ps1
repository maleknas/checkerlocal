param(
  [int]$Port = 8080
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "CheckerV2 diagnostics"
Write-Host "Root: $Root"
Write-Host "Configured port: $Port"

try {
  $health = Invoke-RestMethod -Uri "http://localhost:$Port/api/diagnostics" -TimeoutSec 2
  Write-Host "Server health: ok"
  Write-Host "Database: $($health.database)"
  if ($null -eq $health.device) {
    Write-Host "Device: not connected"
  } else {
    Write-Host "Device: $($health.device | ConvertTo-Json -Compress)"
  }
} catch {
  Write-Host "Server health: not reachable on localhost:$Port"
}

Write-Host "Local IPv4 addresses:"
try {
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" } |
    Select-Object InterfaceAlias, IPAddress, PrefixLength |
    Format-Table -AutoSize
} catch {
  ipconfig | Select-String -Pattern "adapter|IPv4"
}

Write-Host "Mobile hotspot details:"
Write-Host "Windows may not expose the hotspot password to scripts. Use Settings > Network & Internet > Mobile hotspot > Properties if needed."
try {
  Get-NetAdapter |
    Where-Object { $_.InterfaceDescription -match "Wi-Fi Direct|Hosted|Virtual|Mobile|Microsoft Wi-Fi Direct" -or $_.Name -match "Local Area Connection|Wi-Fi Direct|Hotspot" } |
    Select-Object Name, InterfaceDescription, Status, LinkSpeed |
    Format-Table -AutoSize
} catch {
  Write-Host "Network adapter inspection requires elevated Windows permissions in this session."
}
