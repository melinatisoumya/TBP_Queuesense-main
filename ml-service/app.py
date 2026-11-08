"""
app.py — QueueSense ML service
---------------------------------------------------------------------------
A real, standalone prediction service (spec sections 24, 25, 39, 40):

  POST /predict/consultation-duration
  POST /predict/wait-time
  GET  /model/info
  GET  /health

If the trained model can't be loaded, every prediction response includes
"method": "fallback_average" (using the real per-doctor historical average
computed in train_model.py) instead of silently pretending the ML model
served the number — the caller (queue engine / frontend) can and should
show that difference to the user, exactly as the spec requires.

Run:
  pip install flask joblib pandas scikit-learn
  python3 app.py
Default port: 5001
---------------------------------------------------------------------------
"""
import json
from datetime import datetime

import joblib
import pandas as pd
from flask import Flask, request, jsonify

app = Flask(__name__)

MODEL_PATH = "model_artifacts/consultation_duration_model.joblib"
FALLBACK_PATH = "model_artifacts/fallback_table.json"
METADATA_PATH = "model_artifacts/model_metadata.json"

PEAK_START_HOUR, PEAK_END_HOUR = 13, 14

_model = None
_fallback = None
_metadata = None
_model_load_error = None


def load_artifacts():
    global _model, _fallback, _metadata, _model_load_error
    try:
        _model = joblib.load(MODEL_PATH)
    except Exception as e:
        _model = None
        _model_load_error = str(e)
        app.logger.warning(f"ML model unavailable, falling back to historical averages: {e}")

    with open(FALLBACK_PATH) as f:
        _fallback = json.load(f)
    try:
        with open(METADATA_PATH) as f:
            _metadata = json.load(f)
    except FileNotFoundError:
        _metadata = {}


load_artifacts()


def predict_consultation_minutes(doctor_id, hour, day_of_week, queue_size_at_start=0,
                                  is_emergency=0, recent_avg_minutes=None):
    """Returns (minutes, method). method is 'ml_model' or 'fallback_average'."""
    is_peak = 1 if PEAK_START_HOUR <= hour < PEAK_END_HOUR else 0

    if _model is not None:
        if recent_avg_minutes is None:
            recent_avg_minutes = _fallback["per_doctor_avg_minutes"].get(
                doctor_id, _fallback["global_avg_minutes"]
            )
        row = pd.DataFrame([{
            "hour": hour,
            "day_of_week": day_of_week,
            "queue_size_at_start": queue_size_at_start,
            "is_emergency": is_emergency,
            "is_peak_hour": is_peak,
            "recent_avg_minutes": recent_avg_minutes,
            "doctor_id": doctor_id,
        }])
        try:
            minutes = float(_model.predict(row)[0])
            return round(max(2.0, minutes), 1), "ml_model"
        except Exception as e:
            app.logger.warning(f"ML prediction failed at request time, using fallback: {e}")

    # --- fallback path: real historical average, not a guess ---
    minutes = _fallback["per_doctor_avg_minutes"].get(doctor_id, _fallback["global_avg_minutes"])
    if is_peak:
        minutes *= 1.1  # same peak-hour adjustment philosophy as the rest of QueueSense
    return round(minutes, 1), "fallback_average"


@app.route("/health")
def health():
    return jsonify({"ok": True, "model_loaded": _model is not None})


@app.route("/model/info")
def model_info():
    return jsonify({
        "model_loaded": _model is not None,
        "model_load_error": _model_load_error,
        "metadata": _metadata,
        "fallback_table": _fallback,
    })


@app.route("/predict/consultation-duration", methods=["POST"])
def predict_duration():
    body = request.get_json(force=True) or {}
    doctor_id = body.get("doctor_id")
    if not doctor_id:
        return jsonify({"error": "doctor_id required"}), 400

    now = datetime.now()
    hour = body.get("hour", now.hour)
    day_of_week = body.get("day_of_week", now.weekday())

    minutes, method = predict_consultation_minutes(
        doctor_id=doctor_id,
        hour=hour,
        day_of_week=day_of_week,
        queue_size_at_start=body.get("queue_size_at_start", 0),
        is_emergency=1 if body.get("is_emergency") else 0,
        recent_avg_minutes=body.get("recent_avg_minutes"),
    )
    return jsonify({
        "doctor_id": doctor_id,
        "predicted_minutes": minutes,
        "method": method,
        "explanation": (
            f"Predicted from the trained model using doctor {doctor_id}'s recent pattern, "
            f"hour {hour}, and current queue size {body.get('queue_size_at_start', 0)}."
            if method == "ml_model" else
            f"ML model unavailable — using {doctor_id}'s historical average consultation time instead."
        ),
    })


@app.route("/predict/wait-time", methods=["POST"])
def predict_wait():
    body = request.get_json(force=True) or {}
    doctor_id = body.get("doctor_id")
    patients_ahead = body.get("patients_ahead")
    if not doctor_id or patients_ahead is None:
        return jsonify({"error": "doctor_id and patients_ahead required"}), 400

    now = datetime.now()
    hour = body.get("hour", now.hour)
    day_of_week = body.get("day_of_week", now.weekday())
    current_delay_min = body.get("current_delay_min", 0)

    per_patient_minutes, method = predict_consultation_minutes(
        doctor_id=doctor_id,
        hour=hour,
        day_of_week=day_of_week,
        queue_size_at_start=patients_ahead,
        is_emergency=0,
        recent_avg_minutes=body.get("recent_avg_minutes"),
    )
    predicted_wait = round(patients_ahead * per_patient_minutes + current_delay_min, 1)

    return jsonify({
        "doctor_id": doctor_id,
        "patients_ahead": patients_ahead,
        "per_patient_minutes": per_patient_minutes,
        "current_delay_min": current_delay_min,
        "predicted_wait_minutes": predicted_wait,
        "method": method,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
