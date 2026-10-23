"""MuleWatch benchmarks: offline model evaluation and read-only latency.

    python3 scripts/benchmark.py model
    python3 scripts/benchmark.py latency --url https://mulewatch.onrender.com -n 50
    python3 scripts/benchmark.py alert-gap          # needs frontend/.env.local

Nothing here writes to a database, publishes to Kafka, or saves a model.

Leakage: train_model.py refits the deployed artefact on all 100,000 rows of
the sample, so scoring that artefact on any split of the same file is
in-sample. Leak-free numbers come from in-memory clones of the deployed
configuration trained only on a training split and scored on held-out rows.
The resubstitution score of the deployed artefact is reported separately and
labelled as optimistic.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DATASET = ROOT / "data" / "processed" / "paysim_sample_100k.csv"
MODEL = ROOT / "api" / "models" / "fraud_detection_rf.joblib"
THRESHOLD = ROOT / "api" / "models" / "fraud_threshold.json"

# Synthetic, non-persisted payload for the model API (Render /predict only
# scores; it never touches the database).
PROBE = {
    "step": 100,
    "type": "TRANSFER",
    "amount": 5000.0,
    "oldbalanceOrg": 10000.0,
    "oldbalanceDest": 2000.0,
    "orig_txn_count_before": 1,
    "dest_txn_count_before": 4,
    "dest_is_merchant": 0,
}


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile; None for an empty sample."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100 * len(ordered)))
    return ordered[rank - 1]


def summarize(values_ms: list[float], errors: int) -> dict:
    return {
        "n": len(values_ms),
        "errors": errors,
        "p50_ms": percentile(values_ms, 50),
        "p95_ms": percentile(values_ms, 95),
        "p99_ms": percentile(values_ms, 99),
        "mean_ms": round(statistics.fmean(values_ms), 1) if values_ms else None,
        "max_ms": max(values_ms) if values_ms else None,
    }


def classification_metrics(y_true, probabilities, threshold: float) -> dict:
    from sklearn.metrics import (
        average_precision_score,
        confusion_matrix,
        f1_score,
        precision_score,
        recall_score,
        roc_auc_score,
    )

    predicted = (probabilities >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, predicted, labels=[0, 1]).ravel()
    both_classes = len(set(y_true)) == 2
    return {
        "rows": int(len(y_true)),
        "fraud_rows": int(sum(y_true)),
        "threshold": round(threshold, 6),
        "precision": round(float(precision_score(y_true, predicted, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, predicted, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, predicted, zero_division=0)), 4),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        # Undefined when the evaluated rows contain one class only.
        "roc_auc": round(float(roc_auc_score(y_true, probabilities)), 4) if both_classes else None,
        "average_precision": round(float(average_precision_score(y_true, probabilities)), 4) if both_classes else None,
    }


def select_f1_threshold(y_true, probabilities) -> float:
    """Max-F1 threshold, the same rule train_model.py uses."""
    import numpy as np
    from sklearn.metrics import precision_recall_curve

    precision, recall, thresholds = precision_recall_curve(y_true, probabilities, pos_label=1)
    denominator = precision[:-1] + recall[:-1]
    f1 = np.divide(2 * precision[:-1] * recall[:-1], denominator, out=np.zeros_like(denominator), where=denominator > 0)
    return float(thresholds[int(np.argmax(f1))])


def oof_probabilities(model, X, y):
    """Out-of-fold fraud probabilities on training rows only."""
    from sklearn.model_selection import StratifiedKFold, cross_val_predict

    import numpy as np

    cv = StratifiedKFold(n_splits=3, shuffle=True, random_state=43)
    # Columns follow the sorted labels; the model may be unfitted here.
    fraud = list(np.unique(y)).index(1)
    return cross_val_predict(model, X, y, cv=cv, method="predict_proba", n_jobs=2)[:, fraud]


def load_data():
    import joblib
    import pandas as pd

    from api.train_model import prepare_features

    if not DATASET.is_file():
        raise SystemExit(f"Dataset not found: {DATASET} (it is git-ignored; restore it locally).")
    df = pd.read_csv(DATASET)
    # Trusted: the repository's own artefact.
    return prepare_features(df), df["isFraud"].astype(int), joblib.load(MODEL)


def temporal_split(X, quantile: float = 0.8):
    cutoff = int(X["step"].quantile(quantile))
    return cutoff, X["step"] <= cutoff, X["step"] > cutoff


def evaluate_model() -> dict:
    from sklearn.base import clone
    from sklearn.model_selection import train_test_split

    X, y, deployed = load_data()
    threshold = float(json.loads(THRESHOLD.read_text())["threshold"])
    fraud = list(deployed.classes_).index(1)

    def fit_and_score(X_train, y_train, X_test, y_test):
        model = clone(deployed)  # same configuration, fresh fit, never saved
        model.fit(X_train, y_train)
        return classification_metrics(y_test.to_numpy(), model.predict_proba(X_test)[:, fraud], threshold)

    # Same split as train_model.py / evaluate_model.py (random_state=42).
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.20, random_state=42, stratify=y)
    random_split = fit_and_score(X_tr, y_tr, X_te, y_te)

    # Temporal: fit on earlier PaySim steps, test on later ones. The stored
    # threshold was chosen on the *random* training split, which contains
    # later-step rows and labels, so here the threshold is re-selected from
    # out-of-fold probabilities on the early rows only. (Hyperparameters were
    # also tuned on the random split; that remains a mild, documented leak.)
    cutoff, early, late = temporal_split(X)
    temporal_model = clone(deployed)
    temporal_threshold = select_f1_threshold(y[early], oof_probabilities(temporal_model, X[early], y[early]))
    temporal_model.fit(X[early], y[early])
    late_probabilities = temporal_model.predict_proba(X[late])[:, fraud]
    temporal = classification_metrics(y[late].to_numpy(), late_probabilities, temporal_threshold)
    temporal["train_steps"] = f"<= {cutoff}"
    temporal["threshold_source"] = "max-F1 on out-of-fold probabilities of training-period rows only"
    temporal_at_stored = classification_metrics(y[late].to_numpy(), late_probabilities, threshold)

    resubstitution = classification_metrics(y.to_numpy(), deployed.predict_proba(X)[:, fraud], threshold)

    return {
        "ground_truth": "PaySim isFraud labels in data/processed/paysim_sample_100k.csv",
        "threshold_source": "api/models/fraud_threshold.json (chosen on training-split out-of-fold probabilities)",
        "held_out_random_split": random_split,
        "held_out_temporal_split": temporal,
        "held_out_temporal_split_at_stored_threshold_LEAKY": temporal_at_stored,
        "deployed_artefact_resubstitution_NOT_a_generalization_estimate": resubstitution,
    }


def temporal_diagnostics() -> dict:
    """Evidence for why the temporal split flags so little fraud."""
    import numpy as np
    import pandas as pd
    from sklearn.base import clone

    X, y, deployed = load_data()
    threshold = float(json.loads(THRESHOLD.read_text())["threshold"])
    fraud = list(deployed.classes_).index(1)
    cutoff, early, late = temporal_split(X)

    model = clone(deployed)
    model.fit(X[early], y[early])
    late_fraud = X[late & (y == 1)]
    p_late_fraud = model.predict_proba(late_fraud)[:, fraud]
    p_early_oof = oof_probabilities(clone(deployed), X[early], y[early])

    def quantiles(values) -> dict:
        q = np.quantile(values, [0, 0.5, 0.9, 1.0])
        return {k: round(float(v), 4) for k, v in zip(("min", "median", "p90", "max"), q)}

    # Counterfactual: the same late fraud rows with `step` moved into the
    # training range (the training median). Only `step` changes.
    in_range = late_fraud.copy()
    in_range["step"] = int(X.loc[early, "step"].median())
    p_in_range = model.predict_proba(in_range)[:, fraud]

    # Control: a clone that cannot use `step` (constant in train and test).
    no_step = clone(deployed)
    X_const = X.assign(step=0)
    no_step_threshold = select_f1_threshold(y[early], oof_probabilities(clone(deployed), X_const[early], y[early]))
    no_step.fit(X_const[early], y[early])
    no_step_metrics = classification_metrics(
        y[late].to_numpy(), no_step.predict_proba(X_const[late])[:, fraud], no_step_threshold
    )

    # Post-hoc mechanism probe (after the holdout was scored): force every
    # late fraud row to one step value and see where scores collapse; count
    # fraud in the last training band; read the forest's step split points.
    step_probe = {
        str(value): round(float(np.median(model.predict_proba(late_fraud.assign(step=value))[:, fraud])), 3)
        for value in (150, 300, 340, 345, 348, 350, 355, 356, 500, 737)
    }
    edge = early & (X["step"] >= 350)
    forest = model.named_steps["classifier"]
    step_index = list(model.named_steps["preprocessor"].get_feature_names_out()).index("numeric__step")
    step_thresholds = np.concatenate(
        [t.tree_.threshold[t.tree_.feature == step_index] for t in forest.estimators_]
    )

    def drift(column: str) -> dict:
        return {
            "train_fraud_median": float(X.loc[early & (y == 1), column].median()),
            "test_fraud_median": float(X.loc[late & (y == 1), column].median()),
        }

    return {
        "cutoff_step": cutoff,
        "step_range": {
            "train": [int(X.loc[early, "step"].min()), int(X.loc[early, "step"].max())],
            "test": [int(X.loc[late, "step"].min()), int(X.loc[late, "step"].max())],
        },
        "fraud_prevalence": {
            "train": round(float(y[early].mean()), 5),
            "test": round(float(y[late].mean()), 5),
            "train_fraud_rows": int(y[early].sum()),
            "test_fraud_rows": int(y[late].sum()),
        },
        "fraud_type_mix": {
            "train": X.loc[early & (y == 1), "type"].value_counts().to_dict(),
            "test": X.loc[late & (y == 1), "type"].value_counts().to_dict(),
        },
        "feature_drift_in_fraud_rows": {c: drift(c) for c in ("amount", "oldbalanceOrg", "orig_txn_count_before")},
        "training_oof_fraud_probabilities": quantiles(p_early_oof[y[early].to_numpy() == 1]),
        "test_fraud_probabilities": quantiles(p_late_fraud),
        "test_fraud_probabilities_with_step_moved_into_training_range": quantiles(p_in_range),
        "stored_threshold": round(threshold, 6),
        "test_fraud_at_or_above_stored_threshold": int((p_late_fraud >= threshold).sum()),
        "same_rows_with_step_moved_at_or_above_stored_threshold": int((p_in_range >= threshold).sum()),
        "control_clone_without_step": no_step_metrics,
        "post_hoc_step_probe_median_probability": step_probe,
        "last_training_band_350_to_cutoff": {"rows": int(edge.sum()), "fraud_rows": int(y[edge].sum())},
        "forest_step_splits": {
            "trees_splitting_on_step": int(sum((t.tree_.feature == step_index).any() for t in forest.estimators_)),
            "trees": len(forest.estimators_),
            "highest_thresholds": [round(float(v), 1) for v in np.sort(step_thresholds)[-3:]],
        },
    }


def chronological_splits(X, train_q: float = 0.6, holdout_q: float = 0.8):
    """Train / validation / final-holdout masks by PaySim step. The holdout
    (step > holdout cutoff) is the same future period as temporal_split."""
    train_cut = int(X["step"].quantile(train_q))
    holdout_cut = int(X["step"].quantile(holdout_q))
    train = X["step"] <= train_cut
    validation = (X["step"] > train_cut) & (X["step"] <= holdout_cut)
    holdout = X["step"] > holdout_cut
    return (train_cut, holdout_cut), train, validation, holdout


def swap_feature(target, donor, column: str, seed: int = 0):
    """Copy of `target` with `column` replaced by values resampled from `donor`."""
    import numpy as np

    rng = np.random.default_rng(seed)
    swapped = target.copy()
    swapped[column] = rng.choice(donor[column].to_numpy(), size=len(target), replace=True)
    return swapped


VARIANTS = {
    "all_features": lambda X: X,
    # `step` held constant: the forest cannot split on it.
    "without_step": lambda X: X.assign(step=0),
}


def temporal_study() -> dict:
    """Leak-free chronological comparison.

    Selection (variant choice, cause analysis) uses train -> validation only.
    The final holdout is scored once per variant, after selection, with models
    refit on train+validation and thresholds from train+validation OOF.
    """
    import numpy as np
    from scipy.stats import ks_2samp
    from sklearn.base import clone

    X, y, deployed = load_data()
    (train_cut, holdout_cut), train, validation, holdout = chronological_splits(X)
    fraud = list(deployed.classes_).index(1)
    numeric = ["step", "amount", "oldbalanceOrg", "oldbalanceDest", "orig_txn_count_before", "dest_txn_count_before"]

    def fit_threshold_score(variant, fit_mask, eval_mask):
        transform = VARIANTS[variant]
        Xv = transform(X)
        threshold = select_f1_threshold(y[fit_mask], oof_probabilities(clone(deployed), Xv[fit_mask], y[fit_mask]))
        model = clone(deployed).fit(Xv[fit_mask], y[fit_mask])
        p = model.predict_proba(Xv[eval_mask])[:, fraud]
        return model, threshold, p

    # 1. Selection stage: train -> validation.
    selection, base_model, base_threshold = {}, None, None
    for variant in VARIANTS:
        model, threshold, p = fit_threshold_score(variant, train, validation)
        selection[variant] = classification_metrics(y[validation].to_numpy(), p, threshold)
        if variant == "all_features":
            base_model, base_threshold, p_val = model, threshold, p
    chosen = max(selection, key=lambda v: selection[v]["average_precision"] or 0)

    # 2. Cause analysis on validation only: swap one feature at a time in the
    # validation fraud rows for values drawn from training fraud rows.
    val_fraud = X[validation & (y == 1)]
    train_fraud = X[train & (y == 1)]
    p_val_fraud = base_model.predict_proba(val_fraud)[:, fraud]
    swaps = {}
    for column in numeric + ["type"]:
        p = base_model.predict_proba(swap_feature(val_fraud, train_fraud, column))[:, fraud]
        swaps[column] = {
            "median_probability": round(float(np.median(p)), 4),
            "at_or_above_threshold": int((p >= base_threshold).sum()),
        }

    drift = {}
    for column in numeric:
        stat = ks_2samp(X.loc[train, column], X.loc[validation, column]).statistic
        drift[column] = {
            "ks_all_rows_train_vs_validation": round(float(stat), 3),
            "train_range": [float(X.loc[train, column].min()), float(X.loc[train, column].max())],
            "validation_median": float(X.loc[validation, column].median()),
            "train_median": float(X.loc[train, column].median()),
        }

    # 3. Final holdout, scored once per variant after selection.
    final = {}
    for variant in VARIANTS:
        _, threshold, p = fit_threshold_score(variant, train | validation, holdout)
        final[variant] = classification_metrics(y[holdout].to_numpy(), p, threshold)

    return {
        "splits": {
            "train_steps": f"1-{train_cut}",
            "validation_steps": f"{train_cut + 1}-{holdout_cut}",
            "holdout_steps": f"> {holdout_cut}",
            "fraud_rows": {
                "train": int(y[train].sum()),
                "validation": int(y[validation].sum()),
                "holdout": int(y[holdout].sum()),
            },
            "prevalence": {
                "train": round(float(y[train].mean()), 5),
                "validation": round(float(y[validation].mean()), 5),
                "holdout": round(float(y[holdout].mean()), 5),
            },
        },
        "selection_on_validation": selection,
        "selected_variant": chosen,
        "validation_cause_analysis": {
            "baseline_threshold": round(base_threshold, 6),
            "validation_fraud_rows": int(len(val_fraud)),
            "baseline": {
                "median_probability": round(float(np.median(p_val_fraud)), 4),
                "at_or_above_threshold": int((p_val_fraud >= base_threshold).sum()),
            },
            "swap_one_feature_from_training_fraud_rows": swaps,
            "feature_drift": drift,
            "type_mix_fraud": {
                "train": X.loc[train & (y == 1), "type"].value_counts().to_dict(),
                "validation": X.loc[validation & (y == 1), "type"].value_counts().to_dict(),
            },
        },
        "final_holdout_scored_once": final,
        "notes": [
            "Hyperparameters are the deployed configuration, tuned on the random split (which includes later steps): a residual, documented leak.",
            "Holdout labels were not used for variant choice, thresholds or cause analysis.",
        ],
    }


def measure_latency(url: str, n: int, timeout: float) -> dict:
    import httpx

    endpoint = f"{url.rstrip('/')}/predict"
    with httpx.Client(timeout=timeout) as client:
        started = time.perf_counter()
        try:
            first = client.post(endpoint, json=PROBE)
            first_ok = first.status_code == 200
        except httpx.HTTPError:
            first_ok = False
        first_ms = round((time.perf_counter() - started) * 1000, 1)

        times, errors = [], 0
        for _ in range(n):
            started = time.perf_counter()
            try:
                ok = client.post(endpoint, json=PROBE).status_code == 200
            except httpx.HTTPError:
                ok = False
            elapsed = round((time.perf_counter() - started) * 1000, 1)
            if ok:
                times.append(elapsed)
            else:
                errors += 1

    return {
        "endpoint": endpoint,
        "first_request_ms": first_ms,
        "first_request_ok": first_ok,
        "note": "First request may include a Render Free cold start; it is excluded from the warm sample. Times are client-observed round trips from this machine.",
        "warm": summarize(times, errors),
    }


def alert_gap() -> dict:
    """Read-only: time from a transaction row's creation to its model alert's
    creation, both written by /api/predict. This is the persistence gap only;
    queue wait and model time are not recorded in the database."""
    import httpx
    from datetime import datetime

    env = {}
    env_file = ROOT / "frontend" / ".env.local"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip()
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit("Supabase URL and service key are required (frontend/.env.local).")

    response = httpx.get(
        f"{url.rstrip('/')}/rest/v1/alerts",
        params={
            "select": "created_at,transaction:transactions(created_at)",
            "reason": "eq.Random Forest flagged this transaction for review.",
            "order": "created_at.desc",
            "limit": "500",
        },
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=30,
    )
    response.raise_for_status()

    def ts(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    gaps = [
        round((ts(row["created_at"]) - ts(row["transaction"]["created_at"])).total_seconds() * 1000, 1)
        for row in response.json()
        if row.get("transaction") and row["transaction"].get("created_at")
    ]
    return {"measure": "transaction row created -> model alert row created", "sample": summarize(gaps, 0)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("model")
    sub.add_parser("temporal-diagnostics")
    sub.add_parser("temporal-study")
    latency = sub.add_parser("latency")
    latency.add_argument("--url", default="https://mulewatch.onrender.com")
    latency.add_argument("-n", type=int, default=50)
    latency.add_argument("--timeout", type=float, default=120.0)
    sub.add_parser("alert-gap")
    args = parser.parse_args()

    if args.command == "model":
        result = evaluate_model()
    elif args.command == "temporal-diagnostics":
        result = temporal_diagnostics()
    elif args.command == "temporal-study":
        result = temporal_study()
    elif args.command == "latency":
        result = measure_latency(args.url, args.n, args.timeout)
    else:
        result = alert_gap()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
