"""Consumer tests. Kafka clients are in-memory fakes and HTTP goes through
httpx.MockTransport, so nothing reaches a broker, the frontend or Supabase."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from api.kafka_consumer import (
    KafkaSettings,
    Outcome,
    TransactionConsumer,
    parse_record,
)

VALID = {
    "step": 1,
    "type": "TRANSFER",
    "amount": 100.0,
    "oldbalanceOrg": 100.0,
    "oldbalanceDest": 0.0,
    "orig_txn_count_before": 0,
    "dest_txn_count_before": 0,
    "dest_is_merchant": 0,
    "external_transaction_id": "ext-1",
}

ENV = {
    "KAFKA_BROKERS": "broker.test:1",
    "KAFKA_USERNAME": "test-user",
    "KAFKA_PASSWORD": "test-password",
    "MULEWATCH_FRONTEND_URL": "https://frontend.test/",
    "MULEWATCH_API_KEY": "test-api-key",
}


def record(payload=VALID, offset=5, key=b"ext-1", raw=None):
    value = raw if raw is not None else json.dumps(payload).encode()
    return SimpleNamespace(topic="raw-transactions", partition=0, offset=offset, key=key, value=value)


class FakeConsumer:
    def __init__(self, records=(), fail_start=False):
        self.records = list(records)
        self.commits = []
        self.seeks = []
        self.fail_start = fail_start
        self.started = self.stopped = False

    async def start(self):
        if self.fail_start:
            raise ConnectionError("broker.test:1 unreachable")
        self.started = True

    async def stop(self):
        self.stopped = True

    async def getone(self):
        if self.records:
            return self.records.pop(0)
        await asyncio.Event().wait()  # block like a real idle consumer

    async def commit(self, offsets):
        self.commits.append({(tp.topic, tp.partition): o for tp, o in offsets.items()})

    def seek(self, tp, offset):
        self.seeks.append(offset)
        # Redeliver the record, as a real consumer would after a seek.
        self.records.insert(0, self._last)

    def remember(self, rec):
        self._last = rec


class FakeProducer:
    def __init__(self, fail=False, fail_times=0):
        self.fail = fail
        self.fail_times = fail_times
        self.sent = []

    async def start(self):
        pass

    async def stop(self):
        pass

    async def send_and_wait(self, topic, value=None, key=None, headers=None):
        if self.fail or self.fail_times > 0:
            self.fail_times -= 1
            raise ConnectionError("broker down")
        self.sent.append({"topic": topic, "value": value, "key": key, "headers": dict(headers)})


class Frontend:
    """Mock /api/predict with a uniqueness-enforcing store keyed like the DB."""

    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.calls = []
        self.transactions = {}

    def handler(self, request):
        self.calls.append(request)
        if self.responses:
            result = self.responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        body = json.loads(request.content)
        self.transactions[body["external_transaction_id"]] = body  # upsert
        return httpx.Response(200, json={"saved_to_supabase": True})


def make(frontend=None, consumer=None, producer=None):
    frontend = frontend or Frontend()
    settings = KafkaSettings.from_env(ENV)
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    c = TransactionConsumer(
        settings,
        consumer_factory=lambda: consumer,
        producer_factory=lambda: producer,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(frontend.handler)),
        sleep=sleep,
    )
    return c, frontend, sleeps


def handle(c, rec, consumer, producer):
    consumer.remember(rec)
    return asyncio.run(c.handle(rec, consumer, producer))


# Settings ----------------------------------------------------------------


def test_settings_require_every_secret_and_hide_them():
    for name in ENV:
        assert KafkaSettings.from_env({**ENV, name: ""}) is None
    settings = KafkaSettings.from_env(ENV)
    assert settings.topic == "raw-transactions"
    assert settings.dlq_topic == "raw-transactions-dlq"
    assert settings.group_id == "mulewatch-predict-consumer"
    assert settings.frontend_url == "https://frontend.test"
    assert "test-password" not in repr(settings)
    assert "test-api-key" not in repr(settings)


def test_client_options_use_sasl_ssl_plain():
    options = KafkaSettings.from_env(ENV).client_options()
    assert options["security_protocol"] == "SASL_SSL"
    assert options["sasl_mechanism"] == "PLAIN"
    assert options["bootstrap_servers"] == ["broker.test:1"]


# Parsing ------------------------------------------------------------------


@pytest.mark.parametrize(
    "rec, code",
    [
        (record(raw=b"{nope"), "invalid_json"),
        (record(raw=b"[1]"), "not_an_object"),
        (record({**VALID, "type": "BITCOIN"}), "invalid_type"),
        (record({**VALID, "amount": "100"}), "invalid_number"),
        (record({**VALID, "amount": True}), "invalid_number"),
        (record({**VALID, "step": 1.5}), "invalid_field"),
        (record({**VALID, "dest_is_merchant": 2}), "invalid_field"),
        (record(raw=b"x" * 70_000), "record_too_large"),
    ],
)
def test_parse_rejects_invalid_records(rec, code):
    assert parse_record(rec) == (None, code)


def test_parse_derives_a_stable_id_from_key_or_coordinates():
    without_id = {k: v for k, v in VALID.items() if k != "external_transaction_id"}
    payload, _ = parse_record(record(without_id, key=b"from-key"))
    assert payload["external_transaction_id"] == "from-key"
    payload, _ = parse_record(record(without_id, key=None, offset=9))
    assert payload["external_transaction_id"] == "kafka-raw-transactions-0-9"


# Processing ----------------------------------------------------------------


def test_success_forwards_with_api_key_and_commits_after_save():
    c, frontend, _ = make()
    consumer, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), consumer, producer) is Outcome.SUCCESS
    request = frontend.calls[0]
    assert str(request.url) == "https://frontend.test/api/predict"
    assert request.headers["x-api-key"] == "test-api-key"
    assert json.loads(request.content) == VALID
    assert consumer.commits == [{("raw-transactions", 0): 6}]
    assert producer.sent == []


def test_no_commit_when_save_is_not_confirmed():
    c, _, _ = make(Frontend([httpx.Response(200, json={"saved_to_supabase": False})]))
    consumer = FakeConsumer()
    assert handle(c, record(), consumer, FakeProducer()) is Outcome.RETRY
    assert consumer.commits == []


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503, json={"error": "model waking"}),
        httpx.Response(502, json={"error": "db"}),
        httpx.Response(401, json={"error": "key"}),
        httpx.ConnectError("down"),
        httpx.ReadTimeout("slow"),
    ],
)
def test_transient_failures_are_not_committed_and_back_off(response):
    c, _, sleeps = make(Frontend([response]))
    consumer, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), consumer, producer) is Outcome.RETRY
    assert consumer.commits == []
    assert consumer.seeks == [5]
    assert producer.sent == []
    assert sleeps == [2.0]


def test_retry_backoff_grows_and_is_capped():
    c, _, sleeps = make(Frontend([httpx.Response(503)] * 8))
    consumer = FakeConsumer()
    rec = record()
    for _ in range(8):
        handle(c, rec, consumer, FakeProducer())
    assert sleeps == [2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0]
    assert consumer.commits == []


def test_retry_then_success_commits_once():
    c, _, _ = make(Frontend([httpx.Response(503)]))
    consumer = FakeConsumer()
    rec = record()
    assert handle(c, rec, consumer, FakeProducer()) is Outcome.RETRY
    assert handle(c, rec, consumer, FakeProducer()) is Outcome.SUCCESS
    assert consumer.commits == [{("raw-transactions", 0): 6}]


def test_permanent_record_goes_to_dlq_then_commits():
    c, frontend, _ = make()
    consumer, producer = FakeConsumer(), FakeProducer()
    rec = record({**VALID, "type": "BITCOIN"})
    assert handle(c, rec, consumer, producer) is Outcome.SUCCESS
    assert frontend.calls == []
    [sent] = producer.sent
    assert sent["topic"] == "raw-transactions-dlq"
    assert sent["value"] == rec.value and sent["key"] == rec.key
    assert sent["headers"]["mulewatch-error"] == b"invalid_type"
    assert sent["headers"]["mulewatch-source-offset"] == b"5"
    assert consumer.commits == [{("raw-transactions", 0): 6}]


def test_predict_400_is_permanent():
    c, _, _ = make(Frontend([httpx.Response(400, json={"error": "Invalid transaction type."})]))
    consumer, producer = FakeConsumer(), FakeProducer()
    handle(c, record(), consumer, producer)
    assert producer.sent[0]["headers"]["mulewatch-error"] == b"predict_rejected_400"
    assert len(consumer.commits) == 1


def test_dlq_failure_leaves_the_offset_uncommitted():
    c, _, sleeps = make()
    consumer, producer = FakeConsumer(), FakeProducer(fail=True)
    assert handle(c, record(raw=b"{nope"), consumer, producer) is Outcome.RETRY
    assert consumer.commits == []
    assert consumer.seeks == [5]
    assert c.last_error == "dlq_publish_failed"


def test_duplicate_delivery_is_idempotent_by_external_transaction_id():
    c, frontend, _ = make()
    consumer = FakeConsumer()
    handle(c, record(offset=5), consumer, FakeProducer())
    handle(c, record(offset=6), consumer, FakeProducer())  # same event published twice
    handle(c, record(offset=5), consumer, FakeProducer())  # redelivered after a rebalance
    ids = [json.loads(r.content)["external_transaction_id"] for r in frontend.calls]
    assert ids == ["ext-1", "ext-1", "ext-1"]
    assert list(frontend.transactions) == ["ext-1"]
    assert len(consumer.commits) == 3


def test_logs_hold_no_payload_or_secrets(caplog):
    caplog.set_level("DEBUG", logger="mulewatch.kafka")
    c, _, _ = make(Frontend([httpx.Response(503)]))
    handle(c, record(), FakeConsumer(), FakeProducer())
    handle(c, record(raw=b"{nope"), FakeConsumer(), FakeProducer())
    text = caplog.text
    for secret in ("ext-1", "TRANSFER", "test-password", "test-api-key", "broker.test"):
        assert secret not in text


# Lifecycle ---------------------------------------------------------------


def test_run_consumes_until_shutdown_and_closes_clients():
    consumer, producer = FakeConsumer([record()]), FakeProducer()
    c, frontend, _ = make(consumer=consumer, producer=producer)
    consumer.remember(record())

    async def scenario():
        c.start()
        for _ in range(50):
            await asyncio.sleep(0)
            if consumer.commits:
                break
        assert c.state == "running"
        await c.stop()

    asyncio.run(scenario())
    assert consumer.commits == [{("raw-transactions", 0): 6}]
    assert consumer.stopped
    assert c.state == "stopped"


def test_reconnects_with_backoff_then_gives_up():
    c, _, sleeps = make(consumer=FakeConsumer(fail_start=True), producer=FakeProducer())
    asyncio.run(c.run())
    assert c.state == "failed"
    assert c.last_error == "ConnectionError"
    assert sleeps == [5.0, 10.0, 20.0, 40.0, 80.0]


def test_health_reports_disabled_without_kafka_config(monkeypatch):
    from fastapi.testclient import TestClient

    from api import main

    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(main.joblib, "load", lambda *a, **k: object())
    with TestClient(main.app) as client:
        assert client.get("/health").json()["kafka_consumer"] == "disabled"


def test_lifespan_starts_and_stops_the_consumer(monkeypatch):
    from fastapi.testclient import TestClient

    from api import main

    events = []

    class Recorder:
        state = "running"

        def __init__(self, settings):
            events.append("init")

        def start(self):
            events.append("start")

        async def stop(self):
            events.append("stop")

    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(main, "TransactionConsumer", Recorder)
    monkeypatch.setattr(main.joblib, "load", lambda *a, **k: object())
    with TestClient(main.app) as client:
        assert client.get("/health").json()["kafka_consumer"] == "running"
    assert events == ["init", "start", "stop"]


# fraud_alerts events ---------------------------------------------------------

FLAGGED_RESPONSE = {
    "transaction_id": "db-row-uuid",
    "external_transaction_id": "ext-1",
    "predicted_is_fraud": True,
    "fraud_probability": 0.93,
    "model_version": "random-forest-tuned-v2",
    "decision_threshold": 0.405,
    "saved_to_supabase": True,
    "alert_created": True,
}


def flagged(**overrides):
    return httpx.Response(200, json={**FLAGGED_RESPONSE, **overrides})


def test_flagged_transaction_publishes_one_keyed_event_then_commits():
    c, _, _ = make(Frontend([flagged()]))
    consumer, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), consumer, producer) is Outcome.SUCCESS

    [sent] = producer.sent
    assert sent["topic"] == "fraud_alerts"
    assert sent["key"] == b"ext-1"
    event = json.loads(sent["value"])
    assert event["event_id"] == "ext-1:model-flag"
    assert event["external_transaction_id"] == "ext-1"
    assert event["predicted_is_fraud"] is True
    assert event["fraud_probability"] == 0.93
    assert event["model_version"] == "random-forest-tuned-v2"
    assert "event_time" in event
    # No database row ID, account data or raw features.
    for leak in ("db-row-uuid", "source_account", "amount", "oldbalance"):
        assert leak not in sent["value"].decode()
    assert consumer.commits == [{("raw-transactions", 0): 6}]


def test_topic_is_configurable():
    settings = KafkaSettings.from_env({**ENV, "KAFKA_FRAUD_ALERTS_TOPIC": "fraud-alerts-test"})
    assert settings.fraud_alerts_topic == "fraud-alerts-test"
    assert KafkaSettings.from_env(ENV).fraud_alerts_topic == "fraud_alerts"


def test_non_fraud_publishes_nothing():
    c, _, _ = make(Frontend([flagged(predicted_is_fraud=False)]))
    consumer, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), consumer, producer) is Outcome.SUCCESS
    assert producer.sent == []
    assert len(consumer.commits) == 1


def test_unsaved_flagged_result_publishes_nothing_and_retries():
    c, _, _ = make(Frontend([flagged(saved_to_supabase=False)]))
    consumer, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), consumer, producer) is Outcome.RETRY
    assert producer.sent == []
    assert consumer.commits == []


def test_broker_failure_keeps_the_source_record_uncommitted_then_retry_succeeds():
    c, frontend, sleeps = make(Frontend([flagged(), flagged(alert_created=False)]))
    consumer, producer = FakeConsumer(), FakeProducer(fail_times=1)
    rec = record()

    assert handle(c, rec, consumer, producer) is Outcome.RETRY
    assert consumer.commits == []
    assert consumer.seeks == [5]
    assert c.last_error == "fraud_alert_publish_failed"
    assert sleeps == [2.0]

    # Redelivery re-runs the idempotent save, then publishes and commits.
    assert handle(c, rec, consumer, producer) is Outcome.SUCCESS
    assert len(frontend.calls) == 2
    assert [s["topic"] for s in producer.sent] == ["fraud_alerts"]
    assert consumer.commits == [{("raw-transactions", 0): 6}]


def test_redelivery_after_commit_loss_repeats_the_same_event_identity():
    """At-least-once: a replay can publish again, with an identical key and event_id."""
    c, _, _ = make(Frontend([flagged(), flagged(alert_created=False)]))
    consumer, producer = FakeConsumer(), FakeProducer()
    handle(c, record(offset=5), consumer, producer)
    handle(c, record(offset=5), consumer, producer)
    events = [json.loads(s["value"]) for s in producer.sent]
    assert [s["key"] for s in producer.sent] == [b"ext-1", b"ext-1"]
    assert {e["event_id"] for e in events} == {"ext-1:model-flag"}


def test_flagged_response_without_reference_is_not_committed():
    c, _, _ = make(Frontend([flagged(external_transaction_id=None)]))
    consumer, producer = FakeConsumer(), FakeProducer()
    assert handle(c, record(), consumer, producer) is Outcome.RETRY
    assert consumer.commits == []


def test_cold_path_wake_is_best_effort_and_never_blocks_the_commit():
    pings = []

    def handler(request):
        if request.url.path == "/wake":
            pings.append(request.headers.get("x-api-key"))
            raise httpx.ConnectError("asleep")
        return flagged()

    settings = KafkaSettings.from_env({**ENV, "COLD_PATH_WAKE_URL": "https://cold.test/wake"})
    c = TransactionConsumer(
        settings,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        sleep=lambda s: asyncio.sleep(0),
    )
    consumer, producer = FakeConsumer(), FakeProducer()
    consumer.remember(record())

    async def scenario():
        outcome = await c.handle(record(), consumer, producer)
        await asyncio.gather(*c._background)
        return outcome

    assert asyncio.run(scenario()) is Outcome.SUCCESS
    assert pings == ["test-api-key"]
    assert consumer.commits == [{("raw-transactions", 0): 6}]
