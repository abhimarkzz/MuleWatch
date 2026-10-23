# Benchmarks

Reproduce with `scripts/benchmark.py`, which uses only existing dependencies.
Nothing in it writes to Supabase, publishes to Kafka, or saves a model.

```bash
python3 scripts/benchmark.py model
```

```bash
python3 scripts/benchmark.py latency --url https://mulewatch.onrender.com -n 50
```

```bash
python3 scripts/benchmark.py alert-gap
```

## Model evaluation (measured 2026-10-23)

**Ground truth** is PaySim's `isFraud` label in
`data/processed/paysim_sample_100k.csv`. It is kept separate from live
predictions: transactions entered in the app have no ground-truth label, so
their alerts cannot be scored.

**Leakage.** `api/train_model.py` refits the deployed artefact on all
100,000 rows, so scoring it on this file is in-sample. The held-out numbers
below come from in-memory clones of the deployed configuration. Each clone is
trained only on its training rows and never saved. The threshold (0.4054) was
chosen on training-split out-of-fold probabilities.

| Evaluation | Rows (fraud) | Precision | Recall | F1 | TP / FP / FN / TN | ROC-AUC | AP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Held-out random 80/20 split (same split as training) | 20,000 (26) | 0.667 | 0.538 | 0.596 | 14 / 7 / 12 / 19,967 | 0.919 | 0.576 |
| Held-out temporal split (train steps ≤ 355, test later) | 19,744 (62) | 0.000 | 0.000 | 0.000 | 0 / 0 / 62 / 19,682 | 0.868 | 0.582 |
| Deployed artefact on all rows: **in-sample, not a generalisation estimate** | 100,000 (129) | 0.921 | 1.000 | 0.959 | 129 / 11 / 0 / 99,860 | 1.000 | 0.998 |

**Reading the results:**

- **Random split:** these numbers reproduce
  `api/models/evaluation_metrics.json` exactly. With only 26 fraud cases they
  are noisy; one more or one fewer true positive moves recall by about 0.04.
- **Temporal split:** the model still *ranks* later fraud well (ROC-AUC
  0.87, AP 0.58), but **no** later transaction reaches the 0.405 threshold, so
  recall at that threshold is 0. A likely cause is that `step` is a model
  feature, so steps beyond the training range fall outside what the trees
  learned. Treat the random-split figures as optimistic for live, future
  traffic. Fixing this means retraining, which is out of scope here.
- **In-sample row:** this row only shows how much the leaked score would
  overstate performance.

## Latency (measured 2026-10-23, from one client machine)

| What | n | Errors | p50 | p95 | p99 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Model API `POST /predict` on Render, cold start | 1 | 0 | 42,814 ms | — | — | The service was asleep (Render Free). |
| Model API `POST /predict` on Render, warm | 50 | 0 | 200 ms | 317 ms | 491 ms | Client round trip, sequential requests, synthetic payload, nothing persisted. |
| Transaction row → model alert row, from existing data | 3 | 0 | 976 ms | 1,385 ms | 1,385 ms | Too few rows for meaningful percentiles. |

**Sub-300 ms target:**

- **Warm:** the median (200 ms) meets it, but p95 (317 ms) and p99 (491 ms)
  don't.
- **Cold:** a cold start takes about 43 s.
- **The full user-facing path is slower:** the browser calls Vercel
  `/api/predict`, which also authenticates and writes to Supabase. **The target
  isn't demonstrated.**

**Not measured:**

- **Vercel `/api/predict` latency:** every call creates or updates a ledger row
  and possibly an alert.
- **Event-to-alert latency through Kafka:** measuring it means publishing real
  transactions. Enqueue time isn't stored, so it can't be derived from existing
  rows either.

Both need a non-production environment, or explicit approval to write
clearly labelled test rows. The `alert-gap` figure covers only the
persistence step inside `/api/predict`.
