# CheckerV2

CheckerV2 migrates the working `CheckerV0` single-device app to a PC-hosted architecture.

- The PC hosts the web UI, API, business logic, and SQLite database.
- The ESP32 joins the PC Mobile Hotspot as a Wi-Fi client.
- The ESP32 reads RC522 cards, sends scans to the PC over WebSocket, and plays LED/buzzer feedback only after the PC confirms the result.

## First-Time Setup

1. Enable Windows Mobile Hotspot and keep this PC awake.
2. Start the server once to see usable addresses:

```powershell
cd C:\Users\malek\OneDrive\Bureau\RAVENA\checkerv2
powershell -ExecutionPolicy Bypass -File .\scripts\setup-server.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
```

3. Use the PC Mobile Hotspot address, normally `192.168.137.1`, not `localhost` and not the PC's internet-side address.
4. Configure firmware credentials locally:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-firmware.ps1 -Ssid "YOUR_HOTSPOT_NAME" -Password "YOUR_HOTSPOT_PASSWORD" -Port 8080
```

5. Build firmware:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-firmware.ps1
```

6. Upload only after confirming the attached ESP32 serial port:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-firmware.ps1 -Port COM3
```

## Daily Startup

1. Enable the PC Mobile Hotspot. This is required even if the PC has no internet connection.
2. Start CheckerV2:

```powershell
cd C:\Users\malek\OneDrive\Bureau\RAVENA\checkerv2
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
```

3. Power the ESP32.
4. Open the PC URL printed by the server, usually `http://localhost:8080`.
5. Open the phone URL printed by the server from a phone connected to the same hotspot.
6. Wait until the UI reader pill shows the device is ready.

## Optional LCD Keypad Shield

The firmware supports a passive 16x2 parallel LCD status display. The keypad
buttons, A0 input, reset button, and D10 backlight control are not used.

Wire the LCD shield in 4-bit write-only mode:

| LCD shield signal | ESP32 GPIO |
| --- | --- |
| D8 / RS | 21 |
| D9 / Enable | 33 |
| D4 / DB4 | 4 |
| D5 / DB5 | 14 |
| D6 / DB6 | 13 |
| D7 / DB7 | 32 |
| 5V | verified 5V supply |
| GND | common GND |

GPIO4 is an ESP32 boot strapping pin; confirm the attached shield does not
force it to the wrong level during reset. To disable LCD support, set
`CHECKER_LCD_ENABLED` to `0` in `firmware/include/CheckerV2Config.h`.

## Shutdown

Press `Ctrl+C` in the server terminal. The SQLite database is stored in `server/data/checker-v2.sqlite` and survives restarts.

## Diagnostics

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics.ps1
```

This reports server health, database availability, local IPv4 addresses, and ESP connection state without printing hotspot secrets.

## Troubleshooting

- Do not configure the ESP server as `localhost`; on the ESP that means the ESP itself.
- If the phone cannot open the LAN URL, confirm it is connected to the PC hotspot and Windows Firewall allows the configured port on that network.
- If the ESP cannot connect, confirm the hotspot is 2.4 GHz compatible or mixed-band. The detected Wi-Fi adapter supports 2.4 GHz.
- If Windows does not expose the hotspot password to scripts, copy it from Settings > Network & Internet > Mobile hotspot > Properties.
- Firmware does not need reflashing for ordinary daily startup unless the hotspot SSID/password changes.
- If the ESP previously saved an old server URL, type `CLEARWIFI` in Serial Monitor after flashing to force the compiled hotspot defaults.

## Saving Changes With Git

The repository contains the server, web UI, firmware, scripts, and documentation.
From the repository root, save a new version with:

```powershell
git status
git add .
git commit -m "Describe your changes"
```

After an online remote is connected, upload saved commits with `git push`.
A local commit alone does not provide an off-device backup.

Wi-Fi credentials (`firmware/include/CheckerV2Config.h`), the live database
(`server/data/`), build output, and the unrelated `work/` folder are excluded.
Use the application's JSON backup/export feature to save event data separately.
On another computer, follow First-Time Setup to recreate the local firmware
configuration, then restore your event backup through the application.
