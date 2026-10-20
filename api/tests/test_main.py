
from contextlib import contextmanager

import numpy as np
import pytest
from fastapi.testclient import TestClient

from api import main


TEST_API_KEY = "unit-test-api-key"


class FakeFraudModel:
    """Deterministic sklearn-style model for endpoint unit tests."""

    classes_ = np.array([0, 1])

    feature_names_in_ = np.array(
        [
            "step",
            "amount",
            "oldbalanceOrg",
            "oldbalanceDest",
            "orig_txn_count_before",
            "dest_txn_count_before",
            "dest_is_merchant",
            "type",
        ]
    )

    def __init__(self, probability: float):
        self.probability = probability

    def predict_proba(self, features):
        row_count = len(features)

        return np.tile(
            [1.0 - self.probability, self.probability],
            (row_count, 1),
        )

    def predict(self, features):
        """Provide the standard classifier predict interface."""
        return np.full(
            len(features),
            int(self.probability >= 0.5),
        )


VALID_TRANSACTION = {
    "step": 100,
    "type": "TRANSFER",
    "amount": 5000.0,
    "oldbalanceOrg": 10000.0,
    "oldbalanceDest": 2000.0,
    "orig_txn_count_before": 1,
    "dest_txn_count_before": 4,
    "dest_is_merchant": 0,
}


@pytest.fixture
def client_factory(monkeypatch):
    @contextmanager
    def make_client(probability: float):
        fake_model = FakeFraudModel(probability)

        # Ensure the app loads our deterministic fake instead of the
        # production model artifact.
        monkeypatch.setattr(
            main.joblib,
            "load",
            lambda *args, **kwargs: fake_model,
        )

        # Configure test-only credentials in case the API checks an
        # API key. These are dummy values, never production secrets.
        monkeypatch.setenv("MULEWATCH_API_KEY", TEST_API_KEY)

        with TestClient(main.app) as client:
            yield client

    return make_client


def prediction_headers():
    return {"x-api-key": TEST_API_KEY}


def test_health_reports_loaded_model(client_factory):
    with client_factory(0.10) as client:
        response = client.get("/health")

    assert response.status_code == 200, (
        f"Health endpoint failed: HTTP {response.status_code}: "
        f"{response.text}"
    )

    body = response.json()

    assert body["status"] == "healthy"
    assert body["model_loaded"] is True
    assert 0 <= float(body["fraud_threshold"]) <= 1


def test_predict_flags_probability_above_threshold(client_factory):
    with client_factory(0.90) as client:
        health_response = client.get("/health")
        assert health_response.status_code == 200, (
            f"Health endpoint failed: {health_response.text}"
        )

        threshold = float(
            health_response.json()["fraud_threshold"]
        )

        if 0.90 < threshold:
            pytest.skip(
                "Test probability is below the configured fraud threshold."
            )

        response = client.post(
            "/predict",
            json=VALID_TRANSACTION,
            headers=prediction_headers(),
        )

    assert response.status_code == 200, (
        f"Prediction failed: HTTP {response.status_code}: "
        f"{response.text}"
    )

    body = response.json()

    assert body["predicted_is_fraud"] is True
    assert body["fraud_probability"] == pytest.approx(0.90)
    assert body["model_version"]


def test_predict_does_not_flag_probability_below_threshold(client_factory):
    with client_factory(0.01) as client:
        response = client.post(
            "/predict",
            json=VALID_TRANSACTION,
            headers=prediction_headers(),
        )

    assert response.status_code == 200, (
        f"Prediction failed: HTTP {response.status_code}: "
        f"{response.text}"
    )

    body = response.json()

    assert body["predicted_is_fraud"] is False
    assert body["fraud_probability"] == pytest.approx(0.01)
    assert body["model_version"]


def test_predict_rejects_missing_required_fields(client_factory):
    with client_factory(0.10) as client:
        response = client.post(
            "/predict",
            json={"step": 100, "type": "TRANSFER"},
            headers=prediction_headers(),
        )

    assert response.status_code == 422, (
        f"Expected validation error, got HTTP {response.status_code}: "
        f"{response.text}"
    )
