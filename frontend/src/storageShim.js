// Storage shim used by the app as its "database".
// - Without VITE_API_URL: data lives in this browser's localStorage (original behaviour).
// - With VITE_API_URL (e.g. http://192.168.1.20:3001): data is shared through the
//   QueueSense backend so the OP desk, doctor screens and patients' phones (QR page)
//   all see the same queue. localStorage is kept as an offline fallback.
export const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function read() { try { return JSON.parse(localStorage.getItem("queuesense-shim") || "{}"); } catch { return {}; } }
function write(all) { localStorage.setItem("queuesense-shim", JSON.stringify(all)); }

async function remote(path, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(API_URL + path, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

// writes are sent one at a time, newest value wins, so the backend never gets an older blob last
let pending = null, sending = false;
async function flush() {
  if (sending) return;
  sending = true;
  while (pending) {
    const value = pending; pending = null;
    try {
      await remote("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
    } catch { /* offline: localStorage copy still has it */ }
  }
  sending = false;
}

window.storage = {
  async get(key) {
    if (API_URL) {
      try {
        const res = await remote("/api/state");
        if (res.status === 404) throw new Error("not found");
        if (res.ok) { const j = await res.json(); return { key, value: j.value, shared: true }; }
      } catch (e) {
        if (e.message === "not found") throw e;
        /* backend unreachable -> fall through to local copy */
      }
    }
    const all = read(); if (!(key in all)) throw new Error("not found");
    return { key, value: all[key], shared: true };
  },
  async set(key, value) {
    const all = read(); all[key] = value; write(all);
    if (API_URL) { pending = value; flush(); }
    return { key, value, shared: true };
  },
  async delete(key) { const all = read(); const existed = key in all; delete all[key]; write(all); return { key, deleted: existed, shared: true }; },
  async list(prefix = "") { const all = read(); return { keys: Object.keys(all).filter(k => k.startsWith(prefix)), shared: true }; },
};
