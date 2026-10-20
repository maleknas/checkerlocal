#include <Arduino.h>
#include <ArduinoJson.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <SPI.h>
#include <WiFi.h>
#include <esp_websocket_client.h>

#include "CheckerLcdDisplay.h"
#include "CheckerV2Config.h"

static const uint32_t SCAN_COOLDOWN_MS = 2000;
static const uint32_t HELD_CARD_CLEAR_MS = 900;
static const uint32_t HEARTBEAT_MS = 2000;
static const uint32_t WIFI_RETRY_MIN_MS = 1000;
static const uint32_t WIFI_RETRY_MAX_MS = 15000;
static const uint32_t WS_RETRY_MIN_MS = 1000;
static const uint32_t WS_RETRY_MAX_MS = 10000;
static const uint32_t RFID_HEALTH_MS = 3000;
static const uint32_t RFID_DIAG_MS = 5000;
static const uint8_t RFID_FAILURES_BEFORE_RECOVER = 3;

enum DeviceMode { IDLE, CHECK_IN, ASSIGN_SINGLE, ASSIGN_FAST };

const char *modeName(DeviceMode m);
void recoverReader(const char *reason, bool manual);
void printRfidDiagnostics();
void sendHeartbeat();

struct Pulse {
  uint8_t pin;
  bool active;
  uint8_t remaining;
  uint32_t nextMs;
  uint16_t onMs;
  uint16_t offMs;
};

MFRC522 rfid(CHECKER_RC522_SS_PIN, CHECKER_RC522_RST_PIN);
Preferences prefs;

Pulse greenPulse{CHECKER_GREEN_LED_PIN, false, 0, 0, 90, 90};
Pulse redPulse{CHECKER_RED_LED_PIN, false, 0, 0, 180, 120};
Pulse buzzPulse{CHECKER_BUZZER_PIN, false, 0, 0, 70, 90};

esp_websocket_client_handle_t ws = nullptr;
DeviceMode mode = IDLE;
bool readerReady = false;
bool wsConnected = false;
bool serverReady = false;
uint32_t acknowledgedStateRev = 0;
uint32_t bootId = 0;
uint32_t scanSeq = 0;
uint32_t cooldownUntil = 0;
uint32_t lastSeenCardMs = 0;
uint32_t lastHeartbeatMs = 0;
uint32_t lastDiagMs = 0;
uint32_t lastRfidHealthMs = 0;
uint32_t lastRfidDiagMs = 0;
uint32_t rfidPollCount = 0;
uint32_t rfidBlockedCount = 0;
uint32_t rfidReadAttempts = 0;
uint32_t rfidReadSuccess = 0;
uint32_t rfidRecoveries = 0;
uint32_t lastGoodRfidMs = 0;
uint32_t lastSuccessfulCardMs = 0;
uint32_t nextWifiAttemptMs = 0;
uint32_t wifiBackoffMs = WIFI_RETRY_MIN_MS;
uint32_t nextWsAttemptMs = 0;
uint32_t wsBackoffMs = WS_RETRY_MIN_MS;
uint8_t rfidFailureCount = 0;
bool cardHeld = false;
bool heartbeatOn = false;
String lastScanUid = "";
String pendingScanJson = "";
String deviceId = "";
String readerStatus = "Reader not initialized";
String wifiSsid = "";
String wifiPassword = "";
String serverUrl = "";
String serialLine = "";
String pendingSsid = "";
String rfidBlockReason = "booting";
String lastGoodRfidVersion = "";
String lastSuccessfulUid = "";
String pendingLcdResult = "";
String currentAssignName = "";
DeviceMode pendingScanMode = IDLE;
uint8_t serialSetupStep = 0;
int scannedNetworks = 0;

void printHelp() {
  Serial.println();
  Serial.println("CheckerV2 serial commands:");
  Serial.println("  WIFI       scan networks and enter a new password");
  Serial.println("  SERVER     set PC server URL, example: SERVER ws://192.168.137.1:8080/device");
  Serial.println("  STATUS     print current connection status");
  Serial.println("  RFIDSTATUS print RFID polling and RC522 diagnostics");
  Serial.println("  RFIDRECOVER reinitialize only the RC522 reader");
  Serial.println("  CLEARWIFI  forget saved Wi-Fi/server and use compiled defaults");
  Serial.println("  HELP       show this menu");
  Serial.println();
}

void loadSettings() {
  prefs.begin("checker", false);
  wifiSsid = prefs.getString("ssid", CHECKER_WIFI_SSID);
  wifiPassword = prefs.getString("pass", CHECKER_WIFI_PASSWORD);
  serverUrl = prefs.getString("server", CHECKER_SERVER_WS_URL);
  if (serverUrl == "ws://10.238.70.157:8080/device") {
    serverUrl = CHECKER_SERVER_WS_URL;
    prefs.putString("server", serverUrl);
  }
}

void saveWifiSettings(const String &ssid, const String &password) {
  wifiSsid = ssid;
  wifiPassword = password;
  prefs.putString("ssid", wifiSsid);
  prefs.putString("pass", wifiPassword);
}

void saveServerUrl(const String &url) {
  serverUrl = url;
  prefs.putString("server", serverUrl);
}

void stopWebSocket() {
  if (!ws) return;
  esp_websocket_client_stop(ws);
  esp_websocket_client_destroy(ws);
  ws = nullptr;
  wsConnected = false;
  serverReady = false;
}

void restartWifi() {
  stopWebSocket();
  WiFi.disconnect(false, true);
  nextWifiAttemptMs = 0;
  wifiBackoffMs = WIFI_RETRY_MIN_MS;
  nextWsAttemptMs = 0;
  wsBackoffMs = WS_RETRY_MIN_MS;
}

void printStatus() {
  Serial.println();
  Serial.printf("Wi-Fi SSID: %s\n", wifiSsid.c_str());
  Serial.printf("Wi-Fi status: %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "not connected");
  Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("Server URL: %s\n", serverUrl.c_str());
  Serial.printf("WebSocket: %s\n", wsConnected ? "connected" : "not connected");
  Serial.printf("Mode: %s | stateRev=%lu | reader=%s\n", modeName(mode), (unsigned long)acknowledgedStateRev, readerReady ? "ready" : "unavailable");
  printRfidDiagnostics();
  Serial.println();
}

void scanNetworksForSerial() {
  Serial.println();
  Serial.println("[WIFI] Scanning networks...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  delay(120);
  scannedNetworks = WiFi.scanNetworks();
  if (scannedNetworks <= 0) {
    Serial.println("[WIFI] No networks found. Type WIFI to scan again.");
    serialSetupStep = 0;
    return;
  }
  for (int i = 0; i < scannedNetworks; i++) {
    Serial.printf("  %d) %s  RSSI=%d  %s\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "secured");
  }
  Serial.println("Enter network number, or type an SSID manually:");
  serialSetupStep = 1;
}

DeviceMode parseMode(const String &m) {
  if (m == "CHECK_IN") return CHECK_IN;
  if (m == "ASSIGN_SINGLE") return ASSIGN_SINGLE;
  if (m == "ASSIGN_FAST") return ASSIGN_FAST;
  return IDLE;
}

const char *modeName(DeviceMode m) {
  if (m == CHECK_IN) return "CHECK_IN";
  if (m == ASSIGN_SINGLE) return "ASSIGN_SINGLE";
  if (m == ASSIGN_FAST) return "ASSIGN_FAST";
  return "IDLE";
}

void writePulsePin(const Pulse &p, bool active) {
  bool level = active;
  if (p.pin == CHECKER_BUZZER_PIN) digitalWrite(p.pin, level == CHECKER_BUZZER_ACTIVE_HIGH ? HIGH : LOW);
  else digitalWrite(p.pin, level == CHECKER_LED_ACTIVE_HIGH ? HIGH : LOW);
}

void pulseStart(Pulse &p, uint8_t count) {
  p.remaining = count * 2;
  p.active = false;
  p.nextMs = millis();
}

void updatePulse(Pulse &p) {
  if (!p.remaining || millis() < p.nextMs) return;
  p.active = !p.active;
  writePulsePin(p, p.active);
  p.remaining--;
  p.nextMs = millis() + (p.active ? p.onMs : p.offMs);
}

void feedbackOk() { pulseStart(greenPulse, 1); pulseStart(buzzPulse, 1); }
void feedbackAlready() { pulseStart(redPulse, 2); pulseStart(buzzPulse, 2); }
void feedbackBad() { pulseStart(redPulse, 1); buzzPulse.onMs = 180; pulseStart(buzzPulse, 1); buzzPulse.onMs = 70; }
void feedbackUnavailable() { pulseStart(redPulse, 3); buzzPulse.onMs = 60; pulseStart(buzzPulse, 3); buzzPulse.onMs = 70; }

String rfidVersionText(byte ver) {
  char buf[8];
  snprintf(buf, sizeof(buf), "0x%02X", ver);
  return String(buf);
}

bool rc522CommunicationHealthy() {
  byte ver = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (ver == 0x00 || ver == 0xFF) {
    readerReady = false;
    readerStatus = "RC522 communication failed - manual check-in available";
    return false;
  }
  lastGoodRfidVersion = rfidVersionText(ver);
  lastGoodRfidMs = millis();
  rfidFailureCount = 0;
  if (!readerReady) {
    readerStatus = "Reader ready";
  }
  readerReady = true;
  return true;
}

void initReaderHardware() {
  rfid.PCD_Init();
  rfid.PCD_AntennaOn();
}

void recoverReader(const char *reason, bool manual) {
  if (pendingScanJson.length()) {
    readerStatus = "Reader recovery deferred - scan result pending";
    Serial.printf("[RFID] recovery deferred (%s): pending scan not resolved\n", reason);
    return;
  }
  Serial.printf("[RFID] recovery start (%s)\n", reason);
  rfid.PCD_Reset();
  delay(30);
  initReaderHardware();
  cardHeld = false;
  lastScanUid = "";
  cooldownUntil = 0;
  rfidFailureCount = 0;
  rfidRecoveries++;
  bool ok = rc522CommunicationHealthy();
  readerStatus = ok ? (manual ? "Reader recovered manually" : "Reader recovered automatically") : "Reader recovery failed - manual check-in available";
  Serial.printf("[RFID] recovery %s | version=%s | count=%lu\n",
                ok ? "ok" : "failed",
                lastGoodRfidVersion.length() ? lastGoodRfidVersion.c_str() : "unavailable",
                (unsigned long)rfidRecoveries);
  if (!ok) feedbackUnavailable();
  if (wsConnected) sendHeartbeat();
}

void checkReaderHealth() {
  if (millis() - lastRfidHealthMs < RFID_HEALTH_MS) return;
  lastRfidHealthMs = millis();
  if (rc522CommunicationHealthy()) return;
  rfidFailureCount++;
  Serial.printf("[RFID] health failure %u/%u\n", rfidFailureCount, RFID_FAILURES_BEFORE_RECOVER);
  if (rfidFailureCount >= RFID_FAILURES_BEFORE_RECOVER) recoverReader("communication failures", false);
}

void printRfidDiagnostics() {
  Serial.printf("RFID: ready=%s | status=%s | version=%s | failures=%u | recoveries=%lu\n",
                readerReady ? "yes" : "no",
                readerStatus.c_str(),
                lastGoodRfidVersion.length() ? lastGoodRfidVersion.c_str() : "unknown",
                rfidFailureCount,
                (unsigned long)rfidRecoveries);
  Serial.printf("RFID scan loop: polls=%lu | blocked=%lu | reason=%s | attempts=%lu | successes=%lu | held=%s | pending=%s | cooldownRemaining=%lu\n",
                (unsigned long)rfidPollCount,
                (unsigned long)rfidBlockedCount,
                rfidBlockReason.c_str(),
                (unsigned long)rfidReadAttempts,
                (unsigned long)rfidReadSuccess,
                cardHeld ? "yes" : "no",
                pendingScanJson.length() ? "yes" : "no",
                (unsigned long)(millis() < cooldownUntil ? cooldownUntil - millis() : 0));
  Serial.printf("RFID last card: uid=%s | ms=%lu | lastGoodCommMs=%lu\n",
                lastSuccessfulUid.length() ? lastSuccessfulUid.c_str() : "none",
                (unsigned long)lastSuccessfulCardMs,
                (unsigned long)lastGoodRfidMs);
}

void applyState(JsonObject doc) {
  if (doc["stateRev"].is<uint32_t>()) acknowledgedStateRev = doc["stateRev"].as<uint32_t>();
  if (doc["mode"].is<const char *>()) mode = parseMode(doc["mode"].as<String>());
  if (doc["ready"].is<bool>()) serverReady = doc["ready"].as<bool>();
  if (!doc["assignTargetName"].isNull()) currentAssignName = doc["assignTargetName"].as<String>();
  else if (!doc["assignName"].isNull()) currentAssignName = doc["assignName"].as<String>();
}

String scanResultForLcd(const String &result, const String &feedback, DeviceMode submittedMode) {
  String text = result;
  text.trim();

  if (text.startsWith("Card not assigned")) return "Unknown card - Not assigned";
  if (text == "Invalid UID" || text == "Invalid scan event") return "Invalid card - Try again";

  if (submittedMode == ASSIGN_SINGLE || submittedMode == ASSIGN_FAST) {
    if (text.startsWith("Assigned ")) {
      int nameAt = text.indexOf(" to ");
      if (nameAt >= 0) return "Assigned - " + text.substring(nameAt + 4);
      return "Assigned";
    }
    if (text.startsWith("Card already assigned to ")) return "Already assigned - " + text.substring(25);
    if (text.indexOf("queue finished") >= 0) return "Fast complete";
    if (feedback == "ok") return "Assigned";
    if (feedback == "bad") return "Assign failed";
  }

  if (!text.length()) return feedback == "bad" ? String("Scan failed") : String("Done");
  return text;
}

void sendJson(const String &body) {
  if (!wsConnected || !ws) return;
  esp_websocket_client_send_text(ws, body.c_str(), body.length(), pdMS_TO_TICKS(200));
}

void addReaderDiagnostics(JsonDocument &doc) {
  doc["readerReady"] = readerReady;
  doc["readerStatus"] = readerStatus;
  doc["rfidPollCount"] = rfidPollCount;
  doc["rfidBlockedCount"] = rfidBlockedCount;
  doc["rfidBlockReason"] = rfidBlockReason;
  doc["rfidReadAttempts"] = rfidReadAttempts;
  doc["rfidReadSuccess"] = rfidReadSuccess;
  doc["rfidRecoveries"] = rfidRecoveries;
  doc["rfidFailureCount"] = rfidFailureCount;
  doc["rfidVersion"] = lastGoodRfidVersion;
  doc["lastGoodRfidMs"] = lastGoodRfidMs;
  doc["lastSuccessfulUid"] = lastSuccessfulUid;
  doc["lastSuccessfulCardMs"] = lastSuccessfulCardMs;
  doc["cardHeld"] = cardHeld;
  doc["pendingScan"] = pendingScanJson.length() > 0;
  doc["cooldownRemainingMs"] = millis() < cooldownUntil ? cooldownUntil - millis() : 0;
}

void sendHello() {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["protocol"] = 1;
  doc["deviceId"] = deviceId;
  doc["firmware"] = "checkerv2-esp32-1";
  doc["bootId"] = String(bootId, HEX);
  addReaderDiagnostics(doc);
  String out;
  serializeJson(doc, out);
  sendJson(out);
}

void sendHeartbeat() {
  JsonDocument doc;
  doc["type"] = "heartbeat";
  doc["deviceId"] = deviceId;
  doc["bootId"] = String(bootId, HEX);
  doc["stateRev"] = acknowledgedStateRev;
  doc["mode"] = modeName(mode);
  addReaderDiagnostics(doc);
  String out;
  serializeJson(doc, out);
  sendJson(out);
}

void retryPendingScan() {
  if (pendingScanJson.length() && wsConnected) sendJson(pendingScanJson);
}

void handleWsText(const char *data, size_t len) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, data, len);
  if (err) {
    Serial.printf("[WS] JSON parse failed: %s\n", err.c_str());
    return;
  }
  String type = doc["type"].as<String>();
  if (type == "hello_ack" || type == "state" || type == "heartbeat_ack") {
    applyState(doc.as<JsonObject>());
    retryPendingScan();
    return;
  }
  if (type == "scan_result") {
    if (doc["stateRev"].is<uint32_t>()) acknowledgedStateRev = doc["stateRev"].as<uint32_t>();
    if (doc["mode"].is<const char *>()) mode = parseMode(doc["mode"].as<String>());
    if (!doc["assignTargetName"].isNull()) currentAssignName = doc["assignTargetName"].as<String>();
    else if (!doc["assignName"].isNull()) currentAssignName = doc["assignName"].as<String>();
    String eventId = doc["eventId"].as<String>();
    if (pendingScanJson.indexOf(eventId) >= 0) pendingScanJson = "";
    String feedback = doc["feedback"].as<String>();
    String result = doc["result"].as<String>();
    Serial.printf("[SCAN] %s | %s\n", feedback.c_str(), result.c_str());
    String lcdResult = scanResultForLcd(result, feedback, pendingScanMode);
    bool fastAdvancedWithNextTarget = pendingScanMode == ASSIGN_FAST && currentAssignName.length() && feedback == "ok";
    if (!fastAdvancedWithNextTarget) pendingLcdResult = lcdResult;
    pendingScanMode = IDLE;
    if (feedback == "ok") feedbackOk();
    else if (feedback == "already") feedbackAlready();
    else feedbackBad();
    return;
  }
  if (type == "command") {
    String command = doc["command"].as<String>();
    if (command == "recover_reader") recoverReader("server command", true);
    else Serial.printf("[WS] unknown command: %s\n", command.c_str());
  }
}

void wsEvent(void *handlerArgs, esp_event_base_t base, int32_t eventId, void *eventData) {
  (void)handlerArgs;
  (void)base;
  esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)eventData;
  if (eventId == WEBSOCKET_EVENT_CONNECTED) {
    wsConnected = true;
    wsBackoffMs = WS_RETRY_MIN_MS;
    Serial.println("[WS] connected");
    sendHello();
  } else if (eventId == WEBSOCKET_EVENT_DISCONNECTED) {
    wsConnected = false;
    serverReady = false;
    Serial.println("[WS] disconnected");
    feedbackUnavailable();
  } else if (eventId == WEBSOCKET_EVENT_DATA && data->op_code == 0x01) {
    handleWsText((const char *)data->data_ptr, data->data_len);
  } else if (eventId == WEBSOCKET_EVENT_ERROR) {
    wsConnected = false;
    serverReady = false;
    Serial.println("[WS] error");
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiBackoffMs = WIFI_RETRY_MIN_MS;
    return;
  }
  if (millis() < nextWifiAttemptMs) return;
  if (!wifiSsid.length()) {
    Serial.println("[WIFI] No SSID configured. Type WIFI in Serial Monitor.");
    nextWifiAttemptMs = millis() + 5000;
    return;
  }
  Serial.printf("[WIFI] connecting to SSID: %s\n", wifiSsid.c_str());
  WiFi.disconnect(false, true);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  nextWifiAttemptMs = millis() + wifiBackoffMs;
  wifiBackoffMs = min(wifiBackoffMs * 2, WIFI_RETRY_MAX_MS);
}

void ensureWebSocket() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (wsConnected) return;
  if (ws && esp_websocket_client_is_connected(ws)) return;
  if (millis() < nextWsAttemptMs) return;
  if (!ws) {
    esp_websocket_client_config_t config = {};
    config.uri = serverUrl.c_str();
    config.disable_auto_reconnect = true;
    ws = esp_websocket_client_init(&config);
    esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, wsEvent, nullptr);
  }
  Serial.printf("[WS] connecting to %s\n", serverUrl.c_str());
  esp_websocket_client_start(ws);
  nextWsAttemptMs = millis() + wsBackoffMs;
  wsBackoffMs = min(wsBackoffMs * 2, WS_RETRY_MAX_MS);
}

void handleSerialLine(String line) {
  line.trim();

  if (serialSetupStep == 1) {
    if (!line.length()) {
      Serial.println("Enter a network number or SSID.");
      return;
    }
    int selected = line.toInt();
    if (selected > 0 && selected <= scannedNetworks) pendingSsid = WiFi.SSID(selected - 1);
    else pendingSsid = line;
    Serial.printf("Selected SSID: %s\n", pendingSsid.c_str());
    Serial.println("Enter Wi-Fi password, or press Enter for open network:");
    serialSetupStep = 2;
    return;
  }

  if (serialSetupStep == 2) {
    saveWifiSettings(pendingSsid, line);
    Serial.printf("[WIFI] Saved SSID: %s\n", wifiSsid.c_str());
    Serial.println("[WIFI] Password saved but not printed.");
    serialSetupStep = 0;
    pendingSsid = "";
    restartWifi();
    return;
  }

  if (!line.length()) return;

  String upper = line;
  upper.toUpperCase();
  if (upper == "WIFI") {
    scanNetworksForSerial();
  } else if (upper.startsWith("SERVER ")) {
    String url = line.substring(7);
    url.trim();
    if (!url.startsWith("ws://")) {
      Serial.println("[SERVER] URL must start with ws://");
      return;
    }
    saveServerUrl(url);
    Serial.printf("[SERVER] Saved URL: %s\n", serverUrl.c_str());
    stopWebSocket();
    nextWsAttemptMs = 0;
  } else if (upper == "STATUS") {
    printStatus();
  } else if (upper == "RFIDSTATUS") {
    printRfidDiagnostics();
  } else if (upper == "RFIDRECOVER") {
    recoverReader("serial command", true);
  } else if (upper == "CLEARWIFI") {
    prefs.remove("ssid");
    prefs.remove("pass");
    prefs.remove("server");
    wifiSsid = CHECKER_WIFI_SSID;
    wifiPassword = CHECKER_WIFI_PASSWORD;
    serverUrl = CHECKER_SERVER_WS_URL;
    Serial.println("[WIFI] Saved Wi-Fi/server removed; using compiled defaults.");
    restartWifi();
  } else if (upper == "HELP") {
    printHelp();
  } else {
    Serial.println("Unknown command. Type HELP.");
  }
}

void handleSerialConfig() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handleSerialLine(serialLine);
      serialLine = "";
    } else if (c != '\r' && serialLine.length() < 160) {
      serialLine += c;
    }
  }
}

String readUid() {
  String uid;
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  rfidReadSuccess++;
  lastSuccessfulUid = uid;
  lastSuccessfulCardMs = millis();
  return uid;
}

void submitScan(const String &uid) {
  JsonDocument doc;
  scanSeq++;
  String eventId = String(bootId, HEX) + "-" + String(scanSeq);
  doc["type"] = "scan";
  doc["deviceId"] = deviceId;
  doc["bootId"] = String(bootId, HEX);
  doc["seq"] = scanSeq;
  doc["eventId"] = eventId;
  doc["uid"] = uid;
  doc["mode"] = modeName(mode);
  doc["stateRev"] = acknowledgedStateRev;
  doc["readerReady"] = readerReady;
  String out;
  serializeJson(doc, out);
  pendingScanJson = out;
  pendingScanMode = mode;
  sendJson(out);
}

void pollReader() {
  rfidPollCount++;
  if (!readerReady) { rfidBlockedCount++; rfidBlockReason = "reader not ready"; return; }
  if (mode == IDLE) { rfidBlockedCount++; rfidBlockReason = "scanner paused"; return; }
  if (!wsConnected || !serverReady) { rfidBlockedCount++; rfidBlockReason = "server not ready"; return; }
  if (pendingScanJson.length()) { rfidBlockedCount++; rfidBlockReason = "scan result pending"; return; }
  if (millis() < cooldownUntil) { rfidBlockedCount++; rfidBlockReason = "cooldown"; return; }
  rfidBlockReason = "polling";
  bool present = rfid.PICC_IsNewCardPresent();
  if (!present) {
    if (millis() - lastSeenCardMs > HELD_CARD_CLEAR_MS) cardHeld = false;
    rfidBlockReason = "no card";
    return;
  }
  rfidReadAttempts++;
  if (!rfid.PICC_ReadCardSerial()) {
    rfidBlockReason = "serial read failed";
    rfid.PCD_StopCrypto1();
    return;
  }
  lastSeenCardMs = millis();
  String uid = readUid();
  if (cardHeld && uid == lastScanUid) {
    rfidBlockReason = "same card held";
    return;
  }
  cardHeld = true;
  lastScanUid = uid;
  cooldownUntil = millis() + SCAN_COOLDOWN_MS;
  rfidBlockReason = "submitted scan";
  submitScan(uid);
}

void setup() {
  pinMode(CHECKER_GREEN_LED_PIN, OUTPUT);
  pinMode(CHECKER_RED_LED_PIN, OUTPUT);
  pinMode(CHECKER_BUZZER_PIN, OUTPUT);
  writePulsePin(greenPulse, false);
  writePulsePin(redPulse, false);
  writePulsePin(buzzPulse, false);
  Serial.begin(9600);
  delay(600);
  bootId = esp_random();
  deviceId = "checker-" + WiFi.macAddress();
  deviceId.replace(":", "");
  Serial.println();
  Serial.println("CheckerV2 device booting");
  checkerLcdBegin();
  loadSettings();
  Serial.printf("[CONFIG] Wi-Fi SSID: %s\n", wifiSsid.c_str());
  Serial.printf("[CONFIG] Server URL: %s\n", serverUrl.c_str());
  printHelp();

  SPI.begin(CHECKER_SPI_SCK_PIN, CHECKER_SPI_MISO_PIN, CHECKER_SPI_MOSI_PIN, CHECKER_RC522_SS_PIN);
  initReaderHardware();
  rc522CommunicationHealthy();
  if (!readerReady) readerStatus = "Reader unavailable - manual check-in available";
  Serial.printf("[RFID] %s | version=%s\n", readerStatus.c_str(), lastGoodRfidVersion.length() ? lastGoodRfidVersion.c_str() : "unavailable");
}

void loop() {
  handleSerialConfig();
  if (serialSetupStep == 0) {
    ensureWifi();
    ensureWebSocket();
    checkReaderHealth();
    pollReader();
  }
  updatePulse(greenPulse);
  updatePulse(redPulse);
  updatePulse(buzzPulse);
  if (pendingLcdResult.length()) {
    checkerLcdShowResult(pendingLcdResult);
    pendingLcdResult = "";
  }
  checkerLcdUpdate(modeName(mode), readerReady, wsConnected && serverReady, readerStatus, currentAssignName);

  if (wsConnected && millis() - lastHeartbeatMs > HEARTBEAT_MS) {
    sendHeartbeat();
    lastHeartbeatMs = millis();
  }

  if (!greenPulse.remaining && millis() - lastHeartbeatMs > 1000) {
    heartbeatOn = !heartbeatOn;
    digitalWrite(CHECKER_GREEN_LED_PIN, heartbeatOn == CHECKER_LED_ACTIVE_HIGH ? HIGH : LOW);
  }

  if (millis() - lastDiagMs > 5000) {
    Serial.printf("CheckerV2 alive | wifi=%s | ip=%s | ws=%s | mode=%s | rev=%lu | reader=%s\n",
                  WiFi.status() == WL_CONNECTED ? "ok" : "down",
                  WiFi.localIP().toString().c_str(),
                  wsConnected ? "ok" : "down",
                  modeName(mode),
                  (unsigned long)acknowledgedStateRev,
                  readerReady ? "ok" : "down");
    lastDiagMs = millis();
  }

  if (millis() - lastRfidDiagMs > RFID_DIAG_MS) {
    Serial.printf("[RFID] loop=%lu blocked=%lu reason=%s comm=%s lastUid=%s recoveries=%lu\n",
                  (unsigned long)rfidPollCount,
                  (unsigned long)rfidBlockedCount,
                  rfidBlockReason.c_str(),
                  readerReady ? "ok" : "down",
                  lastSuccessfulUid.length() ? lastSuccessfulUid.c_str() : "none",
                  (unsigned long)rfidRecoveries);
    lastRfidDiagMs = millis();
  }
}
