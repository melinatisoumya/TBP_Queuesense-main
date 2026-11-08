# QueueSense ML service

A real, trained prediction service (spec sections 24, 25, 39, 40) — not a
hardcoded constant. This has been run and verified; the numbers below are
from an actual test, not projections.

## What's here

- `generate_historical_data.py` — writes `data/consultations.csv`, a
  synthetic stand-in for real historical consultation logs, in the exact
  schema real logs would use. Swap in a real export later with zero code
  changes elsewhere.
- `train_model.py` — trains a `GradientBoostingRegressor` on that data
  (doctor, hour, day-of-week, queue size at start, emergency flag, peak-hour
  flag, a causally-computed rolling recent average per doctor), evaluates it
  on a held-out 20% test split, and saves:
  - `model_artifacts/consultation_duration_model.joblib` — the trained model
  - `model_artifacts/fallback_table.json` — real per-doctor historical
    averages, used only if the model can't be loaded
  - `model_artifacts/model_metadata.json` — training metadata/metrics
- `app.py` — a Flask service exposing:
  - `POST /predict/consultation-duration`
  - `POST /predict/wait-time`
  - `GET /model/info`
  - `GET /health`

## Verified results (last run)

```
Test MAE:  1.26 min   (naive global-mean baseline MAE: 2.45 min)
Test RMSE: 1.60 min
Held out 1020 of 5096 consultations for evaluation.
```

The model's error is roughly half the naive "always predict the average"
baseline — genuine learned signal from the queue-size/time-of-day/doctor
features, not noise.

**Fallback path, actually triggered and verified:** with the model file
renamed away, `/health` correctly reports `model_loaded: false`, and both
prediction endpoints respond with `"method": "fallback_average"` instead of
silently pretending — using the real per-doctor historical averages:

```json
{"doctor_id":"d2","predicted_minutes":15.4,"method":"fallback_average",
 "explanation":"ML model unavailable — using d2's historical average consultation time instead."}
```

**Backend integration, actually verified:** `queuesense_hardware/backend/server.js`
now calls this service's `/predict/wait-time` for any request that carries
a `doctor_id` (e.g. `GET /api/iot/queue/OP%20Registration%20Desk?doctor_id=d3`),
and falls back to its own local heuristic automatically if the ML service
is unreachable or no `doctor_id` is known (raw ESP32 hardware events never
carry one — the sensors are location-level, not per-doctor). Tested against
the live services:

| Scenario | Result |
|---|---|
| doctor d3, 6 waiting, ML service up | `{"method":"ml_model","source":"ml_service","estimated":52,"predicted":52}` |
| doctor d6, 2 waiting, ML service up | `{"method":"ml_model","source":"ml_service","estimated":18,"predicted":18}` |
| no doctor_id (raw hardware event) | `{"method":"local_heuristic","source":"iot_backend","estimated":48,"predicted":48}` |
| ML service unreachable | `{"method":"local_heuristic","source":"iot_backend","estimated":72,"predicted":72}` |

## Running it yourself

```bash
pip install flask joblib pandas scikit-learn numpy
python3 generate_historical_data.py   # writes data/consultations.csv
python3 train_model.py                # trains + saves model_artifacts/
python3 app.py                        # serves on :5001
```

Then, for the backend integration:

```bash
cd ../queuesense_hardware/backend
npm install
ML_SERVICE_URL=http://127.0.0.1:5001 npm start   # serves on :3001
curl "http://127.0.0.1:3001/api/iot/queue/OP%20Registration%20Desk?doctor_id=d3"
```

## What's honest about this and what isn't done yet

This **is** a real, trained, served model wired into a real backend with a
real, tested fallback path — not a stub. What it is *not* yet:

- Trained on real hospital data (it's trained on the synthetic
  `data/consultations.csv` — swap the CSV for real exports and rerun
  `train_model.py`, nothing else changes).
- Retrained automatically over time — `train_model.py` is run manually;
  a real deployment would schedule periodic retraining as new consultations
  complete.
- Serving more than consultation-duration/wait-time — the bottleneck
  prediction, demand forecasting, and doctor-workload predictions from
  spec section 24/25 would be additional endpoints on this same service,
  following the same train/serve/fallback pattern.
- Production-hardened — Flask's dev server is used here; deploy behind
  gunicorn/uwsgi for real traffic.
