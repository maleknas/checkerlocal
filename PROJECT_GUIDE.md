# CheckerV2 Project Guide

This document explains the CheckerV2 project from the top down: what it does, how the parts talk to each other, where data lives, and which files matter when you want to change or debug the system.

## 1. What CheckerV2 Is

CheckerV2 is an event attendance and RFID assignment system.

It replaces the older CheckerV0 single-device architecture with a PC-hosted architecture:

- The PC runs the web UI, HTTP API, business logic, and SQLite database.
- The ESP32 connects to the PC over Wi-Fi and WebSocket.
- The ESP32 reads RC522 RFID cards and sends card scans to the PC.
- The PC decides what each scan means, saves the result, and sends feedback back to the ESP32.
- The ESP32 only handles hardware behavior: RFID reads, LEDs, buzzer, optional LCD, Wi-Fi, and WebSocket connection.

The important design idea is that the PC server is authoritative. The ESP32 is not trusted to decide attendance or assignment state.

## 2. Main Architecture

```text
Browser / Phone UI
        |
        | HTTP fetch / static files
        v
PC Node.js Server
        |
        | SQLite
        v
server/data/checker-v2.sqlite

ESP32 Firmware
        |
        | WebSocket ws://PC_IP:8080/device
        v
PC Node.js Server

ESP32 Hardware
        |
        | SPI / GPIO
        v
RC522 RFID reader, LEDs, buzzer, optional LCD
```

### PC server responsibilities

The PC server owns:

- Serving the UI from `server/public/checker-ravena.html`.
- Serving Ravena assets from `server/public/style/`.
- All `/api/...` browser routes.
- Event setup and reset.
- People roster storage.
- RFID UID assignment.
- Manual and RFID check-in.
- Undo.
- CSV import/export.
- JSON backup/restore.
- Printable report.
- Scanner modes.
- SQLite persistence.
- WebSocket protocol with the ESP32.
- Device connection status and diagnostics.
- Scan deduplication.
- Stale scanner-state protection.

### ESP32 responsibilities

The ESP32 owns:

- Wi-Fi connection to the PC/hotspot network.
- WebSocket connection to `/device`.
- RC522 initialization and card polling.
- Scan cooldown and held-card suppression.
- Sending scanned UIDs to the server.
- Receiving server-confirmed results.
- LED and buzzer feedback.
- Optional 16x2 LCD status display.
- Serial setup commands for Wi-Fi/server/RFID diagnostics.

## 3. Important Files And Folders

```text
README.md
```

Daily setup/startup instructions.

```text
PROJECT_GUIDE.md
```

This full project explanation.

```text
docs/ARCHITECTURE.md
docs/FEATURE_PARITY.md
docs/MIGRATION.md
docs/TEST_RESULTS.md
```

Existing technical notes, migration details, feature parity notes, and test notes.

```text
server/app.js
```

The main Node.js server. It contains:

- HTTP server.
- Static file serving.
- SQLite schema and persistence helpers.
- Browser API routes.
- Device WebSocket handling.
- Scan processing.
- Backup/restore/report logic.

```text
server/public/checker-ravena.html
```

The browser UI. This is a single HTML file with inline CSS and JavaScript. It renders:

- Dashboard.
- Assignment page.
- Check-in page.
- Add/edit person dialog.
- Event dialogs.
- Tables, pagination, filters, and actions.

```text
server/public/style/
```

UI images/assets:

- Ravena logo image.
- Background image.

```text
server/data/checker-v2.sqlite
```

Runtime SQLite database. This is the live event data. It is ignored by Git and should be backed up when needed.

```text
firmware/src/main.cpp
```

Main ESP32 firmware. Handles Wi-Fi, WebSocket, RC522, serial commands, LEDs, buzzer, and scan sending.

```text
firmware/src/CheckerLcdDisplay.cpp
firmware/include/CheckerLcdDisplay.h
```

Optional LCD display support.

```text
firmware/include/CheckerV2Config.example.h
```

Example firmware config. Copy it to `CheckerV2Config.h` and fill in local Wi-Fi/server values.

```text
firmware/include/CheckerV2Config.h
```

Local firmware config with real Wi-Fi/server details. This should not be committed.

```text
scripts/setup-server.ps1
scripts/start-server.ps1
scripts/diagnostics.ps1
scripts/configure-firmware.ps1
scripts/build-firmware.ps1
scripts/upload-firmware.ps1
```

PowerShell helper scripts for setup, startup, diagnostics, firmware config, build, and upload.

## 4. Runtime Components

### Node.js server

The server is started with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
```

Default host and port:

```text
HOST = 0.0.0.0
PORT = 8080
```

Environment overrides:

```text
CHECKER_HOST
CHECKER_PORT
CHECKER_DB_PATH
```

The server prints:

- PC browser URL, usually `http://localhost:8080`.
- LAN/phone URLs for detected IPv4 adapters.
- ESP server address candidates.

### Browser UI

The browser UI is served from:

```text
http://localhost:8080/
```

The same HTML file is also served for:

```text
/dashboard
/assignment
/check-in
```

The UI polls `/api/status` regularly. If `peopleRev` changes, it reloads `/api/people`.

### ESP32 device

The ESP32 connects to:

```text
ws://PC_IP:8080/device
```

Important: the ESP32 must use the PC hotspot/LAN IPv4 address. It must not use `localhost`, because on the ESP32 `localhost` means the ESP32 itself.

## 5. SQLite Database

Database path:

```text
server/data/checker-v2.sqlite
```

SQLite is opened through Node's `node:sqlite` `DatabaseSync`. The database uses:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

### `state` table

There is one row with `id = 1`.

It stores global event and scanner state:

- `event_id`
- `event_name`
- `event_date`
- `data_rev`
- `state_rev`
- `next_person_num`
- `mode`
- `assign_target_id`
- `fast_queue_json`
- `fast_index`
- `fast_assigned`
- `fast_skipped`
- `undo_available`
- `last_undo_person_id`
- `last_undo_uid`
- `last_physical_result`
- `last_manual_result`
- `storage_status`
- `time_synced`

Two revisions matter:

- `data_rev`: changes when event data changes, such as people, attendance, assignments, imports, restore, etc.
- `state_rev`: changes when scanner mode/state changes, such as check-in mode, assignment mode, or pause.

### `people` table

Stores the roster:

- `id`: person ID like `P1`, `P2`, etc.
- `name`
- `type`: `participant` or `oc`
- `uid`: RFID UID, blank if unassigned.
- `present`
- `time_known`
- `check_in_utc`
- `method`: usually `manual` or `rfid`.
- `rev`

There is a unique partial index:

```sql
CREATE UNIQUE INDEX people_uid_unique ON people(uid) WHERE uid <> '';
```

That means blank UID is allowed for many people, but a real UID can only belong to one person.

### `history` table

Stores recent event history:

- `seq`
- `kind`
- `person_id`
- `uid`
- `method`
- `time_known`
- `utc`
- `rev`

The server keeps a limited history. Current limit:

```text
MAX_HISTORY = 700
```

If the table grows too large, old records are trimmed.

### `scan_events` table

Stores processed physical scan event responses:

- `event_id`
- `boot_id`
- `seq`
- `uid`
- `submitted_state_rev`
- `response_json`
- `created_utc`

This table is used for deduplication. If the ESP retries the same scan event, the server returns the original stored response instead of applying the scan twice.

## 6. Main Business Rules

### People limits

The roster limit is:

```text
MAX_PEOPLE = 400
```

### UID normalization

UIDs are normalized on the server:

- Trim whitespace.
- Remove spaces, colons, and hyphens.
- Convert to uppercase.
- Allow only hexadecimal characters.
- Supported lengths: `8`, `10`, `14`, or `20`.

Example:

```text
04 A1-B2:C3 -> 04A1B2C3
```

### Event modes

Scanner modes:

```text
IDLE
CHECK_IN
ASSIGN_SINGLE
ASSIGN_FAST
```

UI labels:

- `IDLE`: Paused.
- `CHECK_IN`: Check-in active.
- `ASSIGN_SINGLE`: Assigning card.
- `ASSIGN_FAST`: Fast assignment.

### Check-in behavior

Manual and RFID check-in both call server-side attendance logic.

Rules:

- If a person is absent, check-in marks them present.
- Check-in time uses the PC server clock.
- Method is saved as `manual` or `rfid`.
- If a person is already present, repeated check-in does not check them out.
- Repeated check-in returns an "already checked in" style result.
- Unknown RFID card returns a bad result.

### Assignment behavior

Single assignment:

- User chooses a person.
- Server enters `ASSIGN_SINGLE`.
- ESP scans a card.
- Server assigns UID to that person.
- Server returns to `IDLE` after successful assignment.

Fast assignment:

- User starts a queue of unassigned people.
- Scope can be all people, participants, or OC.
- Each scan assigns the card to the current queued person.
- Server advances to the next unassigned person.
- User can skip the current target.
- User can undo the most recent fast assignment if it has not been changed elsewhere.

### Paused-only operations

These require `IDLE` / Paused mode:

- New event.
- CSV import.
- Backup restore.

UID changes are blocked while check-in mode is active.

## 7. Browser API Routes

The browser talks to the server through these routes.

### Status and people

```text
GET /api/status
```

Returns event status, scanner mode, summary counts, recent history, reader state, device diagnostics, revisions, and current assignment target info.

```text
GET /api/people
```

Returns all people and `peopleRev`.

### Event management

```text
POST /api/event
```

Creates or updates the current event name/date.

```text
POST /api/new-event
```

Creates a new empty event. Requires Paused mode.

### People and attendance

```text
POST /api/people/save
```

Adds or edits a person. Can optionally check in the person immediately when `checkIn` is true.

```text
POST /api/checkin
```

Manual check-in by person ID.

```text
POST /api/undo
```

Manual undo for a present person.

### Scanner mode and assignment

```text
POST /api/scanner/mode
```

Changes scanner mode. Uses `stateRev` to reject stale UI actions.

```text
POST /api/assignment/single
```

Starts single-card assignment for a person.

```text
POST /api/assignment/fast/start
```

Starts fast assignment queue.

```text
POST /api/assignment/fast/skip
```

Skips the current fast assignment target.

```text
POST /api/assignment/fast/undo
```

Undoes the last fast assignment if safe.

### Import, export, backup, report

```text
POST /api/import
```

Imports CSV. Requires Paused mode.

Expected CSV headers:

```text
name,type,rfid
```

```text
GET /api/export/people
```

Downloads people CSV.

```text
GET /api/export/attendance
```

Downloads attendance CSV.

```text
GET /api/backup
```

Downloads JSON backup.

```text
POST /api/restore
```

Restores JSON backup. Requires Paused mode.

```text
GET /api/report
```

Returns printable HTML report.

### Diagnostics

```text
GET /api/diagnostics
```

Returns server port, DB path, detected addresses, and device diagnostics.

```text
POST /api/device/recover-reader
```

Asks connected ESP32 to recover/reinitialize the RC522 reader.

## 8. WebSocket Device Protocol

The ESP32 connects to:

```text
/device
```

Transport is JSON messages over WebSocket.

### Device to server

```text
hello
```

Sent after WebSocket connection. Includes device ID, firmware version, boot ID, reader readiness, and diagnostics.

```text
heartbeat
```

Sent regularly. Includes reader status, acknowledged state revision, and diagnostics.

```text
scan
```

Sent after a card is read. Includes:

- `eventId`
- `bootId`
- `seq`
- `uid`
- `mode`
- `stateRev`

### Server to device

```text
hello_ack
```

Confirms protocol version, server time, authoritative mode, state revision, and current ready state.

```text
heartbeat_ack
```

Returns server time and authoritative state.

```text
state
```

Pushed when browser actions change scanner state.

```text
scan_result
```

Returns original event ID, UID, result text, success flag, feedback code, authoritative mode/state revision, and assignment target name.

## 9. Scan Safety Design

### Deduplication

Every physical scan has a unique `eventId`, built from ESP boot identity plus sequence number.

When the server receives a scan:

1. It checks whether `scan_events.event_id` already exists.
2. If yes, it returns the stored `response_json`.
3. If no, it processes the scan transactionally.
4. It stores the response in `scan_events`.

This prevents duplicate attendance or duplicate assignment if the ESP retries a scan.

### Stale state protection

The server keeps `state_rev`.

When browser actions change scanner mode or assignment state, `state_rev` increments.

The ESP includes its acknowledged `stateRev` in every scan. If the ESP sends a scan with an old revision, the server rejects it with a stale-state bad result and does not mutate data.

This protects against cases like:

- User pauses check-in while ESP still thinks check-in is active.
- User changes assignment target while a scan is in flight.
- Device reconnects with outdated mode.

## 10. Frontend UI

The UI is a single file:

```text
server/public/checker-ravena.html
```

It contains:

- HTML markup.
- CSS theme.
- JavaScript API calls.
- Rendering functions.
- Dialog logic.
- Polling loop.

Main pages:

- Dashboard.
- Assignment.
- Check-in.

Dashboard includes:

- Event setup.
- Event summary cards.
- People list with filters and pagination.
- Event tools.
- Backup restore.
- Printable report area.

Assignment includes:

- Add person.
- Import CSV.
- Fast assignment controls.
- Assignment status.
- Assignment roster with search and pagination.

Check-in includes:

- Start/pause check-in.
- Reader status.
- Scan result.
- Summary cards.
- Manual people list with search and pagination.
- Recent attendance.

Important frontend functions:

- `api(path, opt)`: wrapper around `fetch`.
- `poll()`: reloads `/api/status` repeatedly.
- `loadPeople()`: loads `/api/people`.
- `applyStatus(s)`: updates global UI state.
- `renderAll()`: renders all page sections.
- `renderPeople()`, `renderAssign()`, `renderManual()`: list rendering.
- `openPerson()`, `savePerson()`: add/edit person dialog.
- `setMode()`: scanner mode changes.
- `singleAssign()`, `startFast()`, `fastSkip()`, `fastUndo()`: assignment actions.
- `manualIn()`, `undo()`: attendance actions.

## 11. Firmware Details

Main firmware file:

```text
firmware/src/main.cpp
```

### Timing constants

Important values:

```text
SCAN_COOLDOWN_MS = 2000
HELD_CARD_CLEAR_MS = 900
HEARTBEAT_MS = 2000
WIFI_RETRY_MIN_MS = 1000
WIFI_RETRY_MAX_MS = 15000
WS_RETRY_MIN_MS = 1000
WS_RETRY_MAX_MS = 10000
RFID_HEALTH_MS = 3000
RFID_DIAG_MS = 5000
RFID_FAILURES_BEFORE_RECOVER = 3
```

### Hardware pins

Default pins from `CheckerV2Config.example.h`:

```text
RC522 SS: 5
RC522 RST: 22
SPI SCK: 18
SPI MISO: 19
SPI MOSI: 23
Green LED: 26
Red LED: 27
Buzzer: 25
```

Optional LCD:

```text
LCD RS: 21
LCD Enable: 33
LCD DB4: 4
LCD DB5: 14
LCD DB6: 13
LCD DB7: 32
```

### Serial commands

Firmware supports serial commands:

```text
WIFI
SERVER
STATUS
RFIDSTATUS
RFIDRECOVER
CLEARWIFI
HELP
```

Use these for local setup and diagnostics.

### Feedback behavior

The server sends a feedback code with scan results.

Firmware maps that to hardware feedback:

- OK: green pulse and buzzer.
- Already/duplicate-style result: repeated pulse.
- Bad result: red pulse and longer buzzer.
- Unavailable/error: red repeated pulse.

## 12. Network Layout

Recommended runtime:

1. PC enables Windows Mobile Hotspot.
2. Server binds to `0.0.0.0:8080`.
3. Browser opens `http://localhost:8080`.
4. Phone opens one of the printed LAN/hotspot URLs.
5. ESP32 connects to the same hotspot.
6. ESP32 uses the PC hotspot IP, commonly `192.168.137.1`.

Common mistake:

```text
ws://localhost:8080/device
```

This is wrong for firmware. On the ESP32, `localhost` is the ESP32, not the PC.

## 13. Backup And Migration

CheckerV2 keeps CheckerV0 backup schema `1`.

Backup fields include:

- `eventId`
- `eventName`
- `eventDate`
- `offsetMinutes`
- `dataRev`
- `nextPersonNum`
- `timeSynced`
- `timeBaseUtc`
- `people`
- `history`

Migration path from CheckerV0:

1. Open CheckerV0 UI.
2. Download event backup.
3. Start CheckerV2 server.
4. Open CheckerV2 UI.
5. Pause scanner mode.
6. Paste backup JSON into Restore backup.

## 14. Typical Daily Workflow

1. Enable PC Mobile Hotspot.
2. Start the server:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
```

3. Power the ESP32.
4. Open the browser UI.
5. Wait until reader status says reader is ready.
6. Create or load event.
7. Add/import people.
8. Assign RFID cards.
9. Start check-in.
10. Export attendance or print report after the event.
11. Download a backup if the event data matters.

## 15. Development Notes

### Server style

`server/app.js` is intentionally self-contained. There is no large framework. It uses:

- Node HTTP server.
- Manual routing.
- Manual WebSocket upgrade/frame handling.
- SQLite through Node built-in `node:sqlite`.
- Plain static file serving.

This keeps the deployment simple but means code changes should be careful and localized.

### UI style

The frontend is plain HTML/CSS/JS inside one file. There is no build step for the UI.

When changing UI:

- Keep existing API behavior unchanged unless intentionally changing business logic.
- Prefer small changes to rendering functions.
- Avoid changing server routes for display-only improvements.
- Remember that polling calls `renderAll()`, so render functions should be idempotent.

### Firmware style

Firmware is an Arduino/PlatformIO-style ESP32 project.

Local secrets live in:

```text
firmware/include/CheckerV2Config.h
```

Do not commit real hotspot credentials.

## 16. Diagnostics And Troubleshooting

Run diagnostics:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics.ps1
```

Useful checks:

- Server is running.
- Port 8080 is free.
- Browser can load `http://localhost:8080`.
- `/api/diagnostics` returns database and address information.
- ESP32 is connected to same hotspot/LAN as PC.
- Firmware server URL uses PC IP, not localhost.
- Reader pill says reader ready.
- RC522 wiring matches configured pins.
- Serial command `RFIDSTATUS` shows reader diagnostics.
- Serial command `RFIDRECOVER` can reinitialize the reader.

## 17. Current Known Limits

Current server limits:

```text
MAX_PEOPLE = 400
MAX_HISTORY = 700
MAX_IMPORT_BYTES = 40000
MAX_BACKUP_BYTES = 240000
DEVICE_TIMEOUT_MS = 6000
PROTOCOL_VERSION = 1
```

Operational limits:

- No offline attendance buffering is added.
- If the server is down, physical scans cannot be committed.
- Manual check-in remains available from the browser even if the reader is unavailable.
- If ESP power is lost while a scan response is only in memory, that pending retry is lost.
- If the server committed a scan and the ESP retries with the same event ID, the original response is returned.

## 18. Mental Model For Changes

Use this model when deciding where to make changes:

- UI-only display or layout change: edit `server/public/checker-ravena.html`.
- Business rule change: edit `server/app.js`.
- Data persistence/schema change: edit `server/app.js`, then consider migration/backward compatibility.
- Device scan behavior: usually server first, firmware second.
- Hardware pins or Wi-Fi defaults: edit firmware config.
- RC522, LED, buzzer, LCD behavior: edit firmware.
- Startup/build workflow: edit scripts.

The safest default is to keep the PC server as the source of truth and keep the ESP32 as a hardware client.
