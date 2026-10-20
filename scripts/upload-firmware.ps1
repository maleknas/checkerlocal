param(
  [string]$Port = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location "$Root\firmware"

if ($Port) {
  C:\Users\malek\.platformio\penv\Scripts\platformio.exe run -e esp32dev -t upload --upload-port $Port
} else {
  C:\Users\malek\.platformio\penv\Scripts\platformio.exe device list
  Write-Host "If more than one serial device is listed, rerun with -Port COMx."
  C:\Users\malek\.platformio\penv\Scripts\platformio.exe run -e esp32dev -t upload
}
