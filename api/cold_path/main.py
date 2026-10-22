"""MuleWatch cold path (Service B): explains fraud_alerts events in the background.

Run from the repository root:  uvicorn api.cold_path.main:app --port 8002

Deployed as a second Render Web Service. It shares the Random Forest artefact
with Service A but serves no predictions; its HTTP surface is health and an
authenticated wake ping.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from hmac import compare_digest
from pathlib import Path

import joblib
from fastapi import FastAPI, Header, HTTPException, Response

from api.cold_path.consumer import ColdPathSettings, FraudAlertConsumer
from api.cold_path.ledger import Ledger
from api.cold_path.pipeline import build_pipeline
from api.cold_path.store import ExplanationStore

logger = logging.getLogger("mulewatch.cold_path")
MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "fraud_detection_rf.joblib"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = ColdPathSettings.from_env()
    app.state.settings = settings
    app.state.consumer = None
    if settings is None:
        logger.warning("Cold path disabled: Kafka, MongoDB or Supabase settings are missing.")
        yield
        return

    # Trusted: the repository's own artefact, the same file Service A loads.
    # Never point MODEL_PATH at user-supplied or downloaded files.
    model = joblib.load(MODEL_PATH)
    store = ExplanationStore(settings.mongodb_uri, settings.mongodb_database)
    ledger = Ledger(settings.supabase_url, settings.supabase_service_key)
    try:
        await store.ensure_indexes()
    except Exception as exc:  # Atlas down at boot: writes will retry later
        logger.warning("MongoDB index setup failed (%s).", type(exc).__name__)

    consumer = FraudAlertConsumer(settings.kafka, build_pipeline(store=store, ledger=ledger, model=model))
    app.state.consumer = consumer
    consumer.start()
    try:
        yield
    finally:
        await consumer.stop()
        await ledger.close()
        await store.close()


app = FastAPI(title="MuleWatch Cold Path", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health():
    consumer = getattr(app.state, "consumer", None)
    return {"status": "healthy", "fraud_alerts_consumer": consumer.state if consumer else "disabled"}


@app.post("/wake", status_code=204)
def wake(x_api_key: str = Header(default="")):
    """Lets Service A nudge a sleeping instance. Render boots the service for
    any inbound request, so the key can't prevent wake-ups; it keeps this
    endpoint from being a free, unauthenticated success signal and from doing
    any work for strangers."""
    settings = getattr(app.state, "settings", None)
    expected = settings.api_key if settings else None
    if not expected or not x_api_key or not compare_digest(x_api_key, expected):
        raise HTTPException(status_code=401, detail="Unauthorized.")
    return Response(status_code=204)
