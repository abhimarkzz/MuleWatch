"""Read-only access to the Supabase ledger for one fraud event.

Fetches the scored transaction (with the model features /api/predict stored
in metadata.model_features) and counts its 24-hour two-hop neighbourhood using
the same rules as the Analyst Copilot: onward transfers from the receiver
strictly later and less than 24 PaySim steps after, and the sender's other
transfers within 24 steps either side. Counts only; no account IDs leave here.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

WINDOW_STEPS = 24
MAX_ROWS = 25
TX_FIELDS = "id,source_account_id,destination_account_id,transaction_step,metadata"


class LedgerUnavailable(Exception):
    """Supabase could not be reached or failed; worth retrying."""


class TransactionMissing(Exception):
    """No ledger row for the event's reference."""


class LedgerRejected(Exception):
    """PostgREST rejected the query (400): retrying the same event can't help."""


class Ledger:
    def __init__(self, url: str, service_key: str, client: Optional[httpx.AsyncClient] = None):
        self._base = f"{url.rstrip('/')}/rest/v1/transactions"
        self._headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        self._client = client or httpx.AsyncClient(timeout=15.0)

    async def _get(self, params: dict) -> list:
        try:
            response = await self._client.get(self._base, params=params, headers=self._headers)
        except httpx.HTTPError as exc:
            raise LedgerUnavailable(type(exc).__name__) from None
        if response.status_code == 400:
            raise LedgerRejected()
        if response.status_code != 200:
            raise LedgerUnavailable(f"status_{response.status_code}")
        rows = response.json()
        return rows if isinstance(rows, list) else []

    async def context(self, reference: str) -> dict[str, Any]:
        rows = await self._get(
            {"select": TX_FIELDS, "external_transaction_id": f"eq.{reference}", "limit": "1"}
        )
        if not rows:
            raise TransactionMissing()
        tx = rows[0]
        features = (tx.get("metadata") or {}).get("model_features")
        step = tx.get("transaction_step")

        graph: dict[str, Any] = {"available": False}
        sender, receiver = tx.get("source_account_id"), tx.get("destination_account_id")
        if isinstance(step, int) and sender and receiver:
            onward = await self._get(
                {
                    "select": "id",
                    "source_account_id": f"eq.{receiver}",
                    "and": f"(transaction_step.gt.{step},transaction_step.lt.{step + WINDOW_STEPS})",
                    "id": f"neq.{tx['id']}",
                    "limit": str(MAX_ROWS),
                }
            )
            fan = await self._get(
                {
                    "select": "destination_account_id",
                    "source_account_id": f"eq.{sender}",
                    "and": f"(transaction_step.gt.{step - WINDOW_STEPS},transaction_step.lt.{step + WINDOW_STEPS})",
                    "id": f"neq.{tx['id']}",
                    "limit": str(MAX_ROWS),
                }
            )
            receivers = {receiver, *(r.get("destination_account_id") for r in fan if r.get("destination_account_id"))}
            graph = {
                "available": True,
                "window_steps": WINDOW_STEPS,
                "onward_transfers_from_receiver": len(onward),
                "sender_distinct_receivers_in_window": len(receivers),
                "truncated": len(onward) == MAX_ROWS or len(fan) == MAX_ROWS,
            }

        return {
            "features": features if isinstance(features, dict) else None,
            "transaction_step": step if isinstance(step, int) else None,
            "graph": graph,
        }

    async def close(self) -> None:
        await self._client.aclose()
