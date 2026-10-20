# Architecture

## Responsibilities

The PC server owns:

- Static Ravena UI and assets copied from `CheckerV0/style`.
- Existing browser API paths under `/api`.
- Business rules for event setup, people, UID assignment, check-in, undo, CSV, backup, restore, report, and scanner modes.
- SQLite persistence in `server/data/checker-v2.sqlite`.
- Device connection state and scan deduplication.

The ESP32 owns:

- RC522 initialization and reads.
- Wi-Fi client connection to the PC/hotspot network.
- WebSocket connection to `ws://PC_IP:PORT/device`.
- LED and buzzer feedback after server-confirmed outcomes.
- Retry of one in-flight scan while powered.

## Network Layout

The PC should bind to `0.0.0.0` so localhost, LAN, and hotspot clients can reach it. The server prints usable URLs at startup.

The ESP must use the PC hotspot/LAN IPv4 address. It must not use `localhost`.

## Protocol

Transport: WebSocket initiated by ESP at `/device`.

Messages:

- `hello`: device ID, firmware version, boot ID, reader readiness.
- `hello_ack`: protocol version, server UTC, authoritative mode, state revision, ready flag.
- `heartbeat`: reader status, acknowledged mode/state revision.
- `heartbeat_ack`: server UTC and current authoritative state.
- `state`: pushed by server when browser actions change scanner state.
- `scan`: unique event ID, boot ID, sequence, UID, mode, acknowledged state revision.
- `scan_result`: original event ID, result text, success flag, feedback code, authoritative state revision.

The server is authoritative for mode, selected assignment target, people lookup, assignment validation, attendance mutation, and persistence.

## Deduplication

Every scan has a unique `eventId` built from ESP boot ID plus sequence number. The server stores the scan response transactionally in SQLite. Retrying the same event ID returns the original response and does not repeat the mutation.

This is separate from CheckerV0's physical duplicate handling: the ESP still preserves the 2 second cooldown and held-card suppression.

## Stale State Protection

Browser mode/assignment changes increment `stateRev`. The ESP includes its acknowledged `stateRev` in every scan. If a scan arrives with an obsolete revision, the server returns a stale/bad result and does not apply it.

## Restart Behavior

Server restart preserves the SQLite database and starts in the persisted scanner mode. Device status becomes unavailable until the ESP reconnects and handshakes. No offline attendance buffering is added.

If the ESP loses power while a scan response is in flight, the in-memory retry is lost. If the server had already committed the scan and the ESP retries with the same event ID before power loss, the original result is returned.
