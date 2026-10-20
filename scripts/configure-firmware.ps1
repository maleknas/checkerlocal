param(
  [Parameter(Mandatory=$true)][string]$Ssid,
  [Parameter(Mandatory=$true)][string]$Password,
  [string]$ServerAddress = "192.168.137.1",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = Join-Path $Root "firmware\include\CheckerV2Config.h"

function Escape-CString([string]$Value) {
  return $Value.Replace("\", "\\").Replace('"', '\"')
}

$ssidEsc = Escape-CString $Ssid
$passEsc = Escape-CString $Password
$addrEsc = Escape-CString "ws://$ServerAddress`:$Port/device"

@"
#pragma once

// Local generated file. Do not commit real hotspot credentials.
#define CHECKER_WIFI_SSID "$ssidEsc"
#define CHECKER_WIFI_PASSWORD "$passEsc"
#define CHECKER_SERVER_WS_URL "$addrEsc"

#define CHECKER_RC522_SS_PIN 5
#define CHECKER_RC522_RST_PIN 22
#define CHECKER_SPI_SCK_PIN 18
#define CHECKER_SPI_MISO_PIN 19
#define CHECKER_SPI_MOSI_PIN 23

#define CHECKER_GREEN_LED_PIN 26
#define CHECKER_RED_LED_PIN 27
#define CHECKER_BUZZER_PIN 25

#define CHECKER_LED_ACTIVE_HIGH 1
#define CHECKER_BUZZER_ACTIVE_HIGH 1
"@ | Set-Content -Path $Target -Encoding ASCII

Write-Host "Firmware config written. The password was not printed."
