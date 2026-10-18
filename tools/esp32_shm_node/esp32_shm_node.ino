// Smart SHM System - ESP32 sensor node
//
// Reads the project's three sensors and sends them to the API (POST /api/ingest with the
// X-Device-Key header) every few seconds:
//   HX711   strain gauge amplifier   -> strain (microstrain)
//   ADXL345 3-axis accelerometer     -> vibration (peak dynamic acceleration, g)
//   DS18B20 digital temperature      -> temperature (deg C)
//
// Board: ESP32 Dev Module (Arduino IDE > Boards Manager > "esp32 by Espressif Systems").
// Libraries (Arduino IDE > Library Manager), only needed when USE_REAL_SENSORS is 1:
//   "HX711 Arduino Library" by Bogdan Necula, "Adafruit ADXL345" (+ "Adafruit Unified Sensor"),
//   "OneWire" and "DallasTemperature".
//
// Wiring (change the pins below if yours differ):
//   HX711   DOUT -> GPIO 16, SCK -> GPIO 4, VCC -> 3V3, GND -> GND
//   ADXL345 SDA  -> GPIO 21, SCL -> GPIO 22, VCC -> 3V3, GND -> GND (I2C address 0x53)
//   DS18B20 DATA -> GPIO 5 with a 4.7 kOhm pull-up to 3V3, VCC -> 3V3, GND -> GND
//
// 1. Copy secrets.example.h to secrets.h and fill in Wi-Fi, API address and device key.
// 2. Upload, open Serial Monitor at 115200 baud: "POST 200" means the reading arrived.
// 3. Calibrate STRAIN_COUNTS_PER_MICROSTRAIN for your gauge, then tune the limits on the
//    dashboard's Threshold settings page to what your structure normally reads.

#define USE_REAL_SENSORS 1   // 0 = send made-up normal values (no sensors or libraries needed)

#include <WiFi.h>
#include <HTTPClient.h>
#include "secrets.h"

#if USE_REAL_SENSORS
#include <Wire.h>
#include <HX711.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_ADXL345_U.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#endif

const char* NODE_ID   = "ESP32-07";             // must be unique; ESP32-01..06 are the simulator's
const char* LOCATION  = "Ground floor - column C2";  // shown on the dashboard
const char* FIRMWARE  = "1.1.0";
const uint32_t SEND_EVERY_MS = 5000;            // keep under 30 s or the node shows as offline

const int HX711_DOUT_PIN = 16;
const int HX711_SCK_PIN  = 4;
const int DS18B20_PIN    = 5;
// HX711 counts per microstrain. Depends on gauge factor, bridge excitation and gain:
// apply a known strain (or use a calibrated rig) and divide the count change by it.
const float STRAIN_COUNTS_PER_MICROSTRAIN = 4.0;
const int VIBRATION_SAMPLES = 100;             // ~100 samples over ~0.2 s per reading

#if USE_REAL_SENSORS
HX711 strainAmp;
Adafruit_ADXL345_Unified accel(12345);
OneWire oneWire(DS18B20_PIN);
DallasTemperature tempSensor(&oneWire);
bool accelOk = false;
#endif

// ---- sensors ------------------------------------------------------------------------
// Each read returns NAN when the sensor is missing, so that reading is simply left out.
float readStrain() {
#if USE_REAL_SENSORS
  if (!strainAmp.wait_ready_timeout(200)) return NAN;
  return strainAmp.get_units(5);  // tared at start-up, so this is strain since installation
#else
  return 320.0 + random(-100, 100) / 10.0;
#endif
}

float readVibration() {
#if USE_REAL_SENSORS
  if (!accelOk) return NAN;
  // Peak deviation of the total acceleration from its mean over a short window,
  // i.e. the dynamic part with gravity removed, in g.
  static float mags[VIBRATION_SAMPLES];
  float sum = 0;
  for (int i = 0; i < VIBRATION_SAMPLES; i++) {
    sensors_event_t e;
    accel.getEvent(&e);
    mags[i] = sqrt(e.acceleration.x * e.acceleration.x + e.acceleration.y * e.acceleration.y +
                   e.acceleration.z * e.acceleration.z) / SENSORS_GRAVITY_STANDARD;
    sum += mags[i];
    delay(2);
  }
  float mean = sum / VIBRATION_SAMPLES, peak = 0;
  for (int i = 0; i < VIBRATION_SAMPLES; i++) peak = max(peak, (float)fabs(mags[i] - mean));
  return peak;
#else
  return 0.60 + random(-50, 50) / 1000.0;
#endif
}

float readTemperature() {
#if USE_REAL_SENSORS
  tempSensor.requestTemperatures();
  float c = tempSensor.getTempCByIndex(0);
  return c == DEVICE_DISCONNECTED_C ? NAN : c;
#else
  return 27.0 + random(-5, 5) / 10.0;
#endif
}

void setupSensors() {
#if USE_REAL_SENSORS
  strainAmp.begin(HX711_DOUT_PIN, HX711_SCK_PIN);
  strainAmp.set_scale(STRAIN_COUNTS_PER_MICROSTRAIN);
  if (strainAmp.wait_ready_timeout(1000)) {
    strainAmp.tare(20);  // zero strain = the structure's state when the node starts
    Serial.println("HX711 strain amplifier ready");
  } else {
    Serial.println("HX711 not found - check DOUT/SCK wiring");
  }
  accelOk = accel.begin();
  if (accelOk) {
    accel.setRange(ADXL345_RANGE_4_G);
    accel.setDataRate(ADXL345_DATARATE_400_HZ);
    Serial.println("ADXL345 accelerometer ready");
  } else {
    Serial.println("ADXL345 not found - check SDA/SCL wiring");
  }
  tempSensor.begin();
  Serial.printf("DS18B20 sensors found: %d\n", tempSensor.getDeviceCount());
#else
  Serial.println("USE_REAL_SENSORS is 0 - sending made-up values");
#endif
}

// ---- networking ---------------------------------------------------------------------
void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Connecting to Wi-Fi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected, ESP32 IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("\nWi-Fi failed - check the name/password (2.4 GHz networks only)");
  }
}

// Builds the JSON body; returns false when no sensor produced a value.
bool buildJson(String& body) {
  float strain = readStrain(), vibration = readVibration(), temperature = readTemperature();
  String readings;
  char num[24];
  if (!isnan(strain))      { snprintf(num, sizeof(num), "%.1f", strain);      readings += String("\"strain\":") + num; }
  if (!isnan(vibration))   { snprintf(num, sizeof(num), "%.3f", vibration);   readings += String(readings.length() ? "," : "") + "\"vibration\":" + num; }
  if (!isnan(temperature)) { snprintf(num, sizeof(num), "%.1f", temperature); readings += String(readings.length() ? "," : "") + "\"temperature\":" + num; }
  if (!readings.length()) return false;
  body = String("{\"node_id\":\"") + NODE_ID + "\",\"location\":\"" + LOCATION + "\",\"firmware\":\"" + FIRMWARE +
         "\",\"rssi\":" + String(constrain(WiFi.RSSI(), -120, 0)) + ",\"readings\":{" + readings + "}}";
  return true;
}

void sendReading() {
  String body;
  if (!buildJson(body)) {
    Serial.println("No sensor values to send - check the wiring messages above");
    return;
  }
  HTTPClient http;
  http.setTimeout(20000);  // a cloud host (e.g. Vercel) can take a few seconds after a pause
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.POST(body);
  if (code == 200) {
    Serial.printf("POST 200  %s\n", body.c_str());
  } else if (code > 0) {
    // 401 = wrong device key, 422 = bad JSON / out-of-range value
    Serial.printf("POST %d  %s\n", code, http.getString().c_str());
  } else {
    // negative = could not reach the PC: wrong IP, firewall, or network isolation
    Serial.printf("POST failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nSmart SHM node %s -> %s\n", NODE_ID, API_URL);
  setupSensors();
  connectWifi();
}

void loop() {
  static uint32_t last = 0;
  if (millis() - last >= SEND_EVERY_MS || last == 0) {
    last = millis();
    connectWifi();
    if (WiFi.status() == WL_CONNECTED) sendReading();
  }
}
