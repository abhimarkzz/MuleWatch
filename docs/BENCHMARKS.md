# Benchmarks

Reproduce with `scripts/benchmark.py`, which uses only existing dependencies.
Nothing in it writes to Supabase, publishes to Kafka, or saves a model.

```bash
python3 scripts/benchmark.py model
```

```bash
python3 scripts/benchmark.py temporal-diagnostics
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

| Evaluation | Rows (fraud) | Threshold | Precision | Recall | F1 | TP / FP / FN / TN | ROC-AUC | AP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Held-out random 80/20 split (same split as training) | 20,000 (26) | 0.405 (stored) | 0.667 | 0.538 | 0.596 | 14 / 7 / 12 / 19,967 | 0.919 | 0.576 |
| Held-out temporal split (fit on steps ≤ 355, test 356–737) | 19,744 (62) | 0.331 (training-period OOF) | 0.000 | 0.000 | 0.000 | 0 / 0 / 62 / 19,682 | 0.868 | 0.582 |
| Deployed artefact on all rows: **in-sample, not a generalisation estimate** | 100,000 (129) | 0.405 | 0.921 | 1.000 | 0.959 | 129 / 11 / 0 / 99,860 | 1.000 | 0.998 |

**Threshold handling:**

- **Random split:** the stored 0.405 was chosen on out-of-fold probabilities
  of the random training split (`train_model.py`), so using it there is
  leak-free.
- **Temporal split:** that same split contains rows from after step 355, so
  using 0.405 in the temporal test would leak test-period labels. The temporal
  test therefore re-selects its threshold with the same max-F1 rule, using only
  out-of-fold probabilities of rows at steps ≤ 355.
- **Hyperparameters:** these were also tuned on the random split, a milder
  leak that remains.

The random-split figures reproduce `api/models/evaluation_metrics.json`
exactly. With only 26 fraud cases they are noisy.

### Why the temporal split flags no fraud

Run `python3 scripts/benchmark.py temporal-diagnostics`. Measured 2026-10-23:

| Evidence | Value |
| --- | --- |
| `step` range: training vs test | 1–355 vs 356–737 (no overlap) |
| Fraud probability on test fraud rows (median / p90 / max) | 0.044 / 0.265 / **0.289** |
| Training-period out-of-fold probability on fraud rows (median / p90) | 0.460 / 0.838 |
| The same 62 test fraud rows with **only `step`** set to the training median (median / max) | 0.490 / 0.997 |
| Test fraud rows at or above 0.405: as-is vs `step` moved | **0 vs 32** of 62 |
| Control clone with `step` removed (constant), threshold from training OOF | Precision 0.805, recall 0.532, **F1 0.641**, ROC-AUC 0.899 |
| Fraud prevalence: training vs test | 0.083% vs 0.314% |
| Fraud-row medians, `amount` and `oldbalanceOrg` | 273k vs 480k |

**Conclusion:** the evidence points to `step`.

- **What happens:** every test step lies beyond the training range, and the
  forest assigns those rows low fraud probabilities, which caps them at 0.289.
  That is below any threshold chosen from training-period scores.
- **Why `step` is the cause:** changing only `step` restores typical
  probabilities, and removing `step` restores useful temporal performance.
- **Other contributing factors:** prevalence and amount shifts exist, but the
  step-free control still performs well despite them, so they aren't the main
  cause.
- **Implications:**
  - The deployed model includes `step` and was trained on steps 1–737, so live
    transactions entered with larger steps would be affected the same way.
  - The random-split metrics overstate performance on future traffic.
- **The fix is outside this task's scope:** retrain without `step`, or with a
  cyclical hour-of-day feature, then re-validate. Nothing was retrained or
  changed.

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
