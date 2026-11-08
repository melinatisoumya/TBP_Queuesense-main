"""
generate_historical_data.py
---------------------------------------------------------------------------
Produces data/consultations.csv — a synthetic stand-in for real historical
consultation logs, structured EXACTLY the way real hospital logs would be
(one row per completed consultation). This lets the rest of the pipeline
(train_model.py, app.py) be written against a real schema now; swapping in
genuine historical exports later requires zero code changes, only replacing
this CSV.

Each doctor gets a distinct "true" baseline consultation duration and
sensitivity to queue pressure/time-of-day, with realistic per-consultation
noise — so the model has real signal to learn, not just random numbers.
---------------------------------------------------------------------------
"""
import numpy as np
import pandas as pd
from datetime import datetime, timedelta

rng = np.random.default_rng(42)

DOCTORS = [
    # doctor_id, department, baseline_minutes, queue_sensitivity, experience_years
    ("d1", "Cardiology", 12.0, 0.15, 14),
    ("d2", "Cardiology", 15.0, 0.05, 9),
    ("d3", "Orthopedics", 10.0, 0.20, 11),
    ("d4", "Orthopedics", 13.0, 0.10, 7),
    ("d5", "Dermatology", 8.0, 0.25, 16),
    ("d6", "Dermatology", 9.0, 0.15, 5),
    ("d7", "General Medicine", 10.0, 0.12, 12),
    ("d8", "General Medicine", 11.0, 0.08, 8),
]

N_DAYS = 45          # ~9 weeks of synthetic history
START_HOUR, END_HOUR = 9, 17

rows = []
start_date = datetime(2026, 6, 1)

for day_offset in range(N_DAYS):
    day = start_date + timedelta(days=day_offset)
    day_of_week = day.weekday()  # 0=Mon
    if day_of_week >= 5:
        continue  # OP desk closed weekends in this simulation

    for doctor_id, dept, baseline, queue_sens, experience in DOCTORS:
        # each doctor sees a random number of patients that day
        n_patients = rng.integers(14, 26)
        queue_size = rng.integers(0, 6)  # queue building up through the day

        for i in range(n_patients):
            hour = START_HOUR + int(i * (END_HOUR - START_HOUR) / n_patients)
            is_peak = 1 if 13 <= hour < 14 else 0
            is_emergency = 1 if rng.random() < 0.04 else 0

            # more experienced doctors trend slightly faster; queue pressure and
            # peak hour both push consultations a bit shorter (rushed) except
            # emergencies which take longer
            duration = (
                baseline
                - 0.05 * (experience - 10)
                - queue_sens * min(queue_size, 8)
                + (1.5 if is_peak else 0)
                + (6.0 if is_emergency else 0)
                + rng.normal(0, 1.6)
            )
            duration = max(3.0, round(duration, 1))

            rows.append({
                "doctor_id": doctor_id,
                "department": dept,
                "date": day.strftime("%Y-%m-%d"),
                "day_of_week": day_of_week,
                "hour": hour,
                "queue_size_at_start": int(min(queue_size, 12)),
                "is_emergency": is_emergency,
                "is_peak_hour": is_peak,
                "experience_years": experience,
                "consultation_minutes": duration,
            })

            queue_size = max(0, queue_size + (1 if rng.random() < 0.4 else -1))

df = pd.DataFrame(rows)
df.to_csv("data/consultations.csv", index=False)
print(f"Wrote {len(df)} historical consultation rows to data/consultations.csv")
print(df.groupby("doctor_id")["consultation_minutes"].agg(["mean", "median", "std", "count"]))
