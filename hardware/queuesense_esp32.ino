/*
 * QueueSense — ESP32 Node (OP desk + doctor room, all on one breadboard)
 * ---------------------------------------------------------------
 * Hardware: ESP32 NodeMCU 30-pin, 2x IR obstacle sensor, 0.96" SSD1306 OLED
 * (I2C), 1x buzzer, 2x push button, 10x LED.
 * See HARDWARE_SETUP.md for the full GPIO map and wiring notes.
 *
 * WHAT EACH PART DOES
 *   IR sensors (GPIO 4 / 5) .... at the DOCTOR'S DOOR. Entry sensor = patient walked in,
 *                                Exit sensor = patient walked out (consultation finished).
 *   Doctor-room button (GPIO 27)  inside the doctor's room:
 *                                   short press  -> call the NEXT patient
 *                                   double press -> call the PREVIOUS patient back in
 *                                   long press   -> doctor BREAK / absence (long press again = back)
 *   OLED (I2C 21/22) ........... at the OP DESK: who is being called, who is next, queue + wait.
 *   Buzzer (GPIO 25) ........... at the OP DESK: sounds every time a patient is called.
 *   Button 2 (GPIO 26) ......... short = switch OLED page, hold 3 s = reset.
 *
 * Required libraries (Library Manager): Adafruit SSD1306, Adafruit GFX,
 * ArduinoJson (v6). WiFi / HTTPClient / WiFiClientSecure are built in.
 * ---------------------------------------------------------------
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <esp_system.h>

/* ===================== USER CONFIG ===================== */
const char* WIFI_SSID       = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";
const char* BACKEND_HOST    = "your-backend.onrender.com"; // TODO: Replace with your live Render URL (no https://, no trailing slash)
const bool  BACKEND_USE_TLS = true;                        // true = https, false = http (use false for a LAN backend)
const char* DEVICE_ID       = "ESP32_OPDESK_01";
const char* DEVICE_LOCATION = "OP Registration Desk";
const char* DOCTOR_ID       = "d1";                        // which doctor's room this door sensor + button belong to
                                                           // (d1 = Dr. Ananya Rao ... d8 = Dr. Sameer Joshi, see the web app)

/* ===================== GPIO MAP (see HARDWARE_SETUP.md) ===================== */
#define PIN_IR_ENTRY   4    // doctor's door - patient going IN
#define PIN_IR_EXIT    5    // doctor's door - patient coming OUT
#define PIN_OLED_SDA   21
#define PIN_OLED_SCL   22
#define PIN_BUZZER     25   // OP desk buzzer
#define PIN_BTN_NEXT   27   // Button 1: doctor-room button (short / double / long press)
#define PIN_BTN_MODE   26   // Button 2: OLED page / RESET

#define LED_QUEUE_ACTIVE   13
#define LED_QUEUE_LOW      14
#define LED_QUEUE_HIGH     16
#define LED_SERVICE_ACTIVE 17
#define LED_EMERGENCY      18
#define LED_DEVICE_ONLINE  19
#define LED_SERVICE_DONE   23
#define LED_ALERT          32
#define LED_HEARTBEAT      33
#define LED_SPARE          2   // see GPIO2 caution in HARDWARE_SETUP.md

const int ALL_LEDS[10] = {
  LED_QUEUE_ACTIVE, LED_QUEUE_LOW, LED_QUEUE_HIGH, LED_SERVICE_ACTIVE,
  LED_EMERGENCY, LED_DEVICE_ONLINE, LED_SERVICE_DONE, LED_ALERT,
  LED_HEARTBEAT, LED_SPARE
};

/* ===================== TIMING ===================== */
#define DEBOUNCE_MS         50
#define MIN_EVENT_GAP_MS    1200   // minimum time between two counted crossings on the same IR sensor
#define LONG_PRESS_MS       1500   // hold the doctor-room button this long = break
#define DOUBLE_GAP_MS       400    // second press within this window = double press
#define DESK_POLL_MS        2000   // how often the OLED / buzzer data is refreshed
#define HEARTBEAT_MS        15000

/* ===================== IR SENSOR LOGIC ===================== */
#define IR_ACTIVE_LOW true

struct IrSensor {
  int pin;
  bool rawState;
  bool stableState;
  unsigned long lastChangeAt;
  unsigned long lastEventAt;
};

IrSensor irEntry = { PIN_IR_ENTRY, false, false, 0, 0 };
IrSensor irExit  = { PIN_IR_EXIT,  false, false, 0, 0 };

bool isBeamBroken(bool digitalHigh) {
  return IR_ACTIVE_LOW ? !digitalHigh : digitalHigh;
}

/* ===================== STATE ===================== */
bool wifiOnline = false;
bool backendReachable = false;
unsigned long lastHeartbeatAt = 0;
unsigned long lastDeskPollAt = 0;
unsigned long lastWifiRetryAt = 0;
unsigned long lastDrawAt = 0;

struct DeskState {
  bool available;
  bool stale;
  String doctorName;
  int waiting;
  int callingToken;
  int nextToken;
  int inRoomToken;
  int estMin;
  bool onBreak;
  int delayMin;
  int emergency;
};
DeskState desk = { false, true, "", -1, -1, -1, -1, -1, false, 0, 0 };
long lastSeenCallSeq = -1;

bool displayShowsDeviceInfo = false;
unsigned long btn2PressStart = 0;
bool btn2Held = false;

String lastGestureText = "";
unsigned long lastGestureAt = 0;

Adafruit_SSD1306 display(128, 64, &Wire, -1);

/* ===================== EVENT BUFFER (offline-safe) ===================== */
struct PendingEvent {
  bool used;
  String sensorId;
  String action;
  unsigned long seq;
  unsigned long queuedAt;
};
#define BUFFER_SIZE 20
PendingEvent eventBuffer[BUFFER_SIZE];
unsigned long eventSeqCounter = 0;
unsigned long bootId = 0;
unsigned long lastFlushAttemptAt = 0;
bool lastFlushFailed = false;

void queueEvent(String sensorId, String action) {
  for (int i = 0; i < BUFFER_SIZE; i++) {
    if (!eventBuffer[i].used) {
      eventBuffer[i] = { true, sensorId, action, ++eventSeqCounter, millis() };
      return;
    }
  }
  int oldestIdx = 0;
  unsigned long oldestTime = ULONG_MAX;
  for (int i = 0; i < BUFFER_SIZE; i++) {
    if (eventBuffer[i].queuedAt < oldestTime) { oldestTime = eventBuffer[i].queuedAt; oldestIdx = i; }
  }
  eventBuffer[oldestIdx] = { true, sensorId, action, ++eventSeqCounter, millis() };
  Serial.println("[WARN] Event buffer full, dropped oldest pending event");
}

/* ===================== BUZZER ===================== */
int buzzBeepsLeft = 0;
bool buzzIsOn = false;
unsigned long buzzChangeAt = 0;
unsigned long buzzOnMs = 120, buzzOffMs = 120;

void buzzBeeps(int count, unsigned long onMs, unsigned long offMs) {
  buzzBeepsLeft = count;
  buzzOnMs = onMs;
  buzzOffMs = offMs;
  buzzIsOn = true;
  digitalWrite(PIN_BUZZER, HIGH);
  buzzChangeAt = millis();
}

void buzz(unsigned long durationMs) { buzzBeeps(1, durationMs, 0); }

void updateBuzzer() {
  if (!buzzIsOn && buzzBeepsLeft <= 0) return;
  unsigned long now = millis();
  if (buzzIsOn) {
    if (now - buzzChangeAt >= buzzOnMs) {
      digitalWrite(PIN_BUZZER, LOW);
      buzzIsOn = false;
      buzzBeepsLeft--;
      buzzChangeAt = now;
    }
  } else if (buzzBeepsLeft > 0 && now - buzzChangeAt >= buzzOffMs) {
    digitalWrite(PIN_BUZZER, HIGH);
    buzzIsOn = true;
    buzzChangeAt = now;
  }
}

/* ===================== LED PULSE ===================== */
bool heartbeatPulseOn = false;
unsigned long heartbeatPulseAt = 0;
bool serviceDonePulseOn = false;
unsigned long serviceDonePulseAt = 0;

void pulseHeartbeatLed() { digitalWrite(LED_HEARTBEAT, HIGH); heartbeatPulseOn = true; heartbeatPulseAt = millis(); }
void pulseServiceDoneLed() { digitalWrite(LED_SERVICE_DONE, HIGH); serviceDonePulseOn = true; serviceDonePulseAt = millis(); }

void updateLedPulses() {
  if (heartbeatPulseOn && millis() - heartbeatPulseAt > 150) { digitalWrite(LED_HEARTBEAT, LOW); heartbeatPulseOn = false; }
  if (serviceDonePulseOn && millis() - serviceDonePulseAt > 600) { digitalWrite(LED_SERVICE_DONE, LOW); serviceDonePulseOn = false; }
}

void updateStatusLeds() {
  int waiting = desk.waiting > 0 ? desk.waiting : 0;
  digitalWrite(LED_DEVICE_ONLINE, (wifiOnline && backendReachable) ? HIGH : LOW);
  digitalWrite(LED_QUEUE_ACTIVE, waiting > 0 ? HIGH : LOW);
  digitalWrite(LED_QUEUE_LOW, waiting > 0 && waiting <= 3 ? HIGH : LOW);
  digitalWrite(LED_QUEUE_HIGH, waiting >= 8 ? HIGH : LOW);
  digitalWrite(LED_SERVICE_ACTIVE, desk.inRoomToken > 0 ? HIGH : LOW);
  digitalWrite(LED_EMERGENCY, desk.emergency > 0 ? HIGH : LOW);
  digitalWrite(LED_ALERT, (!backendReachable || desk.onBreak) ? HIGH : LOW);
}

/* ===================== WIFI ===================== */
void connectWifi() {
  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print(".");
  }
  wifiOnline = (WiFi.status() == WL_CONNECTED);
  Serial.println(wifiOnline ? "\nWiFi connected" : "\nWiFi connect failed, will retry in loop()");
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiOnline = true; return; }
  wifiOnline = false;
  if (millis() - lastWifiRetryAt > 5000) {
    lastWifiRetryAt = millis();
    Serial.println("[WiFi] reconnecting...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

/* ===================== HTTP HELPERS (Updated for Render Timeout) ===================== */
String backendUrl(String path) {
  String scheme = BACKEND_USE_TLS ? "https://" : "http://";
  return scheme + BACKEND_HOST + path;
}

bool httpPostJson(String path, const JsonDocument& body, JsonDocument& responseOut) {
  if (!wifiOnline) return false;

  WiFiClientSecure secureClient;
  WiFiClient plainClient;
  HTTPClient http;
  bool began;

  if (BACKEND_USE_TLS) {
    secureClient.setInsecure();
    began = http.begin(secureClient, backendUrl(path));
  } else {
    began = http.begin(plainClient, backendUrl(path));
  }
  if (!began) return false;

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(15000); // Increased to 15s to handle Render free tier spin-down cold starts

  String payload;
  serializeJson(body, payload);
  int code = http.POST(payload);

  bool ok = (code >= 200 && code < 300);
  if (ok) {
    String resp = http.getString();
    deserializeJson(responseOut, resp);
  } else {
    Serial.printf("[HTTP] POST %s failed, code=%d\n", path.c_str(), code);
  }
  http.end();
  return ok;
}

bool httpGetJson(String path, JsonDocument& responseOut) {
  if (!wifiOnline) return false;

  WiFiClientSecure secureClient;
  WiFiClient plainClient;
  HTTPClient http;
  bool began;

  if (BACKEND_USE_TLS) {
    secureClient.setInsecure();
    began = http.begin(secureClient, backendUrl(path));
  } else {
    began = http.begin(plainClient, backendUrl(path));
  }
  if (!began) return false;

  http.setTimeout(15000); // Increased to 15s to handle Render free tier spin-down cold starts
  int code = http.GET();
  bool ok = (code >= 200 && code < 300);
  if (ok) {
    String resp = http.getString();
    deserializeJson(responseOut, resp);
  }
  http.end();
  return ok;
}

/* ===================== BACKEND SYNC ===================== */
void sendHeartbeat() {
  StaticJsonDocument<320> body;
  body["device_id"] = DEVICE_ID;
  body["location"] = DEVICE_LOCATION;
  body["status"] = "ONLINE";
  body["queue_count"] = desk.waiting > 0 ? desk.waiting : 0;
  body["ir_entry_status"] = "ACTIVE";
  body["ir_exit_status"] = "ACTIVE";
  body["oled_status"] = "CONNECTED";
  body["buzzer_status"] = "READY";
  body["timestamp"] = (unsigned long)(millis());

  StaticJsonDocument<128> resp;
  backendReachable = httpPostJson("/api/iot/heartbeat", body, resp);
  pulseHeartbeatLed();
}

void sendButtonEvent(String buttonId, String action) {
  StaticJsonDocument<256> body;
  body["device_id"] = DEVICE_ID;
  body["location"] = DEVICE_LOCATION;
  body["button_id"] = buttonId;
  body["action"] = action;
  body["timestamp"] = (unsigned long)(millis());

  StaticJsonDocument<128> resp;
  backendReachable = httpPostJson("/api/iot/button", body, resp) || backendReachable;
}

void flushEventBuffer() {
  if (!wifiOnline) return;
  if (lastFlushFailed && millis() - lastFlushAttemptAt < 3000) return;

  for (int i = 0; i < BUFFER_SIZE; i++) {
    if (!eventBuffer[i].used) continue;

    StaticJsonDocument<320> body;
    body["device_id"] = DEVICE_ID;
    body["doctor_id"] = DOCTOR_ID;
    body["sensor_id"] = eventBuffer[i].sensorId;
    body["action"] = eventBuffer[i].action;
    body["seq"] = eventBuffer[i].seq;
    body["boot_id"] = bootId;
    body["timestamp"] = eventBuffer[i].queuedAt;

    StaticJsonDocument<128> resp;
    lastFlushAttemptAt = millis();
    bool ok = httpPostJson("/api/iot/doctor-event", body, resp);
    if (ok) {
      eventBuffer[i].used = false;
      lastFlushFailed = false;
      backendReachable = true;
    } else {
      lastFlushFailed = true;
      break;
    }
  }
}

void refreshFromBackend() {
  StaticJsonDocument<512> resp;
  bool ok = httpGetJson("/api/iot/desk-state?doctor_id=" + String(DOCTOR_ID), resp);
  backendReachable = ok;
  if (!ok) return;

  desk.available = resp["available"] | false;
  desk.stale = resp["stale"] | true;
  if (!desk.available) return;

  const char* nm = resp["doctor_name"] | "";
  desk.doctorName = String(nm);
  desk.waiting = resp["waiting"] | -1;
  desk.callingToken = resp["calling_token"] | -1;
  desk.nextToken = resp["next_token"] | -1;
  desk.inRoomToken = resp["in_room_token"] | -1;
  desk.estMin = resp["est_min"] | -1;
  desk.onBreak = resp["on_break"] | false;
  desk.delayMin = resp["delay_min"] | 0;
  desk.emergency = resp["emergency"] | 0;

  long seq = resp["call_seq"] | -1;
  if (seq >= 0) {
    if (lastSeenCallSeq >= 0 && seq > lastSeenCallSeq) buzzBeeps(3, 160, 120);
    lastSeenCallSeq = seq;
  }
}

/* ===================== OLED ===================== */
String clip(String s, int maxChars) {
  return s.length() > (unsigned)maxChars ? s.substring(0, maxChars) : s;
}

void drawQueueScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  if (!wifiOnline) {
    display.println("OFFLINE - no WiFi");
  } else if (!backendReachable) {
    display.println("OFFLINE - backend");
  } else if (!desk.available) {
    display.println(clip(DEVICE_LOCATION, 21));
  } else {
    display.println(clip(desk.doctorName, 21));
  }
  display.drawLine(0, 10, 128, 10, SSD1306_WHITE);

  display.setTextSize(2);
  display.setCursor(0, 15);
  if (!backendReachable || !desk.available) {
    display.println("NO DATA");
  } else if (desk.onBreak) {
    display.println("ON BREAK");
  } else if (desk.callingToken > 0) {
    display.print("CALL #"); display.println(desk.callingToken);
  } else if (desk.inRoomToken > 0) {
    display.print("IN #"); display.println(desk.inRoomToken);
  } else if (desk.nextToken > 0) {
    display.print("NEXT #"); display.println(desk.nextToken);
  } else {
    display.println("NO QUEUE");
  }

  display.setTextSize(1);
  display.setCursor(0, 36);
  if (backendReachable && desk.available) {
    display.print("Waiting: "); display.print(desk.waiting >= 0 ? desk.waiting : 0);
    if (desk.nextToken > 0 && desk.callingToken > 0) { display.print("  Next #"); display.print(desk.nextToken); }
    display.println();
    display.setCursor(0, 46);
    display.print("Est wait: "); display.print(desk.estMin >= 0 ? desk.estMin : 0); display.println(" min");
  }

  display.setCursor(0, 56);
  if (millis() - lastGestureAt < 2000 && lastGestureText.length() > 0) {
    display.print("> "); display.print(lastGestureText);
  } else if (desk.onBreak) {
    display.print("Delay +"); display.print(desk.delayMin); display.print(" min");
  } else if (backendReachable && desk.stale) {
    display.print("web app not live");
  } else if (desk.inRoomToken > 0 && desk.callingToken <= 0) {
    display.print("Consultation on");
  }
  display.display();
}

void drawDeviceInfoScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("DEVICE STATUS");
  display.drawLine(0, 10, 128, 10, SSD1306_WHITE);
  display.setCursor(0, 16);
  display.print("WiFi: "); display.println(wifiOnline ? "OK" : "DOWN");
  display.print("Backend: "); display.println(backendReachable ? "OK" : "DOWN");
  display.print("Doctor: "); display.println(DOCTOR_ID);
  int pending = 0;
  for (int i = 0; i < BUFFER_SIZE; i++) if (eventBuffer[i].used) pending++;
  display.print("Buffered evts: "); display.println(pending);
  display.print("ID: "); display.println(DEVICE_ID);
  display.display();
}

void updateDisplay() {
  if (millis() - lastDrawAt < 200) return;
  lastDrawAt = millis();
  if (displayShowsDeviceInfo) drawDeviceInfoScreen();
  else drawQueueScreen();
}

/* ===================== IR SENSORS ===================== */
void pollIrSensor(IrSensor &s, bool isEntry) {
  bool raw = digitalRead(s.pin);
  if (raw != s.rawState) {
    s.rawState = raw;
    s.lastChangeAt = millis();
  }
  if (millis() - s.lastChangeAt >= DEBOUNCE_MS && s.stableState != s.rawState) {
    bool wasBroken = isBeamBroken(s.stableState);
    s.stableState = s.rawState;
    bool nowBroken = isBeamBroken(s.stableState);

    if (!wasBroken && nowBroken && millis() - s.lastEventAt > MIN_EVENT_GAP_MS) {
      s.lastEventAt = millis();
      if (isEntry) {
        queueEvent("IR_DOOR_ENTRY", "ENTRY");
        lastGestureText = "Patient IN";
      } else {
        queueEvent("IR_DOOR_EXIT", "EXIT");
        lastGestureText = "Patient OUT";
        pulseServiceDoneLed();
      }
      lastGestureAt = millis();
      Serial.printf("[IR] doctor door %s\n", isEntry ? "ENTRY" : "EXIT");
    }
  }
}

/* ===================== DOCTOR-ROOM BUTTON ===================== */
bool docBtnRaw = HIGH, docBtnStable = HIGH, docBtnDown = false, docBtnLongFired = false;
unsigned long docBtnRawAt = 0, docBtnDownAt = 0, docLastReleaseAt = 0;
int docClicks = 0;

void doctorGesture(const char* action, const char* label) {
  queueEvent("BTN_DOCTOR_ROOM", action);
  lastGestureText = label;
  lastGestureAt = millis();
  if (String(action) == "NEXT" || String(action) == "PREVIOUS") pulseServiceDoneLed();
  Serial.printf("[BTN] doctor room: %s\n", action);
}

void pollDoctorButton() {
  unsigned long now = millis();
  bool raw = digitalRead(PIN_BTN_NEXT);
  if (raw != docBtnRaw) { docBtnRaw = raw; docBtnRawAt = now; }

  if (now - docBtnRawAt >= DEBOUNCE_MS && docBtnStable != docBtnRaw) {
    docBtnStable = docBtnRaw;
    if (docBtnStable == LOW) {
      docBtnDown = true;
      docBtnDownAt = now;
      docBtnLongFired = false;
    } else {
      if (docBtnDown && !docBtnLongFired) {
        docClicks++;
        docLastReleaseAt = now;
        if (docClicks >= 2) {
          docClicks = 0;
          doctorGesture("PREVIOUS", "Previous patient");
        }
      }
      docBtnDown = false;
    }
  }

  if (docBtnDown && !docBtnLongFired && now - docBtnDownAt >= LONG_PRESS_MS) {
    docBtnLongFired = true;
    docClicks = 0;
    doctorGesture("BREAK", "Break on/off");
  }

  if (docClicks == 1 && !docBtnDown && now - docLastReleaseAt > DOUBLE_GAP_MS) {
    docClicks = 0;
    doctorGesture("NEXT", "Next patient");
  }
}

/* ===================== BUTTON 2 ===================== */
bool btn2Last = HIGH;
unsigned long btn2DebounceAt = 0;

void pollModeButton() {
  bool b2 = digitalRead(PIN_BTN_MODE);
  if (b2 != btn2Last && millis() - btn2DebounceAt > DEBOUNCE_MS) {
    btn2DebounceAt = millis();
    btn2Last = b2;
    if (b2 == LOW) {
      btn2PressStart = millis();
      btn2Held = true;
    } else if (btn2Held) {
      unsigned long heldFor = millis() - btn2PressStart;
      btn2Held = false;
      if (heldFor >= 3000) {
        sendButtonEvent("BTN_MODE", "RESET");
        buzz(400);
        Serial.println("[BTN] RESET (held)");
      } else {
        displayShowsDeviceInfo = !displayShowsDeviceInfo;
        buzz(50);
      }
    }
  }
}

/* ===================== SETUP / LOOP ===================== */
void setup() {
  Serial.begin(115200);
  bootId = esp_random() % 1000000UL;

  pinMode(PIN_IR_ENTRY, INPUT);
  pinMode(PIN_IR_EXIT, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_BTN_NEXT, INPUT_PULLUP);
  pinMode(PIN_BTN_MODE, INPUT_PULLUP);
  for (int i = 0; i < 10; i++) { pinMode(ALL_LEDS[i], OUTPUT); digitalWrite(ALL_LEDS[i], LOW); }

  for (int i = 0; i < BUFFER_SIZE; i++) eventBuffer[i].used = false;

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("[OLED] init failed");
  }
  display.clearDisplay();
  display.display();

  connectWifi();
  if (wifiOnline) { sendHeartbeat(); refreshFromBackend(); }
}

void loop() {
  ensureWifi();

  pollIrSensor(irEntry, true);
  pollIrSensor(irExit, false);
  pollDoctorButton();
  pollModeButton();

  updateBuzzer();
  updateLedPulses();
  updateStatusLeds();

  flushEventBuffer();

  if (millis() - lastHeartbeatAt > HEARTBEAT_MS) {
    lastHeartbeatAt = millis();
    sendHeartbeat();
  }

  if (millis() - lastDeskPollAt > DESK_POLL_MS) {
    lastDeskPollAt = millis();
    refreshFromBackend();
  }

  updateDisplay();
}