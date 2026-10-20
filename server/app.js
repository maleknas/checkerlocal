#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.CHECKER_DB_PATH || path.join(DATA_DIR, "checker-v2.sqlite");
const HOST = process.env.CHECKER_HOST || "0.0.0.0";
const PORT = Number(process.env.CHECKER_PORT || 8080);
const MAX_PEOPLE = 400;
const MAX_HISTORY = 700;
const MAX_IMPORT_BYTES = 40000;
const MAX_BACKUP_BYTES = 240000;
const DEVICE_TIMEOUT_MS = 6000;
const PROTOCOL_VERSION = 1;

const MODES = new Set(["IDLE", "CHECK_IN", "ASSIGN_SINGLE", "ASSIGN_FAST"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_id TEXT NOT NULL DEFAULT '',
  event_name TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL DEFAULT '',
  data_rev INTEGER NOT NULL DEFAULT 1,
  state_rev INTEGER NOT NULL DEFAULT 1,
  next_person_num INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'IDLE',
  assign_target_id TEXT NOT NULL DEFAULT '',
  fast_queue_json TEXT NOT NULL DEFAULT '[]',
  fast_index INTEGER NOT NULL DEFAULT 0,
  fast_assigned INTEGER NOT NULL DEFAULT 0,
  fast_skipped INTEGER NOT NULL DEFAULT 0,
  undo_available INTEGER NOT NULL DEFAULT 0,
  last_undo_person_id TEXT NOT NULL DEFAULT '',
  last_undo_uid TEXT NOT NULL DEFAULT '',
  last_physical_result TEXT NOT NULL DEFAULT '',
  last_manual_result TEXT NOT NULL DEFAULT '',
  storage_status TEXT NOT NULL DEFAULT 'Loaded',
  time_synced INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('participant','oc')),
  uid TEXT NOT NULL DEFAULT '',
  present INTEGER NOT NULL DEFAULT 0,
  time_known INTEGER NOT NULL DEFAULT 0,
  check_in_utc INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS people_uid_unique ON people(uid) WHERE uid <> '';
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  person_id TEXT NOT NULL,
  uid TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  time_known INTEGER NOT NULL DEFAULT 1,
  utc INTEGER NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_events (
  event_id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  uid TEXT NOT NULL,
  submitted_state_rev INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_utc INTEGER NOT NULL
);
INSERT OR IGNORE INTO state(id) VALUES (1);
`);

function one(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function readState() {
  const s = one("SELECT * FROM state WHERE id = 1");
  return {
    eventId: s.event_id,
    eventName: s.event_name,
    eventDate: s.event_date,
    dataRev: s.data_rev,
    stateRev: s.state_rev,
    nextPersonNum: s.next_person_num,
    mode: s.mode,
    assignTargetId: s.assign_target_id,
    fastQueue: JSON.parse(s.fast_queue_json || "[]"),
    fastIndex: s.fast_index,
    fastAssigned: s.fast_assigned,
    fastSkipped: s.fast_skipped,
    undoAvailable: !!s.undo_available,
    lastUndoPersonId: s.last_undo_person_id,
    lastUndoUid: s.last_undo_uid,
    lastPhysicalResult: s.last_physical_result,
    lastManualResult: s.last_manual_result,
    storageStatus: s.storage_status,
    timeSynced: !!s.time_synced,
  };
}

function writeState(s) {
  run(`UPDATE state SET event_id=?, event_name=?, event_date=?, data_rev=?, state_rev=?, next_person_num=?,
    mode=?, assign_target_id=?, fast_queue_json=?, fast_index=?, fast_assigned=?, fast_skipped=?,
    undo_available=?, last_undo_person_id=?, last_undo_uid=?, last_physical_result=?, last_manual_result=?,
    storage_status=?, time_synced=? WHERE id=1`, [
    s.eventId, s.eventName, s.eventDate, s.dataRev, s.stateRev, s.nextPersonNum,
    s.mode, s.assignTargetId, JSON.stringify(s.fastQueue), s.fastIndex, s.fastAssigned, s.fastSkipped,
    s.undoAvailable ? 1 : 0, s.lastUndoPersonId, s.lastUndoUid, s.lastPhysicalResult, s.lastManualResult,
    s.storageStatus, s.timeSynced ? 1 : 0,
  ]);
}

function peopleRows() {
  return all("SELECT * FROM people ORDER BY CAST(SUBSTR(id,2) AS INTEGER), id").map(mapPerson);
}

function mapPerson(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    uid: r.uid || "",
    present: !!r.present,
    timeKnown: !!r.time_known,
    checkInUtc: r.check_in_utc,
    method: r.method || "",
    rev: r.rev,
  };
}

function trimCopy(value) { return String(value ?? "").trim(); }
function modeLabel(mode) {
  if (mode === "CHECK_IN") return "Check-in active";
  if (mode === "ASSIGN_SINGLE") return "Assigning card";
  if (mode === "ASSIGN_FAST") return "Fast assignment";
  return "Paused";
}
function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}
function csvEscape(s) {
  const out = String(s ?? "").replace(/"/g, "\"\"");
  return /[",\r\n]/.test(out) ? `"${out}"` : out;
}
function normalizeUid(uid) {
  const out = String(uid ?? "").trim().replace(/[ :\-]/g, "").toUpperCase();
  if (!out) return "";
  if (!/^[0-9A-F]+$/.test(out)) return "";
  return [8, 10, 14, 20].includes(out.length) ? out : "";
}
function nowUtc() { return Math.floor(Date.now() / 1000); }
function localTimeText(known, utc) {
  if (!known) return "Time unavailable";
  const d = new Date(Number(utc) * 1000);
  const pad = value => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function ensureEventId(s) {
  if (!s.eventId) s.eventId = `E${crypto.randomBytes(4).toString("hex")}`;
}
function bumpData(s) { s.dataRev += 1; }
function bumpState(s) { s.stateRev += 1; }
function findPersonById(id) { const r = one("SELECT * FROM people WHERE id=?", [id]); return r ? mapPerson(r) : null; }
function findPersonByUid(uid) { const r = uid ? one("SELECT * FROM people WHERE uid=?", [uid]) : null; return r ? mapPerson(r) : null; }
function uidOwnerName(uid, ignoreId) {
  const p = findPersonByUid(uid);
  return p && p.id !== ignoreId ? p.name : "";
}
function savePersonRow(p) {
  run(`INSERT INTO people(id,name,type,uid,present,time_known,check_in_utc,method,rev)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,uid=excluded.uid,present=excluded.present,
       time_known=excluded.time_known,check_in_utc=excluded.check_in_utc,method=excluded.method,rev=excluded.rev`, [
    p.id, p.name, p.type, p.uid || "", p.present ? 1 : 0, p.timeKnown ? 1 : 0, p.checkInUtc || 0, p.method || "", p.rev || 1,
  ]);
}
function addHistory(s, kind, personId, uid, method, known, utc) {
  run("INSERT INTO history(kind,person_id,uid,method,time_known,utc,rev) VALUES(?,?,?,?,?,?,?)", [
    kind, personId, uid || "", method || "", known ? 1 : 0, utc, s.dataRev,
  ]);
  const count = one("SELECT COUNT(*) AS c FROM history").c;
  if (count > MAX_HISTORY) {
    run("DELETE FROM history WHERE seq IN (SELECT seq FROM history ORDER BY seq LIMIT 100)");
  }
}
function summary() {
  const people = peopleRows();
  const s = { total: people.length, present: 0, absent: 0, partTotal: 0, partPresent: 0, ocTotal: 0, ocPresent: 0, assigned: 0, unassigned: 0 };
  for (const p of people) {
    if (p.present) s.present += 1;
    if (p.uid) s.assigned += 1; else s.unassigned += 1;
    if (p.type === "oc") { s.ocTotal += 1; if (p.present) s.ocPresent += 1; }
    else { s.partTotal += 1; if (p.present) s.partPresent += 1; }
  }
  s.absent = s.total - s.present;
  return s;
}
function recentRows() {
  return all("SELECT * FROM history ORDER BY seq DESC LIMIT 8").reverse().map(h => {
    const p = findPersonById(h.person_id);
    return `${h.kind} - ${p ? p.name : h.person_id} - ${localTimeText(!!h.time_known, h.utc)}`;
  });
}

const devices = new Map();
function connectedDevice() {
  let newest = null;
  for (const d of devices.values()) {
    if (!newest || d.lastSeen > newest.lastSeen) newest = d;
  }
  return newest;
}
function deviceDiagnostics(d) {
  if (!d) return null;
  return {
    id: d.deviceId,
    connected: Date.now() - d.lastSeen <= DEVICE_TIMEOUT_MS,
    readerReady: !!d.readerReady,
    readerStatus: d.readerStatus || "",
    lastHeartbeat: d.lastSeenIso,
    ip: d.ip,
    rfidPollCount: d.rfidPollCount || 0,
    rfidBlockedCount: d.rfidBlockedCount || 0,
    rfidBlockReason: d.rfidBlockReason || "",
    rfidReadAttempts: d.rfidReadAttempts || 0,
    rfidReadSuccess: d.rfidReadSuccess || 0,
    rfidRecoveries: d.rfidRecoveries || 0,
    rfidFailureCount: d.rfidFailureCount || 0,
    rfidVersion: d.rfidVersion || "",
    lastGoodRfidMs: d.lastGoodRfidMs || 0,
    lastSuccessfulUid: d.lastSuccessfulUid || "",
    lastSuccessfulCardMs: d.lastSuccessfulCardMs || 0,
    cardHeld: !!d.cardHeld,
    pendingScan: !!d.pendingScan,
    cooldownRemainingMs: d.cooldownRemainingMs || 0,
  };
}
function deviceReady() {
  const d = connectedDevice();
  return !!(d && Date.now() - d.lastSeen <= DEVICE_TIMEOUT_MS && d.readerReady);
}
function readerStatus() {
  const d = connectedDevice();
  if (!d || Date.now() - d.lastSeen > DEVICE_TIMEOUT_MS) return "Device unavailable - manual check-in available";
  return d.readerReady ? "Reader ready" : (d.readerStatus || "Reader unavailable - manual check-in available");
}
function readyText(s) {
  if (!deviceReady()) return "Reader unavailable - manual check-in available";
  return ["CHECK_IN", "ASSIGN_SINGLE", "ASSIGN_FAST"].includes(s.mode) ? "Ready to scan" : "Paused";
}
function statusJson() {
  const s = readState();
  const st = {
    ok: true,
    eventId: s.eventId,
    eventName: s.eventName,
    eventDate: s.eventDate,
    mode: s.mode,
    modeLabel: modeLabel(s.mode),
    stateRev: s.stateRev,
    peopleRev: s.dataRev,
    readerReady: deviceReady(),
    readerStatus: readerStatus(),
    storageStatus: s.storageStatus,
    lastPhysicalResult: s.lastPhysicalResult,
    lastManualResult: s.lastManualResult,
    timeSynced: true,
    bootId: "pc",
    readyText: readyText(s),
    fastIndex: s.fastIndex,
    fastTotal: s.fastQueue.length,
    fastAssigned: s.fastAssigned,
    fastSkipped: s.fastSkipped,
    summary: summary(),
    recent: recentRows(),
    device: deviceDiagnostics(connectedDevice()),
  };
  if (s.mode === "ASSIGN_SINGLE") {
    const p = findPersonById(s.assignTargetId);
    st.assignName = p ? p.name : "";
  } else if (s.mode === "ASSIGN_FAST" && s.fastIndex < s.fastQueue.length) {
    const p = findPersonById(s.fastQueue[s.fastIndex]);
    st.assignName = p ? p.name : "";
  }
  return st;
}

function currentAssignName(s) {
  if (s.mode === "ASSIGN_SINGLE") {
    const p = findPersonById(s.assignTargetId);
    return p ? p.name : "";
  }
  if (s.mode === "ASSIGN_FAST" && s.fastIndex < s.fastQueue.length) {
    const p = findPersonById(s.fastQueue[s.fastIndex]);
    return p ? p.name : "";
  }
  return "";
}

function ok(reply, body, code = 200, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  reply.writeHead(code, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", ...headers });
  reply.end(payload);
}
function jsonError(reply, message, code = 400) { ok(reply, { ok: false, error: message }, code); }
function readBody(req, limit = MAX_BACKUP_BYTES) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
function parseJson(body) {
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new Error("Invalid JSON"); }
}

function checkInPerson(s, p, method) {
  if (!p) return { ok: false, result: "Person not found" };
  if (p.present) {
    return { ok: true, changed: false, result: `Already checked in - ${p.name} at ${localTimeText(p.timeKnown, p.checkInUtc)}`, feedback: "already" };
  }
  const utc = nowUtc();
  p.present = true;
  p.timeKnown = true;
  p.checkInUtc = utc;
  p.method = method;
  p.rev += 1;
  bumpData(s);
  savePersonRow(p);
  addHistory(s, "check-in", p.id, p.uid, method, true, utc);
  return { ok: true, changed: true, result: `Checked in - ${p.name} (${p.type === "oc" ? "OC" : "Participant"})`, feedback: "ok" };
}

function assignUidToPerson(s, p, uid) {
  if (!p) return { ok: false, result: "Assignment target not found", feedback: "bad" };
  if (!uid) return { ok: false, result: "Invalid UID", feedback: "bad" };
  const owner = uidOwnerName(uid, p.id);
  if (owner) return { ok: false, result: `Card already assigned to ${owner}`, feedback: "bad" };
  p.uid = uid;
  p.rev += 1;
  bumpData(s);
  savePersonRow(p);
  addHistory(s, "assign", p.id, uid, "", true, nowUtc());
  return { ok: true, changed: true, result: `Assigned ${uid} to ${p.name}`, feedback: "ok" };
}

function processScan(input) {
  return tx(() => {
    const eventId = String(input.eventId || "");
    const existing = eventId ? one("SELECT response_json FROM scan_events WHERE event_id=?", [eventId]) : null;
    if (existing) return JSON.parse(existing.response_json);

    const s = readState();
    const uid = normalizeUid(input.uid || "");
    let result = { ok: false, result: "Invalid UID", feedback: "bad", stateRev: s.stateRev };
    if (!eventId || !uid) {
      result = { ok: false, result: "Invalid scan event", feedback: "bad", stateRev: s.stateRev };
    } else if (Number(input.stateRev) !== s.stateRev) {
      result = { ok: false, result: "Scanner state changed; refresh and try again", feedback: "bad", stale: true, stateRev: s.stateRev };
    } else if (s.mode === "CHECK_IN") {
      const p = findPersonByUid(uid);
      if (!p) result = { ok: false, result: `Card not assigned - ${uid}`, feedback: "bad", stateRev: s.stateRev };
      else result = { ...checkInPerson(s, p, "rfid"), stateRev: s.stateRev };
    } else if (s.mode === "ASSIGN_SINGLE") {
      const p = findPersonById(s.assignTargetId);
      const assigned = assignUidToPerson(s, p, uid);
      result = { ...assigned, stateRev: s.stateRev };
      if (assigned.ok) {
        s.mode = "IDLE";
        s.assignTargetId = "";
        bumpState(s);
        result.stateRev = s.stateRev;
      }
    } else if (s.mode === "ASSIGN_FAST") {
      if (s.fastIndex >= s.fastQueue.length) {
        s.mode = "IDLE";
        s.lastPhysicalResult = "Fast assignment complete";
        bumpState(s);
        result = { ok: true, result: s.lastPhysicalResult, feedback: "bad", stateRev: s.stateRev };
      } else {
        const p = findPersonById(s.fastQueue[s.fastIndex]);
        const assigned = assignUidToPerson(s, p, uid);
        result = { ...assigned, stateRev: s.stateRev };
        if (assigned.ok) {
          s.lastUndoPersonId = p.id;
          s.lastUndoUid = uid;
          s.undoAvailable = true;
          s.fastAssigned += 1;
          s.fastIndex += 1;
          while (s.fastIndex < s.fastQueue.length) {
            const n = findPersonById(s.fastQueue[s.fastIndex]);
            if (n && !n.uid) break;
            s.fastIndex += 1;
          }
          if (s.fastIndex >= s.fastQueue.length) {
            result.result += " - queue finished";
            s.mode = "IDLE";
            bumpState(s);
            result.stateRev = s.stateRev;
          }
        }
      }
    } else {
      result = { ok: false, result: "Paused", feedback: "bad", stateRev: s.stateRev };
    }
    s.lastPhysicalResult = result.result;
    s.storageStatus = "Saved";
    writeState(s);
    const assignName = currentAssignName(s);
    const response = { type: "scan_result", eventId, uid, mode: s.mode, stateRev: s.stateRev, result: result.result, ok: !!result.ok, feedback: result.feedback || "bad", stale: !!result.stale, assignName, assignTargetName: assignName };
    run("INSERT INTO scan_events(event_id,boot_id,seq,uid,submitted_state_rev,response_json,created_utc) VALUES(?,?,?,?,?,?,?)", [
      eventId, String(input.bootId || ""), Number(input.seq || 0), uid, Number(input.stateRev || 0), JSON.stringify(response), nowUtc(),
    ]);
    return response;
  });
}

function makeSnapshot() {
  const s = readState();
  return {
    schema: 1,
    eventId: s.eventId,
    eventName: s.eventName,
    eventDate: s.eventDate,
    offsetMinutes: -new Date().getTimezoneOffset(),
    dataRev: s.dataRev,
    nextPersonNum: s.nextPersonNum,
    timeSynced: true,
    timeBaseUtc: nowUtc(),
    people: peopleRows().map(p => ({
      id: p.id, name: p.name, type: p.type, uid: p.uid, present: p.present,
      timeKnown: p.timeKnown, checkInUtc: p.checkInUtc, method: p.method, rev: p.rev,
    })),
    history: all("SELECT * FROM history ORDER BY seq").map(h => ({
      kind: h.kind, personId: h.person_id, uid: h.uid, method: h.method,
      timeKnown: !!h.time_known, utc: h.utc, rev: h.rev,
    })),
  };
}

function restoreSnapshot(snapshot) {
  if (snapshot.schema !== 1) throw new Error("Unsupported backup schema");
  const rows = Array.isArray(snapshot.people) ? snapshot.people : [];
  if (rows.length > MAX_PEOPLE) throw new Error("Backup has too many people");
  const seenUid = new Set();
  let maxNum = 0;
  const people = rows.map(o => {
    const p = {
      id: String(o.id || ""),
      name: trimCopy(o.name),
      type: String(o.type || ""),
      uid: normalizeUid(o.uid || ""),
      present: !!o.present,
      timeKnown: !!o.timeKnown,
      checkInUtc: Number(o.checkInUtc || 0),
      method: String(o.method || ""),
      rev: Number(o.rev || 1),
    };
    if (!p.id || !p.name || !["participant", "oc"].includes(p.type)) throw new Error("Invalid person in backup");
    if (p.uid) {
      if (seenUid.has(p.uid)) throw new Error("Duplicate UID in backup");
      seenUid.add(p.uid);
    }
    if (/^P\d+$/.test(p.id)) maxNum = Math.max(maxNum, Number(p.id.slice(1)));
    return p;
  });
  tx(() => {
    db.exec("DELETE FROM scan_events; DELETE FROM history; DELETE FROM people;");
    for (const p of people) savePersonRow(p);
    const hist = Array.isArray(snapshot.history) ? snapshot.history.slice(-MAX_HISTORY) : [];
    const s = readState();
    s.eventId = String(snapshot.eventId || "");
    s.eventName = String(snapshot.eventName || "");
    s.eventDate = String(snapshot.eventDate || "");
    s.dataRev = Number(snapshot.dataRev || 1);
    s.nextPersonNum = Math.max(Number(snapshot.nextPersonNum || 1), maxNum + 1);
    s.mode = "IDLE";
    s.assignTargetId = "";
    s.fastQueue = [];
    s.fastIndex = s.fastAssigned = s.fastSkipped = 0;
    s.undoAvailable = false;
    s.lastUndoPersonId = "";
    s.lastUndoUid = "";
    s.lastPhysicalResult = "";
    s.lastManualResult = "";
    s.storageStatus = "Saved";
    bumpState(s);
    writeState(s);
    for (const h of hist) {
      run("INSERT INTO history(kind,person_id,uid,method,time_known,utc,rev) VALUES(?,?,?,?,?,?,?)", [
        String(h.kind || ""), String(h.personId || ""), String(h.uid || ""), String(h.method || ""),
        h.timeKnown ? 1 : 0, Number(h.utc || 0), Number(h.rev || 0),
      ]);
    }
  });
}

function csvParseLine(line, delim) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === "\"" && line[i + 1] === "\"") { cell += "\""; i += 1; }
      else if (c === "\"") quoted = false;
      else cell += c;
    } else if (c === "\"") quoted = true;
    else if (c === delim) { cells.push(cell); cell = ""; }
    else cell += c;
  }
  cells.push(cell);
  return cells;
}

async function apiRoute(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/status") return ok(res, statusJson());
  if (req.method === "GET" && pathname === "/api/people") {
    const s = readState();
    const people = peopleRows().map(p => ({ ...p, timeText: p.present ? localTimeText(p.timeKnown, p.checkInUtc) : "" }));
    return ok(res, { ok: true, peopleRev: s.dataRev, people });
  }
  if (req.method === "POST" && pathname === "/api/event") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      const name = trimCopy(body.name);
      const date = trimCopy(body.date);
      if (!name || name.length > 80) throw Object.assign(new Error("Event name is required"), { code: 400 });
      ensureEventId(s);
      s.eventName = name; s.eventDate = date; bumpData(s); bumpState(s); s.storageStatus = "Saved";
      writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/new-event") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      if (s.mode !== "IDLE") throw Object.assign(new Error("Start new event is available only while Paused"), { code: 400 });
      const name = trimCopy(body.name);
      if (!name) throw Object.assign(new Error("New event name is required"), { code: 400 });
      db.exec("DELETE FROM scan_events; DELETE FROM history; DELETE FROM people;");
      s.eventId = `E${crypto.randomBytes(4).toString("hex")}`;
      s.eventName = name; s.eventDate = trimCopy(body.date); s.nextPersonNum = 1;
      s.fastQueue = []; s.fastIndex = s.fastAssigned = s.fastSkipped = 0; s.undoAvailable = false;
      bumpData(s); bumpState(s); s.storageStatus = "Saved"; writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/people/save") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      const id = String(body.id || "");
      const name = trimCopy(body.name);
      const type = String(body.type || "");
      const uidRaw = String(body.uid || "");
      const uid = uidRaw ? normalizeUid(uidRaw) : "";
      if (!name || name.length > 80) throw Object.assign(new Error("Name is required and must be 80 characters or fewer"), { code: 400 });
      if (!["participant", "oc"].includes(type)) throw Object.assign(new Error("Type must be participant or oc"), { code: 400 });
      if (uidRaw && !uid) throw Object.assign(new Error("RFID UID must be uppercase hexadecimal after removing spaces/colons and have a supported length"), { code: 400 });
      const owner = uidOwnerName(uid, id);
      if (owner) throw Object.assign(new Error(`Card already assigned to ${owner}`), { code: 409 });
      let p = id ? findPersonById(id) : null;
      if (!p) {
        if (one("SELECT COUNT(*) AS c FROM people").c >= MAX_PEOPLE) throw Object.assign(new Error("People limit reached"), { code: 400 });
        p = { id: `P${s.nextPersonNum++}`, name, type, uid, present: false, timeKnown: false, checkInUtc: 0, method: "", rev: 1 };
      } else {
        if (p.uid !== uid && s.mode === "CHECK_IN") throw Object.assign(new Error("Pause RFID check-in before changing a card"), { code: 409 });
        p.name = name; p.type = type; p.uid = uid; p.rev += 1;
      }
      savePersonRow(p); bumpData(s);
      if (body.checkIn && !p.present) {
        const checked = checkInPerson(s, p, "manual");
        s.lastManualResult = checked.result;
      }
      s.storageStatus = "Saved"; writeState(s);
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/checkin") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      const checked = checkInPerson(s, findPersonById(String(body.id || "")), "manual");
      if (!checked.ok) throw Object.assign(new Error(checked.result), { code: 500 });
      s.lastManualResult = checked.result; s.storageStatus = "Saved"; writeState(s);
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/undo") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      const p = findPersonById(String(body.id || ""));
      if (!p) throw Object.assign(new Error("Person not found"), { code: 400 });
      if (!p.present) throw Object.assign(new Error("Person is already absent"), { code: 400 });
      p.present = false; p.timeKnown = false; p.checkInUtc = 0; p.method = ""; p.rev += 1;
      savePersonRow(p); bumpData(s); addHistory(s, "undo", p.id, p.uid, "manual", true, nowUtc());
      s.lastManualResult = `Undo check-in - ${p.name}`; s.storageStatus = "Saved"; writeState(s);
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/scanner/mode") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      if (Number(body.stateRev ?? s.stateRev) !== s.stateRev) throw Object.assign(new Error("Scanner state changed; refresh and try again"), { code: 409 });
      s.mode = MODES.has(body.mode) ? body.mode : "IDLE";
      if (s.mode === "IDLE") { s.assignTargetId = ""; s.fastQueue = []; s.fastIndex = s.fastAssigned = s.fastSkipped = 0; s.undoAvailable = false; }
      s.lastPhysicalResult = ""; bumpState(s); writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/assignment/single") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      if (Number(body.stateRev ?? s.stateRev) !== s.stateRev) throw Object.assign(new Error("Scanner state changed; refresh and try again"), { code: 409 });
      const p = findPersonById(String(body.id || ""));
      if (!p) throw Object.assign(new Error("Person not found"), { code: 400 });
      s.mode = "ASSIGN_SINGLE"; s.assignTargetId = p.id; s.fastQueue = []; s.lastPhysicalResult = `Ready - scan card for ${p.name}`;
      bumpState(s); writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/assignment/fast/start") {
    const body = parseJson(await readBody(req));
    return ok(res, tx(() => {
      const s = readState();
      if (Number(body.stateRev ?? s.stateRev) !== s.stateRev) throw Object.assign(new Error("Scanner state changed; refresh and try again"), { code: 409 });
      const scope = String(body.scope || "all");
      const queue = peopleRows().filter(p => !p.uid && (scope === "all" || p.type === scope)).map(p => p.id);
      if (!queue.length) throw Object.assign(new Error("No unassigned people match this scope"), { code: 400 });
      s.mode = "ASSIGN_FAST"; s.fastQueue = queue; s.fastIndex = s.fastAssigned = s.fastSkipped = 0; s.undoAvailable = false; s.lastPhysicalResult = "Fast assignment ready";
      bumpState(s); writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/assignment/fast/skip") {
    return ok(res, tx(() => {
      const s = readState();
      if (s.mode !== "ASSIGN_FAST") throw Object.assign(new Error("No active fast assignment"), { code: 400 });
      if (s.fastIndex < s.fastQueue.length) { s.fastSkipped += 1; s.fastIndex += 1; }
      if (s.fastIndex >= s.fastQueue.length) { s.mode = "IDLE"; bumpState(s); s.lastPhysicalResult = "Fast assignment finished"; }
      writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/assignment/fast/undo") {
    return ok(res, tx(() => {
      const s = readState();
      if (s.mode !== "ASSIGN_FAST" || !s.undoAvailable) throw Object.assign(new Error("Nothing to undo"), { code: 400 });
      const p = findPersonById(s.lastUndoPersonId);
      if (!p || p.uid !== s.lastUndoUid) { s.undoAvailable = false; writeState(s); throw Object.assign(new Error("Undo conflict: assignment changed"), { code: 400 }); }
      p.uid = ""; p.rev += 1; savePersonRow(p); bumpData(s); addHistory(s, "unassign", p.id, s.lastUndoUid, "", true, nowUtc());
      if (s.fastAssigned) s.fastAssigned -= 1;
      if (s.fastIndex > 0) s.fastIndex -= 1;
      s.fastQueue[s.fastIndex] = p.id; s.undoAvailable = false; s.lastPhysicalResult = `Undid assignment for ${p.name}`;
      s.storageStatus = "Saved"; writeState(s); sendStateToDevices();
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/time") {
    return ok(res, tx(() => {
      const s = readState();
      bumpData(s); s.timeSynced = true; s.storageStatus = "Saved"; writeState(s);
      return { ok: true, status: statusJson() };
    }));
  }
  if (req.method === "POST" && pathname === "/api/import") {
    const text = await readBody(req, MAX_IMPORT_BYTES);
    return ok(res, tx(() => {
      const s = readState();
      if (s.mode !== "IDLE") throw Object.assign(new Error("CSV import requires Paused"), { code: 400 });
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
      const delim = normalized.includes(";") && !normalized.includes(",") ? ";" : ",";
      const additions = [];
      const existing = new Set(peopleRows().map(p => p.uid).filter(Boolean));
      let lineNo = 0;
      for (const line of normalized.split("\n")) {
        lineNo += 1;
        if (!line) continue;
        const c = csvParseLine(line, delim);
        if (lineNo === 1 && c[0] && c[0].toLowerCase() === "name") continue;
        const name = trimCopy(c[0]);
        let type = trimCopy(c[1] || "participant").toLowerCase() || "participant";
        const rawUid = trimCopy(c[2] || "");
        const uid = rawUid ? normalizeUid(rawUid) : "";
        if (!name) throw Object.assign(new Error(`CSV row ${lineNo}: name is required`), { code: 400 });
        if (!["participant", "oc"].includes(type)) throw Object.assign(new Error(`CSV row ${lineNo}: invalid type`), { code: 400 });
        if (rawUid && !uid) throw Object.assign(new Error(`CSV row ${lineNo}: invalid RFID`), { code: 400 });
        if (uid && existing.has(uid)) throw Object.assign(new Error(`CSV row ${lineNo}: RFID already exists in roster`), { code: 400 });
        if (uid && additions.some(p => p.uid === uid)) throw Object.assign(new Error(`CSV row ${lineNo}: duplicate RFID in file`), { code: 400 });
        additions.push({ name, type, uid });
        if (one("SELECT COUNT(*) AS c FROM people").c + additions.length > MAX_PEOPLE) throw Object.assign(new Error("Import would exceed people limit"), { code: 400 });
      }
      for (const a of additions) savePersonRow({ id: `P${s.nextPersonNum++}`, ...a, present: false, timeKnown: false, checkInUtc: 0, method: "", rev: 1 });
      bumpData(s); s.storageStatus = "Saved"; writeState(s);
      return { ok: true, message: `Imported ${additions.length} people`, status: statusJson() };
    }));
  }
  if (req.method === "GET" && pathname === "/api/export/people") {
    const csv = "name,type,rfid\r\n" + peopleRows().map(p => `${csvEscape(p.name)},${p.type},${p.uid}`).join("\r\n") + "\r\n";
    return ok(res, csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=checker-people.csv" });
  }
  if (req.method === "GET" && pathname === "/api/export/attendance") {
    const csv = "name,type,rfid,attendance,check_in_time,method,time_quality\r\n" + peopleRows().map(p =>
      `${csvEscape(p.name)},${p.type},${p.uid},${p.present ? "present" : "absent"},${p.present ? csvEscape(localTimeText(p.timeKnown, p.checkInUtc)) : ""},${p.method},${p.present ? (p.timeKnown ? "known" : "unknown") : ""}`
    ).join("\r\n") + "\r\n";
    return ok(res, csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=checker-attendance.csv" });
  }
  if (req.method === "GET" && pathname === "/api/backup") {
    return ok(res, JSON.stringify(makeSnapshot()), 200, { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=checker-backup.json" });
  }
  if (req.method === "POST" && pathname === "/api/restore") {
    const body = await readBody(req, MAX_BACKUP_BYTES);
    if (readState().mode !== "IDLE") throw Object.assign(new Error("Restore requires Paused"), { code: 400 });
    restoreSnapshot(JSON.parse(body));
    return ok(res, { ok: true, message: "Backup restored. Scanner is Paused.", status: statusJson() });
  }
  if (req.method === "GET" && pathname === "/api/report") {
    const s = readState();
    const sm = summary();
    let h = `<h2>${htmlEscape(s.eventName)}</h2><p>Date: ${htmlEscape(s.eventDate)}<br>Generated: ${localTimeText(true, nowUtc())}</p>`;
    h += `<p>Registered ${sm.total} &middot; Present ${sm.present} &middot; Absent ${sm.absent} &middot; Participants ${sm.partPresent}/${sm.partTotal} &middot; OC ${sm.ocPresent}/${sm.ocTotal}</p>`;
    h += "<table><thead><tr><th>Name</th><th>Type</th><th>RFID</th><th>Attendance</th><th>Check-in time</th><th>Method</th></tr></thead><tbody>";
    for (const p of peopleRows()) h += `<tr><td>${htmlEscape(p.name)}</td><td>${p.type === "oc" ? "OC" : "Participant"}</td><td>${htmlEscape(p.uid)}</td><td>${p.present ? "Present" : "Absent"}</td><td>${p.present ? htmlEscape(localTimeText(p.timeKnown, p.checkInUtc)) : ""}</td><td>${htmlEscape(p.method)}</td></tr>`;
    h += "</tbody></table>";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(h);
  }
  if (req.method === "GET" && pathname === "/api/diagnostics") {
    const d = connectedDevice();
    return ok(res, { ok: true, port: PORT, dbPath: DB_PATH, database: "ok", addresses: usableAddresses(), device: deviceDiagnostics(d) });
  }
  if (req.method === "POST" && pathname === "/api/device/recover-reader") {
    const d = connectedDevice();
    if (!d || Date.now() - d.lastSeen > DEVICE_TIMEOUT_MS || !d.socket || d.socket.destroyed) {
      throw Object.assign(new Error("No connected ESP device"), { code: 503 });
    }
    sendWs(d.socket, { type: "command", command: "recover_reader", commandId: `recover-${Date.now()}` });
    return ok(res, { ok: true, message: "Reader recovery command sent", status: statusJson() });
  }
  return false;
}

function staticRoute(req, res, pathname) {
  let file = pathname === "/" || pathname === "/dashboard" || pathname === "/assignment" || pathname === "/check-in"
    ? path.join(PUBLIC_DIR, "checker-ravena.html")
    : path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  file = path.resolve(file);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function encodeWsFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}
function decodeWsFrames(buffer) {
  const out = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) { if (pos + 2 > buffer.length) break; len = buffer.readUInt16BE(pos); pos += 2; }
    else if (len === 127) throw new Error("Large WebSocket frames are not supported");
    const masked = !!(b1 & 0x80);
    let mask;
    if (masked) { if (pos + 4 > buffer.length) break; mask = buffer.subarray(pos, pos + 4); pos += 4; }
    if (pos + len > buffer.length) break;
    let payload = Buffer.from(buffer.subarray(pos, pos + len));
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    out.push({ opcode, text: payload.toString("utf8"), consumed: pos + len });
    offset = pos + len;
  }
  return { frames: out, rest: buffer.subarray(offset) };
}
function sendWs(socket, obj) {
  if (!socket.destroyed) socket.write(encodeWsFrame(obj));
}
function stateMessage() {
  const s = readState();
  const assignName = currentAssignName(s);
  return {
    type: "state",
    protocol: PROTOCOL_VERSION,
    mode: s.mode,
    stateRev: s.stateRev,
    ready: ["CHECK_IN", "ASSIGN_SINGLE", "ASSIGN_FAST"].includes(s.mode),
    assignName,
    assignTargetName: assignName,
  };
}
function sendStateToDevices() {
  for (const d of devices.values()) sendWs(d.socket, stateMessage());
}
function updateDeviceDiagnostics(d, msg) {
  if (msg.readerReady !== undefined) d.readerReady = !!msg.readerReady;
  if (msg.readerStatus !== undefined) d.readerStatus = String(msg.readerStatus || "");
  for (const key of ["rfidPollCount", "rfidBlockedCount", "rfidReadAttempts", "rfidReadSuccess", "rfidRecoveries", "rfidFailureCount", "lastGoodRfidMs", "lastSuccessfulCardMs", "cooldownRemainingMs"]) {
    if (msg[key] !== undefined) d[key] = Number(msg[key] || 0);
  }
  for (const key of ["rfidBlockReason", "rfidVersion", "lastSuccessfulUid"]) {
    if (msg[key] !== undefined) d[key] = String(msg[key] || "");
  }
  if (msg.cardHeld !== undefined) d.cardHeld = !!msg.cardHeld;
  if (msg.pendingScan !== undefined) d.pendingScan = !!msg.pendingScan;
}
function handleDeviceMessage(socket, msg, ip) {
  if (msg.type === "hello") {
    const deviceId = String(msg.deviceId || socket.deviceId || `esp-${ip}`);
    socket.deviceId = deviceId;
    const d = { socket, deviceId, ip, lastSeen: Date.now(), lastSeenIso: new Date().toISOString() };
    updateDeviceDiagnostics(d, msg);
    devices.set(deviceId, d);
    sendWs(socket, { ...stateMessage(), type: "hello_ack", protocol: PROTOCOL_VERSION, serverTimeUtc: nowUtc() });
    return;
  }
  const deviceId = socket.deviceId || `esp-${ip}`;
  const d = devices.get(deviceId) || { socket, deviceId, ip };
  d.socket = socket; d.lastSeen = Date.now(); d.lastSeenIso = new Date().toISOString();
  updateDeviceDiagnostics(d, msg);
  devices.set(deviceId, d);
  if (msg.type === "heartbeat") sendWs(socket, { ...stateMessage(), type: "heartbeat_ack", serverTimeUtc: nowUtc() });
  if (msg.type === "scan") {
    const response = processScan({ ...msg, bootId: msg.bootId || deviceId });
    sendWs(socket, response);
    sendStateToDevices();
  }
}

function handleUpgrade(req, socket) {
  if (new URL(req.url, "http://x").pathname !== "/device") return socket.destroy();
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  let pending = Buffer.alloc(0);
  const ip = req.socket.remoteAddress;
  socket.on("data", chunk => {
    pending = Buffer.concat([pending, chunk]);
    try {
      const decoded = decodeWsFrames(pending);
      pending = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) return socket.end();
        if (frame.opcode === 0x1) handleDeviceMessage(socket, JSON.parse(frame.text), ip);
      }
    } catch (err) {
      sendWs(socket, { type: "error", message: err.message });
    }
  });
  socket.on("close", () => {
    if (socket.deviceId && devices.get(socket.deviceId)?.socket === socket) devices.delete(socket.deviceId);
  });
}

function usableAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) addrs.push({ name, address: item.address });
    }
  }
  return addrs;
}
function printStartup(server) {
  const addrs = usableAddresses();
  console.log("CheckerV2 server started");
  console.log(`Data: ${DB_PATH}`);
  console.log(`PC browser URL: http://localhost:${PORT}`);
  for (const a of addrs) console.log(`Phone/LAN URL (${a.name}): http://${a.address}:${PORT}`);
  for (const a of addrs) console.log(`ESP server address candidate (${a.name}): ${a.address}:${PORT}`);
  if (!addrs.length) console.log("No non-loopback IPv4 address detected yet. Start/enable the hotspot and rerun diagnostics.");
}
async function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  try {
    const routed = pathname.startsWith("/api/") ? await apiRoute(req, res, pathname) : false;
    if (routed !== false) return;
    if (staticRoute(req, res, pathname)) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    const code = err.code && Number(err.code) ? Number(err.code) : 500;
    jsonError(res, err.message || "Server error", code);
  }
});
server.on("upgrade", handleUpgrade);

(async () => {
  if (!(await isPortFree(PORT))) {
    console.error(`Port ${PORT} is already in use. Set CHECKER_PORT to another port.`);
    process.exit(2);
  }
  server.listen(PORT, HOST, () => printStartup(server));
})();
