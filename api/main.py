from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field


# Load the model from the api/models directory.
MODEL_PATH = (
    Path(__file__).resolve().parent
    / "models"
    / "fraud_detection_rf.joblib"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not MODEL_PATH.is_file():
        raise RuntimeError(
            f"Model file not found: {MODEL_PATH}"
        )

    # Load once when the API starts.
    app.state.model = joblib.load(MODEL_PATH)

    yield


app = FastAPI(
    title="MuleWatch Fraud Detection API",
    description=(
        "Predict transaction fraud risk using a trained "
        "Random Forest model."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step: int = Field(ge=0)
    type: Literal[
        "PAYMENT",
        "TRANSFER",
        "CASH_OUT",
        "CASH_IN",
        "DEBIT",
    ]
    amount: float = Field(ge=0)
    oldbalanceOrg: float = Field(ge=0)
    oldbalanceDest: float = Field(ge=0)

    orig_txn_count_before: int = Field(ge=0)
    dest_txn_count_before: int = Field(ge=0)

    dest_is_merchant: int = Field(ge=0, le=1)


@app.get("/")
def home():
    return {
        "message": "MuleWatch Fraud Detection API",
        "status": "running",
        "docs": "/docs",
    }


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "model_loaded": hasattr(app.state, "model"),
    }


@app.post("/predict")
def predict(request: PredictionRequest):
    model = getattr(app.state, "model", None)

    if model is None:
        raise HTTPException(
            status_code=503,
            detail="The model is not loaded.",
        )

    # Use exactly the prediction-time feature names
    # and columns expected by your trained pipeline.
    features = pd.DataFrame([{
        "step": request.step,
        "type": request.type,
        "amount": request.amount,
        "oldbalanceOrg": request.oldbalanceOrg,
        "oldbalanceDest": request.oldbalanceDest,
        "orig_txn_count_before":
            request.orig_txn_count_before,
        "dest_txn_count_before":
            request.dest_txn_count_before,
        "dest_is_merchant": request.dest_is_merchant,
    }])

    try:
        prediction = int(model.predict(features)[0])
        probabilities = model.predict_proba(features)[0]

        # Find the probability associated with class 1,
        # rather than assuming a fixed class-column order.
        classes = list(model.classes_)
        fraud_index = classes.index(1)
        fraud_probability = float(
            probabilities[fraud_index]
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Prediction failed. Check model compatibility.",
        ) from exc

    return {
        "predicted_is_fraud": bool(prediction == 1),
        "fraud_probability": round(
            fraud_probability, 6
        ),
        "model_version": "random-forest-v1",
        "message": (
            "Demonstration prediction; not a confirmed "
            "fraud determination."
        ),
    }