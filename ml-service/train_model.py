"""
train_model.py
---------------------------------------------------------------------------
Trains a real regression model on modified consultations data to predict
patient waiting time, evaluates it on a held-out test split, and saves 
the model + a per-doctor fallback lookup table.

Run: python3 train_model.py
---------------------------------------------------------------------------
"""
import json
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline

df = pd.read_csv("data/modified_consultations.csv")

# --- rolling "recent average" feature per doctor, computed causally (only
# using consultations that happened before the current row) so the model
# can't cheat by peeking at the future ---
df = df.sort_values(["doctor_id", "date", "hour"]).reset_index(drop=True)
df["recent_avg_wait"] = (
    df.groupby("doctor_id")["patient_waiting_time"]
    .transform(lambda s: s.shift(1).rolling(window=10, min_periods=1).mean())
)
df["recent_avg_wait"] = df["recent_avg_wait"].fillna(df["patient_waiting_time"].mean())

FEATURES_NUM = ["hour", "day_of_week", "queue_size_at_start", "is_emergency", "is_peak_hour", "experience_years", "consultation_minutes", "queue_load", "emergency_factor", "recent_avg_wait"]
FEATURES_CAT = ["doctor_id"]
TARGET = "patient_waiting_time"

X = df[FEATURES_NUM + FEATURES_CAT]
y = df[TARGET]

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=7)

preprocess = ColumnTransformer([
    ("doctor_onehot", OneHotEncoder(handle_unknown="ignore"), FEATURES_CAT),
], remainder="passthrough")

model = Pipeline([
    ("prep", preprocess),
    ("gbr", GradientBoostingRegressor(n_estimators=150, max_depth=3, learning_rate=0.08, random_state=7)),
])

model.fit(X_train, y_train)
pred = model.predict(X_test)

mae = mean_absolute_error(y_test, pred)
rmse = mean_squared_error(y_test, pred) ** 0.5
baseline_pred = np.full_like(y_test, y_train.mean(), dtype=float)
baseline_mae = mean_absolute_error(y_test, baseline_pred)

print(f"Test MAE:  {mae:.2f} min   (naive global-mean baseline MAE: {baseline_mae:.2f} min)")
print(f"Test RMSE: {rmse:.2f} min")
print(f"Held out {len(X_test)} of {len(X)} consultations for evaluation.")

joblib.dump(model, "model_artifacts/consultation_duration_model.joblib")

# --- fallback table: real per-doctor historical averages, used only if the
# ML model can't be loaded/served ---
fallback = (
    df.groupby("doctor_id")["patient_waiting_time"]
    .mean()
    .round(1)
    .to_dict()
)
global_fallback = round(float(df["patient_waiting_time"].mean()), 1)
with open("model_artifacts/fallback_table.json", "w") as f:
    json.dump({"per_doctor_avg_wait": fallback, "global_avg_wait": global_fallback}, f, indent=2)

metadata = {
    "trained_at": pd.Timestamp.now().isoformat(),
    "n_rows": len(df),
    "test_mae_minutes": round(float(mae), 2),
    "test_rmse_minutes": round(float(rmse), 2),
    "naive_baseline_mae_minutes": round(float(baseline_mae), 2),
    "features": FEATURES_NUM + FEATURES_CAT,
    "model": "GradientBoostingRegressor(n_estimators=150, max_depth=3, lr=0.08)",
}
with open("model_artifacts/model_metadata.json", "w") as f:
    json.dump(metadata, f, indent=2)

print("Saved model_artifacts/consultation_duration_model.joblib")
print("Saved model_artifacts/fallback_table.json")
print("Saved model_artifacts/model_metadata.json")