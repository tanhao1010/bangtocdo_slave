#include "ESP32-VirtualMatrixPanel-I2S-DMA.h"
#include <Arduino.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <ModbusRTU.h>
#include <esp_timer.h>

#define PANEL_RES_X 64
#define PANEL_RES_Y 32
#define NUM_ROWS 1
#define NUM_COLS 1

#define BUTTON_PIN 34
#define DEBOUNCE_US 250000
// GPIO34-39 on ESP32 are input-only — INPUT_PULLUP is silently ignored.
// Must use external pull-up resistor. MIN_RACE_US guards against spurious
// triggers.
#define MIN_RACE_US 700000LL // 700ms minimum race time before accepting stop

// Cấu hình ID Slave: Đặt là 1 cho bảng 1, 2 cho bảng 2
#define MODBUS_SLAVE_ID 2

MatrixPanel_I2S_DMA *dma_display = nullptr;
VirtualMatrixPanel *virtualDisp = nullptr;
uint16_t colBlack;

ModbusRTU mb;

enum ModbusHreg {
  HR_SLAVE_ID = 0,
  HR_MODE = 1,
  HR_SEC = 2,
  HR_MS = 3,
  HR_COUNT_STATE = 4,
  HR_MASTER_SIG = 5,
  HR_COLOR_READY = 6,
  HR_COLOR_STOP = 7,
  HR_SYNC_FLAG = 8,
  HR_COUNT = 10
};

enum State { IDLE, RUNNING, STOPPED };
State timerState = IDLE;
int64_t tStart_us = 0;
int64_t tElapsed_us = 0;
bool stateChanged = false;

#define REFRESH_MS 10
static char prevBuf[16] = "";
static uint16_t prevColor = 0;
static int prevFormat = -1;

static int digitAdv = 0;
static int dotAdv = 0;
static int textH = 0;
static int textYoff = 0;

void displayTime(unsigned long ms, uint16_t color);
void initFontMetrics();
void updateModbusRegs();

uint16_t getColorFromID(int id) {
  switch (id) {
  case 1:
    return 0x07E0; // Green
  case 2:
    return 0xF800; // Red
  case 3:
    return 0x001F; // Blue
  case 4:
    return 0xFFE0; // Yellow
  case 5:
    return 0x07FF; // Cyan
  case 6:
    return 0xF81F; // Magenta
  case 7:
    return 0xFFFF; // White
  case 8:
    return 0xFD20; // Orange
  case 9:
    return 0x801F; // Purple
  case 10:
    return 0xAFE5; // Pink/Lime
  default:
    return 0x07E0;
  }
}

volatile bool btnPressed = false;

void IRAM_ATTR buttonISR() {
  int64_t now = esp_timer_get_time();
  static int64_t lastISR = 0;
  if ((now - lastISR) < DEBOUNCE_US)
    return;
  lastISR = now;
  btnPressed = true;
}

void initFontMetrics() {
  const GFXfont *font = &FreeSansBold12pt7b;
  digitAdv = 0;
  for (char c = '0'; c <= '9'; c++) {
    int adv = font->glyph[c - font->first].xAdvance;
    if (adv > digitAdv)
      digitAdv = adv;
  }
  dotAdv = font->glyph['.' - font->first].xAdvance;
  int16_t x1, y1;
  uint16_t w, h;
  virtualDisp->setFont(font);
  virtualDisp->setTextSize(1);
  virtualDisp->getTextBounds("0", 0, 0, &x1, &y1, &w, &h);
  textH = h + 2;
  textYoff = y1 - 1;
}

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, FALLING);

  Serial.begin(115200);
  mb.begin(&Serial);
  mb.slave(MODBUS_SLAVE_ID);

  for (uint16_t i = 0; i < HR_COUNT; i++) {
    mb.addHreg(i, 0);
  }
  mb.Hreg(HR_SLAVE_ID, MODBUS_SLAVE_ID);
  mb.Hreg(HR_COLOR_READY, 1);
  mb.Hreg(HR_COLOR_STOP, 2);
  mb.Hreg(HR_MODE, 1);

  HUB75_I2S_CFG mxconfig(PANEL_RES_X * 2, PANEL_RES_Y / 2, NUM_ROWS * NUM_COLS);
  mxconfig.clkphase = false;
  mxconfig.driver = HUB75_I2S_CFG::ICN2038S;

  dma_display = new MatrixPanel_I2S_DMA(mxconfig);
  dma_display->setBrightness8(200);
  dma_display->begin();
  delay(500);

  virtualDisp = new VirtualMatrixPanel(*dma_display, NUM_ROWS, NUM_COLS,
                                       PANEL_RES_X, PANEL_RES_Y);
  virtualDisp->setPhysicalPanelScanRate(FOUR_SCAN_32PX_HIGH);

  colBlack = virtualDisp->color565(0, 0, 0);
  initFontMetrics();
  virtualDisp->fillScreen(colBlack);
  displayTime(0, getColorFromID(mb.Hreg(HR_COLOR_READY)));
}

uint32_t lastDisplayMs = 0;
uint32_t lastRegUpdateMs = 0;

void loop() {
  mb.task();

  uint16_t masterSig = mb.Hreg(HR_MASTER_SIG);
  uint16_t currentMode = mb.Hreg(HR_MODE);
  static uint16_t lastMasterSig = 999;
  static uint16_t lastHregSec = 999;
  static uint16_t lastHregMs = 999;

  if (masterSig != lastMasterSig) {
    lastMasterSig = masterSig;

    if ((masterSig == 0 || masterSig == 100) &&
        (timerState != IDLE || tElapsed_us != 0)) {
      tElapsed_us = 0;
      timerState = IDLE;
      stateChanged = true;
      lastHregSec = 999;
      lastHregMs = 999;
      updateModbusRegs();
    } else if (masterSig == 150 && timerState != RUNNING) {
      tElapsed_us = 0;
      tStart_us = esp_timer_get_time();
      timerState = RUNNING;
      stateChanged = true;
      lastHregSec = 999;
      lastHregMs = 999;
      updateModbusRegs();
    } else if (masterSig == 155 && lastMasterSig != 155) {
      tElapsed_us = 0;
      tStart_us = esp_timer_get_time();
      timerState = RUNNING;
      stateChanged = true;
      lastHregSec = 999;
      lastHregMs = 999;
      updateModbusRegs();
    } else if (masterSig == 250) {
      // Blank screen immediately for fast visual feedback
      virtualDisp->fillScreen(colBlack);
      prevFormat = -1; // force full redraw on next displayTime()
      prevBuf[0] = '\0';

      // Lấy thời gian chính thức từ master (đã được ghi trước sig=250)
      uint32_t final_sec = mb.Hreg(HR_SEC);
      uint32_t final_ms = mb.Hreg(HR_MS);
      tElapsed_us = ((int64_t)final_sec * 1000 + final_ms) * 1000;
      timerState = STOPPED;
      stateChanged = true;
      updateModbusRegs();
    }
  }

  if (timerState == STOPPED) {
    uint16_t hregSec = mb.Hreg(HR_SEC);
    uint16_t hregMs = mb.Hreg(HR_MS);
    if (hregSec != lastHregSec || hregMs != lastHregMs) {
      lastHregSec = hregSec;
      lastHregMs = hregMs;
      tElapsed_us = ((int64_t)hregSec * 1000 + hregMs) * 1000;
      stateChanged = true;
    }
  }

  if (btnPressed) {
    btnPressed = false;
    int64_t now = esp_timer_get_time();

    if (currentMode == 1) {
      if (MODBUS_SLAVE_ID == 1) {
        if (timerState == IDLE && masterSig == 100) {
          tElapsed_us = 0;
          tStart_us = now;
          timerState = RUNNING;
          stateChanged = true;
          lastHregSec = 999;
          lastHregMs = 999;
          updateModbusRegs();
        }
      } else if (MODBUS_SLAVE_ID == 2) {
        // Guard: ignore trigger within MIN_RACE_US of start (spurious /
        // floating pin)
        if (timerState == RUNNING && (now - tStart_us) >= MIN_RACE_US) {
          tElapsed_us = now - tStart_us;
          timerState = STOPPED;
          stateChanged = true;
          updateModbusRegs();
        }
      }
    } else if (currentMode == 2) {
      // Guard: same minimum time before accepting stop
      if (timerState == RUNNING && (now - tStart_us) >= MIN_RACE_US) {
        tElapsed_us = now - tStart_us;
        timerState = STOPPED;
        stateChanged = true;
        mb.Hreg(HR_SEC, (uint16_t)(tElapsed_us / 1000000));
        mb.Hreg(HR_MS, (uint16_t)((tElapsed_us / 1000) % 1000));
        updateModbusRegs();
      }
    }
  }

  if (millis() - lastRegUpdateMs > 10) {
    lastRegUpdateMs = millis();
    updateModbusRegs();
  }

  uint16_t colorReady = getColorFromID(mb.Hreg(HR_COLOR_READY));
  uint16_t colorStop = getColorFromID(mb.Hreg(HR_COLOR_STOP));

  if (stateChanged) {
    stateChanged = false;
    if (timerState == STOPPED) {
      displayTime((unsigned long)(tElapsed_us / 1000), colorStop);
    } else if (timerState == IDLE) {
      displayTime(0, colorReady);
    }
  }

  if (timerState == RUNNING) {
    if (millis() - lastDisplayMs > REFRESH_MS) {
      lastDisplayMs = millis();
      int64_t elapsed = esp_timer_get_time() - tStart_us;
      if (currentMode == 2 && masterSig == 150) {
        displayTime(0, colorReady); // False start phase: keep LED at 0
      } else {
        displayTime((unsigned long)(elapsed / 1000), colorReady);
      }
    }
  }

  yield();
}

void updateModbusRegs() {
  uint16_t mode = mb.Hreg(HR_MODE);
  if (timerState == RUNNING) {
    mb.Hreg(HR_COUNT_STATE, 100);
    if (mode == 2) {
      uint32_t elapsed_ms =
          (uint32_t)((esp_timer_get_time() - tStart_us) / 1000);
      mb.Hreg(HR_SEC, (uint16_t)(elapsed_ms / 1000));
      mb.Hreg(HR_MS, (uint16_t)(elapsed_ms % 1000));
    }
  } else if (timerState == STOPPED) {
    mb.Hreg(HR_COUNT_STATE, 200);
    if (mode == 2) {
      uint32_t elapsed_ms = (uint32_t)(tElapsed_us / 1000);
      mb.Hreg(HR_SEC, (uint16_t)(elapsed_ms / 1000));
      mb.Hreg(HR_MS, (uint16_t)(elapsed_ms % 1000));
    }
  } else {
    mb.Hreg(HR_COUNT_STATE, 0);
    mb.Hreg(HR_SEC, 0);
    mb.Hreg(HR_MS, 0);
  }

  if (mb.Hreg(HR_SYNC_FLAG) == 1) {
    mb.Hreg(HR_SYNC_FLAG, 0);
  }
}

int calcFixedWidth(const char *s) {
  int w = 0;
  for (int i = 0; s[i]; i++) {
    w += (s[i] == '.') ? dotAdv : digitAdv;
  }
  return w;
}

void displayTime(unsigned long ms, uint16_t color) {
  unsigned long sec = ms / 1000;
  unsigned long frac = ms % 1000;

  int curFormat;
  char buf[16];
  if (sec < 10) {
    sprintf(buf, "%lu.%03lu", sec, frac);
    curFormat = 1;
  } else if (sec < 100) {
    sprintf(buf, "%lu.%02lu", sec, frac / 10);
    curFormat = 2;
  } else if (sec < 1000) {
    sprintf(buf, "%lu.%01lu", sec, frac / 100);
    curFormat = 3;
  } else {
    sprintf(buf, "%lu", sec);
    curFormat = 4;
  }

  const GFXfont *font = &FreeSansBold12pt7b;
  virtualDisp->setFont(font);
  virtualDisp->setTextSize(1);

  int newLen = strlen(buf);
  int totalW = calcFixedWidth(buf);
  int cx = (PANEL_RES_X - totalW) / 2;
  int cy = (PANEL_RES_Y - textH) / 2 - textYoff;

  if (curFormat != prevFormat) {
    if (prevFormat > 0) {
      int oldW = calcFixedWidth(prevBuf);
      int oldX = (PANEL_RES_X - oldW) / 2;
      virtualDisp->fillRect(oldX, cy + textYoff, oldW, textH, colBlack);
    }
    virtualDisp->setTextColor(color);
    int posX = cx;
    for (int i = 0; i < newLen; i++) {
      virtualDisp->setCursor(posX, cy);
      virtualDisp->write((uint8_t)buf[i]);
      posX += (buf[i] == '.') ? dotAdv : digitAdv;
    }
  } else {
    int posX = cx;
    for (int i = 0; i < newLen; i++) {
      char newC = buf[i];
      char oldC = prevBuf[i];
      if (newC != oldC || color != prevColor) {
        int slotW = (newC == '.') ? dotAdv : digitAdv;
        virtualDisp->fillRect(posX, cy + textYoff, slotW, textH, colBlack);
        virtualDisp->setTextColor(color);
        virtualDisp->setCursor(posX, cy);
        virtualDisp->write((uint8_t)newC);
      }
      posX += (buf[i] == '.') ? dotAdv : digitAdv;
    }
  }

  strcpy(prevBuf, buf);
  prevColor = color;
  prevFormat = curFormat;
}
