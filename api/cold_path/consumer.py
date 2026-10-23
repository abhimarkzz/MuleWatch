"""fraud_alerts consumer for the cold path (Service B).

Reuses the hot-path TransactionConsumer's machinery unchanged: bounded
reconnects, manual commits, seek-back retries with capped backoff, and DLQ
publishing for permanent failures. Only the per-record work differs: the
LangGraph pipeline instead of an /api/predict call.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

from api.kafka_consumer import KafkaSettings, Outcome, TransactionConsumer
from api.cold_path.pipeline import PermanentError, RetryableError

logger = logging.getLogger("mulewatch.cold_path")

# An unexpected error that repeats this many times on one record is treated as
# a poison message and sent to the DLQ, so it can't block the partition
# forever. Known outages (MongoDB, Supabase) keep retrying without a cap.
MAX_UNEXPECTED_ATTEMPTS = 5


@dataclass(frozen=True)
class ColdPathSettings:
    kafka: KafkaSettings
    mongodb_uri: str
    mongodb_database: str
    supabase_url: str
    supabase_service_key: str
    api_key: Optional[str]

    def __repr__(self) -> str:  # never print credentials
        return f"ColdPathSettings(topic={self.kafka.topic!r}, group_id={self.kafka.group_id!r})"

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> Optional["ColdPathSettings"]:
        env = os.environ if env is None else env
        get = lambda name: (env.get(name) or "").strip()  # noqa: E731
        required = [
            "KAFKA_BROKERS",
            "KAFKA_USERNAME",
            "KAFKA_PASSWORD",
            "MONGODB_URI",
            "MONGODB_DATABASE",
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
        ]
        if not all(get(name) for name in required):
            return None
        ca = get("KAFKA_CA_CERT").replace("\\n", "\n")
        kafka = KafkaSettings(
            brokers=get("KAFKA_BROKERS"),
            username=get("KAFKA_USERNAME"),
            password=get("KAFKA_PASSWORD"),
            topic=get("KAFKA_FRAUD_ALERTS_TOPIC") or "fraud_alerts",
            dlq_topic=get("KAFKA_COLD_PATH_DLQ_TOPIC") or "fraud_alerts_dlq",
            fraud_alerts_topic="",  # unused: this service never publishes alerts
            group_id=get("KAFKA_COLD_PATH_GROUP") or "mulewatch-cold-path",
            mechanism=(get("KAFKA_SASL_MECHANISM") or "PLAIN").upper(),
            ca_cert=ca or None,
            frontend_url="",
            api_key="",
        )
        return cls(
            kafka=kafka,
            mongodb_uri=get("MONGODB_URI"),
            mongodb_database=get("MONGODB_DATABASE"),
            supabase_url=get("SUPABASE_URL"),
            supabase_service_key=get("SUPABASE_SERVICE_ROLE_KEY"),
            api_key=get("MULEWATCH_API_KEY") or None,
        )


class FraudAlertConsumer(TransactionConsumer):
    def __init__(self, settings: KafkaSettings, pipeline, **kwargs):
        super().__init__(settings, **kwargs)
        self._pipeline = pipeline

    async def _score(self, record) -> tuple[Outcome, str, dict]:
        """Runs the pipeline; returns no prediction, so nothing is re-published."""
        try:
            state = await self._pipeline.ainvoke({"raw": record.value})
        except PermanentError as exc:
            return Outcome.PERMANENT, exc.code, {}
        except RetryableError as exc:
            return Outcome.RETRY, exc.code, {}
        except Exception as exc:  # unexpected: retry a few times, then DLQ
            attempts = self._retry_attempts.get((record.topic, record.partition, record.offset), 0) + 1
            if attempts >= MAX_UNEXPECTED_ATTEMPTS:
                return Outcome.PERMANENT, "pipeline_error_exhausted", {}
            return Outcome.RETRY, f"pipeline_{type(exc).__name__}", {}
        if state.get("duplicate"):
            logger.info("Record p%d@%d already explained; committing.", record.partition, record.offset)
        return Outcome.SUCCESS, "ok", {}
