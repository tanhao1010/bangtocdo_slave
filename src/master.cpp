// ============================================================
//  MASTER  (Controller dieu khien 2 bang LED P5 slave qua LoRa E32)
//  - LoRa E32 noi vao UART2 cua ESP32:
//      ESP32 GPIO16 (RX2) <- LoRa E32 TXD
//      ESP32 GPIO17 (TX2) -> LoRa E32 RXD
//      LoRa E32 M0=M1=GND (transparent mode), AUX khong dung.
//  - Modbus RTU master tren Serial2, baud khop E32 (115200 8N1).
//  - WiFi STA (fallback AP) + Web server tren cong 80.
//  - File web (index.html / app.js / style.css / logo.png) o LittleFS.
//  - REST API JSON cho phep app.js dieu khien 5 mode tren slave.
// ============================================================
#include <Arduino.h>
#include <ModbusRTU.h>
#include <esp_timer.h>
#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

// ---------- HW LoRa ----------
#define LORA_RX_PIN   16
#define LORA_TX_PIN   17
#define LORA_BAUD     115200

// ---------- Slave IDs ----------
#define SLAVE1_ID 1
#define SLAVE2_ID 2

// ---------- WiFi (AP only, master phat song) ----------
const char* AP_SSID       = "PatinMaster";
const char* AP_PASSWORD   = "12345678";
// IP co dinh cua AP cho de nho
IPAddress   AP_IP(192, 168, 4, 1);
IPAddress   AP_GW(192, 168, 4, 1);
IPAddress   AP_MASK(255, 255, 255, 0);

// ---------- MODBUS REG MAP (phai khop slave) ----------
enum {
  HR_SLAVE_ID    = 0,
  HR_MODE        = 1,
  HR_SEC         = 2,
  HR_MS          = 3,
  HR_COUNT_STATE = 4,
  HR_MASTER_SIG  = 5,
  HR_COLOR_READY = 6,
  HR_COLOR_STOP  = 7,
  HR_SYNC_FLAG   = 8,
  HR_TARGET      = 9,
  HR_TRIG_FLAG   = 10
};

enum {
  SIG_IDLE   = 0,
  SIG_ARM    = 100,
  SIG_START  = 110,
  SIG_PAUSE  = 120,
  SIG_RESUME = 130,
  SIG_FINAL  = 250
};

// ---------- Master state ----------
enum MState { M_IDLE, M_ARMED, M_RUNNING, M_PAUSED, M_FINISHED };
volatile MState mState = M_IDLE;

volatile uint8_t  currentMode = 1;
volatile uint16_t targetSec   = 10;
volatile uint16_t colorReady  = 1;
volatile uint16_t colorStop   = 2;

// Dung milliseconds (uint32) thay vi int64 us -> read atomic, an toan cross-task.
volatile uint32_t tStart_ms   = 0;
volatile uint32_t tElapsed_ms = 0;

// Cache trang thai cuoi cua tung slave (cho /api/status, tranh poll moi request)
struct SlaveCache {
  volatile uint16_t state = 0;
  volatile uint16_t sec   = 0;
  volatile uint16_t ms    = 0;
  volatile uint16_t value = 0;
  volatile bool     online = false;
};
SlaveCache cache1, cache2;

volatile uint8_t mode2Winner = 0;

// ---------- Command queue (web -> modbus task) ----------
struct PendingCmd {
  bool    armFlag    = false;
  bool    startFlag  = false;
  bool    pauseFlag  = false;
  bool    resumeFlag = false;
  bool    stopFlag   = false;
  bool    resetFlag  = false;
  int16_t newMode    = -1;   // 1..5 or -1
  int16_t newTarget  = -1;   // 0..9999 or -1
  int16_t newSet1    = -1;
  int16_t newSet2    = -1;
  int16_t newColorR  = -1;   // 1..2 or -1
  int16_t newColorS  = -1;
};
PendingCmd pending;
SemaphoreHandle_t cmdMutex = nullptr;
TaskHandle_t modbusTaskHandle = nullptr;

// ---------- Modbus helpers (timeout ngan + skip slave offline) ----------
ModbusRTU mb;
static uint16_t io_buf = 0;
static volatile bool io_ok = false;

#define MB_TIMEOUT_MS   180
#define MB_OFFLINE_MS  2000   // sau khi fail, skip slave trong 2s

// Trang thai online cua tung slave
struct SlaveLink { bool online = true; uint32_t lastFailMs = 0; };
SlaveLink link1, link2;
SlaveLink& linkOf(uint8_t id) { return (id == SLAVE1_ID) ? link1 : link2; }

bool ioCb(Modbus::ResultCode event, uint16_t /*tid*/, void* /*data*/) {
  io_ok = (event == Modbus::EX_SUCCESS);
  return true;
}

bool slaveSkippable(uint8_t id) {
  SlaveLink& L = linkOf(id);
  if (L.online) return false;
  return (millis() - L.lastFailMs) < MB_OFFLINE_MS;
}

void markSlave(uint8_t id, bool ok) {
  SlaveLink& L = linkOf(id);
  L.online = ok;
  if (!ok) L.lastFailMs = millis();
}

bool readReg(uint8_t slaveId, uint16_t addr, uint16_t &out) {
  if (slaveSkippable(slaveId)) return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) { mb.task(); delay(1); }
  io_buf = 0; io_ok = false;
  if (!mb.readHreg(slaveId, addr, &io_buf, 1, ioCb)) { markSlave(slaveId, false); return false; }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) { mb.task(); delay(1); }
  if (io_ok) { out = io_buf; markSlave(slaveId, true); return true; }
  markSlave(slaveId, false);
  return false;
}

// Doc lien tiep nhieu register trong 1 transaction Modbus (nhanh hon nhieu lan goi).
bool readRegs(uint8_t slaveId, uint16_t addr, uint16_t* outArr, uint16_t count) {
  if (slaveSkippable(slaveId)) return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) { mb.task(); delay(1); }
  io_ok = false;
  if (!mb.readHreg(slaveId, addr, outArr, count, ioCb)) { markSlave(slaveId, false); return false; }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) { mb.task(); delay(1); }
  if (io_ok) { markSlave(slaveId, true); return true; }
  markSlave(slaveId, false);
  return false;
}

bool writeReg(uint8_t slaveId, uint16_t addr, uint16_t value) {
  if (slaveSkippable(slaveId)) return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) { mb.task(); delay(1); }
  io_ok = false;
  if (!mb.writeHreg(slaveId, addr, value, ioCb)) { markSlave(slaveId, false); return false; }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) { mb.task(); delay(1); }
  if (io_ok) { markSlave(slaveId, true); return true; }
  markSlave(slaveId, false);
  return false;
}

bool writeBoth(uint16_t addr, uint16_t value) {
  bool a = writeReg(SLAVE1_ID, addr, value);
  bool b = writeReg(SLAVE2_ID, addr, value);
  return a && b;
}

// ---------- Helpers cao cap ----------
void sendSigBoth(uint16_t sig) { writeBoth(HR_MASTER_SIG, sig); }

void pushModeAndColors() {
  writeBoth(HR_COLOR_READY, colorReady);
  writeBoth(HR_COLOR_STOP, colorStop);
  writeBoth(HR_MODE, currentMode);
}

void setMode(uint8_t m) {
  if (m < 1 || m > 5) return;
  currentMode = m;
  mState = M_IDLE;
  tStart_ms = tElapsed_ms = 0;
  mode2Winner = 0;
  pushModeAndColors();
  sendSigBoth(SIG_IDLE);
}

void armCurrent() {
  pushModeAndColors();
  if (currentMode == 3 || currentMode == 4) writeBoth(HR_TARGET, targetSec);
  sendSigBoth(SIG_ARM);
  mState = M_ARMED;
  tStart_ms = tElapsed_ms = 0;
  mode2Winner = 0;
}

void startCurrent() {
  if (currentMode == 1) {
    sendSigBoth(SIG_START);
    writeReg(SLAVE1_ID, HR_TRIG_FLAG, 0);
    writeReg(SLAVE2_ID, HR_TRIG_FLAG, 0);
    mState = M_ARMED;
    tStart_ms = tElapsed_ms = 0;
    return;
  }
  if (currentMode == 3 || currentMode == 4) writeBoth(HR_TARGET, targetSec);
  sendSigBoth(SIG_START);
  tStart_ms = millis();
  tElapsed_ms = 0;
  mState = M_RUNNING;
}

void pauseCurrent() {
  if (mState != M_RUNNING) return;
  sendSigBoth(SIG_PAUSE);
  if (currentMode == 1) tElapsed_ms += (millis() - tStart_ms);
  mState = M_PAUSED;
}

void resumeCurrent() {
  if (mState != M_PAUSED) return;
  sendSigBoth(SIG_RESUME);
  if (currentMode == 1) tStart_ms = millis();
  mState = M_RUNNING;
}

void stopAndPushFinal(uint32_t finalMs) {
  uint16_t s  = (uint16_t)(finalMs / 1000);
  uint16_t ms = (uint16_t)(finalMs % 1000);
  writeBoth(HR_SEC, s);
  writeBoth(HR_MS, ms);
  sendSigBoth(SIG_FINAL);
  mState = M_FINISHED;
}

void stopCurrent() {
  if (mState == M_RUNNING && currentMode == 1) {
    uint32_t total = tElapsed_ms + (millis() - tStart_ms);
    stopAndPushFinal(total);
  } else {
    sendSigBoth(SIG_IDLE);
    mState = M_IDLE;
  }
}

void resetAll() {
  mState = M_IDLE;
  tStart_ms = tElapsed_ms = 0;
  mode2Winner = 0;
  sendSigBoth(SIG_IDLE);
}

// ---------- Tick theo mode ----------
void tickMode1() {
  uint16_t trig = 0;
  if (mState == M_ARMED) {
    if (readReg(SLAVE1_ID, HR_TRIG_FLAG, trig) && trig == 1) {
      writeReg(SLAVE1_ID, HR_TRIG_FLAG, 0);
      writeReg(SLAVE2_ID, HR_TRIG_FLAG, 0);
      tStart_ms = millis();
      tElapsed_ms = 0;
      mState = M_RUNNING;
    }
  } else if (mState == M_RUNNING) {
    if (readReg(SLAVE2_ID, HR_TRIG_FLAG, trig) && trig == 1) {
      writeReg(SLAVE2_ID, HR_TRIG_FLAG, 0);
      uint32_t total = tElapsed_ms + (millis() - tStart_ms);
      stopAndPushFinal(total);
    }
  }
}

void tickMode2() {
  if (mState != M_RUNNING) return;
  for (int idx = 0; idx < 2; idx++) {
    uint8_t id = (idx == 0) ? SLAVE1_ID : SLAVE2_ID;
    uint8_t other = (idx == 0) ? SLAVE2_ID : SLAVE1_ID;
    uint16_t trig = 0;
    if (!readReg(id, HR_TRIG_FLAG, trig)) continue;
    if (trig != 1) continue;
    writeReg(id, HR_TRIG_FLAG, 0);
    uint16_t s = 0, ms = 0;
    readReg(id, HR_SEC, s);
    readReg(id, HR_MS, ms);
    writeReg(other, HR_SEC, s);
    writeReg(other, HR_MS, ms);
    writeReg(other, HR_MASTER_SIG, SIG_FINAL);
    mode2Winner = id;
    mState = M_FINISHED;
    return;
  }
}

void tickMode34() {
  if (mState != M_RUNNING) return;
  uint16_t st1 = 0, st2 = 0;
  bool ok1 = readReg(SLAVE1_ID, HR_COUNT_STATE, st1);
  bool ok2 = readReg(SLAVE2_ID, HR_COUNT_STATE, st2);
  if (ok1 && ok2 && st1 == 200 && st2 == 200) {
    mState = M_FINISHED;
  }
}

// ---------- Poll cache trang thai 2 slave (cho /api/status) ----------
// Doc SEC, MS, COUNT_STATE bang 1 transaction (3 reg lien tiep).
void pollStatusCache() {
  uint16_t buf[3];
  // Slave 1: 3 reg lien tiep tu HR_SEC (2..4)
  if (readRegs(SLAVE1_ID, HR_SEC, buf, 3)) {
    cache1.sec   = buf[0];
    cache1.ms    = buf[1];
    cache1.state = buf[2];
    if (currentMode == 5) cache1.value = buf[0];
  }
  cache1.online = link1.online;

  // Slave 2
  if (readRegs(SLAVE2_ID, HR_SEC, buf, 3)) {
    cache2.sec   = buf[0];
    cache2.ms    = buf[1];
    cache2.state = buf[2];
    if (currentMode == 5) cache2.value = buf[0];
  }
  cache2.online = link2.online;
}

// ============================================================
//                       WEB SERVER
// ============================================================
WebServer server(80);

void apiOk() {
  server.send(200, "application/json", "{\"ok\":true}");
}
void apiErr(const char* msg) {
  String s = String("{\"ok\":false,\"err\":\"") + msg + "\"}";
  server.send(400, "application/json", s);
}

void apiStatus() {
  StaticJsonDocument<512> doc;
  doc["mode"]      = (uint8_t)currentMode;
  doc["mState"]    = (int)mState;
  doc["target"]    = (uint16_t)targetSec;
  doc["colorReady"] = (uint16_t)colorReady;
  doc["colorStop"] = (uint16_t)colorStop;
  doc["winner"]    = (uint8_t)mode2Winner;

  // Thoi gian dang chay tren master (mode 1) - tinh tu millis() atomic.
  uint32_t live_ms = tElapsed_ms;
  if (mState == M_RUNNING && currentMode == 1) live_ms += (millis() - tStart_ms);
  doc["masterMs"] = live_ms;

  JsonObject s1 = doc["slave1"].to<JsonObject>();
  s1["online"] = cache1.online;
  s1["state"]  = cache1.state;
  s1["sec"]    = cache1.sec;
  s1["ms"]     = cache1.ms;
  s1["value"]  = cache1.value;

  JsonObject s2 = doc["slave2"].to<JsonObject>();
  s2["online"] = cache2.online;
  s2["state"]  = cache2.state;
  s2["sec"]    = cache2.sec;
  s2["ms"]     = cache2.ms;
  s2["value"]  = cache2.value;

  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

void apiMode() {
  if (!server.hasArg("m")) { apiErr("missing m"); return; }
  int m = server.arg("m").toInt();
  if (m < 1 || m > 5) { apiErr("mode 1..5"); return; }
  setMode((uint8_t)m);
  apiOk();
}

void apiArm()    { armCurrent();    apiOk(); }
void apiStart()  { startCurrent();  apiOk(); }
void apiPause()  { pauseCurrent();  apiOk(); }
void apiResume() { resumeCurrent(); apiOk(); }
void apiStop()   { stopCurrent();   apiOk(); }
void apiReset()  { resetAll();      apiOk(); }

void apiTarget() {
  if (!server.hasArg("s")) { apiErr("missing s"); return; }
  int n = server.arg("s").toInt();
  if (n < 0) n = 0; if (n > 9999) n = 9999;
  targetSec = (uint16_t)n;
  writeBoth(HR_TARGET, targetSec);
  apiOk();
}

void apiSet() {
  if (!server.hasArg("slave") || !server.hasArg("v")) { apiErr("missing slave/v"); return; }
  int sl = server.arg("slave").toInt();
  int n  = server.arg("v").toInt();
  if (sl != 1 && sl != 2) { apiErr("slave 1|2"); return; }
  if (n < 0) n = 0; if (n > 9999) n = 9999;
  writeReg((uint8_t)sl, HR_TARGET, (uint16_t)n);
  apiOk();
}

void apiColor() {
  if (server.hasArg("ready")) {
    int v = server.arg("ready").toInt();
    if (v == 1 || v == 2) colorReady = v;
  }
  if (server.hasArg("stop")) {
    int v = server.arg("stop").toInt();
    if (v == 1 || v == 2) colorStop = v;
  }
  writeBoth(HR_COLOR_READY, colorReady);
  writeBoth(HR_COLOR_STOP, colorStop);
  apiOk();
}

// ---------- Phuc vu static file tu LittleFS ----------
String contentTypeOf(const String& path) {
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html; charset=utf-8";
  if (path.endsWith(".css"))  return "text/css; charset=utf-8";
  if (path.endsWith(".js"))   return "application/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".png"))  return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  if (path.endsWith(".ico"))  return "image/x-icon";
  if (path.endsWith(".md"))   return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

bool serveFile(const String& path) {
  String p = path;
  if (p == "/" || p.length() == 0) p = "/index.html";
  if (!LittleFS.exists(p)) return false;
  File f = LittleFS.open(p, "r");
  if (!f) return false;
  server.streamFile(f, contentTypeOf(p));
  f.close();
  return true;
}

void handleNotFound() {
  if (serveFile(server.uri())) return;
  server.send(404, "text/plain", "Not found: " + server.uri());
}

// ---------- Serial console (giu de debug) ----------
String inLine = "";
void handleLine(String line) {
  line.trim();
  if (line.isEmpty()) return;
  if (line == "help") {
    Serial.println(F("mode N | arm | start | pause | resume | stop | reset | target N | set1 N | set2 N | status"));
    return;
  }
  if (line == "arm")    { armCurrent();   Serial.println("ARM");    return; }
  if (line == "start")  { startCurrent(); Serial.println("START");  return; }
  if (line == "pause")  { pauseCurrent(); Serial.println("PAUSE");  return; }
  if (line == "resume") { resumeCurrent();Serial.println("RESUME"); return; }
  if (line == "stop")   { stopCurrent();  Serial.println("STOP");   return; }
  if (line == "reset")  { resetAll();     Serial.println("RESET");  return; }
  if (line == "status") {
    Serial.printf("Mode=%u State=%d Target=%u | S1 st=%u %u.%03u online=%d | S2 st=%u %u.%03u online=%d\n",
                  currentMode, (int)mState, targetSec,
                  cache1.state, cache1.sec, cache1.ms, cache1.online,
                  cache2.state, cache2.sec, cache2.ms, cache2.online);
    return;
  }
  int sp = line.indexOf(' ');
  if (sp < 0) { Serial.println("?"); return; }
  String cmd = line.substring(0, sp);
  String arg = line.substring(sp + 1);
  if (cmd == "mode")   { setMode(arg.toInt()); return; }
  if (cmd == "target") { targetSec = constrain(arg.toInt(), 0, 9999); writeBoth(HR_TARGET, targetSec); return; }
  if (cmd == "set1")   { writeReg(SLAVE1_ID, HR_TARGET, constrain(arg.toInt(), 0, 9999)); return; }
  if (cmd == "set2")   { writeReg(SLAVE2_ID, HR_TARGET, constrain(arg.toInt(), 0, 9999)); return; }
  Serial.println("?");
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { handleLine(inLine); inLine = ""; }
    else if (inLine.length() < 80) inLine += c;
  }
}

// ---------- WiFi setup (AP only) ----------
void setupWiFi() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(AP_IP, AP_GW, AP_MASK);
  bool ok = WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("\nAP %s | pass: %s | IP: %s\n",
                ok ? AP_SSID : "(fail)", AP_PASSWORD,
                WiFi.softAPIP().toString().c_str());
}

void setupRoutes() {
  server.on("/api/status",  HTTP_GET,  apiStatus);
  server.on("/api/mode",    HTTP_POST, apiMode);
  server.on("/api/mode",    HTTP_GET,  apiMode);
  server.on("/api/arm",     HTTP_POST, apiArm);
  server.on("/api/arm",     HTTP_GET,  apiArm);
  server.on("/api/start",   HTTP_POST, apiStart);
  server.on("/api/start",   HTTP_GET,  apiStart);
  server.on("/api/pause",   HTTP_POST, apiPause);
  server.on("/api/pause",   HTTP_GET,  apiPause);
  server.on("/api/resume",  HTTP_POST, apiResume);
  server.on("/api/resume",  HTTP_GET,  apiResume);
  server.on("/api/stop",    HTTP_POST, apiStop);
  server.on("/api/stop",    HTTP_GET,  apiStop);
  server.on("/api/reset",   HTTP_POST, apiReset);
  server.on("/api/reset",   HTTP_GET,  apiReset);
  server.on("/api/target",  HTTP_POST, apiTarget);
  server.on("/api/target",  HTTP_GET,  apiTarget);
  server.on("/api/set",     HTTP_POST, apiSet);
  server.on("/api/set",     HTTP_GET,  apiSet);
  server.on("/api/color",   HTTP_POST, apiColor);
  server.on("/api/color",   HTTP_GET,  apiColor);

  server.on("/", HTTP_GET, []() {
    if (!serveFile("/index.html")) server.send(500, "text/plain", "index.html missing - upload data");
  });
  server.onNotFound(handleNotFound);
}

// ============================================================
//                          SETUP / LOOP
// ============================================================
uint32_t lastTickMs = 0;

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\n=== MASTER (Web + LoRa Modbus) ===");

  Serial2.begin(LORA_BAUD, SERIAL_8N1, LORA_RX_PIN, LORA_TX_PIN);
  mb.begin(&Serial2);
  mb.master();
  delay(150);

  if (!LittleFS.begin(true)) Serial.println("LittleFS mount fail!");
  else                       Serial.println("LittleFS OK.");

  setupWiFi();
  setupRoutes();
  server.begin();
  Serial.println("HTTP server started.");

  // Day cau hinh khoi tao xuong 2 slave
  pushModeAndColors();
  sendSigBoth(SIG_IDLE);

  Serial.println("Type 'help' for serial commands.");
}

void loop() {
  mb.task();
  server.handleClient();
  pollSerial();

  // Mode 1 dang dua: poll het toc do.
  bool mode1Race = (currentMode == 1 && (mState == M_ARMED || mState == M_RUNNING));

  if (mode1Race) {
    tickMode1();
  } else if (millis() - lastTickMs > 100) {
    lastTickMs = millis();
    switch (currentMode) {
      case 1: tickMode1();  break;
      case 2: tickMode2();  break;
      case 3: tickMode34(); break;
      case 4: tickMode34(); break;
      case 5: /* khong tick tich cuc */ break;
    }
  }

  // Cache poll (skip khi mode 1 dang dua - master tu cap nhat masterMs).
  if (!mode1Race) {
    static uint32_t lastCache = 0;
    uint32_t cacheInt = (mState == M_RUNNING || mState == M_PAUSED) ? 250 : 800;
    if (millis() - lastCache > cacheInt) {
      lastCache = millis();
      pollStatusCache();
    }
  }

  delay(1);
}
