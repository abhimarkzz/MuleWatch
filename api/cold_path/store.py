"""MongoDB Atlas store for cold-path explanation documents.

Kept apart from the PostgreSQL ledger: these are derived, re-computable
analysis results, one document per fraud event. The document _id is the
fraud event_id, so a redelivered event can never create a second document.
"""

from __future__ import annotations

from typing import Any, Optional

COLLECTION = "fraud_explanations"


class ExplanationStore:
    def __init__(self, uri: str, database: str, client: Optional[Any] = None):
        if client is None:
            from pymongo import AsyncMongoClient

            # Fail fast so an Atlas outage becomes a retry, not a hang.
            client = AsyncMongoClient(uri, serverSelectionTimeoutMS=10_000, appname="mulewatch-cold-path")
        self._client = client
        self._collection = client[database][COLLECTION]

    async def ensure_indexes(self) -> None:
        await self._collection.create_index("external_transaction_id", name="external_transaction_id_idx")
        await self._collection.create_index("created_at", name="created_at_idx")

    async def exists(self, event_id: str) -> bool:
        return await self._collection.find_one({"_id": event_id}, {"_id": 1}) is not None

    async def save(self, document: dict) -> bool:
        """Idempotent insert. Returns True if this call created the document."""
        from pymongo.errors import DuplicateKeyError

        try:
            result = await self._collection.update_one(
                {"_id": document["_id"]}, {"$setOnInsert": document}, upsert=True
            )
        except DuplicateKeyError:
            # Two concurrent upserts for one _id: the other one stored it.
            return False
        return result.upserted_id is not None

    async def close(self) -> None:
        await self._client.close()
