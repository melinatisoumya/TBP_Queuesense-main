"""
test_model.py
---------------------------------------------------------------------------
Tests the trained Gradient Boosting Regression model on test_dataset.csv
to predict patient waiting time and evaluate performance metrics.

Run: python3 test_model.py
---------------------------------------------------------------------------
"""
import joblib
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

# 1. Load the test dataset and trained model artifact
test_df = pd.read_csv("test_dataset.csv")
model = joblib.load("model_artifacts/consultation_duration_model.joblib")

# 2. Define the features used during training and the target variable
FEATURES_NUM = [
    "hour",
    "day_of_week",
    "queue_size_at_start",
    "is_emergency",
    "is_peak_hour",
    "experience_years",
    "consultation_minutes",
    "queue_load",
    "emergency_factor",
    "recent_avg_wait"
]
FEATURES_CAT = ["doctor_id"]
TARGET = "patient_waiting_time"

X_test = test_df[FEATURES_NUM + FEATURES_CAT]
y_true = test_df[TARGET]

# 3. Generate predictions
y_pred = model.predict(X_test)

# 4. Calculate evaluation metrics
mae = mean_absolute_error(y_true, y_pred)
mse = mean_squared_error(y_true, y_pred)
rmse = mse ** 0.5
r2 = r2_score(y_true, y_pred)

print(f"Test Evaluation Results:")
print(f"------------------------")
print(f"Mean Absolute Error (MAE): {mae:.2f} min")
print(f"Mean Squared Error (MSE):  {mse:.2f}")
print(f"Root Mean Squared Error:   {rmse:.2f} min")
print(f"R² Score:                  {r2:.4f}")
print(f"Evaluated on {len(test_df)} test samples.")