"""LangGraph orchestration for one fraud_alerts event.

    validate ─▶ check_duplicate ─(already stored)─▶ END
                     │
                     ▼
               load_context ─▶ explain ─▶ persist ─▶ END

Nodes raise PermanentError (the event can never succeed: DLQ) or
RetryableError (Supabase or MongoDB trouble: retry, no commit). The run
completes only after MongoDB acknowledged the write.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from api.cold_path.explain import explain_prediction
from api.cold_path.ledger import LedgerUnavailable, TransactionMissing

PIPELINE_VERSION = "cold-path-1"
MAX_EVENT_BYTES = 16 * 1024

SUBGRAPHX_UNAVAILABLE = {
    "status": "unavailable",
    "reason": "SubgraphX explains a graph neural network; MuleWatch has no trained GNN (only a scikit-learn Random Forest), so no SubgraphX output is produced.",
}


class PermanentError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RetryableError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class State(TypedDict, total=False):
    raw: bytes
    event: dict
    duplicate: bool
    context: dict
    explanation: dict
    stored: bool


def parse_event(raw: Optional[bytes]) -> dict:
    """Validates the fraud_alerts contract published by the hot-path consumer."""
    if raw is None:
        raise PermanentError("empty_event")
    if len(raw) > MAX_EVENT_BYTES:
        raise PermanentError("event_too_large")
    try:
        event = json.loads(raw)
    except (UnicodeDecodeError, ValueError):
        raise PermanentError("invalid_json") from None
    if not isinstance(event, dict) or event.get("event_type") != "fraud_alert":
        raise PermanentError("not_a_fraud_alert")
    for field in ("event_id", "external_transaction_id"):
        value = event.get(field)
        if not isinstance(value, str) or not 0 < len(value) <= 200:
            raise PermanentError(f"invalid_{field}")
    if event.get("predicted_is_fraud") is not True:
        raise PermanentError("not_flagged")
    return event


def build_pipeline(*, store, ledger, model):
    async def validate(state: State) -> State:
        return {"event": parse_event(state.get("raw"))}

    async def check_duplicate(state: State) -> State:
        try:
            return {"duplicate": await store.exists(state["event"]["event_id"])}
        except Exception as exc:
            raise RetryableError(f"mongo_{type(exc).__name__}") from None

    async def load_context(state: State) -> State:
        try:
            return {"context": await ledger.context(state["event"]["external_transaction_id"])}
        except TransactionMissing:
            raise PermanentError("transaction_not_found") from None
        except LedgerUnavailable as exc:
            raise RetryableError(f"supabase_{exc}") from None

    async def explain(state: State) -> State:
        features = state["context"].get("features")
        if not features:
            return {"explanation": {"status": "unavailable", "reason": "model features were not stored with this transaction"}}
        try:
            # CPU-bound (hundreds of trees); keep the event loop responsive.
            result = await asyncio.to_thread(explain_prediction, model, features)
        except (ValueError, KeyError, TypeError):
            return {"explanation": {"status": "unavailable", "reason": "stored features do not match the model"}}
        return {"explanation": {"status": "ok", **result}}

    async def persist(state: State) -> State:
        event = state["event"]
        document = {
            "_id": event["event_id"],
            "event_id": event["event_id"],
            "external_transaction_id": event["external_transaction_id"],
            "event": {
                key: event.get(key)
                for key in ("fraud_probability", "decision_threshold", "model_version", "alert_created", "event_time")
            },
            "transaction_step": state["context"].get("transaction_step"),
            "graph_context": state["context"].get("graph"),
            "explanation": state["explanation"],
            "subgraphx": SUBGRAPHX_UNAVAILABLE,
            "pipeline_version": PIPELINE_VERSION,
            "created_at": datetime.now(timezone.utc),
        }
        try:
            return {"stored": await store.save(document)}
        except Exception as exc:
            raise RetryableError(f"mongo_{type(exc).__name__}") from None

    graph = StateGraph(State)
    graph.add_node("validate", validate)
    graph.add_node("check_duplicate", check_duplicate)
    graph.add_node("load_context", load_context)
    graph.add_node("explain", explain)
    graph.add_node("persist", persist)
    graph.add_edge(START, "validate")
    graph.add_edge("validate", "check_duplicate")
    graph.add_conditional_edges("check_duplicate", lambda s: END if s.get("duplicate") else "load_context")
    graph.add_edge("load_context", "explain")
    graph.add_edge("explain", "persist")
    graph.add_edge("persist", END)
    return graph.compile()
