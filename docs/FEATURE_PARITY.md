# Feature Parity

Source of truth used: `C:\Users\malek\OneDrive\Bureau\RAVENA\CheckerV0`.

The older `checker` repo was inspected, but its `AGENTS.md` describes a separate web-platform prototype with firmware deferred. CheckerV2 therefore follows the working `CheckerV0` firmware/UI behavior.

| CheckerV0 location | Current behavior | CheckerV2 destination | Verification |
| --- | --- | --- | --- |
| `style/checker-ravena.html` | Dashboard, Assignment, Check-in pages, labels, dialogs, Ravena assets, polling API | `server/public/checker-ravena.html` and `server/public/style/*` | Static page loaded from `http://localhost:8080/` |
| `src/main.cpp:modeName/modeLabel` | Modes: `IDLE`, `CHECK_IN`, `ASSIGN_SINGLE`, `ASSIGN_FAST`; startup `IDLE` | SQLite `state.mode`; same labels in `server/app.js` | `/api/status` returned `Paused`; mode API moved to `CHECK_IN` |
| `src/main.cpp:SCAN_COOLDOWN_MS` | 2000 ms physical scan cooldown | ESP firmware `SCAN_COOLDOWN_MS = 2000` | Firmware compile; physical timing requires hardware |
| `src/main.cpp:HELD_CARD_CLEAR_MS` | Same held UID ignored until card removed for 900 ms | ESP firmware `HELD_CARD_CLEAR_MS = 900` | Firmware compile; physical timing requires hardware |
| `normalizeUid` | Remove spaces, colons, hyphens; uppercase; only hex lengths 8/10/14/20 | `server/app.js normalizeUid`; firmware sends uppercase raw RC522 UID | API saved `04 A1-B2:C3` as `04A1B2C3` |
| `processUid` check-in | Unknown card: `Card not assigned - UID`, bad feedback | Server scan processor, ESP feedback `bad` | Simulated scan can return bad; physical LED requires hardware |
| `checkInPerson` | Present person repeats return `Already checked in - name at time`; no checkout | Server `checkInPerson` | Retry dedupe tested; same V0 message path implemented |
| `assignUidToPerson` | Duplicate UID rejected with card owner name | Server `assignUidToPerson`; SQLite unique UID | Covered by validation path; full UI check pending |
| `ASSIGN_SINGLE` | Assign selected person, then return to `IDLE` and bump `stateRev` | Server scan processor and pushed device state | Implemented; simulator stale-state test covers revision safety |
| `ASSIGN_FAST` | Queue unassigned people by scope; scan assigns and advances; skip and undo supported | Server state queue in SQLite | API routes implemented; hardware scan path not physically tested |
| `handleSavePerson` | Add/edit person; pause required before UID changes while check-in active | `/api/people/save` | Implemented; invalid/race paths partly verified |
| `handleCheckIn` | Manual check-in available independent of reader | `/api/checkin` | Implemented; API exercised by routes |
| `handleUndo` | Manual undo makes person absent and records `undo` history | `/api/undo` | Implemented; full UI click pending |
| `handleImport` | CSV import requires Paused; validates full input; adds people | `/api/import` transaction | Implemented; not exhaustively tested |
| `peopleCsv/attendanceCsv` | Export current people and attendance CSV | `/api/export/people`, `/api/export/attendance` | Implemented; round trip pending |
| `makeSnapshot/loadSnapshotString` | JSON backup schema 1 with people/history/state metadata | `/api/backup`, `/api/restore` | Format preserved; restore path implemented |
| `handleReport` | HTML report summary and table | `/api/report` | Implemented |
| `feedbackOk` | Green pulse once, buzzer once | ESP firmware | Compiled; physical LED/buzzer not observed |
| `feedbackAlready` | Green pulse twice, buzzer twice | ESP firmware | Compiled; physical LED/buzzer not observed |
| `feedbackBad` | Red pulse once, longer buzzer | ESP firmware | Compiled; physical LED/buzzer not observed |
| `handleSerial` | Serial snapshot/time helper | Moved to PC backup/restore and PC clock | Unavoidable architecture change; no ESP database remains |
| LittleFS web/data hosting | ESP served UI and stored JSON snapshot | Removed from ESP; PC serves UI and SQLite | Server verified |

Important exact rules preserved:

- Startup mode is Paused/`IDLE`.
- Manual attendance remains available when device is unavailable.
- CSV import, restore, and new event require Paused.
- UID changes are blocked while check-in mode is active.
- Repeated check-in does not check out.
- Fast assignment undo only applies to the most recent assignment and detects conflicts.
- Browser state changes use `stateRev` to reject stale operations.

Unavoidable changes:

- New records use the PC clock and are treated as known time.
- Device status is based on WebSocket heartbeat instead of local RC522 state inside the web server.
- ESP serial backup commands are replaced by PC backup/restore routes.
