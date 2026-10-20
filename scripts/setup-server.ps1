$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
node -e "require('node:sqlite'); console.log('Node SQLite available');"
New-Item -ItemType Directory -Force .\server\data | Out-Null
Write-Host "Server setup complete. No npm install is required for CheckerV2."
