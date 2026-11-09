"""
app.py — QueueSense ML service (Backend)
---------------------------------------------------------------------------
A real, standalone prediction service handling wait time and consultation
duration predictions using the trained Gradient Boosting model.
---------------------------------------------------------------------------
"""
import os
import json
from datetime import datetime

import joblib
import pandas as pd
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__)

# Relative paths pointing from backend/ to ml-service/model_artifacts/
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "../ml-service/model_artifacts/consultation_duration_model.joblib")
FALLBACK_PATH = os.path.join(BASE_DIR, "../ml-service/model_artifacts/fallback_table.json")
METADATA_PATH = os.path.join(BASE_DIR, "../ml-service/model_artifacts/model_metadata.json")

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

    try:
        with open(FALLBACK_PATH) as f:
            _fallback = json.load(f)
    except Exception:
        _fallback = {"per_doctor_avg_wait": {}, "global_avg_wait": 10.0}

    try:
        with open(METADATA_PATH) as f:
            _metadata = json.load(f)
    except FileNotFoundError:
        _metadata = {}


load_artifacts()


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


@app.route("/predict/wait-time", methods=["POST"])
def predict_wait():
    body = request.get_json(force=True) or {}
    doctor_id = body.get("doctor_id")
    if not doctor_id:
        return jsonify({"error": "doctor_id required"}), 400

    now = datetime.now()
    hour = body.get("hour", now.hour)
    day_of_week = body.get("day_of_week", now.weekday())
    queue_size = body.get("queue_size_at_start", body.get("patients_ahead", 0))
    is_emergency = 1 if body.get("is_emergency") else 0
    is_peak = 1 if PEAK_START_HOUR <= hour < PEAK_END_HOUR else 0
    experience_years = body.get("experience_years", 10)
    consultation_minutes = body.get("consultation_minutes", 11.0)
    queue_load = queue_size * (is_peak + 1)
    emergency_factor = is_emergency * queue_size
    recent_avg_wait = body.get("recent_avg_wait", 8.0)

    method = "fallback_average"
    predicted_wait = 0.0

    if _model is not None:
        row = pd.DataFrame([{
            "hour": hour,
            "day_of_week": day_of_week,
            "queue_size_at_start": queue_size,
            "is_emergency": is_emergency,
            "is_peak_hour": is_peak,
            "experience_years": experience_years,
            "consultation_minutes": consultation_minutes,
            "queue_load": queue_load,
            "emergency_factor": emergency_factor,
            "recent_avg_wait": recent_avg_wait,
            "doctor_id": doctor_id,
        }])
        try:
            predicted_wait = float(_model.predict(row)[0])
            predicted_wait = round(max(2.0, predicted_wait), 1)
            method = "ml_model"
        except Exception as e:
            app.logger.warning(f"Prediction failed, using fallback: {e}")

    if method == "fallback_average":
        per_doc = _fallback.get("per_doctor_avg_wait", {})
        global_avg = _fallback.get("global_avg_wait", 10.0)
        predicted_wait = per_doc.get(doctor_id, global_avg)
        if is_peak:
            predicted_wait *= 1.1
        predicted_wait = round(predicted_wait, 1)

    return jsonify({
        "doctor_id": doctor_id,
        "predicted_wait_minutes": predicted_wait,
        "method": method,
    })
# Serve React Frontend (Add this near the bottom of your app.py)
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    # Keep your API routes active (ensure your actual prefixes like 'api/', 'predict', etc. are covered)
    if path.startswith("api/") or path.startswith("predict") or path.startswith("health") or path.startswith("model"):
        return jsonify({"error": "Not found"}), 404

    static_folder_path = os.path.join(app.root_path, "static")
    if path != "" and os.path.exists(os.path.join(static_folder_path, path)):
        return send_from_directory(static_folder_path, path)
    else:
        return send_from_directory(static_folder_path, "index.html")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)