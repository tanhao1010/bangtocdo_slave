#include <Arduino.h>
#include <LittleFS.h>
#include "driver/i2s.h"

#define I2S_BCK   25
#define I2S_LRCK  32
#define I2S_DOUT  33

#define I2S_PORT I2S_NUM_0

File wavFile;

void setupI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCK,
    .ws_io_num = I2S_LRCK,
    .data_out_num = I2S_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
}

void playWav(const char *path) {
  wavFile = LittleFS.open(path, "r");

  if (!wavFile) {
    Serial.println("Khong mo duoc file WAV");
    return;
  }

  Serial.println("Dang phat...");

  // Bỏ qua header WAV 44 byte
  wavFile.seek(44);

  uint8_t buffer[1024];
  size_t bytesRead;
  size_t bytesWritten;

  while (wavFile.available()) {
    bytesRead = wavFile.read(buffer, sizeof(buffer));
    i2s_write(I2S_PORT, buffer, bytesRead, &bytesWritten, portMAX_DELAY);
  }

  wavFile.close();
  Serial.println("Phat xong");
}

void setup() {
  Serial.begin(115200);

  if (!LittleFS.begin(true)) {
    Serial.println("Loi LittleFS");
    return;
  }

  setupI2S();

  playWav("/mp3.wav");
}

void loop() {
}