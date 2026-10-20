$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location "$Root\firmware"
C:\Users\malek\.platformio\penv\Scripts\platformio.exe run -e esp32dev
