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
#include "driver/i2s.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <ModbusRTU.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_timer.h>

// ---------- HW LoRa ----------
#define LORA_RX_PIN 16
#define LORA_TX_PIN 17
#define LORA_BAUD 115200

// ---------- I2S Audio (loa phat hieu ung am thanh, vd MAX98357A) ----------
#define I2S_BCK 25
#define I2S_LRCK 32
#define I2S_DOUT 33
#define I2S_PORT I2S_NUM_0

void setupI2S() {
  i2s_config_t i2s_config = {.mode =
                                 (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
                             .sample_rate = 16000,
                             .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
                             .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
                             .communication_format = I2S_COMM_FORMAT_STAND_I2S,
                             .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
                             .dma_buf_count = 8,
                             .dma_buf_len = 512,
                             .use_apll = false,
                             .tx_desc_auto_clear = true,
                             .fixed_mclk = 0};
  i2s_pin_config_t pin_config = {.bck_io_num = I2S_BCK,
                                 .ws_io_num = I2S_LRCK,
                                 .data_out_num = I2S_DOUT,
                                 .data_in_num = I2S_PIN_NO_CHANGE};
  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
}

// Phat 1 file WAV (16kHz/16bit mono) tu LittleFS. Blocking cho den khi phat
// xong.
void playWav(const char *path) {
  File wavFile = LittleFS.open(path, "r");
  if (!wavFile) {
    Serial.printf("Khong mo duoc WAV: %s\n", path);
    return;
  }
  wavFile.seek(44); // bo qua header WAV 44 byte
  uint8_t buffer[1024];
  size_t bytesRead, bytesWritten;
  while (wavFile.available()) {
    bytesRead = wavFile.read(buffer, sizeof(buffer));
    i2s_write(I2S_PORT, buffer, bytesRead, &bytesWritten, portMAX_DELAY);
  }
  wavFile.close();
}

// ---------- Slave IDs ----------
#define SLAVE1_ID 1
#define SLAVE2_ID 2

// ---------- WiFi (AP only, master phat song) ----------
const char *AP_SSID = "PatinMaster";
const char *AP_PASSWORD = "12345678";
// IP co dinh cua AP cho de nho
IPAddress AP_IP(192, 168, 4, 1);
IPAddress AP_GW(192, 168, 4, 1);
IPAddress AP_MASK(255, 255, 255, 0);

// ---------- MODBUS REG MAP (phai khop slave) ----------
enum {
  HR_SLAVE_ID = 0,
  HR_MODE = 1,
  HR_SEC = 2,
  HR_MS = 3,
  HR_COUNT_STATE = 4,
  HR_MASTER_SIG = 5,
  HR_COLOR_READY = 6,
  HR_COLOR_STOP = 7,
  HR_SYNC_FLAG = 8,
  HR_TARGET = 9,
  HR_TRIG_FLAG = 10
};

enum {
  SIG_IDLE = 0,
  SIG_ARM = 100,
  SIG_START = 110,
  SIG_PAUSE = 120,
  SIG_RESUME = 130,
  SIG_FINAL = 250
};

// ---------- Master state ----------
enum MState { M_IDLE, M_ARMED, M_RUNNING, M_PAUSED, M_FINISHED };
volatile MState mState = M_IDLE;

volatile uint8_t currentMode = 1;
volatile uint16_t targetSec = 10;
volatile uint16_t colorSlave1 = 1;
volatile uint16_t colorSlave2 = 2;

// Dung milliseconds (uint32) thay vi int64 us -> read atomic, an toan
// cross-task.
volatile uint32_t tStart_ms = 0;
volatile uint32_t tElapsed_ms = 0;

// Rev snapshot man chiếu (GET /api/display?rev= — tra 304 neu khong doi)
static uint32_t displayRevCached = 0;

// Cache trang thai cuoi cua tung slave (cho /api/status, tranh poll moi
// request)
struct SlaveCache {
  volatile uint16_t state = 0;
  volatile uint16_t sec = 0;
  volatile uint16_t ms = 0;
  volatile uint16_t value = 0;
  volatile bool online = false;
};
SlaveCache cache1, cache2;

volatile uint8_t mode2Winner = 0;
volatile uint16_t timeLapseSeq = 0;
volatile uint32_t timeLapseLastMs = 0;

// ---------- Mode 1 audio state ----------
// Thoi diem bat dau lang nghe cam bien slave1 (ngay sau ready.wav).
volatile uint32_t mode1ArmMs = 0;
volatile bool mode1BepPlayed = false;

// ---------- Command queue (web -> modbus task) ----------
struct PendingCmd {
  bool armFlag = false;
  bool startFlag = false;
  bool pauseFlag = false;
  bool resumeFlag = false;
  bool stopFlag = false;
  bool resetFlag = false;
  int16_t newMode = -1;   // 1..6 or -1
  int16_t newTarget = -1; // 0..9999 or -1
  int16_t newSet1 = -1;
  int16_t newSet2 = -1;
  int16_t newColorR = -1; // 1..2 or -1
  int16_t newColorS = -1;
};
PendingCmd pending;
SemaphoreHandle_t cmdMutex = nullptr;
TaskHandle_t modbusTaskHandle = nullptr;

// ---------- Modbus helpers (timeout ngan + skip slave offline) ----------
ModbusRTU mb;
static uint16_t io_buf = 0;
static volatile bool io_ok = false;

#define MB_TIMEOUT_MS 100
#define MB_OFFLINE_MS 2000 // sau khi fail, skip slave trong 2s

// Trang thai online cua tung slave
struct SlaveLink {
  bool online = true;
  uint32_t lastFailMs = 0;
};
SlaveLink link1, link2;
SlaveLink &linkOf(uint8_t id) { return (id == SLAVE1_ID) ? link1 : link2; }

bool ioCb(Modbus::ResultCode event, uint16_t /*tid*/, void * /*data*/) {
  io_ok = (event == Modbus::EX_SUCCESS);
  return true;
}

bool slaveSkippable(uint8_t id) {
  SlaveLink &L = linkOf(id);
  if (L.online)
    return false;
  return (millis() - L.lastFailMs) < MB_OFFLINE_MS;
}

void markSlave(uint8_t id, bool ok) {
  SlaveLink &L = linkOf(id);
  L.online = ok;
  if (!ok)
    L.lastFailMs = millis();
}

bool readReg(uint8_t slaveId, uint16_t addr, uint16_t &out) {
  if (slaveSkippable(slaveId))
    return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  io_buf = 0;
  io_ok = false;
  if (!mb.readHreg(slaveId, addr, &io_buf, 1, ioCb)) {
    markSlave(slaveId, false);
    return false;
  }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  if (io_ok) {
    out = io_buf;
    markSlave(slaveId, true);
    return true;
  }
  markSlave(slaveId, false);
  return false;
}

// Doc lien tiep nhieu register trong 1 transaction Modbus (nhanh hon nhieu lan
// goi).
bool readRegs(uint8_t slaveId, uint16_t addr, uint16_t *outArr,
              uint16_t count) {
  if (slaveSkippable(slaveId))
    return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  io_ok = false;
  if (!mb.readHreg(slaveId, addr, outArr, count, ioCb)) {
    markSlave(slaveId, false);
    return false;
  }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  if (io_ok) {
    markSlave(slaveId, true);
    return true;
  }
  markSlave(slaveId, false);
  return false;
}

bool writeReg(uint8_t slaveId, uint16_t addr, uint16_t value) {
  if (slaveSkippable(slaveId))
    return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  io_ok = false;
  if (!mb.writeHreg(slaveId, addr, value, ioCb)) {
    markSlave(slaveId, false);
    return false;
  }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  if (io_ok) {
    markSlave(slaveId, true);
    return true;
  }
  markSlave(slaveId, false);
  return false;
}

bool writeBoth(uint16_t addr, uint16_t value) {
  bool a = writeReg(SLAVE1_ID, addr, value);
  bool b = writeReg(SLAVE2_ID, addr, value);
  return a && b;
}

// Broadcast Modbus (slaveId = 0): CA 2 slave nhan CUNG 1 frame, khong ai reply.
// -> ghi 1 lan duy nhat thay vi 2 lan tuan tu, nen 2 slave start/pause dong
// thoi,
//    khong bi lech thoi gian. Dung cho mode 2 (dua) de dem lien, khong tre.
// Khong cho ack -> khong cap nhat trang thai online cua slave.
// LUU Y: chi gui 1 frame moi lan goi. Sau khi gui, doi MB_BCAST_SETTLE_MS cho
// frame
//        bay het qua LoRa truoc khi master gui/doc gi tiep (LoRa ban song cong,
//        2 frame sat nhau se dinh -> slave doc loi CRC -> mat lenh).
#define MB_BCAST_SETTLE_MS 60

bool writeBroadcast(uint16_t addr, uint16_t value) {
  // Doi transaction truoc (neu co) xong de master ranh roi moi broadcast.
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  // writeHreg(0,...) gui frame ngay trong loi goi (rawSend dong bo), khong cho
  // phan hoi.
  bool sent = mb.writeHreg(0, addr, value);
  // Cho frame bay het qua LoRa truoc khi co traffic Modbus khac.
  t0 = millis();
  while (millis() - t0 < MB_BCAST_SETTLE_MS) {
    mb.task();
    delay(1);
  }
  return sent;
}

bool writeRegs(uint8_t slaveId, uint16_t addr, uint16_t *valueArr,
               uint16_t count) {
  if (slaveSkippable(slaveId))
    return false;
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  io_ok = false;
  if (!mb.writeHreg(slaveId, addr, valueArr, count, ioCb)) {
    markSlave(slaveId, false);
    return false;
  }
  t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  if (io_ok) {
    markSlave(slaveId, true);
    return true;
  }
  markSlave(slaveId, false);
  return false;
}

bool writeRegsBoth(uint16_t addr, uint16_t *valueArr, uint16_t count) {
  bool a = writeRegs(SLAVE1_ID, addr, valueArr, count);
  bool b = writeRegs(SLAVE2_ID, addr, valueArr, count);
  return a && b;
}

bool writeRegsBroadcast(uint16_t addr, uint16_t *valueArr, uint16_t count) {
  uint32_t t0 = millis();
  while (mb.slave() && millis() - t0 < MB_TIMEOUT_MS) {
    mb.task();
    delay(1);
  }
  bool sent = mb.writeHreg(0, addr, valueArr, count);
  t0 = millis();
  while (millis() - t0 < MB_BCAST_SETTLE_MS) {
    mb.task();
    delay(1);
  }
  return sent;
}

// ---------- Helpers cao cap ----------
void sendSigBoth(uint16_t sig) { writeBoth(HR_MASTER_SIG, sig); }
// Gui tin hieu cho ca 2 slave cung luc bang broadcast (dung trong mode 2).
void sendSigBroadcast(uint16_t sig) { writeBroadcast(HR_MASTER_SIG, sig); }

void pushModeAndColors() {
  writeReg(SLAVE1_ID, HR_COLOR_READY, colorSlave1);
  writeReg(SLAVE1_ID, HR_COLOR_STOP, colorSlave1);
  if (currentMode == 6) {
    writeReg(SLAVE1_ID, HR_MODE, currentMode);
    return;
  }
  writeReg(SLAVE2_ID, HR_COLOR_READY, colorSlave2);
  writeReg(SLAVE2_ID, HR_COLOR_STOP, colorSlave2);
  writeBoth(HR_MODE, currentMode);
}

// Reset sach toan bo trang thai dua (state, timer, winner, co am thanh, cache
// slave).
void clearRaceState() {
  mState = M_IDLE;
  tStart_ms = tElapsed_ms = 0;
  mode2Winner = 0;
  timeLapseSeq = 0;
  timeLapseLastMs = 0;
  mode1ArmMs = 0;
  mode1BepPlayed = false;
  cache1.state = cache1.sec = cache1.ms = cache1.value = 0;
  cache2.state = cache2.sec = cache2.ms = cache2.value = 0;
}

void setMode(uint8_t m) {
  if (m < 1 || m > 6)
    return;
  currentMode = m;
  clearRaceState(); // doi mode -> reset sach de mode moi chay dung
  pushModeAndColors();

  uint16_t regs[4];
  regs[0] = 0;        // HR_SEC
  regs[1] = 0;        // HR_MS
  regs[2] = 0;        // HR_COUNT_STATE
  regs[3] = SIG_IDLE; // HR_MASTER_SIG
  if (currentMode == 6)
    writeRegs(SLAVE1_ID, HR_SEC, regs, 4);
  else
    writeRegsBoth(HR_SEC, regs, 4);
}

void armCurrent() {
  pushModeAndColors();
  if (currentMode == 3 || currentMode == 4)
    writeBoth(HR_TARGET, targetSec);

  uint16_t regs[4];
  regs[0] = 0;       // HR_SEC
  regs[1] = 0;       // HR_MS
  regs[2] = 0;       // HR_COUNT_STATE
  regs[3] = SIG_ARM; // HR_MASTER_SIG
  if (currentMode == 6)
    writeRegs(SLAVE1_ID, HR_SEC, regs, 4);
  else
    writeRegsBoth(HR_SEC, regs, 4);

  mState = M_ARMED;
  tStart_ms = tElapsed_ms = 0;
  mode2Winner = 0;
}

bool consumeTrig(uint8_t id) {
  uint16_t trig = 0;
  if (readReg(id, HR_TRIG_FLAG, trig) && trig > 0) {
    writeReg(id, HR_TRIG_FLAG, 0);
    return true;
  }
  return false;
}

void stopAndPushFinal(uint32_t finalMs);

void falseStartMode1() {
  playWav("/bepbep.wav");
  stopAndPushFinal(0);
  mode1BepPlayed = true;
}

void falseStartMode2(uint8_t offender) {
  playWav("/bepbep.wav");
  mode2Winner = (offender == SLAVE1_ID) ? SLAVE2_ID : SLAVE1_ID;
  cache1.sec = cache1.ms = 0;
  cache2.sec = cache2.ms = 0;
  cache1.state = cache2.state = 200;

  uint16_t regs[4];
  regs[0] = 0;
  regs[1] = 0;
  regs[2] = 200;
  regs[3] = SIG_FINAL;
  writeRegsBoth(HR_SEC, regs, 4);
  mState = M_FINISHED;
}

bool checkFalseStartMode1() {
  bool hit = consumeTrig(SLAVE1_ID) || consumeTrig(SLAVE2_ID);
  if (hit)
    falseStartMode1();
  return hit;
}

bool checkFalseStartMode2() {
  if (consumeTrig(SLAVE1_ID)) {
    falseStartMode2(SLAVE1_ID);
    return true;
  }
  if (consumeTrig(SLAVE2_ID)) {
    falseStartMode2(SLAVE2_ID);
    return true;
  }
  return false;
}

bool waitIntro(uint32_t ms, uint8_t mode) {
  uint32_t start = millis();
  while (millis() - start < ms) {
    if (mode == 1 && checkFalseStartMode1())
      return false;
    if (mode == 2 && checkFalseStartMode2())
      return false;
    delay(10);
  }
  return true;
}

void startCurrent() {
  if (currentMode == 1) {
    // --- Hieu ung am thanh intro ---
    // teng -> nghi 1s -> onyourmask -> nghi 3s -> ready (dong thoi bao slave
    // dem xuong)
    playWav("/teng.wav");
    if (checkFalseStartMode1())
      return;
    if (!waitIntro(1000, 1))
      return;
    playWav("/onyourmask.wav");
    if (checkFalseStartMode1())
      return;
    if (!waitIntro(3000, 1))
      return;
    if (checkFalseStartMode1())
      return;
    // Ready: bao 2 slave bat dau dem xuong (ve hinh vuong)
    uint16_t regs[4];
    regs[0] = 0;         // HR_SEC
    regs[1] = 0;         // HR_MS
    regs[2] = 100;       // HR_COUNT_STATE (RUNNING)
    regs[3] = SIG_START; // HR_MASTER_SIG
    writeRegsBoth(HR_SEC, regs, 4);

    writeReg(SLAVE1_ID, HR_TRIG_FLAG, 0);
    writeReg(SLAVE2_ID, HR_TRIG_FLAG, 0);
    playWav("/ready.wav");
    mState = M_ARMED;
    tStart_ms = tElapsed_ms = 0;
    mode1ArmMs = millis();
    mode1BepPlayed = false;
    return;
  }
  if (currentMode == 2) {
    // --- Hieu ung am thanh intro mode 2 ---
    // teng -> nghi 1s -> onyourmask -> nghi 3s -> set -> nghi 5s -> sung (bat
    // dau)
    playWav("/teng.wav");
    if (checkFalseStartMode2())
      return;
    if (!waitIntro(1000, 2))
      return;
    playWav("/onyourmask.wav");
    if (checkFalseStartMode2())
      return;
    if (!waitIntro(3000, 2))
      return;
    playWav("/set.wav");
    if (checkFalseStartMode2())
      return;
    if (!waitIntro(5000, 2))
      return;
    if (checkFalseStartMode2())
      return;
    // Sung: broadcast 1 frame duy nhat -> CA 2 slave bat dau dem CUNG LUC
    uint16_t regs[4];
    regs[0] = 0;         // HR_SEC
    regs[1] = 0;         // HR_MS
    regs[2] = 100;       // HR_COUNT_STATE (RUNNING)
    regs[3] = SIG_START; // HR_MASTER_SIG
    writeRegsBroadcast(HR_SEC, regs, 4);

    cache1.state = 0;
    cache2.state = 0;
    playWav("/sung.wav");
    mState = M_RUNNING;
    tStart_ms = tElapsed_ms = 0;
    mode2Winner = 0;
    return;
  }
  if (currentMode == 3 || currentMode == 4) {
    writeBoth(HR_TARGET, targetSec);

    uint16_t regs[4];
    regs[0] = 0;         // HR_SEC
    regs[1] = 0;         // HR_MS
    regs[2] = 100;       // HR_COUNT_STATE (RUNNING)
    regs[3] = SIG_START; // HR_MASTER_SIG
    writeRegsBoth(HR_SEC, regs, 4);

    mState = M_RUNNING;
    tStart_ms = tElapsed_ms = 0;
  }
  if (currentMode == 6) {
    // Time lapse dung hieu lenh giong dau don:
    // teng -> nghi 1s -> onyourmask -> nghi 3s -> ready, roi cho cam bien dau.
    playWav("/teng.wav");
    delay(1000);
    playWav("/onyourmask.wav");
    delay(3000);

    uint16_t runRegs[4];
    runRegs[0] = 0;         // HR_SEC
    runRegs[1] = 0;         // HR_MS
    runRegs[2] = 0;         // HR_COUNT_STATE (wait first trigger)
    runRegs[3] = SIG_START; // slave1 arms time-lapse sensor
    writeRegs(SLAVE1_ID, HR_SEC, runRegs, 4);

    writeReg(SLAVE1_ID, HR_TRIG_FLAG, 0);
    playWav("/ready.wav");
    mState = M_ARMED;
    tStart_ms = tElapsed_ms = 0;
    timeLapseSeq = 0;
    timeLapseLastMs = 0;
  }
}

void pauseCurrent() {
  if (mState != M_RUNNING)
    return;
  // Mode 2 (dua): broadcast de 2 slave pause cung luc, khong lech.
  if (currentMode == 2)
    sendSigBroadcast(SIG_PAUSE);
  else if (currentMode == 6)
    writeReg(SLAVE1_ID, HR_MASTER_SIG, SIG_PAUSE);
  else
    sendSigBoth(SIG_PAUSE);
  if (currentMode == 1)
    tElapsed_ms += (millis() - tStart_ms);
  mState = M_PAUSED;
}

void resumeCurrent() {
  if (mState != M_PAUSED)
    return;
  // Mode 2: broadcast resume cho dong bo voi pause.
  if (currentMode == 2)
    sendSigBroadcast(SIG_RESUME);
  else if (currentMode == 6)
    writeReg(SLAVE1_ID, HR_MASTER_SIG, SIG_RESUME);
  else
    sendSigBoth(SIG_RESUME);
  if (currentMode == 1)
    tStart_ms = millis();
  mState = M_RUNNING;
}

void stopAndPushFinal(uint32_t finalMs) {
  // Luu final time vao tElapsed_ms -> apiStatus tra masterMs dung sau khi STOP.
  tElapsed_ms = finalMs;
  tStart_ms = 0;
  uint16_t s = (uint16_t)(finalMs / 1000);
  uint16_t ms = (uint16_t)(finalMs % 1000);

  uint16_t regs[4];
  regs[0] = s;         // HR_SEC
  regs[1] = ms;        // HR_MS
  regs[2] = 200;       // HR_COUNT_STATE (STOPPED)
  regs[3] = SIG_FINAL; // HR_MASTER_SIG
  writeRegsBoth(HR_SEC, regs, 4);

  mState = M_FINISHED;
}

void stopCurrent() {
  if (mState == M_RUNNING) {
    if (currentMode == 1) {
      uint32_t total = tElapsed_ms + (millis() - tStart_ms);
      stopAndPushFinal(total);
    } else if (currentMode == 2) {
      sendSigBoth(SIG_FINAL);
      mState = M_FINISHED;
    } else {
      uint16_t regs[4];
      regs[0] = 0;        // HR_SEC
      regs[1] = 0;        // HR_MS
      regs[2] = 0;        // HR_COUNT_STATE (IDLE)
      regs[3] = SIG_IDLE; // HR_MASTER_SIG
      if (currentMode == 6)
        writeRegs(SLAVE1_ID, HR_SEC, regs, 4);
      else
        writeRegsBoth(HR_SEC, regs, 4);
      mState = M_IDLE;
    }
  } else {
    mState = M_IDLE;
  }
}

void resetAll() {
  clearRaceState();

  uint16_t regs[4];
  regs[0] = 0;        // HR_SEC
  regs[1] = 0;        // HR_MS
  regs[2] = 0;        // HR_COUNT_STATE
  regs[3] = SIG_IDLE; // HR_MASTER_SIG
  if (currentMode == 6)
    writeRegs(SLAVE1_ID, HR_SEC, regs, 4);
  else
    writeRegsBoth(HR_SEC, regs, 4);
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
      playWav("/ting.wav"); // cam bien slave1 kich -> master bat dau dem
    } else if (!mode1BepPlayed && mode1ArmMs != 0 &&
               (millis() - mode1ArmMs) > 5000) {
      // Sau 5s ma slave1 van chua kich -> bao bepbep 3 lan roi cho bang LED ve
      // 0.000
      mode1BepPlayed = true;
      for (int i = 0; i < 3; i++)
        playWav("/bepbep.wav");
      stopAndPushFinal(
          0); // HR_SEC=0, HR_MS=0, SIG_FINAL -> bang LED hien 0.000
    }
  } else if (mState == M_RUNNING) {
    if (readReg(SLAVE2_ID, HR_TRIG_FLAG, trig) && trig == 1) {
      writeReg(SLAVE2_ID, HR_TRIG_FLAG, 0);
      uint32_t total = tElapsed_ms + (millis() - tStart_ms);
      stopAndPushFinal(total);
      playWav("/ting.wav"); // cam bien slave2 kich -> dung dem
    }
  }
}

void tickMode2() {
  if (mState != M_RUNNING)
    return;
  for (int idx = 0; idx < 2; idx++) {
    uint8_t id = (idx == 0) ? SLAVE1_ID : SLAVE2_ID;
    uint16_t trig = 0;
    if (readReg(id, HR_TRIG_FLAG, trig) && trig == 1) {
      writeReg(id, HR_TRIG_FLAG, 0);
      uint16_t s = 0, ms = 0;
      if (readReg(id, HR_SEC, s) && readReg(id, HR_MS, ms)) {
        if (id == SLAVE1_ID) {
          cache1.sec = s;
          cache1.ms = ms;
          cache1.state = 200;
        } else {
          cache2.sec = s;
          cache2.ms = ms;
          cache2.state = 200;
        }
      }
      if (mode2Winner == 0) {
        mode2Winner = id;
      }
      playWav("/ting.wav"); // cam bien kich -> phat ting, slave hien so + bao
                            // ve master
    }
  }

  bool s1_done = !link1.online || (cache1.state == 200);
  bool s2_done = !link2.online || (cache2.state == 200);
  if (s1_done && s2_done) {
    mState = M_FINISHED;
  }
}

void tickMode34() {
  if (mState != M_RUNNING)
    return;
  uint16_t st1 = 0, st2 = 0;
  bool ok1 = readReg(SLAVE1_ID, HR_COUNT_STATE, st1);
  bool ok2 = readReg(SLAVE2_ID, HR_COUNT_STATE, st2);
  if (ok1 && ok2 && st1 == 200 && st2 == 200) {
    mState = M_FINISHED;
  }
}

void tickMode6() {
  if (mState != M_ARMED && mState != M_RUNNING)
    return;

  uint16_t trig = 0;
  if (readReg(SLAVE1_ID, HR_TRIG_FLAG, trig) && trig > 0) {
    writeReg(SLAVE1_ID, HR_TRIG_FLAG, 0);

    uint16_t s = 0, ms = 0;
    if (readReg(SLAVE1_ID, HR_SEC, s) && readReg(SLAVE1_ID, HR_MS, ms)) {
      cache1.sec = s;
      cache1.ms = ms;
      cache1.state = 100;
      timeLapseLastMs = (uint32_t)s * 1000UL + (uint32_t)ms;
    }

    if (mState == M_ARMED) {
      mState = M_RUNNING; // first sensor cut starts the timer
    } else {
      if (timeLapseSeq < 65535)
        timeLapseSeq++;
      playWav("/ting.wav");
    }
  }
}

// ---------- Poll cache trang thai 2 slave (cho /api/status) ----------
// Doc SEC, MS, COUNT_STATE bang 1 transaction (3 reg lien tiep).
void pollStatusCache() {
  uint16_t buf[3];
  // Slave 1: 3 reg lien tiep tu HR_SEC (2..4)
  if (readRegs(SLAVE1_ID, HR_SEC, buf, 3)) {
    cache1.sec = buf[0];
    cache1.ms = buf[1];
    cache1.state = buf[2];
    if (currentMode == 5)
      cache1.value = buf[0];
  }
  cache1.online = link1.online;

  if (currentMode == 6) {
    cache2.online = false;
    cache2.state = cache2.sec = cache2.ms = cache2.value = 0;
    return;
  }

  // Slave 2
  if (readRegs(SLAVE2_ID, HR_SEC, buf, 3)) {
    cache2.sec = buf[0];
    cache2.ms = buf[1];
    cache2.state = buf[2];
    if (currentMode == 5)
      cache2.value = buf[0];
  }
  cache2.online = link2.online;
}

// ============================================================
//                       WEB SERVER
// ============================================================
WebServer server(80);

void apiOk() { server.send(200, "application/json", "{\"ok\":true}"); }
void apiErr(const char *msg) {
  String s = String("{\"ok\":false,\"err\":\"") + msg + "\"}";
  server.send(400, "application/json", s);
}

void apiStatus() {
  StaticJsonDocument<768> doc;
  doc["mode"] = (uint8_t)currentMode;
  doc["mState"] = (int)mState;
  doc["target"] = (uint16_t)targetSec;
  doc["colorSlave1"] = (uint16_t)colorSlave1;
  doc["colorSlave2"] = (uint16_t)colorSlave2;
  doc["winner"] = (uint8_t)mode2Winner;

  // Mode 1: master dem -> masterMs la thoi gian chinh.
  // Mode 2/3/4/5/6: slave dem -> masterMs = 0, web lay tu slave.
  uint32_t live_ms = 0;
  if (currentMode == 1) {
    live_ms = tElapsed_ms;
    if (mState == M_RUNNING)
      live_ms += (millis() - tStart_ms);
  }
  doc["masterMs"] = live_ms;
  doc["timeLapseSeq"] = (uint16_t)timeLapseSeq;
  doc["timeLapseMs"] = (uint32_t)timeLapseLastMs;

  JsonObject s1 = doc["slave1"].to<JsonObject>();
  s1["online"] = cache1.online;
  s1["state"] = cache1.state;
  s1["sec"] = cache1.sec;
  s1["ms"] = cache1.ms;
  s1["value"] = cache1.value;

  JsonObject s2 = doc["slave2"].to<JsonObject>();
  s2["online"] = cache2.online;
  s2["state"] = cache2.state;
  s2["sec"] = cache2.sec;
  s2["ms"] = cache2.ms;
  s2["value"] = cache2.value;

  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

void apiMode() {
  if (!server.hasArg("m")) {
    apiErr("missing m");
    return;
  }
  int m = server.arg("m").toInt();
  if (m < 1 || m > 6) {
    apiErr("mode 1..6");
    return;
  }
  setMode((uint8_t)m);
  apiOk();
}

void apiArm() {
  armCurrent();
  apiOk();
}
void apiStart() {
  startCurrent();
  apiOk();
}
void apiPause() {
  pauseCurrent();
  apiOk();
}
void apiResume() {
  resumeCurrent();
  apiOk();
}
void apiStop() {
  stopCurrent();
  apiOk();
}
void apiReset() {
  resetAll();
  apiOk();
}

void apiTarget() {
  if (!server.hasArg("s")) {
    apiErr("missing s");
    return;
  }
  int n = server.arg("s").toInt();
  if (n < 0)
    n = 0;
  if (n > 9999)
    n = 9999;
  targetSec = (uint16_t)n;
  writeBoth(HR_TARGET, targetSec);
  apiOk();
}

void apiSet() {
  if (!server.hasArg("slave") || !server.hasArg("v")) {
    apiErr("missing slave/v");
    return;
  }
  int sl = server.arg("slave").toInt();
  int n = server.arg("v").toInt();
  if (sl != 1 && sl != 2) {
    apiErr("slave 1|2");
    return;
  }
  if (n < 0)
    n = 0;
  if (n > 9999)
    n = 9999;
  writeReg((uint8_t)sl, HR_TARGET, (uint16_t)n);
  apiOk();
}

void apiSlaveTime() {
  if (!server.hasArg("slave") || !server.hasArg("ms")) {
    apiErr("missing slave/ms");
    return;
  }
  int sl = server.arg("slave").toInt();
  long totalMs = server.arg("ms").toInt();
  if (sl != 1 && sl != 2) {
    apiErr("slave 1|2");
    return;
  }

  Serial.printf("[API] Set slave time: slave=%d, ms=%ld\n", sl, totalMs);

  uint16_t s = (uint16_t)(totalMs / 1000);
  uint16_t ms = (uint16_t)(totalMs % 1000);

  uint16_t regs[4];
  regs[0] = s;         // HR_SEC
  regs[1] = ms;        // HR_MS
  regs[2] = 200;       // HR_COUNT_STATE (STOPPED)
  regs[3] = SIG_FINAL; // HR_MASTER_SIG

  bool ok;
  if (currentMode == 1) {
    ok = writeRegsBoth(HR_SEC, regs, 4);
    Serial.printf("[API] Modbus writeRegs to BOTH slaves: %s\n", ok ? "SUCCESS" : "FAILED");
    cache1.sec = s;
    cache1.ms = ms;
    cache1.state = 200;
    cache2.sec = s;
    cache2.ms = ms;
    cache2.state = 200;
  } else {
    ok = writeRegs((uint8_t)sl, HR_SEC, regs, 4);
    Serial.printf("[API] Modbus writeRegs to slave %d: %s\n", sl, ok ? "SUCCESS" : "FAILED");
    if (sl == 1) {
      cache1.sec = s;
      cache1.ms = ms;
      cache1.state = 200;
    } else {
      cache2.sec = s;
      cache2.ms = ms;
      cache2.state = 200;
    }
  }

  apiOk();
}

void apiColor() {
  if (server.hasArg("c1")) {
    int v = server.arg("c1").toInt();
    if (v == 1 || v == 2)
      colorSlave1 = v;
  }
  if (server.hasArg("c2")) {
    int v = server.arg("c2").toInt();
    if (v == 1 || v == 2)
      colorSlave2 = v;
  }

  // Save to LittleFS for persistence
  File f = LittleFS.open("/color.txt", "w");
  if (f) {
    f.printf("%d\n%d\n", colorSlave1, colorSlave2);
    f.close();
  }

  writeReg(SLAVE1_ID, HR_COLOR_READY, colorSlave1);
  writeReg(SLAVE1_ID, HR_COLOR_STOP, colorSlave1);
  writeReg(SLAVE2_ID, HR_COLOR_READY, colorSlave2);
  writeReg(SLAVE2_ID, HR_COLOR_STOP, colorSlave2);
  apiOk();
}

// Luu ket qua vong loai (CSV) vao LittleFS. Body = noi dung CSV (text/plain).
void apiSaveCsv() {
  if (!server.hasArg("plain")) {
    apiErr("no body");
    return;
  }
  String name = server.hasArg("name") ? server.arg("name") : String("results");
  // Lam sach ten file: chi cho phep chu/so/_/- de tranh duong dan la
  String safe;
  for (size_t i = 0; i < name.length(); i++) {
    char ch = name[i];
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch == '_' || ch == '-')
      safe += ch;
  }
  if (safe.length() == 0)
    safe = "results";
  String path = "/" + safe + ".csv";
  File f = LittleFS.open(path, "w");
  if (!f) {
    apiErr("open fail");
    return;
  }
  f.print(server.arg("plain"));
  f.close();
  server.send(200, "application/json",
              String("{\"ok\":true,\"path\":\"") + path + "\"}");
}

// Xoa cac file CSV ket qua va trang thai tren LittleFS.
void apiDelCsv() {
  if (LittleFS.exists("/ket_qua_vong_loai.csv"))
    LittleFS.remove("/ket_qua_vong_loai.csv");
  if (LittleFS.exists("/ket_qua_luot1.csv"))
    LittleFS.remove("/ket_qua_luot1.csv");
  if (LittleFS.exists("/ket_qua_bracket.csv"))
    LittleFS.remove("/ket_qua_bracket.csv");
  if (LittleFS.exists("/state.json"))
    LittleFS.remove("/state.json");
  if (LittleFS.exists("/session.json"))
    LittleFS.remove("/session.json");
  apiOk();
}

void apiSaveState() {
  if (!server.hasArg("plain")) {
    apiErr("no body");
    return;
  }
  File f = LittleFS.open("/state.json", "w");
  if (!f) {
    apiErr("open fail");
    return;
  }
  f.print(server.arg("plain"));
  f.close();
  apiOk();
}

void apiLoadState() {
  if (!LittleFS.exists("/state.json")) {
    server.send(404, "application/json", "{\"err\":\"no state\"}");
    return;
  }
  File f = LittleFS.open("/state.json", "r");
  if (!f) {
    apiErr("open fail");
    return;
  }
  server.streamFile(f, "application/json");
  f.close();
}

void apiSaveSession() {
  if (!server.hasArg("plain")) {
    apiErr("no body");
    return;
  }
  File f = LittleFS.open("/session.json", "w");
  if (!f) {
    apiErr("open fail");
    return;
  }
  f.print(server.arg("plain"));
  f.close();
  apiOk();
}

void apiLoadSession() {
  if (!LittleFS.exists("/session.json")) {
    server.send(404, "application/json", "{\"err\":\"no session\"}");
    return;
  }
  File f = LittleFS.open("/session.json", "r");
  if (!f) {
    apiErr("open fail");
    return;
  }
  server.streamFile(f, "application/json");
  f.close();
}

// Snapshot cho man hinh display.html (poll cham, khong goi Modbus)
void apiSaveDisplay() {
  if (!server.hasArg("plain")) {
    apiErr("no body");
    return;
  }
  const String &body = server.arg("plain");
  int p = body.indexOf("\"rev\":");
  if (p >= 0) {
    uint32_t rev = (uint32_t)body.substring(p + 6).toInt();
    if (rev > 0)
      displayRevCached = rev;
  }
  File f = LittleFS.open("/display.json", "w");
  if (!f) {
    apiErr("open fail");
    return;
  }
  f.print(body);
  f.close();
  apiOk();
}

void apiLoadDisplay() {
  if (server.hasArg("rev")) {
    uint32_t clientRev = (uint32_t)server.arg("rev").toInt();
    if (clientRev > 0 && clientRev == displayRevCached) {
      server.send(304, "application/json", "");
      return;
    }
  }
  if (!LittleFS.exists("/display.json")) {
    server.send(404, "application/json", "{\"err\":\"no display\"}");
    return;
  }
  File f = LittleFS.open("/display.json", "r");
  if (!f) {
    apiErr("open fail");
    return;
  }
  server.streamFile(f, "application/json");
  f.close();
}

// Chi tra mState — display poll ~3s de biet khi nao tai lai snapshot
void apiDisplayPulse() {
  String out = String("{\"mState\":") + (int)mState + "}";
  server.send(200, "application/json", out);
}

// ---------- Phuc vu static file tu LittleFS ----------
String contentTypeOf(const String &path) {
  if (path.endsWith(".html") || path.endsWith(".htm"))
    return "text/html; charset=utf-8";
  if (path.endsWith(".css"))
    return "text/css; charset=utf-8";
  if (path.endsWith(".js"))
    return "application/javascript; charset=utf-8";
  if (path.endsWith(".json"))
    return "application/json; charset=utf-8";
  if (path.endsWith(".png"))
    return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg"))
    return "image/jpeg";
  if (path.endsWith(".svg"))
    return "image/svg+xml";
  if (path.endsWith(".ico"))
    return "image/x-icon";
  if (path.endsWith(".md"))
    return "text/markdown; charset=utf-8";
  if (path.endsWith(".csv"))
    return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
}

bool serveFile(const String &path) {
  String p = path;
  if (p == "/" || p.length() == 0)
    p = "/index.html";
  if (!LittleFS.exists(p))
    return false;
  File f = LittleFS.open(p, "r");
  if (!f)
    return false;
  server.streamFile(f, contentTypeOf(p));
  f.close();
  return true;
}

void handleNotFound() {
  if (serveFile(server.uri()))
    return;
  server.send(404, "text/plain", "Not found: " + server.uri());
}

// ---------- Serial console (giu de debug) ----------
String inLine = "";
void handleLine(String line) {
  line.trim();
  if (line.isEmpty())
    return;
  if (line == "help") {
    Serial.println(F("mode N | arm | start | pause | resume | stop | reset | "
                     "target N | set1 N | set2 N | status"));
    return;
  }
  if (line == "arm") {
    armCurrent();
    Serial.println("ARM");
    return;
  }
  if (line == "start") {
    startCurrent();
    Serial.println("START");
    return;
  }
  if (line == "pause") {
    pauseCurrent();
    Serial.println("PAUSE");
    return;
  }
  if (line == "resume") {
    resumeCurrent();
    Serial.println("RESUME");
    return;
  }
  if (line == "stop") {
    stopCurrent();
    Serial.println("STOP");
    return;
  }
  if (line == "reset") {
    resetAll();
    Serial.println("RESET");
    return;
  }
  if (line == "status") {
    Serial.printf("Mode=%u State=%d Target=%u | S1 st=%u %u.%03u online=%d | "
                  "S2 st=%u %u.%03u online=%d\n",
                  currentMode, (int)mState, targetSec, cache1.state, cache1.sec,
                  cache1.ms, cache1.online, cache2.state, cache2.sec, cache2.ms,
                  cache2.online);
    return;
  }
  int sp = line.indexOf(' ');
  if (sp < 0) {
    Serial.println("?");
    return;
  }
  String cmd = line.substring(0, sp);
  String arg = line.substring(sp + 1);
  if (cmd == "mode") {
    setMode(arg.toInt());
    return;
  }
  if (cmd == "target") {
    targetSec = constrain(arg.toInt(), 0, 9999);
    writeBoth(HR_TARGET, targetSec);
    return;
  }
  if (cmd == "set1") {
    writeReg(SLAVE1_ID, HR_TARGET, constrain(arg.toInt(), 0, 9999));
    return;
  }
  if (cmd == "set2") {
    writeReg(SLAVE2_ID, HR_TARGET, constrain(arg.toInt(), 0, 9999));
    return;
  }
  Serial.println("?");
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r')
      continue;
    if (c == '\n') {
      handleLine(inLine);
      inLine = "";
    } else if (inLine.length() < 80)
      inLine += c;
  }
}

// ---------- WiFi setup (AP only) ----------
void setupWiFi() {
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  WiFi.softAPConfig(AP_IP, AP_GW, AP_MASK);
  bool ok = WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("\nAP %s | pass: %s | IP: %s\n", ok ? AP_SSID : "(fail)",
                AP_PASSWORD, WiFi.softAPIP().toString().c_str());
}

void setupRoutes() {
  server.on("/api/status", HTTP_GET, apiStatus);
  server.on("/api/mode", HTTP_POST, apiMode);
  server.on("/api/mode", HTTP_GET, apiMode);
  server.on("/api/arm", HTTP_POST, apiArm);
  server.on("/api/arm", HTTP_GET, apiArm);
  server.on("/api/start", HTTP_POST, apiStart);
  server.on("/api/start", HTTP_GET, apiStart);
  server.on("/api/pause", HTTP_POST, apiPause);
  server.on("/api/pause", HTTP_GET, apiPause);
  server.on("/api/resume", HTTP_POST, apiResume);
  server.on("/api/resume", HTTP_GET, apiResume);
  server.on("/api/stop", HTTP_POST, apiStop);
  server.on("/api/stop", HTTP_GET, apiStop);
  server.on("/api/reset", HTTP_POST, apiReset);
  server.on("/api/reset", HTTP_GET, apiReset);
  server.on("/api/target", HTTP_POST, apiTarget);
  server.on("/api/target", HTTP_GET, apiTarget);
  server.on("/api/set", HTTP_POST, apiSet);
  server.on("/api/set", HTTP_GET, apiSet);
  server.on("/api/color", HTTP_POST, apiColor);
  server.on("/api/color", HTTP_GET, apiColor);
  server.on("/api/save-csv", HTTP_POST, apiSaveCsv);
  server.on("/api/del-csv", HTTP_POST, apiDelCsv);
  server.on("/api/save-state", HTTP_POST, apiSaveState);
  server.on("/api/load-state", HTTP_GET, apiLoadState);
  server.on("/api/save-session", HTTP_POST, apiSaveSession);
  server.on("/api/load-session", HTTP_GET, apiLoadSession);
  server.on("/api/save-display", HTTP_POST, apiSaveDisplay);
  server.on("/api/display", HTTP_GET, apiLoadDisplay);
  server.on("/api/display-pulse", HTTP_GET, apiDisplayPulse);
  server.on("/api/slave-time", HTTP_POST, apiSlaveTime);
  server.on("/api/slave-time", HTTP_GET, apiSlaveTime);

  server.on("/", HTTP_GET, []() {
    if (!serveFile("/index.html"))
      server.send(500, "text/plain", "index.html missing - upload data");
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

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount fail!");
  } else {
    Serial.println("LittleFS OK.");
    if (LittleFS.exists("/color.txt")) {
      File f = LittleFS.open("/color.txt", "r");
      if (f) {
        String c1 = f.readStringUntil('\n');
        String c2 = f.readStringUntil('\n');
        c1.trim();
        c2.trim();
        if (c1.length() > 0) colorSlave1 = c1.toInt();
        if (c2.length() > 0) colorSlave2 = c2.toInt();
        f.close();
      }
    }
  }

  setupI2S();

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

  // Mode 1 hoac 2 dang dua: poll het toc do (uu tien latency).
  bool raceMode = ((currentMode == 1 || currentMode == 2 || currentMode == 6) &&
                   (mState == M_ARMED || mState == M_RUNNING));

  if (raceMode) {
    if (currentMode == 1)
      tickMode1();
    else if (currentMode == 2)
      tickMode2();
    else
      tickMode6();
  } else if (millis() - lastTickMs > 100) {
    lastTickMs = millis();
    switch (currentMode) {
    case 1:
      tickMode1();
      break;
    case 2:
      tickMode2();
      break;
    case 3:
      tickMode34();
      break;
    case 4:
      tickMode34();
      break;
    case 5: /* khong tick tich cuc */
      break;
    case 6:
      tickMode6();
      break;
    }
  }

  // Cache poll: mode 1 skip (master tu dem), mode 2 can poll slave lien tuc.
  if ((currentMode == 2 || currentMode == 6) &&
      (mState == M_ARMED || mState == M_RUNNING)) {
    // Mode 2 dang dua: poll slave ~120ms (web dieu khien poll /api/status nhanh)
    static uint32_t lastCache2 = 0;
    if (millis() - lastCache2 > 120) {
      lastCache2 = millis();
      pollStatusCache();
    }
  } else if (currentMode != 1 || mState == M_IDLE || mState == M_FINISHED) {
    // Mode khac hoac idle: poll cham.
    static uint32_t lastCache = 0;
    uint32_t cacheInt = (mState == M_RUNNING || mState == M_PAUSED) ? 250 : 800;
    if (millis() - lastCache > cacheInt) {
      lastCache = millis();
      pollStatusCache();
    }
  }

  delay(1);
}
