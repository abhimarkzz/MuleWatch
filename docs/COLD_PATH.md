# Cold path: explanations in MongoDB (Service B)

```
Service A (hot path, existing)            Service B (cold path, new)
raw-transactions ─▶ /api/predict ─▶ Supabase ledger
        │ flagged + saved
        ▼
   fraud_alerts ─────────────────────▶ consumer group mulewatch-cold-path
                                         LangGraph: validate → check_duplicate
                                                    → load_context (Supabase, read-only)
                                                    → explain (Random Forest)
                                                    → persist (MongoDB Atlas)
                                         commit offset only after Mongo acks
```

## Two databases, two jobs

| Store | Holds | Why |
| --- | --- | --- |
| Supabase Postgres | Accounts, transactions, alerts, and the graph queries | Relational ledger; unique keys make every write idempotent. |
| MongoDB Atlas, `fraud_explanations` | One explanation document per fraud event | Derived data that can be recomputed. Kept out of the ledger so analysis output never mixes with records of fact. |

### Document shape

- **`_id`:** the same value as `event_id`, which is `<external_transaction_id>:model-flag`.
- **`event`:** score, threshold, model version, `alert_created` and event time.
- **`transaction_step`**
- **`graph_context`:** neighbourhood counts only, no account IDs.
- **`explanation`:** the method, base value and top contributions (see below).
- **`subgraphx`:** always `{status: "unavailable", reason}`.
- **`pipeline_version`** and **`created_at`**.

### Indexes and idempotency

- **Indexes:** `_id` (built in, unique), `external_transaction_id_idx` and
  `created_at_idx`, all created at startup.
- **Idempotency:** writes use `update_one({_id}, {$setOnInsert: doc},
  upsert=True)`, so a redelivered or republished event never creates or
  overwrites a second document.

## What "explanation" means here (truthful scope)

`api/cold_path/explain.py` decomposes the real Random Forest
(`api/models/fraud_detection_rf.joblib`) along each tree's decision path. That
gives an exact split of the score:

```
fraud_probability = base_value + sum(contributions)
```

A test checks this against the committed model: the reconstruction error is
below 1e-6, and on the real model it's 0.0.

- **No data needed:** it uses only the trained pipeline, not the training CSV,
  which isn't deployed.
- **Base value:** the base value is 0.5 because the forest was trained with
  `class_weight="balanced_subsample"`.
- **Not causal:** contributions describe how the model scored the row, not what
  caused it.
- **Features:** they come from `metadata.model_features`, which `/api/predict`
  stores. If they're missing, the document records
  `explanation.status = "unavailable"` instead of guessing.

### Blocked: SubgraphX and PyTorch

SubgraphX explains a **graph neural network's** prediction. This repository has
no trained GNN and no PyTorch or PyTorch Geometric model, only the scikit-learn
Random Forest. So no SubgraphX output is produced, and every document says so.

To unblock it you would need:

1. a GNN trained on the transaction graph;
2. a way to validate that model separately;
3. a Service B build with `torch` and `torch_geometric`.

None of those exist yet. The Random Forest stays the production model.

## Running and deploying Service B

**Run locally** (from the repository root):

```bash
pip install -r api/requirements-cold-path.txt
```

```bash
uvicorn api.cold_path.main:app --port 8002
```

**Deploy as a second Render Web Service:**

1. Connect the same repository, with the root directory set to the repository
   root.
2. **Build command:** `pip install -r api/requirements-cold-path.txt`
3. **Start command:** `uvicorn api.cold_path.main:app --host 0.0.0.0 --port $PORT`
4. **Environment variables:** see `api/cold_path/.env.example`. The service
   needs:
   - the same Aiven credentials as Service A;
   - `MONGODB_URI` and `MONGODB_DATABASE`;
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`;
   - `MULEWATCH_API_KEY`, the same value as Service A.

`GET /health` reports `fraud_alerts_consumer` as `disabled`, `running`,
`retrying`, `failed` and so on.

### Failure handling

Service B reuses Service A's consumer code.

| Case | Result |
| --- | --- |
| Malformed event, not a `fraud_alert`, or missing ID | Published to `fraud_alerts_dlq` with an error header, then committed. |
| Ledger row not found, or Supabase rejects the query (400) | Published to `fraud_alerts_dlq`, then committed. |
| MongoDB rejects the document (`DocumentTooLarge`, `InvalidDocument`, `WriteError`) | Published to `fraud_alerts_dlq`, then committed. |
| DLQ publish fails | No commit; retry. |
| MongoDB or Supabase unreachable, timing out, or returning 5xx | No commit. Seek back and retry after 2 to 60 s, with no cap, because an outage can last hours. |
| Unexpected pipeline error | Retried up to 5 times, then sent to the DLQ as `pipeline_error_exhausted`, so one bad event can't block the partition forever. |
| Event already stored (same `event_id`) | Committed without loading context or recomputing. A concurrent duplicate write (`DuplicateKeyError`) also counts as already stored. |
| Shutdown | The consumer task is cancelled and clients are closed. Uncommitted events are replayed on the next start. |

Logs contain partition, offset and an error code only. They never contain
payloads, references or credentials.

## Render Free: delayed processing

Both services sleep after about 15 minutes without inbound HTTP traffic, so
the cold path is **not real-time**. While Service B sleeps:

- events wait in `fraud_alerts`;
- its group's committed offset marks where to resume;
- the backlog is processed after it wakes.

**Waking it.** Set `COLD_PATH_WAKE_URL` on Service A to
`https://<service-b>.onrender.com/wake`. After each `fraud_alerts` publish,
Service A sends `POST /wake` with `x-api-key` as a fire-and-forget request.
That request never affects Service A's commit.

- **Unauthenticated requests:** `/wake` returns 401 without the key and does no
  work.
- **What the key can't do:** Render boots a sleeping service for *any* inbound
  request, so no authentication can stop strangers waking it. The cost of abuse
  is free-tier hours, not data or work.
- **If the wake fails:** nothing is lost. Open `/health` on Service B to wake it
  manually.
- **Retention:** keep the topic's retention longer than any expected sleep.

## Atlas setup (manual; nothing was created)

1. Create a cluster. The free M0 tier is enough.
2. Create a database user with `readWrite` on the chosen database
   (`MONGODB_DATABASE`, for example `mulewatch`).
3. Under **Network Access**, allow Render's outbound IPs. Use `0.0.0.0/0` only
   if you accept the risk; on Render Free the outbound IPs aren't fixed.
4. Copy the `mongodb+srv://` URI into Service B's `MONGODB_URI`.
5. Create the topic `fraud_alerts_dlq` in Aiven, and allow the SASL user to
   consume `fraud_alerts` with group `mulewatch-cold-path`.

## Postgres: TimescaleDB, partitioning or indexes?

See `supabase/proposals/20261023_transactions_account_step_indexes.sql`. It's a
proposal, not a migration, and hasn't been applied.

- **TimescaleDB:** deprecated by Supabase on Postgres 17 projects. The file
  includes queries to check your version and whether the extension is
  available.
- **Native partitioning:** needs a rewrite of the populated table, and it
  complicates the unique `external_transaction_id` constraint that the
  idempotent upsert relies on.
- **Indexes (recommended at about 100k rows):** two composite indexes,
  `(source_account_id, transaction_step)` and
  `(destination_account_id, transaction_step)`, created `CONCURRENTLY`. They
  match the Copilot and account-history queries.

## Telemetry (not implemented)

MuleWatch has no consented mouse or keyboard telemetry source, so **no capture
was added**. If a consented source is ever introduced, store only minimal,
pseudonymised metadata in MongoDB (a separate `interaction_events`
collection), never in the ledger:

| Field | Notes |
| --- | --- |
| `session_hash` | HMAC of the session ID with a server secret. |
| `event_kind` | For example `pointer_move_batch` or `key_cadence_batch`. |
| `window_start`, `window_ms` | |
| `counts` | Numbers only. |
| `timing_stats` | Mean or variance of intervals. |
| `consent_version` | |
| `expires_at` | A TTL index deletes the document after this time. |

Never store typed characters, key codes, passwords, form contents, clipboard
data, screen contents or raw coordinates.
