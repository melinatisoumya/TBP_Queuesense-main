import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Stethoscope, Calendar, Clock, Star, Users, TrendingUp, CheckCircle2,
  CreditCard, ArrowLeft, ChevronRight, Activity, AlarmClock, Award,
  UserCog, ClipboardList, QrCode, RadioTower, LogOut, ShieldCheck,
  AlertTriangle, Plus, Search, BadgeCheck, Hospital, UserX
} from "lucide-react";
import QRCode from "qrcode";
import { API_URL } from "./storageShim.js";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer
} from "recharts";

/* =========================================================================
   PALETTE — clinical, calm, trustworthy. Deep teal as the dominant tone,
   cool near-white background (not cream), amber reserved only for alerts.
   ========================================================================= */
const C = {
  ink: "#122024",
  sub: "#5C7370",
  bg: "#F4F8F7",
  panel: "#FFFFFF",
  line: "#DCE6E3",
  teal: "#0E4B43",
  tealDeep: "#0A342E",
  mint: "#3E9C86",
  mintSoft: "#E4F2EE",
  amber: "#C97A2E",
  amberSoft: "#FBEADA",
  red: "#B3432E",
  redSoft: "#F8E6E1",
};

const DEPARTMENTS = ["Cardiology", "Orthopedics", "Dermatology", "General Medicine"];

const RAW_DOCTORS = [
  { id: "d1", name: "Dr. Ananya Rao", department: "Cardiology", rating: 4.8, experience: 14,
    achievements: ["Fellowship, All India Institute of Cardiology", "200+ successful angioplasties/year", "Best Physician Award, 2023"],
    bio: "Specialises in interventional cardiology and preventive heart care, with a focus on clear, unhurried patient consultations.",
    avgConsult: 12 },
  { id: "d2", name: "Dr. Karthik Menon", department: "Cardiology", rating: 4.5, experience: 9,
    achievements: ["Cardiac electrophysiology certification", "Published researcher, arrhythmia management"],
    bio: "Focuses on arrhythmia diagnosis and long-term cardiac rhythm management for OP patients.",
    avgConsult: 15 },
  { id: "d3", name: "Dr. Priya Nair", department: "Orthopedics", rating: 4.7, experience: 11,
    achievements: ["Joint replacement specialist", "Sports injury clinic lead"],
    bio: "Treats joint, spine and sports-related injuries with an emphasis on non-surgical recovery paths where possible.",
    avgConsult: 10 },
  { id: "d4", name: "Dr. Vikram Sethi", department: "Orthopedics", rating: 4.3, experience: 7,
    achievements: ["Trauma & fracture care", "Resident teaching faculty"],
    bio: "Handles trauma, fractures and post-operative rehabilitation planning.",
    avgConsult: 13 },
  { id: "d5", name: "Dr. Meera Iyer", department: "Dermatology", rating: 4.9, experience: 16,
    achievements: ["Cosmetic & clinical dermatology", "Speaker, National Dermatology Congress"],
    bio: "Covers general skin health, chronic conditions, and minor procedural dermatology.",
    avgConsult: 8 },
  { id: "d6", name: "Dr. Farhan Ali", department: "Dermatology", rating: 4.2, experience: 5,
    achievements: ["Pediatric dermatology focus"],
    bio: "Sees both adult and paediatric skin conditions with a gentle, explanatory consultation style.",
    avgConsult: 9 },
  { id: "d7", name: "Dr. Lakshmi Iyengar", department: "General Medicine", rating: 4.6, experience: 12,
    achievements: ["Chronic disease management program lead", "Diabetes care certification"],
    bio: "Primary point of contact for general health concerns, chronic condition follow-ups and referrals.",
    avgConsult: 10 },
  { id: "d8", name: "Dr. Sameer Joshi", department: "General Medicine", rating: 4.4, experience: 8,
    achievements: ["Preventive health screening lead"],
    bio: "Focuses on preventive screening, general illness, and coordinating specialist referrals.",
    avgConsult: 11 },
];

const WORK_START_MIN = 9 * 60;   // 9:00 AM
const WORK_END_MIN = 17 * 60;    // 5:00 PM
const PEAK_START_MIN = 13 * 60;  // 1:00 PM
const PEAK_END_MIN = 14 * 60;    // 2:00 PM

function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function minToLabel(min) {
  const h24 = Math.floor(min / 60), m = min % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(m)} ${ampm}`;
}
function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function dateLabel(key) {
  const d = new Date(key + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function slotsForDoctor(doc) {
  const slots = [];
  for (let t = WORK_START_MIN; t + doc.avgConsult <= WORK_END_MIN; t += doc.avgConsult) slots.push(t);
  return slots;
}
function isPeak(min) { return min >= PEAK_START_MIN && min < PEAK_END_MIN; }
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/* =========================================================================
   PERSISTENT STORE — window.storage acts as the shared backend database.
   One record: "queuesense-db" holding doctors' live counters + all bookings.
   ========================================================================= */
const DB_KEY = "queuesense-db-v1";

/* =========================================================================
   PATIENT TREATMENT JOURNEY — shared by online and offline patients alike.
   "Registration" and "Doctor Consultation" are driven by the booking/queue
   system itself; the later stages are advanced explicitly (by doctor/staff
   actions where one exists, or by the patient in this demo standing in for
   lab/pharmacy staff) and each advance pushes a notification with a
   predicted reporting time + place, per feature 1.
   ========================================================================= */
const JOURNEY_STAGES = [
  { key: "registration", name: "Registration", location: "OP Registration Desk" },
  { key: "consultation", name: "Doctor Consultation", location: "Doctor's Room" },
  { key: "lab", name: "Lab Test", location: "Laboratory, Ground Floor" },
  { key: "reports", name: "Reports", location: "Lab Reports Counter, Ground Floor" },
  { key: "pharmacy", name: "Pharmacy", location: "Pharmacy, Ground Floor" },
  { key: "billing", name: "Billing", location: "Billing Counter, Main Lobby" },
  { key: "completed", name: "Completed", location: "—" },
];

// typical minutes-until-ready once the PREVIOUS stage completes
const JOURNEY_ETA_MIN = { lab: 10, reports: 30, pharmacy: 5, billing: 10, completed: 5 };

function defaultJourney() {
  return JOURNEY_STAGES.map((s, i) => ({
    key: s.key,
    name: s.name,
    location: s.location,
    status: i === 0 ? "done" : i === 1 ? "current" : "pending",
    predictedAt: null,
    completedAt: i === 0 ? Date.now() : null,
  }));
}

// marks the current stage done and the next stage current+predicted; returns
// both the updated journey array and a ready-to-send notification message
function advanceJourney(journey) {
  const idx = journey.findIndex((s) => s.status === "current");
  if (idx === -1 || idx >= journey.length - 1) return { journey, notifyText: null };
  const next = journey.map((s, i) => {
    if (i === idx) return { ...s, status: "done", completedAt: Date.now() };
    if (i === idx + 1) {
      const etaMin = JOURNEY_ETA_MIN[s.key] || 15;
      return { ...s, status: "current", predictedAt: Date.now() + etaMin * 60000 };
    }
    return s;
  });
  const nextStage = next[idx + 1];
  const notifyText = nextStage.key === "completed"
    ? "Your treatment journey is complete — thank you for visiting."
    : `Next: ${nextStage.name}. Please report to ${nextStage.location} by ~${minToLabel(((new Date(nextStage.predictedAt)).getHours() * 60) + (new Date(nextStage.predictedAt)).getMinutes())}.`;
  return { journey: next, notifyText };
}

function pushNotification(commit, patientName, bookingId, message) {
  commit((prev) => ({
    ...prev,
    notifications: [
      { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, patientName, bookingId, message, createdAt: Date.now(), read: false },
      ...prev.notifications,
    ].slice(0, 300),
  }));
}

function buildSeedHistory() {
  // synthetic 9AM-5PM historical footfall, online vs offline, for staff analytics
  const hours = [];
  for (let h = 9; h < 17; h++) {
    const base = h === 13 ? 14 : h === 12 || h === 14 ? 10 : h === 9 || h === 16 ? 5 : 7;
    hours.push({
      hour: `${h > 12 ? h - 12 : h}${h >= 12 ? "PM" : "AM"}`,
      online: Math.max(1, base - 3 + (h % 3)),
      offline: Math.max(1, base - (h % 2)),
    });
  }
  return hours;
}

const DEVICE_ID = "ESP32_OPDESK_01";

function seedDB() {
  const doctors = {};
  RAW_DOCTORS.forEach((d) => {
    doctors[d.id] = {
      treatedToday: 0,
      recentDurations: [],   // real sensed consultation minutes, from doctor-room IR entry/exit (feature 3)
      absence: null,          // { active, reason, delayMinutes, announcedAt } (feature 4)
      roomOccupiedBy: null,   // bookingId currently inside the consultation room, if any
      roomEnteredAt: null,
      calling: null,          // { bookingId, at } — patient currently being called (OP-desk OLED + buzzer)
      callSeq: 0,             // increments on every call; the OP-desk buzzer sounds when it changes
    };
  });
  const devices = {
    [DEVICE_ID]: {
      location: "OP Registration Desk",
      lastHeartbeat: null,
      lastEvent: null,
      hwQueueCount: 0,
      irEntry: "UNKNOWN",
      irExit: "UNKNOWN",
      oled: "UNKNOWN",
      buzzer: "UNKNOWN",
    },
  };
  return {
    bookings: [], nextToken: 1, doctors, devices, notifications: [],
    registrations: [], nextReg: 1,
    history: buildSeedHistory(), seededAt: Date.now(),
  };
}

function isDeviceOnline(device) {
  return !!device?.lastHeartbeat && Date.now() - device.lastHeartbeat < 45000;
}

function migrate(parsed) {
  if (!parsed.devices) {
    parsed.devices = {
      [DEVICE_ID]: {
        location: "OP Registration Desk", lastHeartbeat: null, lastEvent: null,
        hwQueueCount: 0, irEntry: "UNKNOWN", irExit: "UNKNOWN", oled: "UNKNOWN", buzzer: "UNKNOWN",
      },
    };
  }
  if (!parsed.notifications) parsed.notifications = [];
  if (!parsed.registrations) parsed.registrations = [];
  if (!parsed.nextReg) parsed.nextReg = parsed.registrations.length + 1;
  RAW_DOCTORS.forEach((d) => {
    const existing = parsed.doctors[d.id] || {};
    parsed.doctors[d.id] = {
      treatedToday: existing.treatedToday || 0,
      recentDurations: existing.recentDurations || [],
      absence: existing.absence || null,
      roomOccupiedBy: existing.roomOccupiedBy || null,
      roomEnteredAt: existing.roomEnteredAt || null,
      calling: existing.calling || null,
      callSeq: existing.callSeq || 0,
    };
  });
  parsed.bookings = (parsed.bookings || []).map((b) => ({
    emergency: false,
    journey: defaultJourney(),
    createdBy: "patient",
    ...b,
  })).map((b) => ({ bookingMode: b.type === "online" ? "online_registrar" : "walk_in", ...b }));
  return parsed;
}

function useDB() {
  const [db, setDB] = useState(null);
  const [ready, setReady] = useState(false);
  const lastWriteAt = useRef(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await window.storage.get(DB_KEY, true);
        if (mounted) { setDB(migrate(JSON.parse(res.value))); setReady(true); }
      } catch (e) {
        const fresh = seedDB();
        try { await window.storage.set(DB_KEY, JSON.stringify(fresh), true); } catch (e2) {}
        if (mounted) { setDB(fresh); setReady(true); }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const commit = useCallback(async (updater) => {
    setDB((prev) => {
      const next = updater(prev);
      lastWriteAt.current = Date.now();
      window.storage.set(DB_KEY, JSON.stringify(next), true).catch(() => {});
      return next;
    });
  }, []);

  // light polling so multiple tabs/roles feel "live"
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(async () => {
      if (Date.now() - lastWriteAt.current < 2500) return;
      try {
        const res = await window.storage.get(DB_KEY, true);
        const remote = migrate(JSON.parse(res.value));
        if (Date.now() - lastWriteAt.current < 2500) return;
        setDB((prev) => (prev && remote.seededAt === prev.seededAt && JSON.stringify(remote) === JSON.stringify(prev) ? prev : remote));
      } catch (e) {}
    }, 4000);
    return () => clearInterval(id);
  }, [ready]);

  return { db, ready, commit };
}

/* =========================================================================
   SHARED UI ATOMS
   ========================================================================= */
function Badge({ tone = "mint", children }) {
  const map = {
    mint: { bg: C.mintSoft, fg: C.teal },
    amber: { bg: C.amberSoft, fg: C.amber },
    red: { bg: C.redSoft, fg: C.red },
  };
  const s = map[tone];
  return (
    <span style={{ background: s.bg, color: s.fg }} className="text-xs font-semibold px-2.5 py-1 rounded-full inline-flex items-center gap-1">
      {children}
    </span>
  );
}

function congestionTone(queueLen) {
  if (queueLen <= 2) return { tone: "mint", label: "Low" };
  if (queueLen <= 5) return { tone: "mint", label: "Moderate" };
  if (queueLen <= 8) return { tone: "amber", label: "High" };
  return { tone: "red", label: "Critical" };
}

function PrimaryButton({ children, onClick, disabled, full, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ background: disabled ? "#9DB3AF" : C.teal, width: full ? "100%" : undefined }}
      className="text-white font-medium text-sm rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 transition-colors disabled:cursor-not-allowed hover:opacity-90"
    >
      {Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      style={{ borderColor: C.line, color: C.teal }}
      className="text-sm font-medium rounded-lg px-3 py-2 border flex items-center gap-2 hover:bg-white transition-colors"
    >
      {Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

function Card({ children, style, className = "", onClick }) {
  return (
    <div
      onClick={onClick}
      style={{ background: C.panel, border: `1px solid ${C.line}`, ...style, cursor: onClick ? "pointer" : undefined }}
      className={`rounded-xl ${className}`}
    >
      {children}
    </div>
  );
}

/* =========================================================================
   QUEUE MATH — derived live from bookings, mirroring the hardware contract
   ========================================================================= */
// Emergency cases always sort ahead of normal cases; within each group,
// earliest slot/token first — this is the one ordering used everywhere
// (queue display, "ahead of you" counts, doctor's upcoming list) so an
// emergency insertion is reflected consistently across every screen.
function sortWaiting(list) {
  return [...list].sort((a, b) => {
    const ae = a.recalled ? 0 : a.emergency ? 1 : 2, be = b.recalled ? 0 : b.emergency ? 1 : 2;
    if (ae !== be) return ae - be;
    return a.slotMin - b.slotMin || a.token - b.token;
  });
}

function computeQueueForDoctor(db, doctorId, dateKey) {
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const dayBookings = db.bookings.filter((b) => b.doctorId === doctorId && b.date === dateKey);
  const waiting = sortWaiting(dayBookings.filter((b) => b.status === "waiting"));
  const treated = dayBookings.filter((b) => b.status === "done");
  const totalSlots = slotsForDoctor(doc).length;
  const bookedCount = dayBookings.filter((b) => b.status !== "cancelled").length;
  const remainingSlots = Math.max(0, totalSlots - bookedCount);
  const emergencyCount = waiting.filter((b) => b.emergency).length;
  return { doc, dayBookings, waiting, treated, totalSlots, remainingSlots, queueLen: waiting.length, emergencyCount };
}

// Average consultation time for a doctor: once the doctor-room IR sensors
// have logged at least 2 real consultations today, their *sensed* average
// replaces the static textbook figure — this is what makes predictions
// actually move as real consultations complete (feature 3).
function effectiveAvgConsult(db, doctorId) {
  const staticDoc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const recent = db.doctors[doctorId]?.recentDurations || [];
  if (recent.length >= 2) {
    const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
    return Math.round(avg * 10) / 10;
  }
  return staticDoc.avgConsult;
}

function estimateWaitMinutes(db, doctorId, aheadCount, atMin) {
  const avgConsult = effectiveAvgConsult(db, doctorId);
  let base = aheadCount * avgConsult;
  if (isPeak(atMin)) base = Math.round(base * 1.15);
  const absence = db.doctors[doctorId]?.absence;
  const delay = absence && absence.active ? (absence.delayMinutes || 0) : 0;
  return Math.round(base) + delay;
}

function computeDisplayStats(db, docId, dateKey) {
  const doc = RAW_DOCTORS.find((d) => d.id === docId);
  const { waiting, remainingSlots, emergencyCount } = computeQueueForDoctor(db, docId, dateKey);
  const cong = congestionTone(waiting.length);
  const avgConsult = effectiveAvgConsult(db, docId);
  const estimated = waiting.length * avgConsult;
  const predicted = estimateWaitMinutes(db, docId, waiting.length, nowMinutes());
  return { doc, waiting, cong, estimated, predicted, remainingSlots, emergencyCount, avgConsult };
}

// position within the emergency-aware sorted order, not raw slot/token order
function aheadCountFor(db, booking, dateKey) {
  const { waiting } = computeQueueForDoctor(db, booking.doctorId, dateKey);
  const idx = waiting.findIndex((b) => b.id === booking.id);
  return idx <= 0 ? 0 : idx;
}

function lookupToken(db, tokenStr, dateKey) {
  const tokenNum = Number(String(tokenStr).trim());
  if (!tokenStr || Number.isNaN(tokenNum)) return null;
  const found = db.bookings.find((b) => b.token === tokenNum && b.date === dateKey);
  if (!found) return { ok: false, text: "No booking found with that token for today." };
  const doc = RAW_DOCTORS.find((d) => d.id === found.doctorId);
  const ds = db.doctors[found.doctorId] || {};
  const absence = ds.absence?.active ? ds.absence : null;
  const base = { ok: true, doc, booking: found, absence };
  if (found.status === "done") return { ...base, done: true };
  if (found.status === "not_available") return { ...base, done: false, notAvailable: true };
  const ahead = aheadCountFor(db, found, dateKey);
  const mins = estimateWaitMinutes(db, found.doctorId, ahead, nowMinutes());
  return { ...base, done: false, ahead, mins, inRoom: ds.roomOccupiedBy === found.id, called: ds.calling?.bookingId === found.id };
}

/* =========================================================================
   OP-DESK BOOKING, DOCTOR-ROOM HARDWARE ACTIONS & QUEUE STATE CHANGES
   Everything that changes the queue goes through these pure functions, so the
   web buttons, the OP desk and the real ESP32 (door IR + room button) all
   behave identically.
   ========================================================================= */
const CONSULT_FEE = 500;
const PAYMENT_METHODS = ["Cash", "UPI", "Card"];

function withNotifs(prev, list) {
  const made = list
    .filter((n) => n.patientName)
    .map((n, i) => ({
      id: `n-${Date.now()}-${prev.notifications.length}-${i}`,
      patientName: n.patientName, bookingId: n.bookingId || null, message: n.message, createdAt: Date.now(), read: false,
    }));
  return made.length ? { ...prev, notifications: [...made, ...prev.notifications].slice(0, 300) } : prev;
}

// first free slot for an online-registrar booking made by the OP desk
function assignSlot(prev, doctorId, dateKey) {
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const taken = new Set(prev.bookings.filter((b) => b.doctorId === doctorId && b.date === dateKey && b.status !== "cancelled").map((b) => b.slotMin));
  const isToday = dateKey === todayKey(0);
  const free = slotsForDoctor(doc).filter((s) => !taken.has(s) && (!isToday || s >= nowMinutes()));
  if (free.length > 0) return free[0];
  return isToday ? nowMinutes() : slotsForDoctor(doc)[0];
}

function startBreak(prev, doctorId, opts = {}) {
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const reason = opts.reason || "Doctor on break / personal reason";
  const delay = opts.delayMinutes ?? 15;
  const { waiting } = computeQueueForDoctor(prev, doctorId, todayKey(0));
  const avg = effectiveAvgConsult(prev, doctorId);
  const notifs = waiting.map((b, i) => {
    const baseWait = Math.round(i * avg * (isPeak(nowMinutes()) ? 1.15 : 1));
    return { patientName: b.patientName, bookingId: b.id, message: `${doc.name} is currently unavailable (${reason}). Your updated estimated wait is now ~${baseWait + delay} min (previously ~${baseWait} min).` };
  });
  const next = {
    ...prev,
    doctors: { ...prev.doctors, [doctorId]: { ...prev.doctors[doctorId], absence: { active: true, reason, delayMinutes: delay, announcedAt: Date.now() } } },
  };
  return withNotifs(next, notifs);
}

function endBreak(prev, doctorId) {
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const { waiting } = computeQueueForDoctor(prev, doctorId, todayKey(0));
  const next = { ...prev, doctors: { ...prev.doctors, [doctorId]: { ...prev.doctors[doctorId], absence: null } } };
  return withNotifs(next, waiting.map((b) => ({ patientName: b.patientName, bookingId: b.id, message: `${doc.name} is back — your queue is resuming normally.` })));
}

// calls the patient at the head of the queue (also used to repeat a call) — this is
// what makes the OP-desk OLED show the token and the buzzer sound
function callHead(prev, doctorId, forceBookingId) {
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const ds = prev.doctors[doctorId];
  const { waiting } = computeQueueForDoctor(prev, doctorId, todayKey(0));
  const head = forceBookingId ? waiting.find((b) => b.id === forceBookingId) : waiting.find((b) => b.id !== ds.roomOccupiedBy);
  if (!head) return { ...prev, doctors: { ...prev.doctors, [doctorId]: { ...ds, calling: null } } };
  const next = {
    ...prev,
    doctors: { ...prev.doctors, [doctorId]: { ...ds, calling: { bookingId: head.id, at: Date.now() }, callSeq: (ds.callSeq || 0) + 1 } },
  };
  return withNotifs(next, [{ patientName: head.patientName, bookingId: head.id, message: `Token #${head.token}: it's your turn — please go to ${doc.name}'s room now.` }]);
}

function applyDoctorAction(prev, doctorId, action, opts = {}) {
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  if (!doc || !prev.doctors[doctorId]) return prev;
  const dateKey = todayKey(0);
  const ds = prev.doctors[doctorId];
  const now = Date.now();

  // door IR (entry): the called patient walks into the consultation room
  if (action === "ENTRY") {
    if (ds.roomOccupiedBy) return prev;
    const { waiting } = computeQueueForDoctor(prev, doctorId, dateKey);
    const target = opts.bookingId ? waiting.find((b) => b.id === opts.bookingId) : waiting[0];
    if (!target) return prev;
    return { ...prev, doctors: { ...prev.doctors, [doctorId]: { ...ds, roomOccupiedBy: target.id, roomEnteredAt: now, calling: null } } };
  }

  // door IR (exit): consultation finished — real duration is sensed and fed into the predictions
  if (action === "EXIT") {
    if (!ds.roomOccupiedBy) return prev;
    const durationMin = ds.roomEnteredAt ? Math.max(1, Math.round((now - ds.roomEnteredAt) / 60000)) : doc.avgConsult;
    let notifyText = null, patientName = null, bookingId = ds.roomOccupiedBy;
    const bookings = prev.bookings.map((b) => {
      if (b.id !== bookingId) return b;
      patientName = b.patientName;
      let journey = b.journey || defaultJourney();
      if (journey[1] && journey[1].status === "current") { // a recalled patient's journey is not advanced twice
        const r = advanceJourney(journey); journey = r.journey; notifyText = r.notifyText;
      }
      return { ...b, status: "done", journey, handledAt: now, recalled: false };
    });
    const next = {
      ...prev, bookings,
      doctors: {
        ...prev.doctors,
        [doctorId]: { ...ds, recentDurations: [...(ds.recentDurations || []), durationMin].slice(-10), treatedToday: (ds.treatedToday || 0) + 1, roomOccupiedBy: null, roomEnteredAt: null },
      },
    };
    return notifyText ? withNotifs(next, [{ patientName, bookingId, message: `Consultation with ${doc.name} complete. ${notifyText}` }]) : next;
  }

  // room button, short press: finish whoever is inside, then call the next patient
  if (action === "NEXT") {
    let state = prev;
    if (ds.roomOccupiedBy) state = applyDoctorAction(state, doctorId, "EXIT");
    if (state.doctors[doctorId].absence?.active) state = endBreak(state, doctorId);
    return callHead(state, doctorId);
  }

  // room button, double press: call the previous patient back in
  if (action === "PREVIOUS") {
    if (ds.roomOccupiedBy) return prev;
    const { waiting } = computeQueueForDoctor(prev, doctorId, dateKey);
    const alreadyRecalled = waiting.find((b) => b.recalled);
    if (alreadyRecalled) return callHead(prev, doctorId, alreadyRecalled.id);
    const last = prev.bookings
      .filter((b) => b.doctorId === doctorId && b.date === dateKey && (b.status === "done" || b.status === "not_available") && b.handledAt)
      .reverse() // on a timestamp tie, the booking handled later in the list wins
      .sort((a, b) => b.handledAt - a.handledAt)[0];
    if (!last) return prev;
    const state = { ...prev, bookings: prev.bookings.map((b) => (b.id === last.id ? { ...b, status: "waiting", recalled: true } : b)) };
    return callHead(state, doctorId, last.id);
  }

  // room button, long press: doctor break / absence on, press again to end it
  if (action === "BREAK") return ds.absence?.active ? endBreak(prev, doctorId) : startBreak(prev, doctorId, opts);

  return prev;
}

// OP desk: patient was called but is not there -> "Not available", queue moves on to the next patient
function markNotAvailable(prev, bookingId) {
  const b = prev.bookings.find((x) => x.id === bookingId);
  if (!b || b.status !== "waiting") return prev;
  const ds = prev.doctors[b.doctorId];
  if (ds.roomOccupiedBy === bookingId) return prev;
  const doc = RAW_DOCTORS.find((d) => d.id === b.doctorId);
  const { waiting } = computeQueueForDoctor(prev, b.doctorId, b.date);
  const wasHead = ds.calling?.bookingId === bookingId || waiting.find((x) => x.id !== ds.roomOccupiedBy)?.id === bookingId;
  let state = { ...prev, bookings: prev.bookings.map((x) => (x.id === bookingId ? { ...x, status: "not_available", handledAt: Date.now() } : x)) };
  state = withNotifs(state, [{ patientName: b.patientName, bookingId, message: `Token #${b.token}: you were not available when called for ${doc.name}. Please report to the OP desk to rejoin the queue.` }]);
  return wasHead ? callHead(state, b.doctorId) : state;
}

function requeueBooking(prev, bookingId) {
  const b = prev.bookings.find((x) => x.id === bookingId);
  if (!b || b.status !== "not_available") return prev;
  const doc = RAW_DOCTORS.find((d) => d.id === b.doctorId);
  const state = { ...prev, bookings: prev.bookings.map((x) => (x.id === bookingId ? { ...x, status: "waiting", slotMin: nowMinutes(), requeued: true } : x)) };
  return withNotifs(state, [{ patientName: b.patientName, bookingId, message: `Token #${b.token}: you're back in ${doc.name}'s queue.` }]);
}

/* =========================================================================
   QR CODE + TOKEN STATUS (public page opened by scanning the OP-desk QR)
   ========================================================================= */
function statusPageUrl(token) {
  const base = (import.meta.env.VITE_PUBLIC_URL || (window.location.origin + window.location.pathname)).replace(/\/$/, "");
  return `${base}/?view=token${token ? `&token=${token}` : ""}`;
}

function QRImage({ text, size = 120 }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let on = true;
    QRCode.toDataURL(text, { margin: 1, width: size * 3, color: { dark: "#0A342E", light: "#FFFFFF" } })
      .then((u) => { if (on) setSrc(u); })
      .catch(() => {});
    return () => { on = false; };
  }, [text, size]);
  return src
    ? <img src={src} alt="QR code — scan to check your waiting time" width={size} height={size} style={{ borderRadius: 8, background: "white" }} />
    : <div style={{ width: size, height: size, background: "white" }} className="rounded-lg" />;
}

function TokenStatusDetails({ lookup, dark = false }) {
  const fg = dark ? "white" : C.ink;
  const sub = dark ? "#9FC2B8" : C.sub;
  if (!lookup) return null;
  if (!lookup.ok) return <div className="text-sm" style={{ color: dark ? "#E8A597" : C.red }}>{lookup.text}</div>;

  const { booking: b, doc, absence } = lookup;
  let badge;
  if (lookup.done) badge = <Badge tone="mint">Consultation completed</Badge>;
  else if (lookup.notAvailable) badge = <Badge tone="red">Not available — see OP desk</Badge>;
  else if (lookup.inRoom) badge = <Badge tone="mint">In consultation now</Badge>;
  else if (lookup.called) badge = <Badge tone="amber">Your turn — go to the doctor's room</Badge>;
  else badge = <Badge tone="amber">Waiting</Badge>;

  const rows = [["Doctor", `${doc.name} · ${doc.department}`], ["Token", `#${b.token}`]];
  if (!lookup.done && !lookup.notAvailable) {
    rows.push(["Patients ahead of you", lookup.inRoom ? "0 — you're in the room" : `${lookup.ahead}`]);
    if (!lookup.inRoom && !lookup.called) {
      rows.push(["Estimated waiting time", lookup.ahead === 0 ? "You're next — please be ready" : `~${lookup.mins} min (around ${minToLabel((nowMinutes() + lookup.mins) % (24 * 60))})`]);
    }
  }
  if (b.emergency) rows.push(["Case type", "Emergency — prioritised"]);
  if (b.paid) rows.push(["Payment", `₹${b.payment?.amount ?? CONSULT_FEE} received${b.payment?.method ? ` (${b.payment.method})` : ""}`]);
  if (b.bookingMode) rows.push(["Registered as", b.bookingMode === "online_registrar" ? "Online registrar" : "Walk-in"]);
  if (lookup.done) {
    const cur = (b.journey || []).find((s) => s.status === "current");
    if (cur) rows.push(["Next stage", `${cur.name} — ${cur.location}`]);
  }

  return (
    <div>
      <div className="mb-2">{badge}</div>
      {absence && !lookup.done && (
        <div className="text-xs rounded-lg px-3 py-2 mb-2" style={{ background: dark ? "rgba(201,122,46,0.18)" : C.amberSoft, color: dark ? "#F3C99A" : C.ink }}>
          Doctor delay: {doc.name} is unavailable ({absence.reason}). About +{absence.delayMinutes} min is included in your waiting time.
        </div>
      )}
      {lookup.notAvailable && (
        <div className="text-xs rounded-lg px-3 py-2 mb-2" style={{ background: dark ? "rgba(179,67,46,0.2)" : C.redSoft, color: dark ? "#F1B8AC" : C.red }}>
          You weren't present when called. Please report to the OP desk to rejoin the queue.
        </div>
      )}
      <div className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-sm">
            <span style={{ color: sub }}>{k}</span>
            <span className="font-medium text-right" style={{ color: fg }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PublicTokenStatus({ db, initialToken }) {
  const [token, setToken] = useState(initialToken || "");
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 10000); return () => clearInterval(id); }, []);
  const lookup = token ? lookupToken(db, token, todayKey(0)) : null;

  return (
    <div style={{ background: C.tealDeep }} className="min-h-full text-white px-5 py-8">
      <div className="max-w-md mx-auto">
        <div className="flex items-center gap-2 mb-6">
          <RadioTower size={18} color={C.mint} />
          <span className="font-semibold">QueueSense — check your waiting time</span>
        </div>
        <Card style={{ background: "#0F5147", borderColor: "rgba(255,255,255,0.1)" }} className="p-5">
          <label className="text-xs font-medium" style={{ color: "#B7D3CB" }}>Enter your token number</label>
          <input
            value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric" placeholder="e.g. 12"
            className="w-full mt-1 mb-4 rounded-lg px-3 py-2.5 text-sm outline-none"
            style={{ background: "#0A342E", color: "white", border: "1px solid rgba(255,255,255,0.15)" }}
          />
          {lookup ? <TokenStatusDetails lookup={lookup} dark /> : <p className="text-xs" style={{ color: "#9FC2B8" }}>Your token number is on the slip given by the OP desk. Details refresh automatically.</p>}
        </Card>
        <button onClick={() => { window.location.href = window.location.pathname; }} className="text-xs mt-5" style={{ color: "#9FC2B8" }}>Go to QueueSense sign in →</button>
      </div>
    </div>
  );
}

/* =========================================================================
   HARDWARE BRIDGE — connects the ESP32 (via the backend) to this app.
   Only active when VITE_API_URL is set and an OP-desk / doctor / kiosk screen is open.
   1) claims doctor-room commands (door IR + button) and applies them to the queue
   2) publishes the live per-doctor summary for the OP-desk OLED + buzzer
   3) mirrors the device heartbeat into the IoT Devices page
   ========================================================================= */
function buildDeskState(db) {
  const dateKey = todayKey(0);
  return RAW_DOCTORS.map((d) => {
    const ds = db.doctors[d.id] || {};
    const { waiting, emergencyCount } = computeQueueForDoctor(db, d.id, dateKey);
    const queue = waiting.filter((b) => b.id !== ds.roomOccupiedBy);
    const calling = ds.calling ? queue.find((b) => b.id === ds.calling.bookingId) : null;
    const inRoom = ds.roomOccupiedBy ? db.bookings.find((b) => b.id === ds.roomOccupiedBy) : null;
    const next = calling ? queue.find((b) => b.id !== calling.id) : queue[0];
    const absence = ds.absence?.active ? ds.absence : null;
    return {
      id: d.id, doctor_name: d.name, department: d.department,
      waiting: queue.length,
      calling_token: calling ? calling.token : null,
      in_room_token: inRoom ? inRoom.token : null,
      next_token: next ? next.token : null,
      est_min: estimateWaitMinutes(db, d.id, queue.length, nowMinutes()),
      on_break: !!absence,
      delay_min: absence ? absence.delayMinutes || 0 : 0,
      emergency: emergencyCount,
      call_seq: ds.callSeq || 0,
    };
  });
}

function useHardwareBridge(enabled, db, commit) {
  const dbRef = useRef(db);
  const lastSent = useRef({ json: "", at: 0 });
  useEffect(() => { dbRef.current = db; }, [db]);
  const active = enabled && !!API_URL;

  // 1) claim and apply doctor-room commands
  useEffect(() => {
    if (!active) return;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(`${API_URL}/api/iot/commands/claim`, { method: "POST" });
        if (res.ok) {
          const { commands = [] } = await res.json();
          commands.forEach((c) => commit((prev) => applyDoctorAction(prev, c.doctor_id, c.action)));
        }
      } catch { /* backend unreachable — retry next tick */ }
      busy = false;
    };
    const id = setInterval(tick, 1500);
    tick();
    return () => clearInterval(id);
  }, [active, commit]);

  // 2) publish the OP-desk display feed (immediately on change, and every 8s as a keep-alive)
  const sendDesk = useCallback(async (force) => {
    const body = JSON.stringify({ doctors: buildDeskState(dbRef.current) });
    const t = Date.now();
    if (!force && body === lastSent.current.json && t - lastSent.current.at < 8000) return;
    lastSent.current = { json: body, at: t };
    try { await fetch(`${API_URL}/api/iot/desk-state`, { method: "POST", headers: { "Content-Type": "application/json" }, body }); } catch { /* ignore */ }
  }, []);
  useEffect(() => { if (active && db) sendDesk(false); }, [active, db, sendDesk]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => sendDesk(false), 4000);
    return () => clearInterval(id);
  }, [active, sendDesk]);

  // 3) mirror the ESP32 heartbeat / sensor status into the IoT Devices page
  useEffect(() => {
    if (!active) return;
    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/api/iot/devices`);
        if (!res.ok) return;
        const { devices = [] } = await res.json();
        const d = devices.find((x) => x.device_id === DEVICE_ID);
        if (!d || !d.lastHeartbeat) return;
        const cur = dbRef.current?.devices?.[DEVICE_ID];
        if (cur && cur.lastHeartbeat === d.lastHeartbeat) return;
        commit((prev) => ({
          ...prev,
          devices: {
            ...prev.devices,
            [DEVICE_ID]: {
              ...prev.devices[DEVICE_ID],
              lastHeartbeat: d.lastHeartbeat, lastEvent: d.lastEvent || prev.devices[DEVICE_ID].lastEvent,
              irEntry: d.irEntryStatus || "UNKNOWN", irExit: d.irExitStatus || "UNKNOWN",
              oled: d.oledStatus || "UNKNOWN", buzzer: d.buzzerStatus || "UNKNOWN",
            },
          },
        }));
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 5000);
    tick();
    return () => clearInterval(id);
  }, [active, commit]);
}

/* =========================================================================
   LOGIN
   ========================================================================= */
function LoginScreen({ onLogin, onKiosk }) {
  const [role, setRole] = useState("patient");
  const [name, setName] = useState("");
  const [doctorId, setDoctorId] = useState(RAW_DOCTORS[0].id);

  const canSubmit = role === "doctor" ? true : name.trim().length > 1;

  return (
    <div style={{ background: C.tealDeep }} className="min-h-full w-full flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ background: C.mint }} className="w-9 h-9 rounded-lg flex items-center justify-center">
            <RadioTower size={18} color="#08221D" />
          </div>
          <span className="text-white text-lg font-semibold tracking-tight">QueueSense</span>
        </div>

        <Card style={{ background: "#0F5147" }} className="p-6 border-0">
          <h1 className="text-white text-xl font-semibold mb-1">Sign in</h1>
          <p style={{ color: "#B7D3CB" }} className="text-sm mb-5">Choose how you're using QueueSense today.</p>

          <div className="grid grid-cols-3 gap-2 mb-5">
            {[
              { k: "patient", label: "Patient", icon: Users },
              { k: "doctor", label: "Doctor", icon: Stethoscope },
              { k: "staff", label: "Staff", icon: UserCog },
            ].map(({ k, label, icon: Icon }) => (
              <button
                key={k}
                onClick={() => setRole(k)}
                style={{
                  background: role === k ? C.mint : "rgba(255,255,255,0.06)",
                  color: role === k ? "#08221D" : "#D9EAE5",
                  borderColor: role === k ? C.mint : "rgba(255,255,255,0.15)",
                }}
                className="rounded-lg border py-3 flex flex-col items-center gap-1.5 text-xs font-medium transition-colors"
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
          </div>

          {role !== "doctor" && (
            <div className="mb-4">
              <label className="text-xs font-medium" style={{ color: "#B7D3CB" }}>Full name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={role === "staff" ? "e.g. Ramesh Kumar, OP Manager" : "e.g. Anita Sharma"}
                className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none"
                style={{ background: "#0A342E", color: "white", border: "1px solid rgba(255,255,255,0.15)" }}
              />
            </div>
          )}

          {role === "doctor" && (
            <div className="mb-4">
              <label className="text-xs font-medium" style={{ color: "#B7D3CB" }}>Select your profile</label>
              <select
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none"
                style={{ background: "#0A342E", color: "white", border: "1px solid rgba(255,255,255,0.15)" }}
              >
                {RAW_DOCTORS.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} — {d.department}</option>
                ))}
              </select>
            </div>
          )}

          <PrimaryButton
            full
            disabled={!canSubmit}
            onClick={() => onLogin({ role, name: role === "doctor" ? RAW_DOCTORS.find(d => d.id === doctorId).name : name.trim(), doctorId })}
          >
            Continue
          </PrimaryButton>
        </Card>

        <button onClick={onKiosk} className="w-full text-center mt-5 text-sm hover:underline" style={{ color: "#9FC2B8" }}>
          Open OP desk display (kiosk) instead →
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   PATIENT — Doctor browsing, profile, booking, payment, my appointments
   ========================================================================= */
function StarRow({ rating }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium" style={{ color: C.ink }}>
      <Star size={14} fill={C.amber} color={C.amber} /> {rating.toFixed(1)}
    </span>
  );
}

function AiDoctorRecommendation({ deptDoctors, db, dateKey, onPick, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [priority, setPriority] = useState("balanced"); // 'balanced' | 'wait' | 'rating'
  const [maxWait, setMaxWait] = useState("");
  const [result, setResult] = useState(null);

  function recommend() {
    const maxW = maxWait ? Number(maxWait) : null;
    const scored = deptDoctors.map((d) => {
      const { queueLen } = computeQueueForDoctor(db, d.id, dateKey);
      const est = estimateWaitMinutes(db, d.id, queueLen, nowMinutes());
      return { d, queueLen, est };
    });
    const inRange = maxW ? scored.filter((s) => s.est <= maxW) : scored;
    const pool = inRange.length > 0 ? inRange : scored; // fall back to all if nothing meets the constraint

    const weighted = pool.map((s) => {
      const ratingScore = (s.d.rating / 5) * 100;
      const waitScore = Math.max(0, 100 - s.est * 2.5);
      let score;
      if (priority === "wait") score = waitScore * 0.8 + ratingScore * 0.2;
      else if (priority === "rating") score = ratingScore * 0.8 + waitScore * 0.2;
      else score = ratingScore * 0.5 + waitScore * 0.5;
      return { ...s, score };
    }).sort((a, b) => b.score - a.score);

    const best = weighted[0];
    const metConstraint = maxW ? best.est <= maxW : true;
    const reasonParts = [
      `${best.d.rating.toFixed(1)}★ rating`,
      `~${best.est} min estimated wait`,
      `${best.queueLen} currently waiting`,
      `${best.d.experience} yrs experience`,
    ];
    const explanation = `Recommended from ${pool.length} doctor${pool.length === 1 ? "" : "s"} in ${best.d.department}, prioritizing ${priority === "wait" ? "shortest wait" : priority === "rating" ? "highest rating" : "a balance of rating and wait"}: ${reasonParts.join(" · ")}.` +
      (maxW && !metConstraint ? ` No doctor met your ${maxW}-min max wait, so this is the closest match.` : "");

    setResult({ doc: best.d, explanation });
  }

  return (
    <Card className="p-4 mb-3" style={{ background: C.mintSoft, borderColor: C.mint }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BadgeCheck size={16} color={C.teal} />
          <span className="text-sm font-semibold" style={{ color: C.ink }}>AI Doctor Recommendation</span>
        </div>
        <ChevronRight size={16} color={C.teal} style={{ transform: open ? "rotate(90deg)" : "none" }} />
      </button>

      {open && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="text-xs font-medium" style={{ color: C.sub }}>Prioritize</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full mt-1 rounded-lg px-2.5 py-2 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
                <option value="balanced">Balanced</option>
                <option value="wait">Shortest wait</option>
                <option value="rating">Highest rating</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium" style={{ color: C.sub }}>Max wait (min, optional)</label>
              <input type="number" min="0" value={maxWait} onChange={(e) => setMaxWait(e.target.value)} placeholder="e.g. 20" className="w-full mt-1 rounded-lg px-2.5 py-2 text-sm outline-none" style={{ border: `1px solid ${C.line}` }} />
            </div>
          </div>
          <PrimaryButton full onClick={recommend}>Get recommendation</PrimaryButton>

          {result && (
            <div className="mt-3 p-3 rounded-lg" style={{ background: "white", border: `1px solid ${C.mint}` }}>
              <div className="text-sm font-semibold mb-1" style={{ color: C.ink }}>{result.doc.name}</div>
              <p className="text-xs mb-2" style={{ color: C.sub }}>{result.explanation}</p>
              <GhostButton onClick={() => onPick(result.doc)} icon={ChevronRight}>View & register {result.doc.name.split(" ").slice(-1)[0]}</GhostButton>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DoctorListItem({ doc, db, dateKey, onSelect }) {
  const { queueLen, remainingSlots, emergencyCount } = computeQueueForDoctor(db, doc.id, dateKey);
  const est = estimateWaitMinutes(db, doc.id, queueLen, nowMinutes());
  const cong = congestionTone(queueLen);
  return (
    <Card className="p-4 flex items-center justify-between gap-4 hover:shadow-sm transition-shadow cursor-pointer" onClick={() => onSelect(doc)}>
      <div className="flex items-center gap-3 min-w-0">
        <div style={{ background: C.mintSoft, color: C.teal }} className="w-11 h-11 rounded-full flex items-center justify-center font-semibold shrink-0">
          {doc.name.split(" ").slice(-1)[0][0]}
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate" style={{ color: C.ink }}>{doc.name}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <StarRow rating={doc.rating} />
            <span style={{ color: C.sub }} className="text-xs">· {doc.experience} yrs exp</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right">
          <Badge tone={cong.tone}>{cong.label} queue</Badge>
          <div style={{ color: C.sub }} className="text-xs mt-1">
            {queueLen} waiting · min wait ~{est}m{emergencyCount > 0 ? ` · ${emergencyCount} emergency ahead` : ""}
          </div>
        </div>
        <div className="text-right hidden sm:block">
          <div className="text-xs" style={{ color: C.sub }}>Slots left today</div>
          <div className="font-semibold text-sm" style={{ color: C.teal }}>{remainingSlots}</div>
        </div>
        <ChevronRight size={18} color={C.sub} />
      </div>
    </Card>
  );
}

function CaseTypeToggle({ value, onChange }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold mb-1.5" style={{ color: C.sub }}>CASE TYPE</div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange(false)}
          style={{
            background: !value ? C.mintSoft : C.bg, color: !value ? C.teal : C.sub,
            border: `1px solid ${!value ? C.mint : C.line}`,
          }}
          className="rounded-lg py-2.5 text-sm font-medium"
        >
          Normal
        </button>
        <button
          type="button"
          onClick={() => onChange(true)}
          style={{
            background: value ? C.redSoft : C.bg, color: value ? C.red : C.sub,
            border: `1px solid ${value ? C.red : C.line}`,
          }}
          className="rounded-lg py-2.5 text-sm font-medium flex items-center justify-center gap-1.5"
        >
          <AlertTriangle size={14} /> Emergency
        </button>
      </div>
      {value && (
        <p className="text-[11px] mt-1.5" style={{ color: C.red }}>
          Emergency cases are moved to the front of the doctor's queue, ahead of all normal-case patients still waiting.
        </p>
      )}
    </div>
  );
}

function RegistrationConfirmed({ regNo, doc, dateKey, onDone }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(10,20,18,0.55)" }}>
      <Card className="w-full max-w-sm p-6 text-center">
        <CheckCircle2 size={40} color={C.mint} className="mx-auto mb-3" />
        <h3 className="font-semibold text-lg mb-1" style={{ color: C.ink }}>Registration submitted</h3>
        <p style={{ color: C.sub }} className="text-sm mb-4">{doc.name} · {dateLabel(dateKey)}</p>
        <div style={{ background: C.mintSoft }} className="rounded-lg py-3 mb-3">
          <div className="text-xs" style={{ color: C.teal }}>Your registration number</div>
          <div className="text-2xl font-bold" style={{ color: C.teal }}>R-{regNo}</div>
        </div>
        <p className="text-xs mb-4" style={{ color: C.sub }}>Show this at the OP desk. The desk confirms your registration, receives the consultation fee and gives you your token.</p>
        <PrimaryButton full onClick={onDone}>Go to my registrations</PrimaryButton>
      </Card>
    </div>
  );
}

function LiveCountdown({ doc, booking, db }) {
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 15000); return () => clearInterval(id); }, []);

  const isToday = booking.date === todayKey(0);
  if (!isToday) {
    return <div className="text-sm" style={{ color: C.sub }}>Scheduled for {dateLabel(booking.date)} at {minToLabel(booking.slotMin)}</div>;
  }
  if (booking.status === "done") return <Badge tone="mint">Consultation completed</Badge>;
  if (booking.status === "not_available") return <Badge tone="red">Not available — please see the OP desk</Badge>;
  const ahead = aheadCountFor(db, booking, booking.date);
  const mins = estimateWaitMinutes(db, doc.id, ahead, nowMinutes());
  const absence = db.doctors[doc.id]?.absence;
  return (
    <div>
      <div className="flex items-center gap-2">
        <AlarmClock size={15} color={C.teal} />
        <span className="text-sm font-medium" style={{ color: C.ink }}>
          {ahead === 0 ? "You're next — please be ready" : `~${mins} min remaining · ${ahead} ahead of you`}
        </span>
      </div>
      {absence?.active && <div className="text-xs mt-1" style={{ color: C.amber }}>Doctor delay: {absence.reason} (+{absence.delayMinutes} min included)</div>}
    </div>
  );
}

function RegisterDoctorPanel({ doc, db, onBack, onRegister, otherDoctors, onSelectOther }) {
  const [dateOffset, setDateOffset] = useState(0);
  const [emergency, setEmergency] = useState(false);
  const dateKey = todayKey(dateOffset);
  const { queueLen, remainingSlots } = computeQueueForDoctor(db, doc.id, dateKey);
  const est = estimateWaitMinutes(db, doc.id, queueLen, nowMinutes());

  return (
    <div className="max-w-3xl mx-auto px-4 pb-16">
      <button onClick={onBack} className="flex items-center gap-1 text-sm mt-4 mb-4" style={{ color: C.teal }}>
        <ArrowLeft size={15} /> Back to doctor list
      </button>

      <Card className="p-5 mb-4">
        <div className="flex items-start gap-4">
          <div style={{ background: C.mintSoft, color: C.teal }} className="w-16 h-16 rounded-full flex items-center justify-center font-semibold text-xl shrink-0">
            {doc.name.split(" ").slice(-1)[0][0]}
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ color: C.ink }}>{doc.name}</h2>
              <StarRow rating={doc.rating} />
            </div>
            <div style={{ color: C.sub }} className="text-sm mb-2">{doc.department} · {doc.experience} years experience</div>
            <p style={{ color: C.ink }} className="text-sm leading-relaxed">{doc.bio}</p>
          </div>
        </div>

        <div className="mt-4 pt-4 grid grid-cols-3 gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
          {[
            { label: "Current queue", value: `${queueLen}`, icon: Users },
            { label: "Slots left", value: `${remainingSlots}`, icon: Calendar },
            { label: "Avg consult time", value: `${doc.avgConsult}m`, icon: Clock },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="text-center">
              <Icon size={16} color={C.teal} className="mx-auto mb-1" />
              <div className="font-semibold" style={{ color: C.ink }}>{value}</div>
              <div className="text-xs" style={{ color: C.sub }}>{label}</div>
            </div>
          ))}
        </div>
        {dateOffset === 0 && <div className="text-xs mt-3 text-center" style={{ color: C.sub }}>Estimated wait if you were in the queue now: ~{est} min</div>}

        <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="text-xs font-semibold mb-2 flex items-center gap-1" style={{ color: C.sub }}>
            <Award size={13} /> ACHIEVEMENTS
          </div>
          <ul className="space-y-1">
            {doc.achievements.map((a, i) => (
              <li key={i} className="text-sm flex items-start gap-2" style={{ color: C.ink }}>
                <BadgeCheck size={14} color={C.mint} className="mt-0.5 shrink-0" /> {a}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card className="p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={16} color={C.teal} />
          <h3 className="font-semibold text-sm" style={{ color: C.ink }}>Preferred visit date</h3>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
          {[0, 1, 2, 3, 4, 5, 6].map((off) => (
            <button
              key={off}
              onClick={() => setDateOffset(off)}
              style={{
                background: dateOffset === off ? C.teal : C.bg,
                color: dateOffset === off ? "white" : C.ink,
                border: `1px solid ${dateOffset === off ? C.teal : C.line}`,
              }}
              className="rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0"
            >
              {off === 0 ? "Today" : dateLabel(todayKey(off))}
            </button>
          ))}
        </div>
        <CaseTypeToggle value={emergency} onChange={setEmergency} />
        <p className="text-xs mb-3" style={{ color: C.sub }}>
          Registering does not book a slot or take payment. The OP desk confirms your registration, receives the ₹{CONSULT_FEE} consultation fee and generates your token.
        </p>
        <PrimaryButton full onClick={() => onRegister(doc, dateKey, emergency)} icon={ClipboardList}>
          Register with {doc.name.split(" ").slice(-1)[0]}
        </PrimaryButton>
      </Card>

      {otherDoctors.length > 0 && (
        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-3" style={{ color: C.ink }}>Other {doc.department} doctors</h3>
          <div className="space-y-2">
            {otherDoctors.map((od) => {
              const { queueLen: qq } = computeQueueForDoctor(db, od.id, todayKey(0));
              const oest = estimateWaitMinutes(db, od.id, qq, nowMinutes());
              return (
                <div key={od.id} onClick={() => onSelectOther(od)} className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer hover:bg-gray-50" style={{ border: `1px solid ${C.line}` }}>
                  <div>
                    <div className="text-sm font-medium" style={{ color: C.ink }}>{od.name}</div>
                    <StarRow rating={od.rating} />
                  </div>
                  <div className="text-right text-xs" style={{ color: C.sub }}>{qq} waiting · ~{oest}m min wait</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function OnlineRegistrarsFlow({ session, db, commit }) {
  const [tab, setTab] = useState("register"); // 'register' | 'ai' | 'mine'
  const [dept, setDept] = useState(DEPARTMENTS[0]);
  const [activeDoc, setActiveDoc] = useState(null);
  const [confirmed, setConfirmed] = useState(null);
  const [notice, setNotice] = useState("");

  const deptDoctors = RAW_DOCTORS.filter((d) => d.department === dept);
  const myRegs = db.registrations.filter((r) => r.patientName === session.name && r.status === "pending");
  const myBookings = db.bookings.filter((b) => b.patientName === session.name && b.type === "online");

  function handleRegister(doc, dateKey, emergency) {
    const dup = db.registrations.some((r) => r.patientName === session.name && r.doctorId === doc.id && r.date === dateKey && r.status === "pending");
    if (dup) { setNotice(`You already have a pending registration with ${doc.name} for ${dateLabel(dateKey)}.`); return; }
    setNotice("");
    const regNo = db.nextReg;
    commit((prev) => withNotifs({
      ...prev,
      registrations: [...prev.registrations, {
        id: `rg-${prev.nextReg}-${Date.now()}`, regNo: prev.nextReg, patientName: session.name, doctorId: doc.id,
        date: dateKey, emergency: !!emergency, createdAt: Date.now(), status: "pending",
      }],
      nextReg: prev.nextReg + 1,
    }, [{ patientName: session.name, message: `Registration R-${prev.nextReg} received for ${doc.name} on ${dateLabel(dateKey)}.${emergency ? " Marked as an emergency case." : ""} Please visit the OP desk to confirm, pay and collect your token.` }]));
    setConfirmed({ regNo, doc, dateKey });
  }

  function cancelRegistration(id) {
    commit((prev) => ({ ...prev, registrations: prev.registrations.map((r) => (r.id === id && r.status === "pending" ? { ...r, status: "cancelled" } : r)) }));
  }

  const deptChips = (
    <div className="flex gap-2 overflow-x-auto py-3">
      {DEPARTMENTS.map((dp) => (
        <button
          key={dp}
          onClick={() => setDept(dp)}
          style={{
            background: dept === dp ? C.teal : C.panel, color: dept === dp ? "white" : C.ink,
            border: `1px solid ${dept === dp ? C.teal : C.line}`,
          }}
          className="rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap shrink-0"
        >
          {dp}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <div className="max-w-3xl mx-auto px-4">
        <div className="flex gap-3 mt-2 mb-2 overflow-x-auto">
          {[["register", "Register"], ["ai", "AI Recommendation"], ["mine", "My Registrations"]].map(([t, label]) => (
            <button
              key={t}
              onClick={() => { setTab(t); setActiveDoc(null); setNotice(""); }}
              style={{ color: tab === t ? C.teal : C.sub, borderColor: tab === t ? C.teal : "transparent" }}
              className="text-sm font-semibold pb-2 border-b-2 px-1 whitespace-nowrap"
            >
              {label}
            </button>
          ))}
        </div>
        {notice && <div className="text-xs rounded-lg px-3 py-2 mt-1" style={{ background: C.amberSoft, color: C.ink }}>{notice}</div>}
      </div>

      {tab === "register" && !activeDoc && (
        <div className="max-w-3xl mx-auto px-4 pb-16">
          <p className="text-xs mt-2" style={{ color: C.sub }}>Choose a doctor and register. The OP desk confirms your registration, takes payment and issues your token.</p>
          {deptChips}
          <div className="space-y-3">
            {deptDoctors.map((doc) => (
              <DoctorListItem key={doc.id} doc={doc} db={db} dateKey={todayKey(0)} onSelect={setActiveDoc} />
            ))}
          </div>
        </div>
      )}

      {tab === "ai" && !activeDoc && (
        <div className="max-w-3xl mx-auto px-4 pb-16">
          <p className="text-xs mt-2" style={{ color: C.sub }}>Pick a department and let QueueSense suggest the best doctor for you, then register with them.</p>
          {deptChips}
          <AiDoctorRecommendation deptDoctors={deptDoctors} db={db} dateKey={todayKey(0)} onPick={setActiveDoc} defaultOpen />
        </div>
      )}

      {(tab === "register" || tab === "ai") && activeDoc && (
        <RegisterDoctorPanel
          doc={activeDoc} db={db}
          onBack={() => setActiveDoc(null)}
          onRegister={handleRegister}
          otherDoctors={RAW_DOCTORS.filter((d) => d.department === activeDoc.department && d.id !== activeDoc.id)}
          onSelectOther={setActiveDoc}
        />
      )}

      {tab === "mine" && (
        <div className="max-w-3xl mx-auto px-4 pb-16 space-y-3 pt-2">
          {myRegs.length === 0 && myBookings.length === 0 && (
            <Card className="p-6 text-center text-sm" style={{ color: C.sub }}>No registrations yet — register with a doctor from the "Register" tab.</Card>
          )}
          {myRegs.map((r) => {
            const doc = RAW_DOCTORS.find((d) => d.id === r.doctorId);
            return (
              <Card key={r.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm" style={{ color: C.ink }}>{doc.name}</div>
                    <div className="text-xs" style={{ color: C.sub }}>{doc.department} · Reg. R-{r.regNo} · {dateLabel(r.date)}{r.emergency ? " · Emergency" : ""}</div>
                  </div>
                  <Badge tone="amber">Awaiting OP desk</Badge>
                </div>
                <div className="mt-3 pt-3 flex items-center justify-between" style={{ borderTop: `1px solid ${C.line}` }}>
                  <span className="text-xs" style={{ color: C.sub }}>Visit the OP desk to confirm, pay and get your token.</span>
                  <button onClick={() => cancelRegistration(r.id)} className="text-xs font-medium" style={{ color: C.red }}>Cancel</button>
                </div>
              </Card>
            );
          })}
          {myBookings.map((b) => {
            const doc = RAW_DOCTORS.find((d) => d.id === b.doctorId);
            return (
              <Card key={b.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm" style={{ color: C.ink }}>{doc.name}</div>
                    <div className="text-xs" style={{ color: C.sub }}>{doc.department} · Token #{b.token} · {dateLabel(b.date)}, {minToLabel(b.slotMin)}</div>
                  </div>
                  <Badge tone={b.status === "done" ? "mint" : b.status === "not_available" ? "red" : "amber"}>
                    {b.status === "done" ? "Completed" : b.status === "not_available" ? "Not available" : "Waiting"}
                  </Badge>
                </div>
                <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${C.line}` }}>
                  <LiveCountdown doc={doc} booking={b} db={db} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {confirmed && (
        <RegistrationConfirmed
          regNo={confirmed.regNo} doc={confirmed.doc} dateKey={confirmed.dateKey}
          onDone={() => { setConfirmed(null); setActiveDoc(null); setTab("mine"); }}
        />
      )}
    </div>
  );
}

// Walk-in patients: no booking here — the OP desk books them and issues the token.
// They can only follow their waiting time, doctor delay and notifications.
function WalkInStatusView({ session, db }) {
  const [tokenQuery, setTokenQuery] = useState("");
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 15000); return () => clearInterval(id); }, []);
  const dateKey = todayKey(0);
  const myTokens = db.bookings.filter((b) => b.patientName === session.name && b.date === dateKey);
  const lookup = tokenQuery ? lookupToken(db, tokenQuery, dateKey) : null;

  return (
    <div className="max-w-3xl mx-auto px-4 pb-16 pt-2 space-y-3">
      <p className="text-xs" style={{ color: C.sub }}>
        Walk-in visits are booked at the OP desk, which takes payment and gives you a token. Here you can follow your waiting time, doctor delays and updates — notifications arrive in the Notifications tab.
      </p>

      <Card className="p-4">
        <div className="text-xs font-semibold mb-2" style={{ color: C.sub }}>CHECK BY TOKEN NUMBER</div>
        <input
          value={tokenQuery} onChange={(e) => setTokenQuery(e.target.value)} inputMode="numeric"
          placeholder="Enter your token number"
          className="w-full rounded-lg px-3 py-2.5 text-sm outline-none"
          style={{ border: `1px solid ${C.line}` }}
        />
        {lookup && <div className="mt-3"><TokenStatusDetails lookup={lookup} /></div>}
      </Card>

      {myTokens.length === 0 && !tokenQuery && (
        <Card className="p-6 text-center text-sm" style={{ color: C.sub }}>No token under your name today. Visit the OP desk to get booked, then check your status here.</Card>
      )}
      {myTokens.map((b) => (
        <Card key={b.id} className="p-4">
          <div className="text-xs font-semibold mb-2" style={{ color: C.sub }}>YOUR TOKEN TODAY</div>
          <TokenStatusDetails lookup={lookupToken(db, String(b.token), dateKey)} />
        </Card>
      ))}
    </div>
  );
}

function timeUntilLabel(ts) {
  if (!ts) return "";
  const diffMin = Math.round((ts - Date.now()) / 60000);
  if (diffMin <= 0) return "any moment now";
  return `~${diffMin} min (by ${minToLabel(new Date(ts).getHours() * 60 + new Date(ts).getMinutes())})`;
}

function JourneyStageTracker({ booking, db, onAdvance }) {
  const stages = booking.journey || defaultJourney();
  const consultStageIdx = 1;
  const aheadNow = booking.status === "waiting" ? aheadCountFor(db, booking, booking.date) : 0;
  const consultMins = booking.status === "waiting" ? estimateWaitMinutes(db, booking.doctorId, aheadNow, nowMinutes()) : null;

  return (
    <div className="space-y-0">
      {stages.map((s, i) => {
        const isConsult = i === consultStageIdx;
        const isLast = i === stages.length - 1;
        return (
          <div key={s.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                style={{
                  background: s.status === "done" ? C.mint : s.status === "current" ? C.teal : C.line,
                  color: s.status === "pending" ? C.sub : "white",
                }}
                className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
              >
                {s.status === "done" ? "✓" : i + 1}
              </div>
              {!isLast && <div style={{ background: s.status === "done" ? C.mint : C.line, width: 2 }} className="flex-1 min-h-[22px]" />}
            </div>
            <div className="pb-4 flex-1">
              <div className="text-sm font-medium" style={{ color: s.status === "pending" ? C.sub : C.ink }}>{s.name}</div>
              {s.status === "current" && isConsult && (
                <div className="text-xs mt-0.5" style={{ color: C.teal }}>
                  {aheadNow === 0 ? "You're next — please be ready" : `~${consultMins} min · ${aheadNow} ahead of you`} · {s.location}
                </div>
              )}
              {s.status === "current" && !isConsult && (
                <div className="text-xs mt-0.5" style={{ color: C.teal }}>
                  Report to {s.location} — expected {timeUntilLabel(s.predictedAt)}
                </div>
              )}
              {s.status === "done" && <div className="text-xs mt-0.5" style={{ color: C.sub }}>Completed</div>}
              {s.status === "current" && !isConsult && onAdvance && (
                <button onClick={() => onAdvance(booking.id)} className="text-xs font-medium mt-1.5" style={{ color: C.teal, textDecoration: "underline" }}>
                  Mark "{s.name}" complete
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PatientJourneyView({ session, db, commit }) {
  const myBookings = db.bookings
    .filter((b) => b.patientName === session.name)
    .slice()
    .sort((a, b) => b.bookedAt - a.bookedAt);

  function advance(bookingId) {
    let patientName = null, notifyText = null;
    commit((prev) => ({
      ...prev,
      bookings: prev.bookings.map((b) => {
        if (b.id !== bookingId) return b;
        patientName = b.patientName;
        const { journey, notifyText: nt } = advanceJourney(b.journey || defaultJourney());
        notifyText = nt;
        return { ...b, journey };
      }),
    }));
    if (patientName && notifyText) pushNotification(commit, patientName, bookingId, notifyText);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 pb-16 pt-2 space-y-3">
      <p className="text-xs mb-1" style={{ color: C.sub }}>
        Tracks every stage of your visit — doctor consultation, lab testing, reports, pharmacy and billing — with where to go next and when. Notifications are sent automatically as each stage completes.
      </p>
      {myBookings.length === 0 && (
        <Card className="p-6 text-center text-sm" style={{ color: C.sub }}>No visits yet — book an appointment to see your treatment journey here.</Card>
      )}
      {myBookings.map((b) => {
        const doc = RAW_DOCTORS.find((d) => d.id === b.doctorId);
        const stageDone = (b.journey || []).filter((s) => s.status === "done").length;
        const stageTotal = (b.journey || []).length;
        return (
          <Card key={b.id} className="p-4">
            <div className="flex items-center justify-between mb-1">
              <div>
                <div className="font-semibold text-sm" style={{ color: C.ink }}>{doc.name}</div>
                <div className="text-xs" style={{ color: C.sub }}>
                  {doc.department} · Token #{b.token} · {dateLabel(b.date)} · {b.type === "online" ? "Online registrar" : "Walk-in"}
                  {b.emergency ? " · Emergency" : ""}
                </div>
              </div>
              <Badge tone="mint">{stageDone}/{stageTotal} stages</Badge>
            </div>
            <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${C.line}` }}>
              <JourneyStageTracker booking={b} db={db} onAdvance={b.status === "done" ? advance : null} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function PatientNotifications({ session, db, commit }) {
  const mine = db.notifications
    .filter((n) => n.patientName === session.name)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  const unread = mine.filter((n) => !n.read).length;

  function markAllRead() {
    commit((prev) => ({
      ...prev,
      notifications: prev.notifications.map((n) => (n.patientName === session.name ? { ...n, read: true } : n)),
    }));
  }

  return (
    <div className="max-w-3xl mx-auto px-4 pb-16 pt-2 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs" style={{ color: C.sub }}>Updates about your bookings, queue position and treatment journey.</p>
        {unread > 0 && <button onClick={markAllRead} className="text-xs font-medium" style={{ color: C.teal }}>Mark all read</button>}
      </div>
      {mine.length === 0 && <Card className="p-6 text-center text-sm" style={{ color: C.sub }}>No notifications yet.</Card>}
      {mine.map((n) => (
        <Card key={n.id} className="p-3.5" style={{ background: n.read ? C.panel : C.mintSoft, borderColor: n.read ? C.line : C.mint }}>
          <div className="text-sm" style={{ color: C.ink }}>{n.message}</div>
          <div className="text-[11px] mt-1" style={{ color: C.sub }}>{timeAgo(n.createdAt)}</div>
        </Card>
      ))}
    </div>
  );
}

function PatientApp({ session, db, commit, onLogout }) {
  const [mainTab, setMainTab] = useState("registrars"); // 'registrars' | 'walkin' | 'journey' | 'notifications'
  const unreadCount = db.notifications.filter((n) => n.patientName === session.name && !n.read).length;
  const labels = { registrars: "Online Registrars", walkin: "Walk-in", journey: "Treatment Journey", notifications: "Notifications" };

  return (
    <div style={{ background: C.bg }} className="min-h-full">
      <TopBar role="Patient" name={session.name} onLogout={onLogout} />

      <div className="max-w-3xl mx-auto px-4 pt-3">
        <div className="flex gap-3 mb-1 overflow-x-auto">
          {Object.keys(labels).map((t) => (
            <button
              key={t}
              onClick={() => setMainTab(t)}
              style={{ color: mainTab === t ? C.teal : C.sub, borderColor: mainTab === t ? C.teal : "transparent" }}
              className="text-sm font-semibold pb-2 border-b-2 px-1 flex items-center gap-1.5 whitespace-nowrap"
            >
              {labels[t]}
              {t === "notifications" && unreadCount > 0 && <Badge tone="red">{unreadCount}</Badge>}
            </button>
          ))}
        </div>
      </div>

      {mainTab === "registrars" && <OnlineRegistrarsFlow session={session} db={db} commit={commit} />}
      {mainTab === "walkin" && <WalkInStatusView session={session} db={db} />}
      {mainTab === "journey" && <PatientJourneyView session={session} db={db} commit={commit} />}
      {mainTab === "notifications" && <PatientNotifications session={session} db={db} commit={commit} />}
    </div>
  );
}

/* =========================================================================
   DOCTOR APP
   ========================================================================= */
function DoctorApp({ session, db, commit, onLogout }) {
  const [tab, setTab] = useState("profile");
  const doc = RAW_DOCTORS.find((d) => d.id === session.doctorId);
  const dateKey = todayKey(0);
  const { waiting, treated, remainingSlots, totalSlots } = computeQueueForDoctor(db, doc.id, dateKey);
  const roomState = db.doctors[doc.id] || {};
  const inRoomBooking = roomState.roomOccupiedBy ? db.bookings.find((b) => b.id === roomState.roomOccupiedBy) : null;

  // Same actions the doctor-room hardware sends: door IR entry/exit (the room's IR sensors
  // measure the real consultation duration, which feeds every waiting patient's prediction).
  function callIntoRoom(bookingId) {
    commit((prev) => applyDoctorAction(prev, doc.id, "ENTRY", { bookingId }));
  }
  function completeConsultation() {
    commit((prev) => applyDoctorAction(prev, doc.id, "EXIT"));
  }

  return (
    <div style={{ background: C.bg }} className="min-h-full">
      <TopBar role="Doctor" name={doc.name} onLogout={onLogout} />
      <div className="max-w-3xl mx-auto px-4">
        <div className="flex gap-2 mt-4 mb-4">
          {["profile", "queue"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ color: tab === t ? C.teal : C.sub, borderColor: tab === t ? C.teal : "transparent" }}
              className="text-sm font-semibold pb-2 border-b-2 px-1"
            >
              {t === "profile" ? "My Profile" : "Today's Queue"}
            </button>
          ))}
        </div>

        {tab === "profile" && (
          <Card className="p-5 mb-16">
            <div className="flex items-start gap-4">
              <div style={{ background: C.mintSoft, color: C.teal }} className="w-16 h-16 rounded-full flex items-center justify-center font-semibold text-xl shrink-0">
                {doc.name.split(" ").slice(-1)[0][0]}
              </div>
              <div>
                <h2 className="text-lg font-semibold" style={{ color: C.ink }}>{doc.name}</h2>
                <div style={{ color: C.sub }} className="text-sm mb-1">{doc.department} · {doc.experience} years experience</div>
                <StarRow rating={doc.rating} />
              </div>
            </div>
            <p className="text-sm mt-4" style={{ color: C.ink }}>{doc.bio}</p>
            <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
              <div className="text-xs font-semibold mb-2" style={{ color: C.sub }}>ACHIEVEMENTS</div>
              <ul className="space-y-1">
                {doc.achievements.map((a, i) => (
                  <li key={i} className="text-sm flex items-start gap-2" style={{ color: C.ink }}>
                    <Award size={14} color={C.mint} className="mt-0.5 shrink-0" /> {a}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-4 pt-4 text-sm" style={{ borderTop: `1px solid ${C.line}`, color: C.sub }}>
              Working hours: {minToLabel(WORK_START_MIN)} – {minToLabel(WORK_END_MIN)} · {roomState.recentDurations?.length >= 2
                ? `Sensed avg consult time today: ${effectiveAvgConsult(db, doc.id)} min (from ${roomState.recentDurations.length} room-sensed consultations)`
                : `Avg consult time ${doc.avgConsult} min (static — will switch to live-sensed average after 2 room-sensed consultations today)`}
            </div>
          </Card>
        )}

        {tab === "queue" && (
          <div className="pb-16 space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Waiting now", value: waiting.length, icon: Users },
                { label: "Treated today", value: treated.length, icon: CheckCircle2 },
                { label: "Slots left", value: remainingSlots, icon: Calendar },
              ].map(({ label, value, icon: Icon }) => (
                <Card key={label} className="p-3 text-center">
                  <Icon size={16} color={C.teal} className="mx-auto mb-1" />
                  <div className="text-xl font-bold" style={{ color: C.ink }}>{value}</div>
                  <div className="text-xs" style={{ color: C.sub }}>{label}</div>
                </Card>
              ))}
            </div>

            {roomState.absence?.active && (
              <Card className="p-4" style={{ background: C.amberSoft, borderColor: C.amber }}>
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle size={15} color={C.amber} />
                  <div className="text-sm font-semibold" style={{ color: C.ink }}>Absence announced to waiting patients</div>
                </div>
                <div className="text-sm" style={{ color: C.ink }}>
                  Reason: {roomState.absence.reason} · +{roomState.absence.delayMinutes} min added to every waiting patient's prediction
                </div>
              </Card>
            )}

            {inRoomBooking && (
              <Card className="p-4" style={{ background: C.mintSoft, borderColor: C.mint }}>
                <div className="flex items-center gap-2 mb-1">
                  <RadioTower size={15} color={C.teal} />
                  <div className="text-sm font-semibold" style={{ color: C.ink }}>In consultation now</div>
                </div>
                <div className="text-sm mb-3" style={{ color: C.ink }}>
                  #{inRoomBooking.token} · {inRoomBooking.patientName || "Walk-in patient"} — room entry sensed {timeAgo(roomState.roomEnteredAt)}
                </div>
                <GhostButton onClick={() => completeConsultation()} icon={CheckCircle2}>
                  Patient left room — complete consultation
                </GhostButton>
              </Card>
            )}

            <Card className="p-4">
              <div className="text-xs font-semibold mb-3" style={{ color: C.sub }}>
                UPCOMING PATIENTS {roomState.recentDurations?.length >= 2 && `· sensed avg ${effectiveAvgConsult(db, doc.id)}m (last ${roomState.recentDurations.length})`}
              </div>
              {waiting.length === 0 && <div className="text-sm py-4 text-center" style={{ color: C.sub }}>No patients currently waiting.</div>}
              <div className="space-y-2">
                {waiting.map((b, i) => (
                  <div key={b.id} className="flex items-center justify-between px-3 py-2.5 rounded-lg" style={{ border: `1px solid ${b.emergency ? C.red : C.line}`, background: i === 0 ? C.mintSoft : "transparent" }}>
                    <div className="flex items-center gap-3">
                      <div style={{ background: b.emergency ? C.red : C.teal, color: "white" }} className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0">#{b.token}</div>
                      <div>
                        <div className="text-sm font-medium flex items-center gap-1.5" style={{ color: C.ink }}>
                          {b.patientName || "Walk-in patient"}
                          {b.emergency && <Badge tone="red">Emergency</Badge>}
                        </div>
                        <div className="text-xs" style={{ color: C.sub }}>{minToLabel(b.slotMin)} · {b.type === "online" ? "Online registrar" : "Walk-in"}{roomState.calling?.bookingId === b.id ? " · Called" : ""}</div>
                      </div>
                    </div>
                    {i === 0 && !inRoomBooking && <GhostButton onClick={() => callIntoRoom(b.id)} icon={ChevronRight}>Call in — room entry</GhostButton>}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   STAFF / MANAGEMENT APP — analytics, suggestions, efficiency
   ========================================================================= */
function OpDisplayGrid({ db }) {
  const dateKey = todayKey(0);
  const stats = RAW_DOCTORS.map((d) => computeDisplayStats(db, d.id, dateKey));

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <RadioTower size={16} color={C.teal} />
        <div className="text-sm font-semibold" style={{ color: C.ink }}>OP / LED Display — live, per doctor</div>
      </div>
      <p className="text-xs mb-4" style={{ color: C.sub }}>
        Mirrors exactly what patients see on the OP desk display, fed continuously by the ESP32 + dual IR sensor hardware and the backend database — refreshes automatically as bookings and consultations change.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {stats.map(({ doc, waiting, cong, estimated, predicted, remainingSlots }) => (
          <Card key={doc.id} className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold" style={{ color: C.ink }}>{doc.name}</div>
                <div className="text-xs" style={{ color: C.sub }}>{doc.department}</div>
              </div>
              <Badge tone={cong.tone}>{cong.label}</Badge>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-lg font-bold" style={{ color: C.ink }}>{waiting.length}</div>
                <div className="text-[10px]" style={{ color: C.sub }}>In queue</div>
              </div>
              <div>
                <div className="text-lg font-bold" style={{ color: C.ink }}>{estimated}m</div>
                <div className="text-[10px]" style={{ color: C.sub }}>Estimated</div>
              </div>
              <div>
                <div className="text-lg font-bold" style={{ color: C.mint }}>{predicted}m</div>
                <div className="text-[10px]" style={{ color: C.sub }}>Predicted</div>
              </div>
              <div>
                <div className="text-lg font-bold" style={{ color: C.ink }}>{remainingSlots}</div>
                <div className="text-[10px]" style={{ color: C.sub }}>Slots left</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return "Never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

function IotDevicesPanel({ db, commit }) {
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 3000); return () => clearInterval(id); }, []);

  const device = db.devices[DEVICE_ID];
  const online = isDeviceOnline(device);

  function sendHeartbeat() {
    commit((prev) => ({
      ...prev,
      devices: {
        ...prev.devices,
        [DEVICE_ID]: { ...prev.devices[DEVICE_ID], lastHeartbeat: Date.now(), irEntry: "ACTIVE", irExit: "ACTIVE", oled: "CONNECTED", buzzer: "READY" },
      },
    }));
  }

  function sendEvent(kind) {
    commit((prev) => {
      const d = prev.devices[DEVICE_ID];
      const nextCount = kind === "ENTRY" ? d.hwQueueCount + 1 : Math.max(0, d.hwQueueCount - 1);
      return {
        ...prev,
        devices: {
          ...prev.devices,
          [DEVICE_ID]: { ...d, hwQueueCount: nextCount, lastHeartbeat: Date.now(), lastEvent: { type: kind, at: Date.now() } },
        },
      };
    });
  }

  const chips = [
    { label: "IR Entry", value: device.irEntry },
    { label: "IR Exit", value: device.irExit },
    { label: "OLED", value: device.oled },
    { label: "Buzzer", value: device.buzzer },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <RadioTower size={16} color={C.teal} />
        <div className="text-sm font-semibold" style={{ color: C.ink }}>QueueSense IoT Devices</div>
      </div>
      <p className="text-xs mb-4" style={{ color: C.sub }}>
        Real device registry — populated by actual HTTP POSTs from the ESP32 (device heartbeat + IR entry/exit events) once it's flashed and connected to the backend. It currently shows "Offline" because no physical hardware is wired in yet; the buttons below simulate exactly the payloads the firmware sends, for testing the pipeline end-to-end without hardware attached.
      </p>

      <Card className="p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm font-semibold" style={{ color: C.ink }}>{DEVICE_ID}</div>
            <div className="text-xs" style={{ color: C.sub }}>{device.location}</div>
          </div>
          <Badge tone={online ? "mint" : "red"}>{online ? "ONLINE" : "OFFLINE"}</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div>
            <div className="text-xs" style={{ color: C.sub }}>Last heartbeat</div>
            <div className="text-sm font-medium" style={{ color: C.ink }}>{timeAgo(device.lastHeartbeat)}</div>
          </div>
          <div>
            <div className="text-xs" style={{ color: C.sub }}>Last event</div>
            <div className="text-sm font-medium" style={{ color: C.ink }}>{device.lastEvent ? `${device.lastEvent.type} · ${timeAgo(device.lastEvent.at)}` : "None yet"}</div>
          </div>
          <div>
            <div className="text-xs" style={{ color: C.sub }}>Hardware queue count</div>
            <div className="text-sm font-medium" style={{ color: C.ink }}>{device.hwQueueCount}</div>
          </div>
          <div>
            <div className="text-xs" style={{ color: C.sub }}>Device ↔ booking count match</div>
            <div className="text-sm font-medium" style={{ color: C.ink }}>
              {device.hwQueueCount === RAW_DOCTORS.reduce((s, d) => s + computeQueueForDoctor(db, d.id, todayKey(0)).queueLen, 0) ? "Reconciled" : "Diverging"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {chips.map((c) => (
            <span key={c.label} className="text-xs px-2 py-1 rounded-md" style={{ background: C.bg, color: C.sub, border: `1px solid ${C.line}` }}>
              {c.label}: <strong style={{ color: C.ink }}>{c.value}</strong>
            </span>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={sendHeartbeat} icon={RadioTower}>Simulate heartbeat</GhostButton>
          <GhostButton onClick={() => sendEvent("ENTRY")} icon={Plus}>Simulate IR ENTRY event</GhostButton>
          <GhostButton onClick={() => sendEvent("EXIT")} icon={ArrowLeft}>Simulate IR EXIT event</GhostButton>
        </div>
        <p className="text-[11px] mt-3" style={{ color: C.sub }}>
          These three actions correspond exactly to the JSON payloads real firmware POSTs to <code>/api/iot/heartbeat</code> and <code>/api/iot/event</code> — see the provided ESP32 firmware and backend server files.
        </p>
      </Card>
      <DoctorRoomSimulator db={db} commit={commit} />
    </div>
  );
}

const ABSENCE_REASONS = ["Another case / emergency elsewhere", "In an operation", "Personal reasons", "Other"];

function AbsenceAnnouncer({ db, commit }) {
  const [doctorId, setDoctorId] = useState(RAW_DOCTORS[0].id);
  const [reason, setReason] = useState(ABSENCE_REASONS[0]);
  const [delay, setDelay] = useState(20);
  const dateKey = todayKey(0);
  const doc = RAW_DOCTORS.find((d) => d.id === doctorId);
  const active = db.doctors[doctorId]?.absence?.active;

  function announce() {
    const { waiting } = computeQueueForDoctor(db, doctorId, dateKey);
    commit((prev) => ({
      ...prev,
      doctors: { ...prev.doctors, [doctorId]: { ...prev.doctors[doctorId], absence: { active: true, reason, delayMinutes: Number(delay) || 0, announcedAt: Date.now() } } },
    }));
    waiting.forEach((b, i) => {
      if (!b.patientName) return; // hardware-anonymous walk-ins have no one to notify
      const avgConsult = effectiveAvgConsult(db, doctorId);
      const baseWait = Math.round(i * avgConsult * (isPeak(nowMinutes()) ? 1.15 : 1));
      const newWait = baseWait + (Number(delay) || 0);
      pushNotification(commit, b.patientName, b.id,
        `${doc.name} is currently unavailable (${reason}). Your updated estimated wait is now ~${newWait} min (previously ~${baseWait} min).`);
    });
  }

  function clearAbsence() {
    const { waiting } = computeQueueForDoctor(db, doctorId, dateKey);
    commit((prev) => ({
      ...prev,
      doctors: { ...prev.doctors, [doctorId]: { ...prev.doctors[doctorId], absence: null } },
    }));
    waiting.forEach((b) => {
      if (!b.patientName) return;
      pushNotification(commit, b.patientName, b.id, `${doc.name} is back — your queue is resuming normally.`);
    });
  }

  return (
    <Card className="p-4">
      <div className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: C.ink }}>
        <AlertTriangle size={15} color={C.amber} /> Announce doctor absence / delay
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-xs font-medium" style={{ color: C.sub }}>Doctor</label>
          <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
            {RAW_DOCTORS.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.department}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: C.sub }}>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
            {ABSENCE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <div className="mb-3">
        <label className="text-xs font-medium" style={{ color: C.sub }}>Added delay (minutes) — applied on top of each waiting patient's current predicted wait</label>
        <input type="number" min="0" value={delay} onChange={(e) => setDelay(e.target.value)} className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }} />
      </div>
      {active ? (
        <div>
          <Badge tone="amber">Absence currently active for {doc.name}</Badge>
          <div className="mt-2"><GhostButton onClick={clearAbsence} icon={CheckCircle2}>Doctor has returned — clear & notify</GhostButton></div>
        </div>
      ) : (
        <PrimaryButton full onClick={announce} icon={AlertTriangle}>Announce to all waiting patients</PrimaryButton>
      )}
    </Card>
  );
}

function TokenSlip({ slip, onDone }) {
  const doc = RAW_DOCTORS.find((d) => d.id === slip.doctorId);
  return (
    <Card className="p-5 text-center" style={{ borderColor: C.mint }}>
      <CheckCircle2 size={34} color={C.mint} className="mx-auto mb-2" />
      <div className="font-semibold" style={{ color: C.ink }}>Payment received · Token generated</div>
      <div className="text-xs mb-3" style={{ color: C.sub }}>
        {slip.patientName} · {doc.name} · {slip.mode === "online_registrar" ? "Online registrar" : "Walk-in"} · ₹{CONSULT_FEE} ({slip.method})
      </div>
      <div style={{ background: C.mintSoft }} className="rounded-lg py-3 mb-3">
        <div className="text-xs" style={{ color: C.teal }}>Token number{slip.emergency ? " · EMERGENCY" : ""}</div>
        <div className="text-3xl font-bold" style={{ color: C.teal }}>#{slip.token}</div>
      </div>
      <div className="flex justify-center mb-2"><QRImage text={statusPageUrl(slip.token)} size={110} /></div>
      <p className="text-[11px] mb-3" style={{ color: C.sub }}>Scan to see this token's waiting time on a phone.</p>
      <PrimaryButton full onClick={onDone} icon={Plus}>Book next patient</PrimaryButton>
    </Card>
  );
}

// The OP desk is the ONLY place where bookings are made, payment is received and tokens are generated.
function OpDeskBooking({ db, commit }) {
  const [mode, setMode] = useState("online_registrar"); // 'online_registrar' | 'walk_in'
  const [search, setSearch] = useState("");
  const [regId, setRegId] = useState(null);
  const [verified, setVerified] = useState(false);
  const [name, setName] = useState("");
  const [dept, setDept] = useState(DEPARTMENTS[0]);
  const [doctorId, setDoctorId] = useState(RAW_DOCTORS.find((d) => d.department === DEPARTMENTS[0]).id);
  const [emergency, setEmergency] = useState(false);
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [slip, setSlip] = useState(null);
  const dateKey = todayKey(0);

  const pending = db.registrations
    .filter((r) => r.status === "pending")
    .filter((r) => !search.trim() || r.patientName.toLowerCase().includes(search.trim().toLowerCase()) || `r-${r.regNo}` === search.trim().toLowerCase())
    .sort((a, b) => a.createdAt - b.createdAt);
  const reg = pending.find((r) => r.id === regId) || null;
  const deptDoctors = RAW_DOCTORS.filter((d) => d.department === dept);

  const ready = mode === "online_registrar" ? !!reg && verified : name.trim().length > 1;

  const todaysDeskBookings = db.bookings
    .filter((b) => b.createdBy === "staff" && b.date === dateKey)
    .slice().reverse().slice(0, 8);

  function pickReg(r) { setRegId(r.id); setVerified(false); setEmergency(r.emergency); }

  function issueToken() {
    if (!ready) return;
    const isReg = mode === "online_registrar";
    const finalDoctorId = isReg ? reg.doctorId : doctorId;
    const finalName = isReg ? reg.patientName : name.trim();
    const finalDate = isReg ? reg.date : dateKey;
    const doc = RAW_DOCTORS.find((d) => d.id === finalDoctorId);
    const token = db.nextToken;

    commit((prev) => {
      const tk = prev.nextToken;
      const booking = {
        id: `bk-${tk}-${Date.now()}`, doctorId: finalDoctorId, patientName: finalName,
        type: isReg ? "online" : "offline", bookingMode: mode,
        date: finalDate, slotMin: isReg ? assignSlot(prev, finalDoctorId, finalDate) : nowMinutes(),
        token: tk, status: "waiting", bookedAt: Date.now(), emergency, journey: defaultJourney(), createdBy: "staff",
        paid: true, payment: { method, amount: CONSULT_FEE, at: Date.now() }, registrationId: isReg ? reg.id : null,
      };
      const next = {
        ...prev,
        bookings: [...prev.bookings, booking],
        nextToken: tk + 1,
        registrations: isReg ? prev.registrations.map((r) => (r.id === reg.id ? { ...r, status: "booked", bookingId: booking.id, token: tk } : r)) : prev.registrations,
      };
      return withNotifs(next, [{
        patientName: finalName, bookingId: booking.id,
        message: `OP desk ${isReg ? "confirmed your registration and booked" : "booked your walk-in appointment with"} ${doc.name}${isReg ? "" : ""} (${dateLabel(finalDate)}). ₹${CONSULT_FEE} received (${method}). Your token is #${tk}.${emergency ? " Marked as an emergency case." : ""}`,
      }]);
    });

    setSlip({ token, doctorId: finalDoctorId, patientName: finalName, mode, method, emergency });
    setRegId(null); setVerified(false); setName(""); setEmergency(false); setSearch("");
  }

  if (slip) return <TokenSlip slip={slip} onDone={() => setSlip(null)} />;

  return (
    <Card className="p-4">
      <div className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: C.ink }}>
        <ClipboardList size={15} color={C.teal} /> Book patient · receive payment · generate token
      </div>

      <div className="text-xs font-semibold mb-1.5" style={{ color: C.sub }}>PATIENT BOOKING MODE</div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {[["online_registrar", "Online registrar"], ["walk_in", "Walk-in"]].map(([k, label]) => (
          <button
            key={k} type="button" onClick={() => setMode(k)}
            style={{ background: mode === k ? C.mintSoft : C.bg, color: mode === k ? C.teal : C.sub, border: `1px solid ${mode === k ? C.mint : C.line}` }}
            className="rounded-lg py-2.5 text-sm font-medium"
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "online_registrar" && (
        <div className="mb-3">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by patient name or R-number" className="w-full rounded-lg px-3 py-2.5 text-sm outline-none mb-2" style={{ border: `1px solid ${C.line}` }} />
          {pending.length === 0 && <div className="text-xs py-3 text-center" style={{ color: C.sub }}>No pending online registrations.</div>}
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {pending.map((r) => {
              const d = RAW_DOCTORS.find((x) => x.id === r.doctorId);
              const sel = r.id === regId;
              return (
                <div key={r.id} onClick={() => pickReg(r)} className="px-3 py-2 rounded-lg cursor-pointer text-sm flex items-center justify-between" style={{ border: `1px solid ${sel ? C.mint : C.line}`, background: sel ? C.mintSoft : "transparent" }}>
                  <div>
                    <div className="font-medium" style={{ color: C.ink }}>{r.patientName} <span className="text-xs font-normal" style={{ color: C.sub }}>· R-{r.regNo}</span></div>
                    <div className="text-xs" style={{ color: C.sub }}>{d.name} · {dateLabel(r.date)}{r.emergency ? " · Emergency" : ""}</div>
                  </div>
                  {sel && <CheckCircle2 size={16} color={C.mint} />}
                </div>
              );
            })}
          </div>
          {reg && (
            <label className="flex items-start gap-2 mt-3 text-sm cursor-pointer" style={{ color: C.ink }}>
              <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} className="mt-1" />
              <span>Confirmed — {reg.patientName} has registered online (R-{reg.regNo}).</span>
            </label>
          )}
        </div>
      )}

      {mode === "walk_in" && (
        <>
          <div className="mb-3">
            <label className="text-xs font-medium" style={{ color: C.sub }}>Patient full name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="As the patient will log in with" className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }} />
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs font-medium" style={{ color: C.sub }}>Department</label>
              <select value={dept} onChange={(e) => { setDept(e.target.value); setDoctorId(RAW_DOCTORS.find((d) => d.department === e.target.value).id); }} className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
                {DEPARTMENTS.map((dp) => <option key={dp} value={dp}>{dp}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium" style={{ color: C.sub }}>Doctor</label>
              <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="w-full mt-1 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
                {deptDoctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </div>
        </>
      )}

      <CaseTypeToggle value={emergency} onChange={setEmergency} />

      <div className="text-xs font-semibold mb-1.5" style={{ color: C.sub }}>PAYMENT</div>
      <div style={{ background: C.bg }} className="rounded-lg p-3 mb-2 flex justify-between text-sm">
        <span style={{ color: C.sub }}>Consultation fee</span>
        <span className="font-semibold" style={{ color: C.ink }}>₹{CONSULT_FEE}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-4">
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m} type="button" onClick={() => setMethod(m)}
            style={{ background: method === m ? C.mintSoft : C.bg, color: method === m ? C.teal : C.sub, border: `1px solid ${method === m ? C.mint : C.line}` }}
            className="rounded-lg py-2 text-sm font-medium"
          >
            {m}
          </button>
        ))}
      </div>

      <PrimaryButton full onClick={issueToken} disabled={!ready} icon={CreditCard}>Payment received — generate token</PrimaryButton>
      <p className="text-[11px] text-center mt-2" style={{ color: C.sub }}>Simulated payment for demo purposes — no real transaction occurs.</p>

      {todaysDeskBookings.length > 0 && (
        <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="text-xs font-semibold mb-2" style={{ color: C.sub }}>RECENT OP DESK BOOKINGS TODAY</div>
          <div className="space-y-1.5">
            {todaysDeskBookings.map((b) => {
              const bd = RAW_DOCTORS.find((d) => d.id === b.doctorId);
              const ahead = aheadCountFor(db, b, dateKey);
              return (
                <div key={b.id} className="text-xs flex items-center justify-between px-2.5 py-1.5 rounded-lg" style={{ background: C.bg }}>
                  <span style={{ color: C.ink }}>#{b.token} {b.patientName} → {bd.name}{b.emergency ? " · Emergency" : ""}</span>
                  <span style={{ color: C.sub }}>{b.status === "done" ? "Completed" : b.status === "not_available" ? "Not available" : `${ahead} ahead`}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

// Patients called by the doctor but not present are marked "Not available" here; the queue moves on.
function OpDeskQueueControl({ db, commit }) {
  const [doctorId, setDoctorId] = useState(RAW_DOCTORS[0].id);
  const dateKey = todayKey(0);
  const ds = db.doctors[doctorId] || {};
  const { waiting } = computeQueueForDoctor(db, doctorId, dateKey);
  const skipped = db.bookings.filter((b) => b.doctorId === doctorId && b.date === dateKey && b.status === "not_available");
  const headId = waiting.find((b) => b.id !== ds.roomOccupiedBy)?.id;

  return (
    <Card className="p-4">
      <div className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: C.ink }}>
        <Users size={15} color={C.teal} /> Doctor's queue — mark patients not available
      </div>
      <p className="text-xs mb-3" style={{ color: C.sub }}>If a called patient isn't there, mark them "Not available" — the queue moves straight on to the next patient.</p>
      <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="w-full mb-3 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
        {RAW_DOCTORS.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.department}</option>)}
      </select>

      {ds.absence?.active && <div className="mb-3"><Badge tone="amber">Doctor on break — {ds.absence.reason}</Badge></div>}
      {waiting.length === 0 && <div className="text-sm py-3 text-center" style={{ color: C.sub }}>No patients currently waiting.</div>}
      <div className="space-y-2">
        {waiting.map((b) => {
          const inRoom = ds.roomOccupiedBy === b.id;
          const calling = ds.calling?.bookingId === b.id;
          return (
            <div key={b.id} className="flex items-center justify-between px-3 py-2.5 rounded-lg" style={{ border: `1px solid ${b.emergency ? C.red : calling ? C.amber : C.line}`, background: inRoom ? C.mintSoft : "transparent" }}>
              <div>
                <div className="text-sm font-medium flex items-center gap-1.5 flex-wrap" style={{ color: C.ink }}>
                  #{b.token} {b.patientName || "Walk-in patient"}
                  {b.emergency && <Badge tone="red">Emergency</Badge>}
                  {inRoom && <Badge tone="mint">In consultation</Badge>}
                  {calling && <Badge tone="amber">Now calling</Badge>}
                  {!inRoom && !calling && b.id === headId && <Badge tone="mint">Next</Badge>}
                </div>
                <div className="text-xs" style={{ color: C.sub }}>{b.bookingMode === "online_registrar" || b.type === "online" ? "Online registrar" : "Walk-in"}</div>
              </div>
              {!inRoom && <GhostButton onClick={() => commit((prev) => markNotAvailable(prev, b.id))} icon={UserX}>Not available</GhostButton>}
            </div>
          );
        })}
      </div>

      {skipped.length > 0 && (
        <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="text-xs font-semibold mb-2" style={{ color: C.sub }}>MARKED NOT AVAILABLE</div>
          <div className="space-y-2">
            {skipped.map((b) => (
              <div key={b.id} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: C.redSoft }}>
                <span className="text-sm" style={{ color: C.ink }}>#{b.token} {b.patientName || "Walk-in patient"}</span>
                <GhostButton onClick={() => commit((prev) => requeueBooking(prev, b.id))} icon={Plus}>Patient arrived — re-queue</GhostButton>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// Test the doctor-room hardware (door IR + button) without the ESP32 — same actions the firmware sends
function DoctorRoomSimulator({ db, commit }) {
  const [doctorId, setDoctorId] = useState(RAW_DOCTORS[0].id);
  const onBreak = !!db.doctors[doctorId]?.absence?.active;
  const act = (a) => commit((prev) => applyDoctorAction(prev, doctorId, a));
  return (
    <Card className="p-4 mb-4">
      <div className="text-sm font-semibold mb-1" style={{ color: C.ink }}>Doctor-room hardware (simulate)</div>
      <p className="text-xs mb-3" style={{ color: C.sub }}>
        The real ESP32 sends these to <code>/api/iot/doctor-event</code>: door IR sensors (entry / exit) and the in-room button — short press = next patient, double press = previous patient, long press = break.
      </p>
      <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="w-full mb-3 rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${C.line}` }}>
        {RAW_DOCTORS.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.department}</option>)}
      </select>
      <div className="flex flex-wrap gap-2">
        <GhostButton onClick={() => act("ENTRY")} icon={Plus}>Door IR: patient enters</GhostButton>
        <GhostButton onClick={() => act("EXIT")} icon={ArrowLeft}>Door IR: patient exits</GhostButton>
        <GhostButton onClick={() => act("NEXT")} icon={ChevronRight}>Button: short press (next)</GhostButton>
        <GhostButton onClick={() => act("PREVIOUS")} icon={ChevronRight}>Button: double press (previous)</GhostButton>
        <GhostButton onClick={() => act("BREAK")} icon={AlertTriangle}>Button: long press ({onBreak ? "end break" : "break"})</GhostButton>
      </div>
    </Card>
  );
}

function StaffApp({ session, db, commit, onLogout }) {
  const [view, setView] = useState("analytics"); // 'analytics' | 'display'
  const dateKey = todayKey(0);
  const perDoctor = RAW_DOCTORS.map((d) => ({ d, ...computeQueueForDoctor(db, d.id, dateKey) }));
  const totalWaiting = perDoctor.reduce((s, x) => s + x.queueLen, 0);
  const totalTreated = perDoctor.reduce((s, x) => s + x.treated.length, 0);
  const busiest = [...perDoctor].sort((a, b) => b.queueLen - a.queueLen)[0];

  const peakHourEntry = [...db.history].sort((a, b) => (b.online + b.offline) - (a.online + a.offline))[0];
  const avgQueue = totalWaiting / RAW_DOCTORS.length;

  const suggestions = [];
  if (avgQueue > 4) suggestions.push("Average queue length is high across departments — consider opening an additional registration counter during peak hours.");
  if (busiest && busiest.queueLen > 6) suggestions.push(`${busiest.d.name}'s queue (${busiest.queueLen} waiting) is a bottleneck — consider adding a second doctor or support staff for ${busiest.d.department} at peak times.`);
  if (peakHourEntry) suggestions.push(`${peakHourEntry.hour} is consistently the busiest hour (${peakHourEntry.online + peakHourEntry.offline} patients) — schedule extra front-desk staff for that window.`);
  if (suggestions.length === 0) suggestions.push("Queues are within normal range across all departments — no immediate staffing changes recommended.");

  const successRate = totalTreated + totalWaiting > 0 ? Math.round((totalTreated / (totalTreated + totalWaiting)) * 100) : 0;
  const waitReduction = 27; // simulated improvement vs pre-QueueSense manual headcount baseline

  return (
    <div style={{ background: C.bg }} className="min-h-full">
      <TopBar role="Staff" name={session.name} onLogout={onLogout} />
      <div className="max-w-4xl mx-auto px-4 pb-16">
        <div className="flex gap-2 mt-4 mb-4">
          {["analytics", "display", "devices", "frontdesk"].map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{ color: view === v ? C.teal : C.sub, borderColor: view === v ? C.teal : "transparent" }}
              className="text-sm font-semibold pb-2 border-b-2 px-1 whitespace-nowrap"
            >
              {v === "analytics" ? "Analytics & Suggestions" : v === "display" ? "OP / LED Display" : v === "devices" ? "IoT Devices" : "OP Desk"}
            </button>
          ))}
        </div>

        {view === "analytics" && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                { label: "Waiting now (all depts.)", value: totalWaiting, icon: Users },
                { label: "Treated today", value: totalTreated, icon: CheckCircle2 },
                { label: "Queue monitoring success rate", value: `${successRate}%`, icon: ShieldCheck },
                { label: "Avg wait-time reduction", value: `${waitReduction}%`, icon: TrendingUp },
              ].map(({ label, value, icon: Icon }) => (
                <Card key={label} className="p-3">
                  <Icon size={16} color={C.teal} className="mb-1" />
                  <div className="text-xl font-bold" style={{ color: C.ink }}>{value}</div>
                  <div className="text-xs" style={{ color: C.sub }}>{label}</div>
                </Card>
              ))}
            </div>

            <Card className="p-4 mb-5">
              <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>Peak booking hours — online registrars vs walk-ins</div>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={db.history} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.line} vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 11, fill: C.sub }} axisLine={{ stroke: C.line }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: C.sub }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="online" name="Online registrars" stackId="a" fill={C.mint} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="offline" name="Walk-ins" stackId="a" fill={C.teal} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4 mb-5">
              <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>Live queue length by doctor</div>
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={perDoctor.map((x) => ({ name: x.d.name.split(" ").slice(-1)[0], queue: x.queueLen }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.line} vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: C.sub }} axisLine={{ stroke: C.line }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: C.sub }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="queue" stroke={C.amber} strokeWidth={2.5} dot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4">
              <div className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: C.ink }}>
                <AlertTriangle size={15} color={C.amber} /> Staffing & capacity suggestions
              </div>
              <ul className="space-y-2">
                {suggestions.map((s, i) => (
                  <li key={i} className="text-sm flex items-start gap-2 px-3 py-2 rounded-lg" style={{ background: C.amberSoft, color: C.ink }}>
                    <Plus size={14} color={C.amber} className="mt-0.5 shrink-0" /> {s}
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}

        {view === "display" && <OpDisplayGrid db={db} />}
        {view === "devices" && <IotDevicesPanel db={db} commit={commit} />}
        {view === "frontdesk" && (
          <div className="space-y-4">
            <AbsenceAnnouncer db={db} commit={commit} />
            <OpDeskBooking db={db} commit={commit} />
            <OpDeskQueueControl db={db} commit={commit} />
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   KIOSK / OLED DISPLAY — public, hardware-fed
   ========================================================================= */
function KioskDisplay({ db, commit, onExit }) {
  const [docId, setDocId] = useState(RAW_DOCTORS[0].id);
  const [tokenQuery, setTokenQuery] = useState("");
  const dateKey = todayKey(0);
  const { doc, waiting, cong, estimated, predicted } = computeDisplayStats(db, docId, dateKey);
  const ds = db.doctors[docId] || {};
  const callingBooking = ds.calling ? waiting.find((b) => b.id === ds.calling.bookingId) : null;

  function simulateArrival() {
    commit((prev) => {
      const token = prev.nextToken;
      const booking = {
        id: `bk-${token}-${Date.now()}`, doctorId: docId, patientName: null,
        type: "offline", date: dateKey, slotMin: nowMinutes(), token, status: "waiting", bookedAt: Date.now(),
        emergency: false, journey: defaultJourney(), createdBy: "hardware",
      };
      return { ...prev, bookings: [...prev.bookings, booking], nextToken: token + 1 };
    });
  }

  const lookup = tokenQuery ? lookupToken(db, tokenQuery, dateKey) : null;

  return (
    <div style={{ background: C.tealDeep }} className="min-h-full text-white px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <RadioTower size={18} color={C.mint} />
            <span className="font-semibold">QueueSense OP Desk Display</span>
          </div>
          <button onClick={onExit} className="text-xs" style={{ color: "#9FC2B8" }}>Exit kiosk</button>
        </div>

        <select
          value={docId} onChange={(e) => setDocId(e.target.value)}
          className="w-full mb-5 rounded-lg px-3 py-2.5 text-sm outline-none"
          style={{ background: "#0F5147", color: "white", border: "1px solid rgba(255,255,255,0.15)" }}
        >
          {RAW_DOCTORS.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.department}</option>)}
        </select>

        <Card style={{ background: "#0F5147", borderColor: "rgba(255,255,255,0.1)" }} className="p-6 mb-5">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm" style={{ color: "#B7D3CB" }}>{doc.name} · {doc.department}</div>
            <Badge tone={cong.tone}>{cong.label} congestion</Badge>
          </div>
          {(callingBooking || ds.absence?.active) && (
            <div className="mb-4 text-sm font-semibold" style={{ color: ds.absence?.active ? "#F3C99A" : C.mint }}>
              {ds.absence?.active ? `Doctor on break — ${ds.absence.reason}` : `Now calling: token #${callingBooking.token}`}
            </div>
          )}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-3xl font-bold">{waiting.length}</div>
              <div className="text-xs" style={{ color: "#9FC2B8" }}>People in queue</div>
            </div>
            <div>
              <div className="text-3xl font-bold">{estimated}<span className="text-base font-normal"> min</span></div>
              <div className="text-xs" style={{ color: "#9FC2B8" }}>Estimated wait</div>
            </div>
            <div>
              <div className="text-3xl font-bold" style={{ color: C.mint }}>{predicted}<span className="text-base font-normal"> min</span></div>
              <div className="text-xs" style={{ color: "#9FC2B8" }}>Predicted wait</div>
            </div>
          </div>
        </Card>

        <Card style={{ background: "#0F5147", borderColor: "rgba(255,255,255,0.1)" }} className="p-6 mb-5">
          <div className="flex items-center gap-2 mb-3">
            <QrCode size={16} color={C.mint} />
            <span className="text-sm font-medium">Scan the QR code and enter your token to see your waiting time</span>
          </div>
          <div className="flex gap-4 items-start">
            <div className="shrink-0">
              <QRImage text={statusPageUrl()} size={116} />
            </div>
            <div className="flex-1">
              <input
                value={tokenQuery} onChange={(e) => setTokenQuery(e.target.value)} inputMode="numeric"
                placeholder="Or enter token number here"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none"
                style={{ background: "#0A342E", color: "white", border: "1px solid rgba(255,255,255,0.15)" }}
              />
              {lookup && <div className="mt-3"><TokenStatusDetails lookup={lookup} dark /></div>}
            </div>
          </div>
        </Card>

        <GhostButton onClick={simulateArrival} icon={Plus}>
          Simulate hardware detection — unregistered walk-in arrival
        </GhostButton>
        <p className="text-[11px] mt-3" style={{ color: "#7FA599" }}>
          Simulation only: it adds an anonymous walk-in to the selected doctor's queue. Real bookings and tokens are issued by the OP desk.
        </p>
      </div>
    </div>
  );
}

/* =========================================================================
   SHELL
   ========================================================================= */
function TopBar({ role, name, onLogout }) {
  return (
    <div style={{ background: C.panel, borderBottom: `1px solid ${C.line}` }} className="px-4 py-3 flex items-center justify-between sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <div style={{ background: C.teal }} className="w-7 h-7 rounded-md flex items-center justify-center">
          <RadioTower size={14} color="white" />
        </div>
        <span className="font-semibold text-sm" style={{ color: C.ink }}>QueueSense</span>
        <Badge tone="mint">{role}</Badge>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm hidden sm:inline" style={{ color: C.sub }}>{name}</span>
        <button onClick={onLogout} className="flex items-center gap-1 text-sm" style={{ color: C.sub }}>
          <LogOut size={14} /> Logout
        </button>
      </div>
    </div>
  );
}

export default function QueueSenseApp() {
  const { db, ready, commit } = useDB();
  const [session, setSession] = useState(null);
  const [kiosk, setKiosk] = useState(false);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const publicTokenPage = params.get("view") === "token"; // opened by scanning the OP-desk QR code

  useHardwareBridge(ready && !!db && !publicTokenPage && (kiosk || session?.role === "staff" || session?.role === "doctor"), db, commit);

  if (!ready || !db) {
    return (
      <div style={{ background: C.tealDeep }} className="min-h-full flex items-center justify-center">
        <div className="text-white text-sm flex items-center gap-2"><Activity size={16} className="animate-pulse" /> Loading QueueSense…</div>
      </div>
    );
  }

  if (publicTokenPage) return <PublicTokenStatus db={db} initialToken={params.get("token") || ""} />;
  if (kiosk) return <KioskDisplay db={db} commit={commit} onExit={() => setKiosk(false)} />;
  if (!session) return <LoginScreen onLogin={setSession} onKiosk={() => setKiosk(true)} />;

  if (session.role === "patient") return <PatientApp session={session} db={db} commit={commit} onLogout={() => setSession(null)} />;
  if (session.role === "doctor") return <DoctorApp session={session} db={db} commit={commit} onLogout={() => setSession(null)} />;
  return <StaffApp session={session} db={db} commit={commit} onLogout={() => setSession(null)} />;
}
