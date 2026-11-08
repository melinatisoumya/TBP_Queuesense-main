# QueueSense — changes in this version

## Run it
```
# 1. backend (shared database + ESP32 endpoints)
cd backend && npm install && npm start            # http://<PC-IP>:3001

# 2. frontend
cd frontend && npm install
cp .env.example .env        # set VITE_API_URL and VITE_PUBLIC_URL to your PC's LAN IP
npm run dev -- --host       # open http://<PC-IP>:5173
```
Without `VITE_API_URL` the app still works on one browser (localStorage) exactly as before, but phones scanning the
QR code and the ESP32 can only see the same data when the backend is configured.

## Features
1. **QR at the OP desk** (Kiosk screen) — real QR code. Scanning opens a public page; entering the token shows waiting time,
   patients ahead, status (waiting / now calling / in consultation / not available / completed), doctor delay, payment, next journey stage.
2. **Online Registrars** tab in the patient window (was online booking). Booking removed from online and walk-in patients.
3. **OP Desk (Staff → OP Desk)** is the only place that books, receives payment (Cash / UPI / Card) and generates tokens.
4. **Walk-in** tab: view waiting time, doctor delay, status and notifications only.
5. **Online Registrars** have *Register* and *AI Recommendation* options (+ *My Registrations*).
6. OP-desk booking has a **patient booking mode**: *Online registrar* (confirm the patient has registered) / *Walk-in*.
7. **Not available** at the OP desk — patient is skipped, the queue moves to the next patient (can be re-queued).
8. Consultation journey and simulations kept; the old simulate buttons remain, plus a new "Doctor-room hardware (simulate)" card.
9. Doctor-room hardware: door IR (entry/exit) + room button (short = next, double = previous, long = break / absence).
10. OP-desk OLED shows the called / next patient and queue; buzzer sounds when the next patient is called.

See `hardware/HARDWARE_SETUP.md` for wiring roles and the test procedure.
