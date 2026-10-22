"""Kafka consumer that scores queued transactions through the frontend.

Reads ``raw-transactions`` and forwards each record to the deployed
frontend's ``/api/predict`` (MULEWATCH_API_KEY auth), which scores it via this
service's ``/predict`` and persists it to Supabase. Offsets are committed
manually, and only after that call reports a successful save, so a crash or
outage replays the record instead of losing it. Replays are safe because
``/api/predict`` upserts on the unique ``external_transaction_id`` and the
alerts table is unique on (transaction_id, reason).

Outcomes per record:
  * success    -> if flagged, publish a fraud_alerts event; then commit
                  offset + 1 (a failed event publish leaves it uncommitted)
  * permanent  -> publish to the DLQ topic, commit only after the DLQ ack
  * retryable  -> no commit; seek back and retry with capped backoff

Nothing here logs payloads, keys, credentials or broker addresses.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Optional

import httpx

logger = logging.getLogger("mulewatch.kafka")

# aiokafka logs broker hosts and protocol detail at INFO; keep it quiet.
logging.getLogger("aiokafka").setLevel(logging.WARNING)

TRANSACTION_TYPES = {"PAYMENT", "TRANSFER", "CASH_OUT", "CASH_IN", "DEBIT"}
NUMERIC_FIELDS = (
    "step",
    "amount",
    "oldbalanceOrg",
    "oldbalanceDest",
    "orig_txn_count_before",
    "dest_txn_count_before",
    "dest_is_merchant",
)
MAX_RECORD_BYTES = 64 * 1024
# /api/predict status codes that a retry can never fix.
PERMANENT_STATUSES = {400, 413, 422}


class Outcome(Enum):
    SUCCESS = "success"
    PERMANENT = "permanent"
    RETRY = "retry"


@dataclass(frozen=True)
class KafkaSettings:
    brokers: str
    username: str
    password: str
    topic: str
    dlq_topic: str
    fraud_alerts_topic: str
    group_id: str
    mechanism: str
    ca_cert: Optional[str]
    frontend_url: str
    api_key: str
    max_reconnect_attempts: int = 6
    reconnect_base_seconds: float = 5.0
    reconnect_max_seconds: float = 300.0
    retry_base_seconds: float = 2.0
    retry_max_seconds: float = 60.0
    request_timeout_seconds: float = 100.0

    def __repr__(self) -> str:  # never print credentials
        return f"KafkaSettings(topic={self.topic!r}, group_id={self.group_id!r})"

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> Optional["KafkaSettings"]:
        """Settings, or None when the consumer is not configured."""
        env = os.environ if env is None else env
        required = {
            name: (env.get(name) or "").strip()
            for name in (
                "KAFKA_BROKERS",
                "KAFKA_USERNAME",
                "KAFKA_PASSWORD",
                "MULEWATCH_FRONTEND_URL",
                "MULEWATCH_API_KEY",
            )
        }
        if not all(required.values()):
            return None
        ca = (env.get("KAFKA_CA_CERT") or "").replace("\\n", "\n").strip()
        return cls(
            brokers=required["KAFKA_BROKERS"],
            username=required["KAFKA_USERNAME"],
            password=required["KAFKA_PASSWORD"],
            topic=(env.get("KAFKA_TOPIC") or "raw-transactions").strip(),
            dlq_topic=(env.get("KAFKA_DLQ_TOPIC") or "raw-transactions-dlq").strip(),
            fraud_alerts_topic=(env.get("KAFKA_FRAUD_ALERTS_TOPIC") or "fraud_alerts").strip(),
            group_id=(env.get("KAFKA_CONSUMER_GROUP") or "mulewatch-predict-consumer").strip(),
            mechanism=(env.get("KAFKA_SASL_MECHANISM") or "PLAIN").strip().upper(),
            ca_cert=ca or None,
            frontend_url=required["MULEWATCH_FRONTEND_URL"].rstrip("/"),
            api_key=required["MULEWATCH_API_KEY"],
        )

    def client_options(self) -> dict:
        from aiokafka.helpers import create_ssl_context

        return {
            "bootstrap_servers": [b.strip() for b in self.brokers.split(",") if b.strip()],
            "security_protocol": "SASL_SSL",
            "sasl_mechanism": self.mechanism,
            "sasl_plain_username": self.username,
            "sasl_plain_password": self.password,
            # Aiven signs broker certificates with a per-project CA.
            "ssl_context": create_ssl_context(cadata=self.ca_cert) if self.ca_cert else create_ssl_context(),
        }


def _non_negative(value: Any, integer: bool = False) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if not math.isfinite(value) or value < 0:
        return False
    return not integer or float(value).is_integer()


def _optional_id(value: Any, max_length: int) -> bool:
    return value is None or (isinstance(value, str) and 0 < len(value) <= max_length)


def validate_transaction(payload: Any) -> Optional[str]:
    """Mirror of /api/predict's checks; returns an error code or None."""
    if not isinstance(payload, dict):
        return "not_an_object"
    if payload.get("type") not in TRANSACTION_TYPES:
        return "invalid_type"
    for field in NUMERIC_FIELDS:
        value = payload.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return "invalid_number"
    if not (
        _non_negative(payload["step"], integer=True)
        and _non_negative(payload["amount"])
        and _non_negative(payload["oldbalanceOrg"])
        and _non_negative(payload["oldbalanceDest"])
        and _non_negative(payload["orig_txn_count_before"], integer=True)
        and _non_negative(payload["dest_txn_count_before"], integer=True)
        and payload["dest_is_merchant"] in (0, 1)
        and _optional_id(payload.get("external_transaction_id"), 150)
        and _optional_id(payload.get("source_account_external_id"), 200)
        and _optional_id(payload.get("destination_account_external_id"), 200)
    ):
        return "invalid_field"
    return None


def parse_record(record: Any) -> tuple[Optional[dict], Optional[str]]:
    """Decodes and validates a record; returns (payload, error_code)."""
    value = record.value
    if value is None:
        return None, "empty_record"
    if len(value) > MAX_RECORD_BYTES:
        return None, "record_too_large"
    try:
        payload = json.loads(value)
    except (UnicodeDecodeError, ValueError):
        return None, "invalid_json"
    error = validate_transaction(payload)
    if error:
        return None, error

    if payload.get("external_transaction_id") is None:
        # Every delivery of a record needs the same ID or /api/predict would
        # mint a new one per attempt and store duplicates. The key is the ID
        # the producer chose; failing that, the record's own coordinates.
        key = record.key.decode("utf-8", "replace") if record.key else ""
        payload["external_transaction_id"] = (
            key if 0 < len(key) <= 150 else f"kafka-{record.topic}-{record.partition}-{record.offset}"
        )
    return payload, None


class TransactionConsumer:
    def __init__(
        self,
        settings: KafkaSettings,
        *,
        consumer_factory: Optional[Callable[[], Any]] = None,
        producer_factory: Optional[Callable[[], Any]] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.settings = settings
        self._consumer_factory = consumer_factory or self._default_consumer
        self._producer_factory = producer_factory or self._default_producer
        self._http = http_client
        self._owns_http = http_client is None
        self._sleep = sleep
        self._task: Optional[asyncio.Task] = None
        self._retry_attempts: dict[tuple, int] = {}
        self.state = "idle"
        self.last_error: Optional[str] = None

    # Clients -------------------------------------------------------------

    def _default_consumer(self):
        from aiokafka import AIOKafkaConsumer

        return AIOKafkaConsumer(
            self.settings.topic,
            group_id=self.settings.group_id,
            client_id="mulewatch-api-consumer",
            enable_auto_commit=False,
            auto_offset_reset="earliest",
            # One record can wait up to ~100 s on a cold model plus backoff.
            max_poll_interval_ms=600_000,
            **self.settings.client_options(),
        )

    def _default_producer(self):
        from aiokafka import AIOKafkaProducer

        return AIOKafkaProducer(
            client_id="mulewatch-api-dlq",
            acks="all",
            enable_idempotence=True,
            **self.settings.client_options(),
        )

    # Lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Starts the background task; never blocks the HTTP server."""
        if self._task is None:
            self._task = asyncio.create_task(self.run(), name="mulewatch-kafka-consumer")

    async def stop(self, timeout: float = 10.0) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        if self._http is not None and self._owns_http:
            await self._http.aclose()
            self._http = None
        self.state = "stopped"

    async def run(self) -> None:
        """Connects and consumes, reconnecting a bounded number of times."""
        failures = 0
        while True:
            consumer = producer = None
            try:
                self.state = "connecting"
                consumer = self._consumer_factory()
                producer = self._producer_factory()
                await consumer.start()
                await producer.start()
                failures = 0
                self.state = "running"
                logger.info("Kafka consumer started.")
                await self._consume(consumer, producer)
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # connection, auth or broker failure
                failures += 1
                self.last_error = type(exc).__name__
                logger.warning("Kafka consumer error (%s), attempt %d.", self.last_error, failures)
                if failures >= self.settings.max_reconnect_attempts:
                    self.state = "failed"
                    logger.error("Kafka consumer stopped after %d failed attempts.", failures)
                    return
                self.state = "reconnecting"
            finally:
                await _quietly_stop(producer)
                await _quietly_stop(consumer)
            await self._sleep(
                min(
                    self.settings.reconnect_base_seconds * 2 ** (failures - 1),
                    self.settings.reconnect_max_seconds,
                )
            )

    async def _consume(self, consumer, producer) -> None:
        while True:
            record = await consumer.getone()
            await self.handle(record, consumer, producer)

    # Per record -----------------------------------------------------------

    async def handle(self, record, consumer, producer) -> Outcome:
        """Processes one record and commits or rewinds accordingly."""
        from aiokafka import TopicPartition

        tp = TopicPartition(record.topic, record.partition)
        coords = (record.topic, record.partition, record.offset)
        outcome, code, prediction = await self._score(record)

        if outcome is Outcome.SUCCESS and prediction.get("predicted_is_fraud") is True:
            if not await self._publish_fraud_alert(producer, prediction):
                # The transaction is saved, but the event is not: replaying the
                # record re-runs the idempotent save and retries the event.
                code, outcome = "fraud_alert_publish_failed", Outcome.RETRY

        if outcome is Outcome.PERMANENT:
            if await self._publish_dlq(producer, record, code):
                outcome = Outcome.SUCCESS  # safely parked; commit below
            else:
                code = "dlq_publish_failed"
                outcome = Outcome.RETRY

        if outcome is Outcome.SUCCESS:
            await consumer.commit({tp: record.offset + 1})
            self._retry_attempts.pop(coords, None)
            self.state = "running"
            return Outcome.SUCCESS

        attempt = self._retry_attempts.get(coords, 0) + 1
        self._retry_attempts = {coords: attempt}  # only the head record retries
        self.state = "retrying"
        self.last_error = code
        logger.warning(
            "Record p%d@%d not committed (%s); retry %d.", record.partition, record.offset, code, attempt
        )
        consumer.seek(tp, record.offset)
        await self._sleep(
            min(self.settings.retry_base_seconds * 2 ** (attempt - 1), self.settings.retry_max_seconds)
        )
        return Outcome.RETRY

    async def process(self, record) -> tuple[Outcome, str]:
        outcome, code, _ = await self._score(record)
        return outcome, code

    async def _score(self, record) -> tuple[Outcome, str, dict]:
        """Like process, plus /api/predict's body on success."""
        payload, error = parse_record(record)
        if error:
            return Outcome.PERMANENT, error, {}

        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self.settings.request_timeout_seconds)
        try:
            response = await self._http.post(
                f"{self.settings.frontend_url}/api/predict",
                json=payload,
                headers={"x-api-key": self.settings.api_key},
            )
        except httpx.TimeoutException:
            return Outcome.RETRY, "predict_timeout", {}
        except httpx.HTTPError:
            return Outcome.RETRY, "predict_unreachable", {}

        if response.status_code == 200:
            try:
                body = response.json()
            except ValueError:
                body = None
            if isinstance(body, dict) and body.get("saved_to_supabase") is True:
                return Outcome.SUCCESS, "ok", body
            return Outcome.RETRY, "predict_unconfirmed", {}
        if response.status_code in PERMANENT_STATUSES:
            return Outcome.PERMANENT, f"predict_rejected_{response.status_code}", {}
        # 401/403 (key mismatch), 404 (wrong URL), 429 and 5xx (model or
        # database outage) can all recover, so the record waits.
        return Outcome.RETRY, f"predict_status_{response.status_code}", {}

    async def _publish_fraud_alert(self, producer, prediction: dict) -> bool:
        """Hands a model-flagged, persisted transaction to fraud_alerts.

        Keyed by external_transaction_id, with a deterministic event_id, so a
        replayed record yields the same key and ID for consumers to dedupe.
        Carries no account IDs, raw features or database row IDs.
        """
        reference = prediction.get("external_transaction_id")
        if not isinstance(reference, str) or not reference:
            return False
        event = {
            "event_type": "fraud_alert",
            "event_id": f"{reference}:model-flag",
            "external_transaction_id": reference,
            "predicted_is_fraud": True,
            "fraud_probability": prediction.get("fraud_probability"),
            "decision_threshold": prediction.get("decision_threshold"),
            "model_version": prediction.get("model_version"),
            "alert_created": prediction.get("alert_created"),
            "event_time": datetime.now(timezone.utc).isoformat(),
            "source": "mulewatch-kafka-consumer",
        }
        try:
            await producer.send_and_wait(
                self.settings.fraud_alerts_topic,
                value=json.dumps(event).encode(),
                key=reference.encode(),
                headers=[("content-type", b"application/json")],
            )
        except Exception as exc:
            logger.warning("Fraud alert publish failed (%s).", type(exc).__name__)
            return False
        return True

    async def _publish_dlq(self, producer, record, code: str) -> bool:
        headers = [
            ("mulewatch-error", code.encode()),
            ("mulewatch-source-topic", record.topic.encode()),
            ("mulewatch-source-partition", str(record.partition).encode()),
            ("mulewatch-source-offset", str(record.offset).encode()),
            ("mulewatch-failed-at", datetime.now(timezone.utc).isoformat().encode()),
        ]
        try:
            await producer.send_and_wait(
                self.settings.dlq_topic, value=record.value, key=record.key, headers=headers
            )
        except Exception as exc:
            logger.warning("DLQ publish failed (%s).", type(exc).__name__)
            return False
        logger.info("Record p%d@%d sent to DLQ (%s).", record.partition, record.offset, code)
        return True


async def _quietly_stop(client) -> None:
    if client is None:
        return
    try:
        await client.stop()
    except Exception:
        pass
