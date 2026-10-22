"""Cold path tests. Kafka, MongoDB, Supabase and the explainer are fakes; the
one real-model test only reads the committed artefact from disk."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import joblib
import pytest

from api.cold_path import pipeline as pipeline_module
from api.cold_path.consumer import ColdPathSettings, FraudAlertConsumer
from api.cold_path.explain import explain_prediction
from api.cold_path.ledger import Ledger, LedgerUnavailable, TransactionMissing
from api.cold_path.pipeline import PermanentError, build_pipeline, parse_event
from api.kafka_consumer import KafkaSettings, Outcome
from api.tests.test_kafka_consumer import FakeConsumer, FakeProducer

EVENT = {
    "event_type": "fraud_alert",
    "event_id": "ext-1:model-flag",
    "external_transaction_id": "ext-1",
    "predicted_is_fraud": True,
    "fraud_probability": 0.93,
    "decision_threshold": 0.405,
    "model_version": "random-forest-tuned-v2",
    "alert_created": True,
    "event_time": "2026-10-23T00:00:00+00:00",
    "source": "mulewatch-kafka-consumer",
}
FEATURES = {
    "step": 100,
    "type": "TRANSFER",
    "amount": 9000.0,
    "oldbalanceOrg": 9000.0,
    "oldbalanceDest": 0.0,
    "orig_txn_count_before": 0,
    "dest_txn_count_before": 0,
    "dest_is_merchant": 0,
}
CONTEXT = {
    "features": FEATURES,
    "transaction_step": 100,
    "graph": {"available": True, "onward_transfers_from_receiver": 1, "sender_distinct_receivers_in_window": 2},
}
ENV = {
    "KAFKA_BROKERS": "broker.test:1",
    "KAFKA_USERNAME": "test-user",
    "KAFKA_PASSWORD": "test-password",
    "MONGODB_URI": "mongodb+srv://test-user:test-secret@cluster.test",
    "MONGODB_DATABASE": "mulewatch_test",
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service-key",
}


class FakeStore:
    def __init__(self, fail_saves=0, fail_exists=False):
        self.docs = {}
        self.fail_saves = fail_saves
        self.fail_exists = fail_exists

    async def exists(self, event_id):
        if self.fail_exists:
            raise ConnectionError("atlas down")
        return event_id in self.docs

    async def save(self, doc):
        if self.fail_saves:
            self.fail_saves -= 1
            raise ConnectionError("atlas down")
        if doc["_id"] in self.docs:
            return False
        self.docs[doc["_id"]] = doc
        return True


class FakeLedger:
    def __init__(self, result=CONTEXT):
        self.result = result
        self.calls = 0

    async def context(self, reference):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture(autouse=True)
def fake_explainer(monkeypatch):
    calls = []

    def explain(model, features):
        calls.append(features)
        return {"method": "test", "fraud_probability": 0.93, "contributions": []}

    monkeypatch.setattr(pipeline_module, "explain_prediction", explain)
    return calls


def record(event=EVENT, offset=7, raw=None):
    value = raw if raw is not None else json.dumps(event).encode()
    return SimpleNamespace(topic="fraud_alerts", partition=0, offset=offset, key=b"ext-1", value=value)


def make(store=None, ledger=None):
    store = store or FakeStore()
    ledger = ledger or FakeLedger()
    settings = ColdPathSettings.from_env(ENV)
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    consumer = FraudAlertConsumer(
        settings.kafka,
        build_pipeline(store=store, ledger=ledger, model=object()),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500))),
        sleep=sleep,
    )
    return consumer, store, ledger, sleeps


def handle(c, rec, kafka_consumer, producer):
    kafka_consumer.remember(rec)
    return asyncio.run(c.handle(rec, kafka_consumer, producer))


# Settings ----------------------------------------------------------------


def test_settings_use_their_own_group_and_hide_secrets():
    for name in ENV:
        assert ColdPathSettings.from_env({**ENV, name: ""}) is None
    s = ColdPathSettings.from_env(ENV)
    assert s.kafka.topic == "fraud_alerts"
    assert s.kafka.group_id == "mulewatch-cold-path"
    assert s.kafka.group_id != KafkaSettings.from_env({**ENV, "MULEWATCH_FRONTEND_URL": "x", "MULEWATCH_API_KEY": "k"}).group_id
    assert s.kafka.dlq_topic == "fraud_alerts_dlq"
    for secret in ("test-secret", "test-password", "test-service-key"):
        assert secret not in repr(s)


# Processing ----------------------------------------------------------------


def test_success_persists_then_commits(fake_explainer):
    c, store, _, _ = make()
    kc, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), kc, producer) is Outcome.SUCCESS
    doc = store.docs["ext-1:model-flag"]
    assert doc["external_transaction_id"] == "ext-1"
    assert doc["explanation"]["status"] == "ok"
    assert doc["graph_context"]["onward_transfers_from_receiver"] == 1
    assert doc["subgraphx"]["status"] == "unavailable"
    assert fake_explainer == [FEATURES]
    assert kc.commits == [{("fraud_alerts", 0): 8}]
    assert producer.sent == []  # nothing republished, no loop


def test_mongo_failure_is_not_committed_then_retry_succeeds():
    c, store, _, sleeps = make(store=FakeStore(fail_saves=1))
    kc, producer = FakeConsumer(), FakeProducer()
    rec = record()
    assert handle(c, rec, kc, producer) is Outcome.RETRY
    assert kc.commits == [] and kc.seeks == [7]
    assert c.last_error == "mongo_ConnectionError"
    assert handle(c, rec, kc, producer) is Outcome.SUCCESS
    assert list(store.docs) == ["ext-1:model-flag"]
    assert kc.commits == [{("fraud_alerts", 0): 8}]
    assert sleeps == [2.0]


def test_mongo_read_failure_retries():
    c, _, _, _ = make(store=FakeStore(fail_exists=True))
    kc = FakeConsumer()
    assert handle(c, record(), kc, FakeProducer()) is Outcome.RETRY
    assert kc.commits == []


def test_supabase_outage_retries_without_writing():
    c, store, _, _ = make(ledger=FakeLedger(LedgerUnavailable("status_503")))
    kc = FakeConsumer()
    assert handle(c, record(), kc, FakeProducer()) is Outcome.RETRY
    assert store.docs == {} and kc.commits == []


def test_duplicate_event_id_is_committed_without_reprocessing(fake_explainer):
    c, store, ledger, _ = make()
    kc = FakeConsumer()
    handle(c, record(offset=7), kc, FakeProducer())
    handle(c, record(offset=9), kc, FakeProducer())  # same event republished
    assert len(store.docs) == 1
    assert ledger.calls == 1 and len(fake_explainer) == 1
    assert kc.commits == [{("fraud_alerts", 0): 8}, {("fraud_alerts", 0): 10}]


def test_concurrent_duplicate_write_does_not_overwrite():
    store = FakeStore()
    store.docs["ext-1:model-flag"] = {"_id": "ext-1:model-flag", "original": True}
    assert asyncio.run(store.save({"_id": "ext-1:model-flag"})) is False
    assert store.docs["ext-1:model-flag"]["original"] is True


@pytest.mark.parametrize(
    "raw, code",
    [
        (b"{nope", "invalid_json"),
        (json.dumps({**EVENT, "event_type": "other"}).encode(), "not_a_fraud_alert"),
        (json.dumps({**EVENT, "event_id": ""}).encode(), "invalid_event_id"),
        (json.dumps({**EVENT, "predicted_is_fraud": False}).encode(), "not_flagged"),
        (b"x" * 20_000, "event_too_large"),
    ],
)
def test_malformed_events_go_to_dlq_then_commit(raw, code):
    c, store, _, _ = make()
    kc, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(raw=raw), kc, producer) is Outcome.SUCCESS
    [sent] = producer.sent
    assert sent["topic"] == "fraud_alerts_dlq"
    assert sent["headers"]["mulewatch-error"] == code.encode()
    assert store.docs == {} and len(kc.commits) == 1


def test_missing_ledger_row_goes_to_dlq():
    c, _, _, _ = make(ledger=FakeLedger(TransactionMissing()))
    producer = FakeProducer()
    handle(c, record(), FakeConsumer(), producer)
    assert producer.sent[0]["headers"]["mulewatch-error"] == b"transaction_not_found"


def test_dlq_failure_keeps_malformed_event_uncommitted():
    c, _, _, _ = make()
    kc = FakeConsumer()
    assert handle(c, record(raw=b"{nope"), kc, FakeProducer(fail=True)) is Outcome.RETRY
    assert kc.commits == []


def test_missing_features_are_recorded_truthfully(fake_explainer):
    c, store, _, _ = make(ledger=FakeLedger({**CONTEXT, "features": None}))
    handle(c, record(), FakeConsumer(), FakeProducer())
    assert store.docs["ext-1:model-flag"]["explanation"]["status"] == "unavailable"
    assert fake_explainer == []


def test_logs_hold_no_payload_or_secrets(caplog):
    caplog.set_level("DEBUG")
    c, _, _, _ = make(store=FakeStore(fail_saves=1))
    handle(c, record(), FakeConsumer(), FakeProducer())
    handle(c, record(raw=b"{nope"), FakeConsumer(), FakeProducer())
    for secret in ("ext-1", "test-secret", "test-password", "test-service-key", "9000"):
        assert secret not in caplog.text


# Lifecycle ---------------------------------------------------------------


def test_shutdown_stops_the_consumer_and_closes_clients():
    kc = FakeConsumer([record()])
    kc.remember(record())
    store = FakeStore()
    settings = ColdPathSettings.from_env(ENV)
    c = FraudAlertConsumer(
        settings.kafka,
        build_pipeline(store=store, ledger=FakeLedger(), model=object()),
        consumer_factory=lambda: kc,
        producer_factory=lambda: FakeProducer(),
    )

    async def scenario():
        c.start()
        for _ in range(100):
            await asyncio.sleep(0)
            if kc.commits:
                break
        await c.stop()

    asyncio.run(scenario())
    assert kc.commits == [{("fraud_alerts", 0): 8}]
    assert kc.stopped and c.state == "stopped"


def test_service_b_health_and_wake(monkeypatch):
    from fastapi.testclient import TestClient

    from api.cold_path import main

    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    with TestClient(main.app) as client:
        assert client.get("/health").json() == {"status": "healthy", "fraud_alerts_consumer": "disabled"}
        assert client.post("/wake").status_code == 401
        main.app.state.settings = ColdPathSettings.from_env({**ENV, "MULEWATCH_API_KEY": "wake-key"})
        assert client.post("/wake", headers={"x-api-key": "wrong"}).status_code == 401
        assert client.post("/wake", headers={"x-api-key": "wake-key"}).status_code == 204


# Ledger client (HTTP mocked) --------------------------------------------------


def test_ledger_counts_neighbourhood_and_maps_errors():
    def handler(request):
        params = dict(request.url.params)
        if params.get("external_transaction_id") == "eq.ext-1":
            return httpx.Response(
                200,
                json=[{"id": "t0", "source_account_id": "A", "destination_account_id": "B", "transaction_step": 100, "metadata": {"model_features": FEATURES}}],
            )
        if params.get("source_account_id") == "eq.B":
            assert params["and"] == "(transaction_step.gt.100,transaction_step.lt.124)"
            return httpx.Response(200, json=[{"id": "t1"}])
        if params.get("source_account_id") == "eq.A":
            assert params["and"] == "(transaction_step.gt.76,transaction_step.lt.124)"
            return httpx.Response(200, json=[{"destination_account_id": "C"}, {"destination_account_id": "B"}])
        return httpx.Response(200, json=[])

    ledger = Ledger("https://example.supabase.co", "k", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    ctx = asyncio.run(ledger.context("ext-1"))
    assert ctx["features"] == FEATURES
    assert ctx["graph"]["onward_transfers_from_receiver"] == 1
    assert ctx["graph"]["sender_distinct_receivers_in_window"] == 2
    assert "A" not in json.dumps(ctx["graph"])

    empty = Ledger("https://x", "k", httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[]))))
    with pytest.raises(TransactionMissing):
        asyncio.run(empty.context("nope"))
    down = Ledger("https://x", "k", httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))))
    with pytest.raises(LedgerUnavailable):
        asyncio.run(down.context("ext-1"))


def test_parse_event_accepts_the_published_contract():
    assert parse_event(json.dumps(EVENT).encode())["event_id"] == "ext-1:model-flag"
    with pytest.raises(PermanentError):
        parse_event(None)


# Real artefact ---------------------------------------------------------------


def test_explanation_reconstructs_the_real_models_probability():
    from api import main as service_a

    model = joblib.load(service_a.MODEL_PATH)
    result = explain_prediction(model, FEATURES)
    assert result["reconstruction_error"] < 1e-6
    assert result["fraud_probability"] == pytest.approx(model.predict_proba(
        __import__("pandas").DataFrame([{k: FEATURES[k] for k in ["step", "amount", "oldbalanceOrg", "oldbalanceDest", "orig_txn_count_before", "dest_txn_count_before", "dest_is_merchant", "type"]}])
    )[0][1], abs=1e-6)
    assert {c["feature"] for c in result["contributions"]} <= set(FEATURES)
    with pytest.raises(ValueError):
        explain_prediction(model, {"step": 1})
