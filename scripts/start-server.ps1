param(
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$env:CHECKER_PORT = "$Port"
Set-Location $Root
node .\server\app.js
