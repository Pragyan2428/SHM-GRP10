// Smart SHM System - ESP32 sensor node
//
// Reads the project's three sensors and sends them to the API (POST /api/ingest with the
// X-Device-Key header) every few seconds:
//   HX711   strain gauge amplifier   -> strain (microstrain)
//   ADXL345 3-axis accelerometer     -> vibration (peak dynamic acceleration, g)
//   DS18B20 digital temperature      -> temperature (deg C)
//
// WIRELESS SET-UP (no USB cable or secrets.h editing needed per board)
//   1. Bluetooth: a board with no Wi-Fi saved (or whose Wi-Fi fails) advertises over
//      Bluetooth as "SHM-xxxxxx". On the website: Sensor nodes > Add node > "Set up over
//      Bluetooth" sends it the Wi-Fi name, password and the website's address.
//   2. Wi-Fi: once on Wi-Fi the board announces itself to the API every 5 s. It appears
//      under Add node > "Nearby devices" for admins on the same Wi-Fi.
//   3. The admin clicks Connect, picks the name/floor/location, and the board receives its
//      own node ID and device key, saves them in flash and starts sending readings.
//   Hold the BOOT button for 5 s to forget Wi-Fi and pairing (back to step 1).
//
// MANUAL SET-UP (as before): put DEVICE_KEY in secrets.h and set NODE_ID/LOCATION below.
// The board then skips pairing and sends straight away with that key (e.g. a personal
// device key from "Connect your ESP32" on a user's page).
//
// Board: ESP32 Dev Module (Arduino IDE > Boards Manager > "esp32 by Espressif Systems").
// IMPORTANT: Tools > Partition Scheme > "Huge APP (3MB No OTA/1MB SPIFFS)" - Bluetooth +
// Wi-Fi + HTTPS do not fit in the default 1.2 MB app partition.
// Libraries (Arduino IDE > Library Manager), only needed when USE_REAL_SENSORS is 1:
//   "HX711 Arduino Library" by Bogdan Necula, "Adafruit ADXL345" (+ "Adafruit Unified Sensor"),
//   "OneWire" and "DallasTemperature". Bluetooth/Wi-Fi/Preferences come with the ESP32 core.
//
// Wiring (change the pins below if yours differ):
//   HX711   DOUT -> GPIO 16, SCK -> GPIO 4, VCC -> 3V3, GND -> GND
//   ADXL345 SDA  -> GPIO 21, SCL -> GPIO 22, VCC -> 3V3, GND -> GND (I2C address 0x53)
//   DS18B20 DATA -> GPIO 5 with a 4.7 kOhm pull-up to 3V3, VCC -> 3V3, GND -> GND
//
// Serial Monitor at 115200 baud: "POST 200" means a reading arrived.

#define USE_REAL_SENSORS 1   // 0 = send made-up normal values (no sensors or libraries needed)

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// secrets.h is optional now: anything left out is set over Bluetooth / from the website.
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef API_URL
#define API_URL ""          // e.g. "https://<project>.vercel.app" (the /api/ingest ending is optional)
#endif
#ifndef DEVICE_KEY
#define DEVICE_KEY ""       // empty = pair from the website (recommended)
#endif

#if USE_REAL_SENSORS
#include <Wire.h>
#include <HX711.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_ADXL345_U.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#endif

// Only used with a manual DEVICE_KEY; a paired board gets its ID and location from the website.
const char* NODE_ID   = "ESP32-07";
const char* LOCATION  = "Ground floor - column C2";
const char* FIRMWARE  = "2.0.0";
const uint32_t SEND_EVERY_MS     = 5000;   // keep under 30 s or the node shows as offline
const uint32_t ANNOUNCE_EVERY_MS = 5000;
const int BOOT_BUTTON_PIN = 0;

const int HX711_DOUT_PIN = 16;
const int HX711_SCK_PIN  = 4;
const int DS18B20_PIN    = 5;
// HX711 counts per microstrain. Depends on gauge factor, bridge excitation and gain:
// apply a known strain (or use a calibrated rig) and divide the count change by it.
const float STRAIN_COUNTS_PER_MICROSTRAIN = 4.0;
const int VIBRATION_SAMPLES = 100;             // ~100 samples over ~0.2 s per reading

// Bluetooth set-up service (the website uses the same UUIDs)
#define BLE_SERVICE_UUID   "6e1a0001-5a4d-4f8e-9b3c-53484d000001"
#define BLE_CONFIG_UUID    "6e1a0002-5a4d-4f8e-9b3c-53484d000001"  // write: {"ssid","pass","api"}
#define BLE_STATUS_UUID    "6e1a0003-5a4d-4f8e-9b3c-53484d000001"  // read/notify: {"state",...}
#define BLE_NETWORKS_UUID  "6e1a0004-5a4d-4f8e-9b3c-53484d000001"  // read: Wi-Fi networks nearby

#if USE_REAL_SENSORS
HX711 strainAmp;
Adafruit_ADXL345_Unified accel(12345);
OneWire oneWire(DS18B20_PIN);
DallasTemperature tempSensor(&oneWire);
bool accelOk = false;
#endif

Preferences prefs;
String cfgSsid, cfgPass, cfgApi, nodeId, nodeLocation, nodeKey, claimSecret, macStr;
bool manualKey = false;

// ---- small helpers ------------------------------------------------------------------
String apiBase(String u) {
  u.trim();
  if (u.endsWith("/api/ingest")) u = u.substring(0, u.length() - 11);
  while (u.endsWith("/")) u.remove(u.length() - 1);
  return u;
}

// Reads one string value from a flat JSON object (enough for the API's and the website's replies).
String jsonStr(const String& body, const char* key) {
  String needle = String("\"") + key + "\"";
  int i = body.indexOf(needle);
  if (i < 0) return "";
  i = body.indexOf(':', i + needle.length());
  if (i < 0) return "";
  i = body.indexOf('"', i);
  if (i < 0) return "";
  String out;
  for (int j = i + 1; j < (int)body.length(); j++) {
    char c = body[j];
    if (c == '\\' && j + 1 < (int)body.length()) {
      char n = body[++j];
      out += n == 'n' ? '\n' : n == 't' ? '\t' : n;
    } else if (c == '"') {
      return out;
    } else {
      out += c;
    }
  }
  return "";
}

String jsonEscape(const String& s) {
  String o;
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((uint8_t)c >= 0x20) o += c;
  }
  return o;
}

void loadConfig() {
  prefs.begin("shm", false);
  cfgSsid      = prefs.getString("ssid", WIFI_SSID);
  cfgPass      = prefs.getString("pass", WIFI_PASSWORD);
  cfgApi       = apiBase(prefs.getString("api", API_URL));
  nodeId       = prefs.getString("node", "");
  nodeLocation = prefs.getString("loc", "");
  nodeKey      = prefs.getString("key", "");
  claimSecret  = prefs.getString("claim", "");
  if (claimSecret.length() < 16) {  // random, kept for life: proves to the API it is the same board
    char buf[33];
    for (int i = 0; i < 16; i++) snprintf(buf + i * 2, 3, "%02x", (uint8_t)(esp_random() & 0xFF));
    claimSecret = buf;
    prefs.putString("claim", claimSecret);
  }
  if (nodeKey.length() == 0 && strlen(DEVICE_KEY) > 0 && String(DEVICE_KEY) != "paste-device-key-here") {
    manualKey = true;  // old-style set-up from secrets.h
    nodeKey = DEVICE_KEY;
    nodeId = NODE_ID;
    nodeLocation = LOCATION;
  }
}

void forgetEverything() {
  Serial.println("Forgetting Wi-Fi and pairing, restarting...");
  String claim = claimSecret;
  prefs.clear();
  prefs.putString("claim", claim);
  delay(300);
  ESP.restart();
}

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

// ---- Bluetooth set-up -----------------------------------------------------------------
bool bleOn = false, bleClient = false, bleGotConfig = false, bleReleased = false;
BLECharacteristic *bleStatus = nullptr, *bleNetworks = nullptr;
uint32_t bleStopAt = 0;

void bleSetStatus(const String& state, const String& extra = "") {
  if (!bleOn || !bleStatus) return;
  String s = "{\"state\":\"" + state + "\",\"mac\":\"" + macStr + "\",\"fw\":\"" + FIRMWARE + "\"" +
             (extra.length() ? "," + extra : "") + "}";
  bleStatus->setValue((uint8_t*)s.c_str(), s.length());
  if (bleClient) bleStatus->notify();
}

class ServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleClient = true; }
  void onDisconnect(BLEServer* s) override {
    bleClient = false;
    if (bleOn) s->getAdvertising()->start();  // let the website reconnect
  }
};

class ConfigCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String body = String(c->getValue().c_str());  // works with ESP32 core 2.x (std::string) and 3.x (String)
    String ssid = jsonStr(body, "ssid");
    if (!ssid.length()) { bleSetStatus("bad_config"); return; }
    cfgSsid = ssid;
    cfgPass = jsonStr(body, "pass");
    String api = jsonStr(body, "api");
    if (api.length()) cfgApi = apiBase(api);
    prefs.putString("ssid", cfgSsid);
    prefs.putString("pass", cfgPass);
    prefs.putString("api", cfgApi);
    bleGotConfig = true;  // connect from loop(), not inside the Bluetooth callback
  }
};

void startBle() {
  if (bleOn) return;
  if (bleReleased) { ESP.restart(); return; }  // Bluetooth memory was handed to Wi-Fi: start fresh
  // Scan first so the website can offer a list of Wi-Fi names
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  String nets = "[";
  for (int i = 0, added = 0; i < n && added < 12 && nets.length() < 440; i++) {
    String s = WiFi.SSID(i);
    if (!s.length() || nets.indexOf("\"" + jsonEscape(s) + "\"") >= 0) continue;
    nets += String(added++ ? "," : "") + "{\"ssid\":\"" + jsonEscape(s) + "\",\"rssi\":" + WiFi.RSSI(i) + "}";
  }
  nets += "]";
  WiFi.scanDelete();

  String name = "SHM-" + macStr.substring(9, 11) + macStr.substring(12, 14) + macStr.substring(15, 17);
  BLEDevice::init(name.c_str());
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  BLEService* svc = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic* cfg = svc->createCharacteristic(BLE_CONFIG_UUID, BLECharacteristic::PROPERTY_WRITE);
  cfg->setCallbacks(new ConfigCb());
  bleStatus = svc->createCharacteristic(BLE_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  bleStatus->addDescriptor(new BLE2902());
  bleNetworks = svc->createCharacteristic(BLE_NETWORKS_UUID, BLECharacteristic::PROPERTY_READ);
  bleNetworks->setValue((uint8_t*)nets.c_str(), nets.length());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  bleOn = true;
  bleSetStatus("waiting_for_wifi");
  Serial.printf("Bluetooth set-up on: open the website > Sensor nodes > Add node > Set up over Bluetooth, pick \"%s\"\n", name.c_str());
}

void stopBle() {
  if (!bleOn) return;
  bleOn = false;
  bleReleased = true;
  BLEDevice::deinit(true);  // frees ~100 kB RAM for HTTPS; Bluetooth comes back after a restart
  Serial.println("Bluetooth set-up off (on Wi-Fi now)");
}

// ---- networking ---------------------------------------------------------------------
bool connectWifi(uint32_t timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!cfgSsid.length()) return false;
  Serial.printf("Connecting to Wi-Fi \"%s\"", cfgSsid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) { delay(250); Serial.print("."); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected, ESP32 IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }
  Serial.println("\nWi-Fi failed - check the name/password (2.4 GHz networks only)");
  WiFi.disconnect();
  return false;
}

int httpPost(const String& url, const String& body, const char* key, String& reply) {
  HTTPClient http;
  http.setTimeout(20000);  // a cloud host (e.g. Vercel) can take a few seconds after a pause
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  if (key && strlen(key)) http.addHeader("X-Device-Key", key);
  int code = http.POST(body);
  reply = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  return code;
}

// Unpaired: tell the API "I'm here" until an admin clicks Connect on the website.
void announce() {
  String body = "{\"mac\":\"" + macStr + "\",\"claim_secret\":\"" + claimSecret + "\",\"firmware\":\"" + FIRMWARE +
                "\",\"rssi\":" + String(constrain(WiFi.RSSI(), -120, 0)) + ",\"local_ip\":\"" + WiFi.localIP().toString() +
                "\",\"ssid\":\"" + jsonEscape(WiFi.SSID()) + "\",\"sensors\":[\"strain\",\"vibration\",\"temperature\"]}";
  String reply;
  int code = httpPost(cfgApi + "/api/devices/announce", body, nullptr, reply);
  if (code != 200) {
    Serial.printf("Announce %d: %s\n", code, reply.c_str());
    return;
  }
  if (jsonStr(reply, "status") == "approved") {
    nodeId = jsonStr(reply, "node_id");
    nodeLocation = jsonStr(reply, "location");
    nodeKey = jsonStr(reply, "device_key");
    if (nodeId.length() && nodeKey.length()) {
      prefs.putString("node", nodeId);
      prefs.putString("loc", nodeLocation);
      prefs.putString("key", nodeKey);
      Serial.printf("Connected from the website as %s (%s)\n", nodeId.c_str(), nodeLocation.c_str());
    }
  } else {
    Serial.printf("Waiting for an admin: Sensor nodes > Add node > Nearby devices (%s)\n", macStr.c_str());
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
  body = "{\"node_id\":\"" + nodeId + "\",";
  // A paired node's location is managed on the website, so only manual set-ups send it.
  if (manualKey) body += "\"location\":\"" + jsonEscape(nodeLocation) + "\",";
  body += "\"firmware\":\"" + String(FIRMWARE) + "\",\"rssi\":" + String(constrain(WiFi.RSSI(), -120, 0)) +
          ",\"readings\":{" + readings + "}}";
  return true;
}

void sendReading() {
  String body, reply;
  if (!buildJson(body)) {
    Serial.println("No sensor values to send - check the wiring messages above");
    return;
  }
  int code = httpPost(cfgApi + "/api/ingest", body, nodeKey.c_str(), reply);
  if (code == 200) {
    Serial.printf("POST 200  %s\n", body.c_str());
  } else if (code == 401 && !manualKey) {
    // the node was deleted on the website (its key no longer works): go back to being discoverable
    Serial.println("Device key refused - node removed on the website. Announcing again.");
    nodeKey = nodeId = nodeLocation = "";
    prefs.remove("key"); prefs.remove("node"); prefs.remove("loc");
  } else if (code > 0) {
    // 401 = wrong device key, 409 = node ID used by another device, 422 = bad JSON / value
    Serial.printf("POST %d  %s\n", code, reply.c_str());
  } else {
    // negative = could not reach the server: wrong address, firewall, or network isolation
    Serial.printf("POST failed: %s\n", reply.c_str());
  }
}

// ---- main -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  WiFi.mode(WIFI_STA);
  macStr = WiFi.macAddress();
  loadConfig();
  Serial.printf("\nSmart SHM node %s  MAC %s  server %s\n", FIRMWARE, macStr.c_str(),
                cfgApi.length() ? cfgApi.c_str() : "(not set - use Bluetooth set-up)");
  setupSensors();
  if (!cfgApi.length() || !connectWifi(20000)) startBle();
}

void loop() {
  static uint32_t lastSend = 0, lastAnnounce = 0, lastWifiTry = 0, buttonDown = 0;

  // BOOT button held 5 s = forget Wi-Fi and pairing
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (!buttonDown) buttonDown = millis();
    else if (millis() - buttonDown > 5000) forgetEverything();
  } else {
    buttonDown = 0;
  }

  // New Wi-Fi details from the website over Bluetooth
  if (bleGotConfig) {
    bleGotConfig = false;
    bleSetStatus("connecting", "\"ssid\":\"" + jsonEscape(cfgSsid) + "\"");
    WiFi.disconnect();
    if (connectWifi(20000)) {
      bleSetStatus("wifi_ok", "\"ip\":\"" + WiFi.localIP().toString() + "\"");
      bleStopAt = millis() + 4000;  // give the website time to read the result
    } else {
      bleSetStatus("wifi_failed");
    }
  }
  if (bleOn && bleStopAt && millis() > bleStopAt) { bleStopAt = 0; stopBle(); }

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiTry > 30000) {
      lastWifiTry = millis();
      if (!connectWifi(10000) && !bleOn && !cfgSsid.length()) startBle();
      else if (WiFi.status() == WL_CONNECTED && bleOn && !bleStopAt) bleStopAt = millis() + 4000;
    }
    return;
  }
  if (!cfgApi.length()) return;  // waiting for the website's address over Bluetooth

  if (nodeKey.length()) {
    if (millis() - lastSend >= SEND_EVERY_MS || lastSend == 0) {
      lastSend = millis();
      sendReading();
    }
  } else if (millis() - lastAnnounce >= ANNOUNCE_EVERY_MS || lastAnnounce == 0) {
    lastAnnounce = millis();
    announce();
  }
}
