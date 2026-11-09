/*
 * QueueSense IoT backend — a small, real Express server the ESP32 talks to
 * directly over HTTP(S). This is a starter backend: it persists to a JSON
 * file on disk so it survives restarts, which is enough to develop and demo
 * against real hardware. It is NOT the full hospital-OS backend described in
 * the QueueSense spec (no Postgres, no auth, no WebSockets, no ML service,
 * no lab/scan/pharmacy modules) — treat this as the IoT ingestion slice you
 * can build the rest around, not a finished production system.
 *
 * Run:
 *   npm install
 *   npm start
 * Then point BACKEND_HOST in the ESP32 firmware at wherever this is hosted
 * (e.g. deploy it to Render alongside the existing QueueSense app).
 *
 * Calls out to the QueueSense ML service (see ../../queuesense_ml/) for
 * doctor-specific predictions via ML_SERVICE_URL; falls back to a local
 * heuristic automatically if that service is unreachable or no doctor_id
 * is known for the request (see estimateAndPredict() below).
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// CORS — the web app (Vite dev server / hosted site) and the QR status page on
// patients' phones call this server from a different origin.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "5mb" }));

const DB_PATH = path.join(__dirname, "iot-db.json");
const DEVICE_OFFLINE_AFTER_MS = 45 * 1000;
const AVG_CONSULT_MIN = 12;     // last-resort per-patient estimate if the ML service is unreachable
const PEAK_START_HOUR = 13;     // matches the PPT's detected post-lunch peak window
const PEAK_END_HOUR = 14;

// The ML service (see queuesense_ml/) is the authoritative source for
// per-patient consultation duration and wait-time predictions (spec
// sections 24-25). This backend calls it over HTTP and only falls back to
// the local heuristic below if the ML service is unreachable or no
// doctor_id was given (the hardware itself is location-level, not
// per-doctor, so raw sensor events never carry a doctor_id).
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:5001";
const ML_TIMEOUT_MS = 2500;

async function callMlWaitTime(doctorId, patientsAhead) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);
  try {
    const now = new Date();
    const res = await fetch(`${ML_SERVICE_URL}/predict/wait-time`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doctor_id: doctorId,
        patients_ahead: patientsAhead,
        hour: now.getHours(),
        day_of_week: now.getDay(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json(); // { predicted_wait_minutes, per_patient_minutes, method }
  } catch (e) {
    clearTimeout(timer);
    return null; // ML service down/unreachable/timed out — caller falls back
  }
}

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { devices: {}, events: [], locations: {}, commands: [], deskState: null, appState: null };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getLocation(db, location) {
  if (!db.locations[location]) {
    db.locations[location] = { queueCount: 0, serviceActive: false, emergency: false };
  }
  return db.locations[location];
}

function isPeakNow() {
  const h = new Date().getHours();
  return h >= PEAK_START_HOUR && h < PEAK_END_HOUR;
}

async function estimateAndPredict(queueCount, doctorId) {
  if (doctorId) {
    const ml = await callMlWaitTime(doctorId, queueCount);
    if (ml) {
      return {
        estimated: Math.round(queueCount * ml.per_patient_minutes),
        predicted: Math.round(ml.predicted_wait_minutes),
        method: ml.method,        // "ml_model" or "fallback_average" — as reported by the ML service itself
        source: "ml_service",
      };
    }
  }
  // No doctor_id (raw hardware event) or ML service unreachable — local heuristic,
  // clearly labeled so callers/UI can show degraded-prediction state (spec section 40).
  const estimated = queueCount * AVG_CONSULT_MIN;
  const predicted = Math.round(estimated * (isPeakNow() ? 1.15 : 1));
  return { estimated, predicted, method: "local_heuristic", source: "iot_backend" };
}

/* ---------------- Device heartbeat ---------------- */
app.post("/api/iot/heartbeat", (req, res) => {
  const { device_id, location, status, queue_count, ir_entry_status, ir_exit_status, oled_status, buzzer_status } = req.body || {};
  if (!device_id) return res.status(400).json({ error: "device_id required" });

  const db = loadDb();
  db.devices[device_id] = {
    ...(db.devices[device_id] || {}),
    location: location || db.devices[device_id]?.location || "unknown",
    status: status || "ONLINE",
    queueCount: typeof queue_count === "number" ? queue_count : db.devices[device_id]?.queueCount ?? 0,
    irEntryStatus: ir_entry_status || "UNKNOWN",
    irExitStatus: ir_exit_status || "UNKNOWN",
    oledStatus: oled_status || "UNKNOWN",
    buzzerStatus: buzzer_status || "UNKNOWN",
    lastHeartbeat: Date.now(),
  };
  saveDb(db);
  res.json({ ok: true });
});

/* ---------------- Sensor event (ENTRY / EXIT) ---------------- */
// Idempotency: if the same device_id + seq was already applied, skip it —
// this protects against the ESP32's retry buffer double-counting.
app.post("/api/iot/event", async (req, res) => {
  const { device_id, location, sensor_id, event, timestamp, seq } = req.body || {};
  if (!device_id || !event || !location) return res.status(400).json({ error: "device_id, location, event required" });

  const db = loadDb();
  const dedupeKey = `${device_id}:${seq ?? "noseq"}:${sensor_id}:${event}`;
  const alreadyApplied = seq != null && db.events.some((e) => e.dedupeKey === dedupeKey);

  if (!alreadyApplied) {
    const loc = getLocation(db, location);
    if (event === "ENTRY") loc.queueCount += 1;
    else if (event === "EXIT") loc.queueCount = Math.max(0, loc.queueCount - 1);

    db.events.push({ device_id, location, sensor_id, event, timestamp, seq, dedupeKey, receivedAt: Date.now() });
    if (db.events.length > 2000) db.events = db.events.slice(-2000); // simple retention cap

    if (db.devices[device_id]) {
      db.devices[device_id].lastEvent = { type: event, at: Date.now() };
      db.devices[device_id].lastHeartbeat = Date.now(); // an event implies the device is alive
      db.devices[device_id].queueCount = loc.queueCount;
    }
    saveDb(db);
  }

  const loc = getLocation(db, location);
  // raw hardware events never carry a doctor_id (the sensors are location-level),
  // so this always uses the local heuristic — see /api/iot/queue/:location for
  // the ML-backed, doctor-specific prediction used by the web app.
  const { estimated, predicted, method, source } = await estimateAndPredict(loc.queueCount);
  res.json({ ok: true, queue_count: loc.queueCount, estimated_min: estimated, predicted_min: predicted, method, source });
});

/* ---------------- Button event ---------------- */
app.post("/api/iot/button", (req, res) => {
  const { device_id, location, button_id, action } = req.body || {};
  if (!device_id || !button_id) return res.status(400).json({ error: "device_id, button_id required" });

  const db = loadDb();
  const loc = getLocation(db, location || "unknown");

  if (action === "SERVICE_COMPLETE") {
    loc.queueCount = Math.max(0, loc.queueCount - 1);
    loc.serviceActive = loc.queueCount > 0;
  } else if (action === "RESET") {
    loc.queueCount = 0;
    loc.serviceActive = false;
    loc.emergency = false;
  }

  if (db.devices[device_id]) {
    db.devices[device_id].lastEvent = { type: `BUTTON:${action}`, at: Date.now() };
    db.devices[device_id].lastHeartbeat = Date.now();
  }
  saveDb(db);
  res.json({ ok: true, queue_count: loc.queueCount });
});

/* ---------------- Queue read (polled by ESP32 + web dashboard) ---------------- */
// ?doctor_id=d1 is optional: pass it to get an ML-backed, doctor-specific
// prediction (what the web app should do); omit it for the generic,
// location-level estimate the ESP32's own OLED polls for.
app.get("/api/iot/queue/:location", async (req, res) => {
  const db = loadDb();
  const loc = getLocation(db, req.params.location);
  const { estimated, predicted, method, source } = await estimateAndPredict(loc.queueCount, req.query.doctor_id);
  res.json({
    queue_count: loc.queueCount,
    estimated_min: estimated,
    predicted_min: predicted,
    method,
    source,
    emergency: loc.emergency,
    service_active: loc.serviceActive,
  });
});

/* ---------------- Device registry (for the staff "IoT Devices" page) ---------------- */
app.get("/api/iot/devices", (req, res) => {
  const db = loadDb();
  const now = Date.now();
  const devices = Object.entries(db.devices).map(([id, d]) => ({
    device_id: id,
    ...d,
    online: !!d.lastHeartbeat && now - d.lastHeartbeat < DEVICE_OFFLINE_AFTER_MS,
  }));
  res.json({ devices });
});

/* ---------------- Manual/staff override: raise or clear emergency ---------------- */
app.post("/api/iot/emergency", (req, res) => {
  const { location, emergency } = req.body || {};
  if (!location) return res.status(400).json({ error: "location required" });
  const db = loadDb();
  const loc = getLocation(db, location);
  loc.emergency = !!emergency;
  saveDb(db);
  res.json({ ok: true, emergency: loc.emergency });
});


/* =====================================================================
   SHARED APP STATE — lets the web app (OP desk PC, doctor, patients'
   phones scanning the QR) share ONE database instead of one per browser.
   The frontend stores its whole JSON blob here (see storageShim.js).
   ===================================================================== */
app.get("/api/state", (req, res) => {
  const db = loadDb();
  if (!db.appState) return res.status(404).json({ error: "no state yet" });
  res.json({ value: db.appState, updatedAt: db.appStateAt || null });
});

app.put("/api/state", (req, res) => {
  const { value } = req.body || {};
  if (typeof value !== "string") return res.status(400).json({ error: "value (string) required" });
  const db = loadDb();
  db.appState = value;
  db.appStateAt = Date.now();
  saveDb(db);
  res.json({ ok: true });
});

/* =====================================================================
   DOCTOR-ROOM HARDWARE (IR sensors at the doctor's door + the button
   inside the room). The queue logic lives in the web app, so the ESP32
   posts a COMMAND here and the OP-desk / doctor web app claims it,
   applies it to the queue and publishes the result back as desk-state.
     ENTRY    patient crossed the door IR going in
     EXIT     patient crossed the door IR going out (consultation done)
     NEXT     button short press  -> call next patient
     PREVIOUS button double press -> call previous patient back in
     BREAK    button long press   -> toggle doctor break / absence
   ===================================================================== */
const DOCTOR_ACTIONS = new Set(["ENTRY", "EXIT", "NEXT", "PREVIOUS", "BREAK"]);
const COMMAND_MAX_AGE_MS = 2 * 60 * 1000; // a stale command is never applied late

app.post("/api/iot/doctor-event", (req, res) => {
  const { device_id, doctor_id, action, sensor_id, seq, boot_id, timestamp } = req.body || {};
  if (!device_id || !doctor_id || !DOCTOR_ACTIONS.has(action)) {
    return res.status(400).json({ error: "device_id, doctor_id and a valid action required" });
  }
  const db = loadDb();
  db.commands = db.commands || [];
  const key = seq != null ? `${device_id}:${boot_id ?? 0}:${seq}` : null;
  if (key && db.commands.some((c) => c.key === key)) return res.json({ ok: true, duplicate: true });

  db.commands.push({
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key, device_id, doctor_id, action, sensor_id, timestamp,
    receivedAt: Date.now(), status: "pending",
  });
  if (db.commands.length > 300) db.commands = db.commands.slice(-300);

  if (db.devices[device_id]) {
    db.devices[device_id].lastEvent = { type: `${action}:${doctor_id}`, at: Date.now() };
    db.devices[device_id].lastHeartbeat = Date.now();
  }
  saveDb(db);
  res.json({ ok: true });
});

// The web app claims pending commands. Claiming marks them so exactly one
// open browser applies each command, even if several are open.
app.post("/api/iot/commands/claim", (req, res) => {
  const db = loadDb();
  db.commands = db.commands || [];
  const now = Date.now();
  const claimed = [];
  db.commands.forEach((c) => {
    if (c.status !== "pending") return;
    if (now - c.receivedAt > COMMAND_MAX_AGE_MS) { c.status = "expired"; return; }
    c.status = "claimed";
    c.claimedAt = now;
    claimed.push({ id: c.id, doctor_id: c.doctor_id, action: c.action, receivedAt: c.receivedAt });
  });
  if (claimed.length || db.commands.some((c) => c.status === "expired" && !c.noted)) saveDb(db);
  res.json({ commands: claimed });
});

/* =====================================================================
   OP-DESK DISPLAY FEED — the web app publishes the live per-doctor queue
   summary here; the ESP32 polls it for the OLED + buzzer. `call_seq`
   increases every time a patient is called, which is what triggers the
   buzzer at the OP desk.
   ===================================================================== */
app.post("/api/iot/desk-state", (req, res) => {
  const { doctors } = req.body || {};
  if (!Array.isArray(doctors)) return res.status(400).json({ error: "doctors[] required" });
  const db = loadDb();
  db.deskState = { doctors, updatedAt: Date.now() };
  saveDb(db);
  res.json({ ok: true });
});

app.get("/api/iot/desk-state", (req, res) => {
  const db = loadDb();
  const s = db.deskState;
  if (!s) return res.json({ available: false, stale: true });
  const d = (s.doctors || []).find((x) => x.id === req.query.doctor_id);
  if (!d) return res.json({ available: false, stale: true });
  res.json({ available: true, stale: Date.now() - s.updatedAt > 30000, ...d });
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`QueueSense IoT backend listening on :${PORT}`));
