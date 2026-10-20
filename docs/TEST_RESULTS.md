# Test Results

Date: 2026-10-01

## Performed

- Inspected `CheckerV0` firmware, config, web UI, routes, storage format, hardware pins, modes, cooldowns, and feedback timings.
- Confirmed Node built-in SQLite is available.
- Started CheckerV2 server on `http://localhost:8080`.
- Loaded `/api/status` successfully.
- Loaded the copied Ravena UI from `/`.
- Created a demo event via `/api/event`.
- Added a person via `/api/people/save`; UID normalized from `04 A1-B2:C3` to `04A1B2C3`.
- Changed scanner mode through `/api/scanner/mode`.
- Used a Node WebSocket simulator as an ESP device.
- Simulated an RFID check-in scan.
- Retried the same scan event ID and confirmed the original response was replayed without a second mutation.
- Sent a stale scan with an old `stateRev` and confirmed it was rejected as stale.
- Restarted the server and confirmed event/person/attendance data persisted in SQLite.
- Built ESP32 firmware successfully with PlatformIO.
- Checked server syntax with `node --check`.
- Removed the generated demo SQLite files after verification so first real startup is clean.
- Confirmed clean `/api/status` returns empty Paused state after test data removal.
- Confirmed `/api/diagnostics` returns database health and detected addresses from the normal session.

## Network Inspection

- Tools are running directly on Windows PowerShell with access to Windows networking commands when elevated.
- Detected Wi-Fi adapter: Realtek RTL8852AE WiFi 6.
- Detected Wi-Fi adapter supports 2.4 GHz and 5 GHz.
- Detected active Wi-Fi IPv4: `192.168.1.199`.
- Detected VMware IPv4 addresses: `192.168.15.1`, `10.10.1.1`.
- Mobile Hotspot did not appear enabled: `Connexion au réseau local*` interfaces showed APIPA `169.254.x.x` addresses.
- Hotspot password was not retrieved or printed. Use Windows Settings if needed.

## Not Performed

- Did not upload CheckerV2 firmware because `CheckerV2Config.h` still contains placeholder hotspot credentials.
- Did not perform a physical RFID scan with the ESP32.
- Did not observe physical green/red LED or buzzer patterns.
- Did not validate phone access over the hotspot because the hotspot did not appear enabled during diagnostics.
- Did not create Windows Firewall rules.
- In this sandbox, an elevated PowerShell process could inspect adapters but did not reach the non-elevated local server on `localhost:8080`; direct non-elevated API checks succeeded.

## Remaining Hardware Checks

1. Enable Mobile Hotspot.
2. Configure `firmware/include/CheckerV2Config.h` with the actual hotspot SSID/password and PC hotspot IPv4.
3. Upload firmware to the confirmed ESP32 port.
4. Start server and watch `/api/diagnostics` or UI reader pill for device readiness.
5. Start check-in mode.
6. Scan an assigned card and verify the UI check-in plus green/buzzer feedback.
7. Scan an unknown card and verify bad result plus red/buzzer feedback.

## 2026-10-02 Focused Server/UI Update

- Rechecked `server/app.js` syntax with `node --check`.
- Rechecked the inline browser script syntax from `server/public/checker-ravena.html`.
- Started the server on temporary port `8091` with a temporary smoke-test SQLite database.
- Loaded `/api/status` and the main UI page.
- Created a smoke-test event through `/api/event`.
- Added a person through `/api/people/save` and confirmed UID normalization still works.
- Imported one CSV row through `/api/import`.
- Entered single-card assignment mode and confirmed `/api/status` includes the selected person's `assignName`.
- Removed the temporary smoke-test database after verification.
- Firmware was not changed or reflashed for this server/UI-only update.

## 2026-10-02 RFID Recovery Update

- Inspected ESP scan loop early returns: reader readiness, paused mode, server readiness, pending scan, cooldown, no-card, same-card-held, and read-failed paths.
- Added firmware diagnostics for RFID poll-loop progress, blocked reason, RC522 communication health, read attempts/successes, last successful UID, held-card state, pending scan state, and recovery count.
- Added controlled RC522-only recovery using MFRC522 reset/reinitialize/antenna-on. Recovery is deferred while a scan result is pending.
- Added automatic recovery only after repeated RC522 communication failures. No-card polling does not trigger recovery.
- Added Serial Monitor commands `RFIDSTATUS` and `RFIDRECOVER`.
- Added server `/api/device/recover-reader` and UI `Recover reader` button.
- Rechecked `server/app.js` syntax with `node --check`.
- Rechecked inline UI script syntax.
- Built ESP32 firmware successfully with PlatformIO.
- Started a temporary server on port `8092`, loaded diagnostics/UI, and confirmed the recovery endpoint returns a clean `503 No connected ESP device` when no ESP is connected.

Not physically verified:

- Did not upload firmware to the ESP32.
- Did not reproduce the RFID-read freeze on hardware.
- Did not confirm that automatic or manual RC522 recovery restores card reads after the freeze.
- Did not observe LED/buzzer behavior after a recovered real scan.
