# Kafka ingestion (optional)

An asynchronous path for scoring transactions. It runs alongside the existing
synchronous `/api/predict` and the QStash receiver, and replaces neither. The UI
does not use it yet.

```
caller ──POST /api/transactions/queue──▶ Vercel (KafkaJS producer)
                                             │ acks=all, idempotent
                                             ▼
                                   Aiven topic raw-transactions
                                             │
                     FastAPI on Render (aiokafka consumer, group mulewatch-predict-consumer)
                                             │ POST /api/predict  (x-api-key)
                                             ▼
                       Vercel /api/predict ──▶ Render /predict ──▶ Supabase upsert
                                             │
                      success: if flagged → fraud_alerts, then commit offset
                      permanent: raw-transactions-dlq, then commit
                      transient: no commit, retry with backoff
```

## Producer: `POST /api/transactions/queue`

- **Auth:** the same callers as `/api/predict`, either `x-api-key: $MULEWATCH_API_KEY`
  or a signed-in analyst's Supabase token (the allowlist applies).
- **Validation:** the same rules and messages as `/api/predict`. A parity test
  runs both routes on the same bad inputs.
- **Message:** the key is `external_transaction_id` (one is generated if the
  payload has none). The value is the JSON transaction. Sends use `acks=all`, an
  idempotent producer and TLS + SASL.
- **Responses:**

  | Status | Meaning |
  | --- | --- |
  | 202 | The broker acknowledged the message. Body: `{status:"queued", prediction:"pending", external_transaction_id, topic, partition, offset}`. Scoring has **not** happened yet. |
  | 400 | The JSON or a transaction field is invalid. |
  | 401 / 403 | The caller is not authorized. |
  | 413 | The body is over 64 KB. |
  | 503 | Kafka is not configured or not reachable. The client should retry. |

  Error bodies and logs contain error names only, with no broker hosts or
  credentials.

## Consumer (`api/kafka_consumer.py`)

The consumer starts from the FastAPI lifespan as a background task. It is
disabled unless all of `KAFKA_BROKERS`, `KAFKA_USERNAME`, `KAFKA_PASSWORD`,
`MULEWATCH_FRONTEND_URL` and `MULEWATCH_API_KEY` are set. `/health` reports it
as `kafka_consumer`, with one of these states:

| State | Meaning |
| --- | --- |
| `disabled` | Not configured. |
| `connecting` | Connecting to the brokers. |
| `running` | Consuming normally. |
| `retrying` | A record failed transiently and is being retried. |
| `reconnecting` | Waiting before the next connection attempt. |
| `failed` | Stopped after the bounded reconnect attempts ran out. |
| `stopped` | Shut down with the service. |

How each record is handled:

| Result | Action |
| --- | --- |
| `/api/predict` returns 200 with `saved_to_supabase: true` | If `predicted_is_fraud` is true, publish a `fraud_alerts` event first. Then commit `offset + 1`. |
| The `fraud_alerts` publish fails | No commit; retry. The replay re-runs the idempotent save and publishes again. |
| Invalid JSON or field, record over 64 KB, or `/api/predict` 400/413/422 | Publish to `raw-transactions-dlq` (original key and value, plus headers `mulewatch-error`, source topic, partition and offset, and failure time), then commit. |
| DLQ publish fails | No commit; retry. |
| Timeout, network error, 401/403/404/429/5xx, or a 200 without a confirmed save | No commit. Seek back and retry after 2, 4, 8 … 60 s (capped). |
| Broker connection fails | Reconnect after 5, 10, 20, 40, 80 s; after 6 failures, stop with state `failed`. Restart the service to try again. |

Other behaviour:

- **Idempotency:** replays are safe. `/api/predict` upserts on
  `transactions.external_transaction_id`, and the unique index
  `transactions_external_transaction_id_key` exists (verified in the SQL Editor
  on 2026-10-22). Alerts are unique on `(transaction_id, reason)`. A record
  with no ID gets its Kafka key, or else `kafka-<topic>-<partition>-<offset>`,
  so every redelivery uses the same ID. **No migration is needed.**
- **Ordering:** records are processed one at a time. A record that keeps
  failing transiently blocks the records behind it on its partition until it
  succeeds. That is deliberate (nothing is skipped), and `/health` shows
  `retrying`.
- **Logs:** they contain only partition, offset and an error code. They never
  contain payloads, keys, credentials or broker hosts.

## `fraud_alerts` events

For every record the consumer scores and saves with `predicted_is_fraud: true`,
it publishes to `KAFKA_FRAUD_ALERTS_TOPIC` (default `fraud_alerts`):

- **Key:** `external_transaction_id`.
- **Value:** JSON with these fields:
  - `event_type` (`fraud_alert`)
  - `event_id` (`<external_transaction_id>:model-flag`)
  - `external_transaction_id`
  - `predicted_is_fraud`
  - `fraud_probability`
  - `decision_threshold`
  - `model_version`
  - `alert_created`
  - `event_time`
  - `source`
- **Not included:** account IDs, raw features or database row IDs.

Nothing in MuleWatch consumes this topic yet; it's the handoff for a later
phase, so there's no processing loop.

**Delivery is at least once.**

- **Normal case:** the event is published before the source offset is
  committed, so a crash or broker failure can't lose it.
- **When a duplicate happens:** if the event is published but the commit is
  then lost (crash or rebalance in between), the record is replayed and the
  event is published again.
- **Telling duplicates apart:** a replayed event has the same key and
  `event_id`, so downstream consumers should de-duplicate on `event_id`.
  `alert_created` is `false` on a replay, because the alert row already
  exists.
- **Why not exactly once:** that would need Kafka transactions spanning
  the consume, the external HTTP save and the publish, which this design can't
  provide.

**What it doesn't cover:** only transactions scored through Kafka produce
events. A transaction scored by calling `/api/predict` directly, or through
QStash, doesn't.

## Aiven setup (manual)

1. **Create the topics** in the Aiven console:
   - `raw-transactions`
   - `raw-transactions-dlq`
   - `fraud_alerts`

   One partition each is enough for this prototype. Producers never create
   topics (`allowAutoTopicCreation: false`).
2. **Enable SASL:** Service → Advanced configuration →
   `kafka_authentication_methods.sasl = true`.
3. **Use PLAIN or SCRAM:** Aiven's SASL listener may default to SCRAM. Either
   enable PLAIN, or set `KAFKA_SASL_MECHANISM` to `scram-sha-256` on the
   frontend and `SCRAM-SHA-256` on the API.
4. **Create a service user** with produce and consume rights on both topics.
   The consumer group `mulewatch-predict-consumer` must be allowed too.
5. **Download the project CA certificate** (Connection information → CA
   certificate) and put the PEM in `KAFKA_CA_CERT`. Aiven brokers present
   certificates signed by that CA, so TLS verification fails without it.

## Environment variables

**Vercel** (frontend):

| Variable | Notes |
| --- | --- |
| `KAFKA_BROKERS` | SASL `host:port` list. |
| `KAFKA_USERNAME` | |
| `KAFKA_PASSWORD` | |
| `KAFKA_CA_CERT` | |
| `KAFKA_TOPIC` | Optional. Defaults to `raw-transactions`. |
| `KAFKA_SASL_MECHANISM` | Optional. Defaults to `plain`. |
| `MULEWATCH_API_KEY` | Already set. |

**Render** (API, see `api/.env.example`):

| Variable | Notes |
| --- | --- |
| `KAFKA_BROKERS` | |
| `KAFKA_USERNAME` | |
| `KAFKA_PASSWORD` | |
| `KAFKA_CA_CERT` | |
| `KAFKA_SASL_MECHANISM` | |
| `KAFKA_TOPIC` | |
| `KAFKA_DLQ_TOPIC` | |
| `KAFKA_FRAUD_ALERTS_TOPIC` | Optional. Defaults to `fraud_alerts`. |
| `KAFKA_CONSUMER_GROUP` | |
| `MULEWATCH_FRONTEND_URL` | `https://mule-watch.vercel.app` |
| `MULEWATCH_API_KEY` | The **same** value as on Vercel. |

## Free tier: what to expect

- **Render Free sleeps.** A Free web service spins down after about 15 minutes
  without *inbound HTTP* traffic. Its outbound Kafka connection does not count,
  so the consumer stops consuming while the service sleeps. **The consumer is
  not continuously available.**
- **Messages are not lost while Render sleeps.** They stay in
  `raw-transactions`, and the committed offset marks where to resume. When
  Render wakes (cold start, typically under a minute and sometimes longer), the
  consumer rejoins its group and processes the backlog from that offset.
- **Best-effort wake-up.** After each successful publish, the producer sends
  `GET /health` to Render using Next.js `after()`. The 202 is returned first,
  so a cold start never delays the caller. That inbound request starts a
  sleeping service. While the backlog drains, each record makes Render's
  `/predict` busy (through Vercel), which keeps the service awake. About 15
  minutes after the queue goes quiet, it sleeps again.
- **What the wake-up does not cover:**
  - A message produced by anything other than this endpoint (for example the
    Aiven console) doesn't wake Render.
  - If the wake-up request fails, nothing retries it.
  - Recovery: open `https://mulewatch.onrender.com/health` (or send any
    request) to wake the service. The consumer then catches up.
- **Retention is a limit.** Messages older than the topic's retention are
  deleted by Kafka, including unconsumed ones. Check the retention configured
  on the Aiven plan and keep Render from sleeping longer than that while
  messages are pending.
- **Monthly hours.** Render Free has a monthly instance-hour allowance, and a
  busy queue keeps the service awake longer.
- **Latency.** The first record after a sleep waits for the cold start: up to
  90 s inside `/api/predict`, and otherwise it is retried.

## Testing safely

- **Unit tests** use fakes only and send nothing to Kafka, Vercel or Supabase:
  - `frontend/src/app/api/transactions/queue/route.test.ts`
  - `api/tests/test_kafka_consumer.py`
- **Live check after deploying:**
  1. Confirm `/health` on Render shows `kafka_consumer: "running"`.
  2. Queue **one** test transaction with an obvious ID, for example
     `external_transaction_id: "kafka-smoke-1"`, using your API key.
  3. Expect a 202 with an offset.
  4. Within about a minute (plus any cold start), the transaction should
     appear in Supabase. Re-sending the same ID must not add a second row.
  5. Publish `{"bad": true}` from the Aiven console. It should appear in
     `raw-transactions-dlq` with `mulewatch-error: invalid_type`.

The live test writes one real transaction row. Delete it afterwards if you
don't want it kept.
