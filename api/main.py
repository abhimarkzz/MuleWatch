import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field


MODELS_DIR = Path(__file__).resolve().parent / "models"

MODEL_PATH = MODELS_DIR / "fraud_detection_rf.joblib"
THRESHOLD_PATH = MODELS_DIR / "fraud_threshold.json"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not MODEL_PATH.is_file():
        raise RuntimeError(
            f"Model file not found: {MODEL_PATH}"
        )

    # Load the model once when the API starts.
    app.state.model = joblib.load(MODEL_PATH)

    # Default to 0.5 if no threshold file exists.
    threshold = 0.5

    if THRESHOLD_PATH.is_file():
        try:
            with THRESHOLD_PATH.open(
                "r", encoding="utf-8"
            ) as file:
                config = json.load(file)

            threshold = float(config["threshold"])

            if not 0 <= threshold <= 1:
                raise ValueError(
                    "Threshold must be between 0 and 1."
                )

        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise RuntimeError(
                f"Invalid threshold configuration: {THRESHOLD_PATH}"
            ) from exc

    app.state.fraud_threshold = threshold

    print(
        "MuleWatch model loaded. "
        f"Fraud decision threshold: {threshold:.6f}"
    )

    yield


app = FastAPI(
    title="MuleWatch Fraud Detection API",
    description=(
        "Predict transaction fraud risk using a tuned "
        "Random Forest model and a configurable decision threshold."
    ),
    version="1.1.0",
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
        "fraud_threshold": getattr(
            app.state, "fraud_threshold", 0.5
        ),
    }


@app.post("/predict")
def predict(request: PredictionRequest):
    model = getattr(app.state, "model", None)

    if model is None:
        raise HTTPException(
            status_code=503,
            detail="The model is not loaded.",
        )

    # IMPORTANT:
    # Preserve the exact feature names and column order expected
    # by the trained scikit-learn pipeline.
    features = pd.DataFrame(
        [
            {
                "step": request.step,
                "amount": request.amount,
                "oldbalanceOrg": request.oldbalanceOrg,
                "oldbalanceDest": request.oldbalanceDest,
                "orig_txn_count_before":
                    request.orig_txn_count_before,
                "dest_txn_count_before":
                    request.dest_txn_count_before,
                "dest_is_merchant":
                    request.dest_is_merchant,
                "type": request.type,
            }
        ]
    )

    try:
        probabilities = model.predict_proba(features)[0]

        classes = list(model.classes_)

        try:
            fraud_index = classes.index(1)
        except ValueError as exc:
            raise ValueError(
                "The model does not contain fraud class 1."
            ) from exc

        fraud_probability = float(
            probabilities[fraud_index]
        )

        if not 0 <= fraud_probability <= 1:
            raise ValueError(
                "The model returned an invalid fraud probability."
            )

        threshold = float(
            getattr(app.state, "fraud_threshold", 0.5)
        )

        # Apply the selected threshold instead of model.predict().
        predicted_is_fraud = (
            fraud_probability >= threshold
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                "Prediction failed. Check model compatibility "
                "and the feature configuration."
            ),
        ) from exc

    return {
        "predicted_is_fraud": bool(predicted_is_fraud),
        "fraud_probability": round(
            fraud_probability, 6
        ),
        "decision_threshold": round(threshold, 6),
        "model_version": "random-forest-tuned-v2",
        "message": (
            "Demonstration prediction; not a confirmed "
            "fraud determination."
        ),
    }