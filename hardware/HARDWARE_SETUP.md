# QueueSense — Hardware Setup (ESP32 OP Desk + Doctor Room Node)

## 0. What each part does (college-project layout — everything is wired on one breadboard)

| Part | Where it "is" in the hospital | What it does |
|---|---|---|
| IR sensor 1 (GPIO 4) + IR sensor 2 (GPIO 5) | **Doctor's door** | Sensor 1 = patient walks **in**, sensor 2 = patient walks **out**. In = consultation starts, out = consultation finished (the real duration feeds the wait-time predictions). |
| Push button 1 (GPIO 27) | **Inside the doctor's room** | **Short press** = call the **next** patient · **Double press** = call the **previous** patient back in · **Long press (1.5 s)** = doctor **break / absence** (long press again = doctor is back). |
| OLED (I2C, GPIO 21/22) | **OP desk** | Shows who is being called (`CALL #12`), who is next, patients waiting, estimated wait, or `ON BREAK`. |
| Buzzer (GPIO 25) | **OP desk** | Beeps 3 times every time a patient is called (next / previous). |
| Push button 2 (GPIO 26) | OP desk | Short press = switch OLED page, hold 3 s = reset. |
| 10 LEDs | OP desk | Status lights (queue size, patient inside, emergency waiting, online, break/alert, heartbeat). |

Set `DOCTOR_ID` at the top of the sketch to the doctor whose room this door sensor and button belong to
(`d1` Dr. Ananya Rao … `d8` Dr. Sameer Joshi).

**How it reaches the web app:** the ESP32 posts door/button events to the backend (`/api/iot/doctor-event`).
The web app open on the OP-desk PC (Staff, Doctor or Kiosk screen) picks them up, updates the queue,
and publishes the result back (`/api/iot/desk-state`) which the ESP32 polls every 2 s for the OLED + buzzer.
So: **keep the Staff (OP Desk) page open on the OP-desk computer**, and run the frontend with `VITE_API_URL`
pointing at the backend (see `../frontend/.env.example`).

This document is the single source of truth for wiring and configuring the
physical OP-desk unit. It matches **exactly** the parts you listed — nothing
else is assumed.

## 1. Bill of materials (yours) + what's electrically required but missing

| Part | Qty | Notes |
|---|---|---|
| ESP32 NodeMCU 30-pin | 1 | Main controller |
| IR obstacle sensor module (3-pin: VCC/GND/OUT) | 2 | Entry + Exit |
| 0.96" OLED SSD1306, 4-pin, I2C | 1 | Local display |
| Small buzzer | 1 | Active or passive |
| 4-pin push button | 2 | Momentary, normally-open |
| LED (5mm, generic) | 10 | Status indicators |
| Breadboard | 1 | |
| Male-Female jumper wires | 60 | |
| USB cable | 1 | Power + programming |

**Missing but electrically required** (you must add these — they are cheap
passives, not optional):

- **10 × current-limiting resistors for the LEDs**, ~220–330 Ω each. Driving
  an LED directly from a GPIO with no resistor will over-current the pin and
  can damage the ESP32 or the LED. There is no way to wire 10 LEDs safely
  without these.
- **2 × 10 kΩ resistors are *not* required for the buttons** — the firmware
  uses the ESP32's internal `INPUT_PULLUP`, so the buttons wire directly
  between the GPIO and GND with no external resistor.
- If your IR modules are 5 V-logic output (check the module's silkscreen —
  most cheap 3-pin "IR obstacle avoidance" modules run happily at 3.3–5 V and
  their OUT pin swings to VCC), power them from the ESP32's **3.3V** pin, not
  5V/VIN, so the OUT signal stays within the ESP32's 3.3 V-tolerant GPIO
  range. If you only have 5V-only modules, you additionally need a simple
  2-resistor voltage divider (e.g. 10 kΩ + 20 kΩ) on each OUT line — do not
  feed 5 V logic directly into an ESP32 GPIO.

## 2. Final GPIO pin map

I2C, buttons, and buzzer sit on completely safe, conflict-free GPIOs. LEDs
use 9 clean GPIOs plus one (GPIO2) that needs a small caution noted below.
**GPIO0, 12, 15 (strapping pins), GPIO6–11 (internal flash), and GPIO34–39
(input-only) are deliberately avoided everywhere except the one noted
exception.**

| Function | GPIO | Mode | Notes |
|---|---|---|---|
| IR Entry sensor (OUT) — doctor's door, patient going in | **4** | `INPUT` | Powered from 3.3V, GND |
| IR Exit sensor (OUT) — doctor's door, patient coming out | **5** | `INPUT` | Powered from 3.3V, GND |
| OLED SDA | **21** | I2C | Hardware I2C default |
| OLED SCL | **22** | I2C | Hardware I2C default |
| Buzzer (OP desk) | **25** | `OUTPUT` | Non-blocking digitalWrite beeps |
| Button 1 — doctor-room button (short / double / long press) | **27** | `INPUT_PULLUP` | Active LOW, no external resistor |
| Button 2 — OLED page / RESET | **26** | `INPUT_PULLUP` | Active LOW, no external resistor |
| LED 1 — Queue Active | **13** | `OUTPUT` | + 220–330 Ω resistor |
| LED 2 — Queue Low | **14** | `OUTPUT` | + resistor |
| LED 3 — Queue High / Congested | **16** | `OUTPUT` | + resistor |
| LED 4 — Patient inside doctor's room | **17** | `OUTPUT` | + resistor |
| LED 5 — Emergency case waiting | **18** | `OUTPUT` | + resistor |
| LED 6 — Device Online | **19** | `OUTPUT` | + resistor |
| LED 7 — Door exit / next-previous pulse | **23** | `OUTPUT` | + resistor |
| LED 8 — Backend offline or doctor on break | **32** | `OUTPUT` | + resistor |
| LED 9 — Heartbeat Pulse | **33** | `OUTPUT` | + resistor |
| LED 10 — Spare / configurable | **2** | `OUTPUT` | ⚠ see caution below |

**GPIO2 caution:** GPIO2 is a boot-strapping pin on some ESP32 modules (must
read LOW or float at boot for normal startup). Wiring an LED + resistor to it
is extremely common and safe in practice — worst case is a brief flicker
during boot — but do **not** attach anything else (buttons, pull-ups) to
GPIO2, and if your specific board fails to boot with the LED attached, move
this one LED to GPIO2 → free GPIO1 (TX0) instead and avoid using the Serial
monitor while that LED is active.

**Power/ground:** all component grounds go to one of the ESP32's `GND` pins,
common ground across the breadboard. IR sensors and OLED are powered from
`3.3V`. LEDs and buzzer are driven directly by their GPIO (through the
resistor for LEDs) — do not power them from `VIN`/`5V`.

## 3. Wi-Fi & backend configuration

Edit the top of `queuesense_esp32.ino`:

```cpp
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* BACKEND_HOST  = "your-backend.onrender.com"; // no https://, no trailing slash
const bool  BACKEND_USE_TLS = true;   // true for https (Render etc.), false for plain http on your LAN
const char* DEVICE_ID     = "ESP32_OPDESK_01";
const char* DEVICE_LOCATION = "OP Registration Desk";
```

> The firmware uses `WiFiClientSecure` with `setInsecure()` for HTTPS — this
> skips certificate validation so it works against any host without pinning
> a root certificate, which is fine for a class prototype but is **not**
> secure for a real deployment. For production, pin the backend's actual CA
> certificate instead.

## 4. Required libraries (Arduino IDE Library Manager)

- **Adafruit SSD1306** (and its dependency **Adafruit GFX Library**)
- **ArduinoJson** (v6.x)
- `WiFi.h`, `HTTPClient.h`, `WiFiClientSecure.h` — built into the ESP32 board package, no install needed.

Board setting: **ESP32 Dev Module** (or the exact NodeMCU-32 entry if your
board package lists it), matching your board's flash size/partition scheme.

## 5. What the firmware actually does

- Debounces both door IR sensors in software (stable for 50 ms, plus a 1.2 s gap between counted crossings
  on the same sensor) so one person walking through produces exactly one `ENTRY` or one `EXIT`.
- Detects three gestures on the doctor-room button without blocking: **short press** (`NEXT`, confirmed
  after a 0.4 s double-press window), **double press** (`PREVIOUS`), **long press** (`BREAK`, fires while
  still held so the doctor gets instant feedback). The OLED's bottom line confirms the last event for 2 s.
- Every door/button event is queued with a sequence number + random boot id and POSTed to
  `/api/iot/doctor-event`; if Wi-Fi/backend is down it stays in a 20-event buffer and is retried every 3 s
  (the backend de-duplicates retries).
- Polls `/api/iot/desk-state?doctor_id=...` every 2 s and shows the result on the OLED
  (`CALL #n` / `IN #n` / `NEXT #n` / `ON BREAK`, waiting count, estimated wait). Whenever the web app calls a
  patient, the buzzer beeps 3 times (it never buzzes by itself right after a reboot).
- Heartbeat to the backend every 15 s (shows Online/Offline on the staff IoT Devices page).
- No `delay()` in `loop()`; OLED redraws are limited to 5 per second so sensor polling stays responsive.

## 5b. What happens in the web app for each hardware event

| Hardware event | Queue effect |
|---|---|
| Door IR **entry** | The called (head-of-queue) patient is marked "in consultation"; the consultation timer starts. |
| Door IR **exit** | Consultation completes, real duration is recorded (feeds wait-time predictions), patient's journey advances and they're notified. |
| Button **short press** | If someone is inside they are completed first; then the next patient is called (OLED shows the token, buzzer beeps, patient is notified). Pressing again re-announces the same patient. |
| Button **double press** | The previous patient (last completed or marked "Not available") is called back in, ahead of everyone else. |
| Button **long press** | Doctor break: every waiting patient is notified of the delay (+15 min by default). Long press again (or a short press) ends the break and notifies them. |
| OP desk marks a patient **Not available** | Patient is skipped, the queue moves to the next patient who is called automatically. "Re-queue" brings them back if they arrive. |

## 6. Testing procedure

1. Start the backend (`cd backend && npm install && npm start`) and the frontend with `VITE_API_URL` set
   (`cd frontend && npm install && npm run dev -- --host`). Log in as **Staff** on the OP-desk PC and leave it open.
2. Flash the sketch, open Serial Monitor at 115200 baud — confirm Wi-Fi connects and the heartbeat succeeds
   (the Staff → IoT Devices page shows the device Online).
3. At the OP desk, book two or three patients (Staff → OP Desk) for the doctor set in `DOCTOR_ID`.
4. **Short-press** the room button — OLED shows `CALL #<token>`, the buzzer beeps 3×.
5. Wave a hand across the **entry** IR sensor, then the **exit** IR sensor — the patient goes "in consultation",
   then "completed"; the OLED moves on.
6. **Double-press** the button — the previous patient is called back in.
7. **Long-press** the button for ~1.5 s — OLED shows `ON BREAK`; waiting patients get a delay notification.
   Long-press again to end the break.
8. At the OP desk mark a called patient **Not available** — the OLED/buzzer move on to the next patient.
9. Disconnect Wi-Fi, press the button / wave at the sensors, reconnect — buffered events are sent after reconnect.
