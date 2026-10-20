# Migration

## Safe Path From CheckerV0

Do not flash CheckerV2 firmware until the existing CheckerV0 event data is backed up if it is the only live copy.

Preferred backup options from CheckerV0:

1. Open the CheckerV0 web UI at `http://192.168.4.1`.
2. Use **Download event backup**.
3. Start CheckerV2 server.
4. Paste that JSON into **Restore backup** while Paused.

Serial backup is also available in CheckerV0 firmware through the existing `CHECKER SNAPSHOT` command, but the browser backup is simpler.

## Backup Format

CheckerV2 preserves CheckerV0 backup schema `1`:

- `eventId`
- `eventName`
- `eventDate`
- `offsetMinutes`
- `dataRev`
- `nextPersonNum`
- `timeSynced`
- `timeBaseUtc`
- `people[]`
- `history[]`

People IDs, UID normalization, attendance fields, history records, and revisions are preserved.

## Database Location

Runtime database:

```text
server/data/checker-v2.sqlite
```

This path is ignored by Git. Back it up like any other local event data.

## Rollback

CheckerV2 does not modify CheckerV0. To roll back, power the old ESP firmware/device and use the existing CheckerV0 flow. If you already flashed CheckerV2 to the ESP, rebuild/upload CheckerV0 from the original `CheckerV0` folder.

## Firmware Credentials

Credentials are stored locally in:

```text
firmware/include/CheckerV2Config.h
```

This file is ignored by Git. Use `scripts/configure-firmware.ps1` to update it without printing the password.
