// ============================================================
//  SLAVE  (Bang LED P5 64x32)
//  - Giao tiep voi MASTER qua LoRa E32 (UART0 mac dinh: TX/RX)
//  - Modbus RTU slave, ID = 1 hoac 2 (set qua build_flag)
//  - 6 mode: dau don / dau doi / dem nguoc / dem toi / tang thu cong / time lapse
//  - Chi 2 mau: XANH (id=1) va DO (id=2)
// ============================================================
#include <Arduino.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFi.h>
#include <WiFiClient.h>

#include "ESP32-VirtualMatrixPanel-I2S-DMA.h"
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <ModbusRTU.h>
#include <esp_timer.h>

// ===================== OTA =====================
const char *WIFI_SSID = "ATProSoft";
const char *WIFI_PASSWORD = "ATPro1234560";
const int FIRMWARE_VERSION = 35;

// URL OTA tu dong khop voi build env (slave1 / slave2) qua MODBUS_SLAVE_ID.
#define _STR(x) #x
#define STR(x) _STR(x)
#define SLAVE_TAG "slave" STR(MODBUS_SLAVE_ID)

const char *VERSION_URL = "http://192.168.1.52:8000/" SLAVE_TAG "/version.txt";
const char *FIRMWARE_URL =
    "http://192.168.1.52:8000/.pio/build/" SLAVE_TAG "/firmware.bin";

// ===================== HW =====================
#define PANEL_RES_X 64
#define PANEL_RES_Y 32
#define NUM_ROWS 1
#define NUM_COLS 1

#define BUTTON_PIN 34
#define DEBOUNCE_US 0
// GPIO34 input-only, can ngoai tro keo len. MIN_RACE chong nhieu chan thoi gian
// toi thieu de chap nhan trigger sau khi RUNNING.
#define MIN_RACE_US 0LL

#ifndef MODBUS_SLAVE_ID
#define MODBUS_SLAVE_ID 1
#endif

#define LORA_BAUD 115200 // E32 mac dinh 9600 8N1

// ===================== MODBUS REG MAP =====================
enum ModbusHreg {
  HR_SLAVE_ID = 0,
  HR_MODE = 1,        // 1..6
  HR_SEC = 2,         // giay (display / final time)
  HR_MS = 3,          // ms (mode 1/2)
  HR_COUNT_STATE = 4, // 0=IDLE 100=RUN 200=STOP 300=PAUSE
  HR_MASTER_SIG = 5,  // tin hieu tu master (xem MasterSig)
  HR_COLOR_READY = 6, // 1=xanh, 2=do
  HR_COLOR_STOP = 7,  // 1=xanh, 2=do
  HR_SYNC_FLAG = 8,   // co dong bo (du phong)
  HR_TARGET = 9,      // muc tieu giay (mode 3/4) hoac gia tri set (mode 5)
  HR_TRIG_FLAG = 10,  // 1 = slave da nhan nut, master xoa ve 0
  HR_COUNT = 12
};

enum MasterSig {
  SIG_IDLE = 0,
  SIG_ARM = 100,   // san sang
  SIG_START = 110, // bat dau dem
  SIG_PAUSE = 120,
  SIG_RESUME = 130,
  SIG_FINAL = 250 // chot va hien so cuoi tu HR_SEC/HR_MS
};

// ===================== STATE =====================
enum State { ST_IDLE, ST_RUNNING, ST_STOPPED, ST_PAUSED };
State slaveState = ST_IDLE;

int64_t tStart_us = 0;   // moc bat dau segment dang chay
int64_t tElapsed_us = 0; // tong da troi qua (cong don qua cac lan pause)
int64_t tTarget_us = 0;  // muc tieu (mode 3/4)
uint32_t mode5Value = 0; // gia tri dem thu cong

bool stateChanged = false;
bool invalidateDisplay = false;

// ===================== DISPLAY =====================
MatrixPanel_I2S_DMA *dma_display = nullptr;
VirtualMatrixPanel *virtualDisp = nullptr;
uint16_t colBlack;
ModbusRTU mb;

#define REFRESH_MS 15
struct RenderChar {
  char c;
  int size; // 12 or 9
};

static RenderChar prevChars[16];
static int prevLen = 0;
static uint16_t prevColor = 0;
static int prevFormat = -1;

static int digitAdv12 = 0;
static int dotAdv12 = 0;
static int textH12 = 0;
static int textYoff12 = 0;

static int digitAdv9 = 0;
static int dotAdv9 = 0;
static int textH9 = 0;
static int textYoff9 = 0;

void displayTime(unsigned long ms, uint16_t color);
void displayNumber(uint32_t n, uint16_t color);
void runSquareEffect(uint16_t color);
void initFontMetrics();
void clearScreen();
void updateStateReg();

// Chi co 2 mau: XANH (1) va DO (2)
uint16_t getColor(int id) {
  return (id == 2) ? 0xF800 /* RED */ : 0x07E0 /* GREEN */;
}

// ===================== ISR =====================
volatile bool btnPressed = false;
void IRAM_ATTR buttonISR() {
  int64_t now = esp_timer_get_time();
  static int64_t lastISR = 0;
  if ((now - lastISR) < DEBOUNCE_US)
    return;
  lastISR = now;
  btnPressed = true;
}

// ===================== FONT =====================
void initFontMetrics() {
  // Large font (12pt)
  const GFXfont *font12 = &FreeSansBold12pt7b;
  digitAdv12 = 0;
  for (char c = '0'; c <= '9'; c++) {
    int adv = font12->glyph[c - font12->first].xAdvance;
    if (adv > digitAdv12)
      digitAdv12 = adv;
  }
  dotAdv12 = font12->glyph['.' - font12->first].xAdvance;
  int16_t x1, y1;
  uint16_t w, h;
  virtualDisp->setFont(font12);
  virtualDisp->setTextSize(1);
  virtualDisp->getTextBounds("0", 0, 0, &x1, &y1, &w, &h);
  textH12 = h + 2;
  textYoff12 = y1 - 1;

  // Small font (9pt)
  const GFXfont *font9 = &FreeSans9pt7b;
  digitAdv9 = 0;
  for (char c = '0'; c <= '9'; c++) {
    int adv = font9->glyph[c - font9->first].xAdvance;
    if (adv > digitAdv9)
      digitAdv9 = adv;
  }
  dotAdv9 = font9->glyph['.' - font9->first].xAdvance;
  virtualDisp->setFont(font9);
  virtualDisp->setTextSize(1);
  virtualDisp->getTextBounds("0", 0, 0, &x1, &y1, &w, &h);
  textH9 = h + 2;
  textYoff9 = y1 - 1;
}

// ===================== OTA =====================
void connectWiFi() {
  Serial.printf("Ket noi WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Khong noi duoc WiFi.");
  }
}

int getRemoteVersion() {
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(4000); // ngan lai de khong treo lau khi server tat
  http.setTimeout(4000);
  http.setReuse(false);
  Serial.printf("GET %s\n", VERSION_URL);
  if (!http.begin(client, VERSION_URL)) {
    Serial.println("http.begin() that bai");
    return -1;
  }
  int code = http.GET();
  int remote = -1;
  if (code == HTTP_CODE_OK) {
    remote = http.getString().toInt();
    Serial.printf("Version tren server: %d\n", remote);
  } else {
    Serial.printf("Loi GET, HTTP code: %d\n", code);
  }
  http.end();
  return remote;
}

void doUpdate() {
  Serial.println("Bat dau tai firmware moi...");
  WiFiClient client;
  HTTPUpdate updater(30000);
  updater.rebootOnUpdate(true);
  updater.onProgress([](int cur, int total) {
    Serial.printf("Tai: %d / %d (%d%%)\r", cur, total,
                  total ? cur * 100 / total : 0);
  });
  t_httpUpdate_return ret = updater.update(client, FIRMWARE_URL);
  Serial.println();
  switch (ret) {
  case HTTP_UPDATE_FAILED:
    Serial.printf("Update fail (%d): %s\n", updater.getLastError(),
                  updater.getLastErrorString().c_str());
    break;
  case HTTP_UPDATE_NO_UPDATES:
    Serial.println("Khong co update.");
    break;
  case HTTP_UPDATE_OK:
    Serial.println("Update OK!");
    break;
  }
}

void checkForUpdate() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi chua noi -> bo qua OTA.");
    return;
  }
  int remote = getRemoteVersion();
  if (remote < 0) {
    Serial.println("Bo qua OTA (khong lay duoc version).");
    return;
  }
  Serial.printf("Local FW=%d, Server FW=%d\n", FIRMWARE_VERSION, remote);
  if (remote > FIRMWARE_VERSION) {
    Serial.println("Co ban moi -> cap nhat.");
    doUpdate();
  } else {
    Serial.println("Da la ban moi nhat.");
  }
}

// ===================== SETUP =====================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n=== SLAVE %d  FW %d ===\n", MODBUS_SLAVE_ID,
                FIRMWARE_VERSION);

  connectWiFi();
  checkForUpdate();
  Serial.println("Tat WiFi, khoi tao LED + Modbus...");
  Serial.flush();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, FALLING);

  // CHU Y: tu day Serial chuyen sang LORA_BAUD cho Modbus.
  // Neu muon thay monitor de debug, doi monitor sang LORA_BAUD = 115200.
  Serial.flush();
  Serial.updateBaudRate(LORA_BAUD);
  mb.begin(&Serial);
  mb.slave(MODBUS_SLAVE_ID);

  for (uint16_t i = 0; i < HR_COUNT; i++)
    mb.addHreg(i, 0);
  mb.Hreg(HR_SLAVE_ID, MODBUS_SLAVE_ID);
  mb.Hreg(HR_COLOR_READY, 1); // xanh
  mb.Hreg(HR_COLOR_STOP, 2);  // do
  mb.Hreg(HR_MODE, 1);

  HUB75_I2S_CFG mxconfig(PANEL_RES_X * 2, PANEL_RES_Y / 2, NUM_ROWS * NUM_COLS);
  mxconfig.clkphase = false;
  mxconfig.driver = HUB75_I2S_CFG::ICN2038S;
  dma_display = new MatrixPanel_I2S_DMA(mxconfig);
  dma_display->setBrightness8(200);
  dma_display->begin();
  delay(300);
  virtualDisp = new VirtualMatrixPanel(*dma_display, NUM_ROWS, NUM_COLS,
                                       PANEL_RES_X, PANEL_RES_Y);
  virtualDisp->setPhysicalPanelScanRate(FOUR_SCAN_32PX_HIGH);
  colBlack = virtualDisp->color565(0, 0, 0);
  initFontMetrics();
  virtualDisp->fillScreen(colBlack);
  displayTime(0, getColor(mb.Hreg(HR_COLOR_READY)));
}

// ===================== LOOP =====================
uint32_t lastDisplayMs = 0;

void loop() {
  mb.task();

  uint16_t mode = mb.Hreg(HR_MODE);
  uint16_t sig = mb.Hreg(HR_MASTER_SIG);
  uint16_t target = mb.Hreg(HR_TARGET);
  uint16_t colorRdy = getColor(mb.Hreg(HR_COLOR_READY));
  uint16_t colorStop = getColor(mb.Hreg(HR_COLOR_STOP));

  static uint16_t lastSig = 0xFFFF;
  static uint16_t lastMode = 0xFFFF;
  static uint16_t lastTarget = 0xFFFF;

  // ---------- Doi MODE -> reset ----------
  if (mode != lastMode) {
    lastMode = mode;
    slaveState = ST_IDLE;
    tElapsed_us = 0;
    mode5Value = 0;
    stateChanged = true;
    invalidateDisplay = true;
  }

  // ---------- Xu ly tin hieu MASTER ----------
  if (sig != lastSig) {
    lastSig = sig;
    int64_t now = esp_timer_get_time();

    if (sig == SIG_IDLE) {
      slaveState = ST_IDLE;
      tElapsed_us = 0;
      if (mode == 5)
        mode5Value = 0;
      stateChanged = true;
      invalidateDisplay = true;
      mb.Hreg(HR_TRIG_FLAG, 0);
    } else if (sig == SIG_ARM) {
      slaveState = ST_IDLE;
      tElapsed_us = 0;
      stateChanged = true;
      invalidateDisplay = true;
      mb.Hreg(HR_TRIG_FLAG, 0);
    } else if (sig == SIG_START) {
      if (mode == 6) {
        // Time lapse: START chi arm slave1, cam bien lan dau moi bat dau dem.
        slaveState = ST_IDLE;
        tElapsed_us = 0;
        tStart_us = now;
        stateChanged = true;
        invalidateDisplay = true;
        mb.Hreg(HR_SEC, 0);
        mb.Hreg(HR_MS, 0);
        mb.Hreg(HR_TRIG_FLAG, 0);
        return;
      }
      if (mode == 3 || mode == 4) {
        tTarget_us = (int64_t)target * 1000000LL;
      }
      tElapsed_us = 0;
      tStart_us = now;
      slaveState = ST_RUNNING;
      stateChanged = true;
      invalidateDisplay = true;
      mb.Hreg(HR_TRIG_FLAG, 0); // tu xoa co kich cu -> master khoi gui them
                                // frame (tranh dinh frame LoRa)
      // Mode 1: slave KHONG dem (chi hieu ung), master dem.
      // Mode 2: slave tu dem.
    } else if (sig == SIG_PAUSE) {
      if (slaveState == ST_RUNNING) {
        tElapsed_us += (now - tStart_us);
        slaveState = ST_PAUSED;
        stateChanged = true;
      }
    } else if (sig == SIG_RESUME) {
      if (slaveState == ST_PAUSED) {
        tStart_us = now;
        slaveState = ST_RUNNING;
        stateChanged = true;
      }
    } else if (sig == SIG_FINAL) {
      // Mode 2: slave tu dung khi kich, KHONG dung khi nhan SIG_FINAL.
      // Master chi gui SIG_FINAL de cap nhat so hien thi cho slave chua dung.
      if (mode == 2 && slaveState == ST_RUNNING) {
        // Slave dang chay -> BO QUA, tiep tuc dem cua chinh no.
        // (Master da ghi HR_SEC/HR_MS nhung slave se ghi de len moi 10ms.)
      } else {
        // Mode khac (1/3/4/5) hoac slave da STOPPED -> dung binh thuong.
        uint32_t s = mb.Hreg(HR_SEC);
        uint32_t m = mb.Hreg(HR_MS);
        tElapsed_us = ((int64_t)s * 1000 + m) * 1000;
        slaveState = ST_STOPPED;
        stateChanged = true;
        invalidateDisplay = true;
      }
    }
  }

  // ---------- Dong bo thoi gian tu master khi o trang thai STOPPED va tin hieu
  // la SIG_FINAL ----------
  if (sig == SIG_FINAL) {
    if (!(mode == 2 && slaveState == ST_RUNNING)) {
      uint32_t s = mb.Hreg(HR_SEC);
      uint32_t m = mb.Hreg(HR_MS);
      int64_t reg_total_us = ((int64_t)s * 1000 + m) * 1000;
      int64_t diff = reg_total_us > tElapsed_us ? reg_total_us - tElapsed_us
                                                : tElapsed_us - reg_total_us;
      if (diff >= 1000) {
        tElapsed_us = reg_total_us;
        slaveState = ST_STOPPED;
        stateChanged = true;
        invalidateDisplay = true;
      }
    }
  }

  // ---------- Mode 5: master ghi HR_TARGET de set so ----------
  if (mode == 5 && target != lastTarget) {
    lastTarget = target;
    mode5Value = (target > 9999) ? 9999 : target;
    stateChanged = true;
  }
  if (mode != 5)
    lastTarget = target; // tranh trigger nham khi quay lai mode 5

  // ---------- Nut bam ----------
  if (btnPressed) {
    btnPressed = false;
    int64_t now = esp_timer_get_time();

    if (mode == 1) {
      // Mode 1 = dau don. Slave 1 = cong START, slave 2 = cong FINISH.
      // Master da gui SIG_START tu dau -> ca 2 slave dang ST_RUNNING hieu ung.
      if (slaveState == ST_IDLE && sig == SIG_ARM) {
        // Xuat phat som trong luc dang nghe hieu lenh.
        mb.Hreg(HR_TRIG_FLAG, 1);
      } else if (MODBUS_SLAVE_ID == 1 && slaveState == ST_RUNNING) {
        // Slave 1: bao master "co nguoi cat qua cong start" - khong can guard.
        mb.Hreg(HR_TRIG_FLAG, 1);
      } else if (MODBUS_SLAVE_ID == 2 && slaveState == ST_RUNNING &&
                 (now - tStart_us) >= MIN_RACE_US) {
        mb.Hreg(HR_TRIG_FLAG, 1);
      }
    } else if (mode == 2) {
      // Mode 2 = ai bam truoc thang. Tu dung dem, ghi thoi gian, bao master.
      if (slaveState == ST_IDLE && sig == SIG_ARM) {
        // Xuat phat som truoc sung.wav.
        mb.Hreg(HR_TRIG_FLAG, 1);
      } else if (slaveState == ST_RUNNING && (now - tStart_us) >= MIN_RACE_US) {
        tElapsed_us = now - tStart_us;
        slaveState = ST_STOPPED;
        stateChanged = true;
        invalidateDisplay = true;
        uint32_t ms = (uint32_t)(tElapsed_us / 1000);
        mb.Hreg(HR_SEC, (uint16_t)(ms / 1000));
        mb.Hreg(HR_MS, (uint16_t)(ms % 1000));
        mb.Hreg(HR_TRIG_FLAG, 1);
      }
    } else if (mode == 5) {
      // Mode 5: counter cam bien -> CHONG DOI MANH, khong can nhay.
      // Mode 1/2 KHONG bi anh huong (chi check tai day, trong nhanh mode 5).
      // 1.5s giua 2 lan dem => tranh hat ket / rung cam bien.
      static int64_t lastM5Press = -2000000LL;
      if ((now - lastM5Press) >= 1500000LL) {
        lastM5Press = now;
        if (mode5Value < 9999)
          mode5Value++;
        mb.Hreg(HR_SEC, (uint16_t)mode5Value);
        stateChanged = true;
      }
    } else if (mode == 6 && MODBUS_SLAVE_ID == 1) {
      // Time lapse: lan 1 bat dau dem, cac lan sau bao master ghi vong.
      static int64_t lastM6Press = -800000LL;
      if ((now - lastM6Press) >= 800000LL) {
        lastM6Press = now;
        if (slaveState == ST_IDLE && sig == SIG_START) {
          tElapsed_us = 0;
          tStart_us = now;
          slaveState = ST_RUNNING;
          mb.Hreg(HR_SEC, 0);
          mb.Hreg(HR_MS, 0);
          mb.Hreg(HR_TRIG_FLAG, 1);
          stateChanged = true;
          invalidateDisplay = true;
        } else if (slaveState == ST_RUNNING) {
          int64_t cur = (now - tStart_us) + tElapsed_us;
          uint32_t ms = (uint32_t)(cur / 1000);
          mb.Hreg(HR_SEC, (uint16_t)(ms / 1000));
          mb.Hreg(HR_MS, (uint16_t)(ms % 1000));
          mb.Hreg(HR_TRIG_FLAG, 1);
          stateChanged = true;
          invalidateDisplay = true;
        }
      }
    }
    // Mode 3, 4: nut khong tac dung.
  }

  // ---------- Kiem tra mode 3 / 4 ket thuc ----------
  if (slaveState == ST_RUNNING && (mode == 3 || mode == 4)) {
    int64_t cur = (esp_timer_get_time() - tStart_us) + tElapsed_us;
    if (cur >= tTarget_us) {
      tElapsed_us = tTarget_us;
      slaveState = ST_STOPPED;
      stateChanged = true;
      invalidateDisplay = true;
    }
  }

  updateStateReg();

  // ---------- Hien thi ----------
  bool needRefresh = stateChanged || (millis() - lastDisplayMs > REFRESH_MS);
  if (needRefresh) {
    lastDisplayMs = millis();
    stateChanged = false;

    if (invalidateDisplay) {
      clearScreen();
      invalidateDisplay = false;
    }

    if (slaveState == ST_RUNNING) {
      if (mode == 1 || mode == 2) {
        // Mode 1/2: chi hieu ung hinh vuong, KHONG hien so (dem ngam).
        runSquareEffect(colorRdy);
      } else if (mode == 3) {
        int64_t cur = (esp_timer_get_time() - tStart_us) + tElapsed_us;
        int64_t remain = tTarget_us - cur;
        if (remain < 0)
          remain = 0;
        displayNumber((uint32_t)(remain / 1000000), colorRdy);
      } else if (mode == 4) {
        int64_t cur = (esp_timer_get_time() - tStart_us) + tElapsed_us;
        displayNumber((uint32_t)(cur / 1000000), colorRdy);
      } else if (mode == 5) {
        displayNumber(mode5Value, colorRdy);
      } else if (mode == 6) {
        int64_t cur = (esp_timer_get_time() - tStart_us) + tElapsed_us;
        displayTime((unsigned long)(cur / 1000), colorRdy);
      }
    } else if (slaveState == ST_PAUSED) {
      if (mode == 3) {
        int64_t remain = tTarget_us - tElapsed_us;
        if (remain < 0)
          remain = 0;
        displayNumber((uint32_t)(remain / 1000000), colorRdy);
      } else if (mode == 4) {
        displayNumber((uint32_t)(tElapsed_us / 1000000), colorRdy);
      }
    } else if (slaveState == ST_STOPPED) {
      if (mode == 1 || mode == 2) {
        displayTime((unsigned long)(tElapsed_us / 1000), colorStop);
      } else if (mode == 3) {
        displayNumber(0, colorStop);
      } else if (mode == 4) {
        displayNumber((uint32_t)(tTarget_us / 1000000), colorStop);
      } else if (mode == 5) {
        displayNumber(mode5Value, colorStop);
      } else if (mode == 6) {
        displayTime((unsigned long)(tElapsed_us / 1000), colorStop);
      }
    } else { // IDLE
      if (mode == 3) {
        displayNumber(target, colorRdy); // hien target ban dau
      } else if (mode == 4) {
        displayNumber(0, colorRdy);
      } else if (mode == 5) {
        displayNumber(mode5Value, colorRdy);
      } else if (mode == 6) {
        displayTime(0, colorRdy);
      } else {
        displayTime(0, colorRdy);
      }
    }
  }

  yield();
}

void updateStateReg() {
  uint16_t mode = mb.Hreg(HR_MODE);
  uint16_t st = 0;
  switch (slaveState) {
  case ST_RUNNING:
    st = 100;
    break;
  case ST_STOPPED:
    st = 200;
    break;
  case ST_PAUSED:
    st = 300;
    break;
  default:
    st = 0;
    break;
  }
  mb.Hreg(HR_COUNT_STATE, st);

  // Mode 2/6: slave dem -> ghi SEC/MS lien tuc de master doc realtime.
  if ((mode == 2 || mode == 6) && slaveState == ST_RUNNING) {
    int64_t cur = (esp_timer_get_time() - tStart_us) + tElapsed_us;
    uint32_t elapsed_ms = (uint32_t)(cur / 1000);
    mb.Hreg(HR_SEC, (uint16_t)(elapsed_ms / 1000));
    mb.Hreg(HR_MS, (uint16_t)(elapsed_ms % 1000));
  }
}

// ===================== HIEU UNG VE HINH VUONG =====================
// Ve duong vien hinh vuong, co 1 doan sang chay xoay vong quanh chu vi.
void runSquareEffect(uint16_t color) {
  static int phase = 0;

  const int x0 = 1;
  const int y0 = 1;
  const int W = PANEL_RES_X - 2;
  const int H = PANEL_RES_Y - 2;
  const int perim = 2 * W + 2 * H - 4;
  const int segLen = perim / 3;

  virtualDisp->fillScreen(colBlack);

  // Khung mo (tat dieu chinh sang/toi -> dung mau full)
  virtualDisp->drawRect(x0, y0, W, H, color);

  // Doan sang (ve them lop 2 pixel cho day hon de "lap lanh")
  for (int i = 0; i < segLen; i++) {
    int p = (phase + i) % perim;
    int px, py;
    if (p < W) {
      px = x0 + p;
      py = y0;
    } else if (p < W + H - 1) {
      px = x0 + W - 1;
      py = y0 + (p - W + 1);
    } else if (p < 2 * W + H - 2) {
      px = x0 + W - 1 - (p - W - H + 2);
      py = y0 + H - 1;
    } else {
      px = x0;
      py = y0 + H - 1 - (p - 2 * W - H + 3);
    }
    virtualDisp->drawPixel(px, py, color);
    // pixel ke ben de doan dam hon
    if (i < segLen - 1) {
      int p2 = (phase + i + 1) % perim;
      int qx, qy;
      if (p2 < W) {
        qx = x0 + p2;
        qy = y0 + 1;
      } else if (p2 < W + H - 1) {
        qx = x0 + W - 2;
        qy = y0 + (p2 - W + 1);
      } else if (p2 < 2 * W + H - 2) {
        qx = x0 + W - 1 - (p2 - W - H + 2);
        qy = y0 + H - 2;
      } else {
        qx = x0 + 1;
        qy = y0 + H - 1 - (p2 - 2 * W - H + 3);
      }
      if (qx >= x0 && qx < x0 + W && qy >= y0 && qy < y0 + H) {
        virtualDisp->drawPixel(qx, qy, color);
      }
    }
  }

  phase = (phase + 3) % perim;
  // Bao toan cua format/buffer cu de displayTime/Number ve sau redraw day du
  prevFormat = -1;
  prevLen = 0;
}

void clearScreen() {
  virtualDisp->fillScreen(colBlack);
  prevFormat = -1;
  prevLen = 0;
}

// ===================== DISPLAY (so / thoi gian) =====================

int getRenderChars(const char *buf, int curFormat, RenderChar *out) {
  int len = strlen(buf);
  if (curFormat == 2) {
    // Format 2: XX.XXX -> 12, 12, 12, 9, 9, 9
    for (int i = 0; i < len; i++) {
      out[i].c = buf[i];
      out[i].size = (i < 3) ? 12 : 9;
    }
  } else if (curFormat == 3 || curFormat == 4) {
    // Format 3: XXX.XX -> all 9
    // Format 4: XXXX -> all 9
    for (int i = 0; i < len; i++) {
      out[i].c = buf[i];
      out[i].size = 9;
    }
  } else {
    // Default / Format 1 (X.XXX) / Format >= 10 -> all 12
    for (int i = 0; i < len; i++) {
      out[i].c = buf[i];
      out[i].size = 12;
    }
  }
  return len;
}

int calcRenderWidth(const RenderChar *chars, int len) {
  int w = 0;
  for (int i = 0; i < len; i++) {
    if (chars[i].size == 12) {
      w += (chars[i].c == '.') ? dotAdv12 : digitAdv12;
    } else {
      w += (chars[i].c == '.') ? dotAdv9 : digitAdv9;
    }
  }
  return w;
}

void renderBuf(const char *buf, int curFormat, uint16_t color) {
  RenderChar newChars[16];
  int newLen = getRenderChars(buf, curFormat, newChars);

  int totalW = calcRenderWidth(newChars, newLen);
  int cx = (PANEL_RES_X - totalW) / 2;

  if (curFormat != prevFormat) {
    // Clear whole text bounding box based on max text height (12pt font)
    int cyMax = (PANEL_RES_Y - textH12) / 2 - textYoff12;
    virtualDisp->fillRect(0, cyMax + textYoff12, PANEL_RES_X, textH12,
                          colBlack);

    int posX = cx;
    for (int i = 0; i < newLen; i++) {
      int size = newChars[i].size;
      int cy = (size == 12) ? ((PANEL_RES_Y - textH12) / 2 - textYoff12)
                            : ((PANEL_RES_Y - textH9) / 2 - textYoff9 + 2);
      virtualDisp->setFont((size == 12) ? &FreeSansBold12pt7b : &FreeSans9pt7b);
      virtualDisp->setTextColor(color);
      virtualDisp->setCursor(posX, cy);
      virtualDisp->write((uint8_t)newChars[i].c);

      posX += (newChars[i].c == '.') ? ((size == 12) ? dotAdv12 : dotAdv9)
                                     : ((size == 12) ? digitAdv12 : digitAdv9);
    }
  } else {
    int posX = cx;
    for (int i = 0; i < newLen; i++) {
      int size = newChars[i].size;
      int cy = (size == 12) ? ((PANEL_RES_Y - textH12) / 2 - textYoff12)
                            : ((PANEL_RES_Y - textH9) / 2 - textYoff9 + 2);
      int textH = (size == 12) ? textH12 : textH9;
      int textYoff = (size == 12) ? textYoff12 : textYoff9;
      int charW = (newChars[i].c == '.')
                      ? ((size == 12) ? dotAdv12 : dotAdv9)
                      : ((size == 12) ? digitAdv12 : digitAdv9);

      if (newChars[i].c != prevChars[i].c || color != prevColor) {
        virtualDisp->fillRect(posX, cy + textYoff, charW, textH, colBlack);
        virtualDisp->setFont((size == 12) ? &FreeSansBold12pt7b
                                          : &FreeSans9pt7b);
        virtualDisp->setTextColor(color);
        virtualDisp->setCursor(posX, cy);
        virtualDisp->write((uint8_t)newChars[i].c);
      }
      posX += charW;
    }
  }

  for (int i = 0; i < newLen; i++) {
    prevChars[i] = newChars[i];
  }
  prevLen = newLen;
  prevColor = color;
  prevFormat = curFormat;
}

void displayTime(unsigned long ms, uint16_t color) {
  unsigned long sec = ms / 1000;
  unsigned long frac = ms % 1000;
  int curFormat;
  char buf[16];
  if (sec < 10) {
    sprintf(buf, "%lu.%03lu", sec, frac);
    curFormat = 1; // X.XXX (All large font)
  } else if (sec < 100) {
    sprintf(buf, "%lu.%03lu", sec, frac);
    curFormat = 2; // XX.XXX (Seconds large, MS small)
  } else if (sec < 1000) {
    sprintf(buf, "%lu.%02lu", sec, frac / 10);
    curFormat = 3; // XXX.XX (All small font)
  } else {
    sprintf(buf, "%lu", sec);
    curFormat = 4; // XXXX (All small font)
  }
  renderBuf(buf, curFormat, color);
}

void displayNumber(uint32_t n, uint16_t color) {
  if (n > 9999)
    n = 9999;
  char buf[8];
  sprintf(buf, "%lu", (unsigned long)n);
  // dung format theo so chu so (+10 de tach khoi format displayTime)
  int curFormat = 10 + strlen(buf);
  renderBuf(buf, curFormat, color);
}
