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


def evaluate_model() -> dict:
    import joblib
    import pandas as pd
    from sklearn.base import clone
    from sklearn.model_selection import train_test_split

    from api.train_model import prepare_features

    if not DATASET.is_file():
        raise SystemExit(f"Dataset not found: {DATASET} (it is git-ignored; restore it locally).")

    df = pd.read_csv(DATASET)
    X, y = prepare_features(df), df["isFraud"].astype(int)
    # Trusted: the repository's own artefact.
    deployed = joblib.load(MODEL)
    threshold = float(json.loads(THRESHOLD.read_text())["threshold"])
    fraud = list(deployed.classes_).index(1)

    def fit_and_score(X_train, y_train, X_test, y_test):
        model = clone(deployed)  # same configuration, fresh fit, never saved
        model.fit(X_train, y_train)
        return classification_metrics(y_test.to_numpy(), model.predict_proba(X_test)[:, fraud], threshold)

    # Same split as train_model.py / evaluate_model.py (random_state=42).
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.20, random_state=42, stratify=y)
    random_split = fit_and_score(X_tr, y_tr, X_te, y_te)

    # Temporal: train on earlier PaySim steps, test on later ones, so the
    # model never learns from the future (closer to live use).
    cutoff = int(X["step"].quantile(0.8))
    early, late = X["step"] <= cutoff, X["step"] > cutoff
    temporal = fit_and_score(X[early], y[early], X[late], y[late])
    temporal["train_steps"] = f"<= {cutoff}"

    resubstitution = classification_metrics(y.to_numpy(), deployed.predict_proba(X)[:, fraud], threshold)

    return {
        "ground_truth": "PaySim isFraud labels in data/processed/paysim_sample_100k.csv",
        "threshold_source": "api/models/fraud_threshold.json (chosen on training-split out-of-fold probabilities)",
        "held_out_random_split": random_split,
        "held_out_temporal_split": temporal,
        "deployed_artefact_resubstitution_NOT_a_generalization_estimate": resubstitution,
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
    latency = sub.add_parser("latency")
    latency.add_argument("--url", default="https://mulewatch.onrender.com")
    latency.add_argument("-n", type=int, default=50)
    latency.add_argument("--timeout", type=float, default=120.0)
    sub.add_parser("alert-gap")
    args = parser.parse_args()

    if args.command == "model":
        result = evaluate_model()
    elif args.command == "latency":
        result = measure_latency(args.url, args.n, args.timeout)
    else:
        result = alert_gap()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
