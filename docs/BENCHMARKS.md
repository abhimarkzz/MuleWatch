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
python3 scripts/benchmark.py temporal-study
```

```bash
python3 scripts/benchmark.py latency --url https://mulewatch.onrender.com -n 50
```

```bash
python3 scripts/benchmark.py alert-gap
```

## Model evaluation (measured 2026-10-23)

> **Which numbers to use.** This page records several protocols in the order
> they were run. For the question "does removing `step` help?", use only the
> **fair comparison** at the end of this page. In it, both variants get
> identical chronological tuning and forward-chaining thresholds, and are
> frozen before a single scoring of the holdout. The sections in between are
> earlier, weaker protocols, kept for traceability:
>
> - **Protocol A** (`model`): production hyperparameters and a shuffled
>   out-of-fold threshold.
> - **Protocol B** (`temporal-study`): a 9-fraud validation stage.
> - **Post-hoc diagnostics** (`temporal-diagnostics`): experiments run on the
>   holdout after it was scored. They explain a mechanism; they don't
>   independently confirm a model choice.

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

### Protocol A follow-up: why the temporal split flags no fraud (post-hoc)

Run `python3 scripts/benchmark.py temporal-diagnostics`. Measured 2026-10-23:

> **Superseded exploratory result — not comparable to the final equally tuned evaluation. Use F1=0.5843 vs 0.5859.**

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

### Protocol B: chronological study (`temporal-study`, superseded)

`temporal-diagnostics` above runs its experiments on the future period itself.
This study keeps that period untouched until the end:

- **Train:** steps 1–282 (58 fraud rows).
- **Validation:** steps 283–355 (9 fraud rows). The variant choice, thresholds
  (max-F1 on out-of-fold probabilities) and cause analysis use only train and
  validation.
- **Final holdout:** steps 356–737 (62 fraud rows), scored **once** per variant.
  Each model is refit on train+validation, with its threshold from
  train+validation out-of-fold probabilities.

> **Superseded exploratory result — not comparable to the final equally tuned evaluation. Use F1=0.5843 vs 0.5859.**

| Final holdout (scored once) | Threshold | Precision | Recall | F1 | TP / FP / FN / TN | PR-AUC (AP) | ROC-AUC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Random Forest, all features | 0.331 | 0.000 | 0.000 | 0.000 | 0 / 0 / 62 / 19,682 | 0.582 | 0.868 |
| Same configuration with `step` held constant | 0.357 | 0.805 | 0.532 | **0.641** | 33 / 8 / 29 / 19,674 | 0.590 | 0.899 |

**The validation stage was underpowered.** It has only 9 fraud rows.

- **Selection:** the variants nearly tie on PR-AUC (0.419 vs 0.422). The step-free
  variant was selected by that margin, and the all-features variant was better
  on F1 (0.50 vs 0.40).
- **No collapse in validation:** there, the all-features model still catches 3
  of 9.
- **Swaps:** swapping `step` (or the count or balance features) for training
  values changes nothing on validation. Swapping `amount` or `oldbalanceOrg`
  lowers scores, because those are the predictive features.
- **Drift:** apart from `step` (KS = 1.0, by construction), training-to-validation
  shift is small: KS ≤ 0.057.

### Mechanism (post-hoc on the holdout after it was scored; not independent confirmation)

| Evidence | Value |
| --- | --- |
| Trees in the steps 1–355 forest that split on `step` | 350 / 350 |
| Highest `step` split thresholds | 351.5–352 |
| Last training band, steps 350–355 | 3,144 rows, **0 fraud** |
| Median score of the 62 future fraud rows with `step` forced to 150 / 300 / 340 | 0.508 / 0.367 / 0.440 |
| … forced to 348 / 350 / 355 / 356 / 500 / 737 | 0.248 / **0.046 / 0.044 / 0.044 / 0.044 / 0.044** |
| Fraud prevalence: train / validation / holdout | 0.096% / 0.045% / 0.314% |

**What this shows:** a mechanism, under Protocol A's conditions (production
hyperparameters and a shuffled out-of-fold threshold).

- **The mechanism:** the forest uses `step` as a time index. Every future step
  falls beyond its highest split (about 352), into a region learned from steps
  350–355, which contained no fraud. Scores collapse to about 0.044.
- **The evidence:** forcing only `step` back into range restores normal scores.
- **Caveat:** these probes were run on the holdout after it was scored, so they
  explain the failure but don't confirm a remedy.
- **The fair comparison changes the conclusion:** with a forward-chaining
  threshold and chronologically tuned hyperparameters, a model that keeps
  `step` performs about as well as one without it. So `step` causes the
  Protocol A collapse, but isn't by itself shown to be disqualifying.
- **Production impact:** the deployed artefact (trained on steps 1–737, with
  the shuffled out-of-fold threshold 0.405) is still exposed to the same edge
  effect for steps beyond 737. That wasn't measured, because no later labelled
  data exists.

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

## Fair comparison: with vs without `step` (2026-10-23)

This is research only. Production (`api/models/`, the API, the 0.405
threshold and the feature schema) is unchanged; its checksums were verified
before and after the run.

```bash
python3 scripts/train_candidate_no_step.py
```

- **Run time:** about 110 s, deterministic.
- **Outputs:** `research/candidate_no_step/` holds `metrics.json`,
  `threshold.json`, and the without-`step` `model.joblib`. The model is
  git-ignored. Any output path inside `api/models/` is refused.

**Protocol (identical for both variants):**

- **Training period:** steps 1–355 (80,256 rows, 67 fraud).
- **Final holdout:** steps 356–737 (19,744 rows, 62 fraud).
- **Variants:** the production feature set (`with_step`), and the same minus
  `step` (`without_step`). The same feature frame is used for fit and predict.
- **Hyperparameters:** the same search space, budget (8 configurations) and
  seed as `api/train_model.py`, scored by average precision on the same 3
  forward-chaining chronological folds. Those folds hold 14, 22 and 9 fraud
  rows.
- **Threshold:** max-F1 on forward-chaining out-of-fold probabilities from the
  training period only. The first block, which has no out-of-fold prediction,
  isn't used.
- **Scoring:** both models are refit on the whole training period, frozen with
  their thresholds, and only then scored once on the holdout.
- **Not used:** the production artefact itself. It was trained on steps 1–737,
  so its holdout score would be in-sample.

| Holdout (62 fraud) | Threshold | Precision | Recall | F1 | TP / FP / FN / TN | PR-AUC | ROC-AUC | Chronological CV AP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `with_step` | 0.172 | 0.963 | 0.419 | 0.584 | 26 / **1** / 36 / 19,681 | 0.623 | 0.852 | 0.495 |
| `without_step` | 0.712 | 0.784 | 0.468 | 0.586 | 29 / **8** / 33 / 19,674 | 0.616 | 0.931 | 0.516 |

Tuned parameters:

- `with_step`: `n_estimators=250, max_depth=None, min_samples_split=5,
  min_samples_leaf=1, max_features="sqrt", class_weight="balanced"`.
- `without_step`: `n_estimators=150, max_depth=30, min_samples_split=10,
  min_samples_leaf=4, max_features=0.7, class_weight="balanced"`.

**Uncertainty** (paired bootstrap over holdout rows, 1,000 resamples,
without − with; `paired_bootstrap_without_step_minus_with_step` in
`metrics.json`):

- **F1:** +0.002, 95% CI **[−0.070, +0.071]**.
- **PR-AUC:** −0.007, 95% CI **[−0.059, +0.044]**.

**Conclusion:** the fair comparison does **not** support removing `step` on
the grounds of better detection.

- **Detection:** F1 and PR-AUC are statistically indistinguishable.
- **The trade-off:** the step-free model catches 3 more frauds (29 vs 26) for 7
  more false positives (8 vs 1). It ranks better on ROC-AUC (0.931 vs 0.852),
  but no uncertainty interval was computed for ROC-AUC.
- **Correction:** an earlier version of this section compared the step-free
  candidate with an *untuned* baseline (production hyperparameters) and
  reported an F1 gain of +0.24. That gain came from the uneven tuning, not from
  removing `step`.
- **The real lesson:** how the threshold and hyperparameters are chosen matters
  more than the `step` feature. A forward-chaining threshold avoids the
  Protocol A collapse in both variants.
