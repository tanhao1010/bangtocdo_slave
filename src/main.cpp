#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>

// ===================== CẤU HÌNH =====================
// 1) WiFi
const char* WIFI_SSID     = "ATProSoft";
const char* WIFI_PASSWORD = "ATPro1234560";

// 2) Version firmware hiện tại đang chạy trên ESP32.
//    Mỗi lần build firmware mới -> tăng số này lên (vd 1 -> 2)
const int FIRMWARE_VERSION = 1;

// 3) URL raw trên GitHub (đổi USER/REPO/BRANCH cho đúng repo của bạn)
//    File version.txt chỉ chứa 1 số nguyên, vd: 2
//    File firmware.bin là file build ra (.pio/build/.../firmware.bin)
const char* VERSION_URL  =
  "https://raw.githubusercontent.com/tanhao1010/bangtocdo_slave/main/version.txt";
const char* FIRMWARE_URL =
  "https://raw.githubusercontent.com/tanhao1010/bangtocdo_slave/main/.pio/build/esp32doit-devkit-v1/firmware.bin";
// ====================================================

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
    Serial.print("Da ket noi. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Khong ket noi duoc WiFi.");
  }
}

// Lay so version moi nhat tu version.txt tren GitHub
int getRemoteVersion() {
  WiFiClientSecure client;
  client.setInsecure();           // bo qua kiem tra chung chi (don gian)
  client.setTimeout(15);          // timeout doc du lieu: 15 giay

  HTTPClient http;
  http.setConnectTimeout(15000);  // timeout ket noi: 15 giay
  http.setTimeout(15000);         // timeout tong: 15 giay
  http.setReuse(false);
  // Theo redirect (raw.githubusercontent co the chuyen huong)
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  if (!http.begin(client, VERSION_URL)) {
    Serial.println("Khong mo duoc VERSION_URL");
    return -1;
  }
  http.addHeader("User-Agent", "ESP32");  // GitHub thich co User-Agent

  int code = http.GET();
  int remote = -1;
  if (code == HTTP_CODE_OK) {
    remote = http.getString().toInt();
    Serial.printf("Version tren server: %d\n", remote);
  } else {
    Serial.printf("Loi tai version.txt, HTTP code: %d\n", code);
  }
  http.end();
  return remote;
}

void doUpdate() {
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(20);

  Serial.println("Bat dau tai firmware moi...");
  httpUpdate.rebootOnUpdate(true);  // tu reboot sau khi update xong
  // raw.githubusercontent co the chuyen huong -> phai cho phep follow
  httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  t_httpUpdate_return ret = httpUpdate.update(client, FIRMWARE_URL);

  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("Update that bai (%d): %s\n",
                    httpUpdate.getLastError(),
                    httpUpdate.getLastErrorString().c_str());
      break;
    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("Khong co update.");
      break;
    case HTTP_UPDATE_OK:
      Serial.println("Update OK!");  // thuong khong toi day vi da reboot
      break;
  }
}

void checkForUpdate() {
  if (WiFi.status() != WL_CONNECTED) return;

  int remote = getRemoteVersion();
  if (remote < 0) return;

  Serial.printf("Version hien tai: %d | Version server: %d\n",
                FIRMWARE_VERSION, remote);

  if (remote > FIRMWARE_VERSION) {
    Serial.println("Co ban moi -> cap nhat.");
    doUpdate();
  } else {
    Serial.println("Da la ban moi nhat.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n=== Khoi dong. Firmware version: %d ===\n", FIRMWARE_VERSION);

  connectWiFi();
  checkForUpdate();   // kiem tra update ngay luc boot
}

void loop() {
   Serial.println("2");
  delay(1000);
}
