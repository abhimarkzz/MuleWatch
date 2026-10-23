"""Research only: train and evaluate a Random Forest candidate without `step`.

    python3 scripts/train_candidate_no_step.py

Never touches the production artefact (api/models/), the deployed API, the
production threshold or the API feature schema. Outputs go to
research/candidate_no_step/ only.

Protocol (no holdout leakage):
  * Training period: PaySim steps <= the 80th-percentile step (355). Future
    holdout: later steps, untouched until every choice is fixed.
  * Hyperparameters: the production search space and budget (8 random
    configurations, average precision), but scored on forward-chaining
    chronological folds inside the training period.
  * Threshold: max-F1 on forward-chaining out-of-fold probabilities from the
    training period only (each fold is predicted by a model fit on earlier
    steps, mimicking scoring the future).
  * Both variants (production features with `step`; the same without it) go
    through the identical protocol: same folds, same search space, budget and
    seed, same threshold rule. Each is then fit on the whole training period,
    frozen with its threshold, and only then scored once on the holdout.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.benchmark import classification_metrics, load_data, select_f1_threshold, temporal_split  # noqa: E402

PRODUCTION_MODELS_DIR = ROOT / "api" / "models"
RESEARCH_DIR = ROOT / "research" / "candidate_no_step"
RANDOM_STATE = 42

# The production features minus `step`, in production order.
CANDIDATE_FEATURES = [
    "amount",
    "oldbalanceOrg",
    "oldbalanceDest",
    "orig_txn_count_before",
    "dest_txn_count_before",
    "dest_is_merchant",
    "type",
]
CANDIDATE_NUMERIC = [f for f in CANDIDATE_FEATURES if f != "type"]
# Production feature set (api/main.py order), used for the baseline variant.
BASELINE_FEATURES = ["step"] + CANDIDATE_FEATURES
VARIANT_FEATURES = {"with_step": BASELINE_FEATURES, "without_step": CANDIDATE_FEATURES}

# Same search space and budget as api/train_model.py.
PARAMETER_SPACE = {
    "classifier__n_estimators": [150, 250, 350],
    "classifier__class_weight": [None, "balanced", "balanced_subsample"],
    "classifier__max_depth": [None, 12, 20, 30],
    "classifier__min_samples_split": [2, 5, 10],
    "classifier__min_samples_leaf": [1, 2, 4],
    "classifier__max_features": ["sqrt", 0.7],
}
SEARCH_ITERATIONS = 8

PROTOCOL = (
    "Research only: both with-step and without-step Random Forest variants receive identical "
    "chronological tuning (same forward-chaining folds, search space, budget and seed) and "
    "max-F1 thresholds from training-period forward-chaining out-of-fold predictions; both are "
    "frozen before a single scoring of the future holdout."
)


def safe_output_dir(path: Path) -> Path:
    """Refuses any output location inside the production model directory."""
    resolved = path.resolve()
    production = PRODUCTION_MODELS_DIR.resolve()
    if resolved == production or production in resolved.parents:
        raise ValueError(f"Refusing to write research artefacts into {production}")
    return resolved


def feature_frame(X, features):
    """The exact feature frame for a variant, used for both fit and predict."""
    missing = [f for f in features if f not in X.columns]
    if missing:
        raise ValueError(f"missing features: {missing}")
    return X[features]


def candidate_frame(X):
    return feature_frame(X, CANDIDATE_FEATURES)


def build_candidate_pipeline():
    return build_pipeline(CANDIDATE_FEATURES)


def build_pipeline(features):
    from sklearn.compose import ColumnTransformer
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder

    return Pipeline(
        [
            (
                "preprocessor",
                ColumnTransformer(
                    [
                        ("categorical", OneHotEncoder(handle_unknown="ignore"), ["type"]),
                        ("numeric", "passthrough", [f for f in features if f != "type"]),
                    ]
                ),
            ),
            ("classifier", RandomForestClassifier(random_state=RANDOM_STATE, n_jobs=-1)),
        ]
    )


def forward_chaining_folds(steps, n_folds: int = 3):
    """(fit_idx, score_idx) position pairs: each fold scores a later block of
    steps with a model fit only on earlier steps. Positions index `steps`."""
    steps = np.asarray(steps)
    edges = np.quantile(steps, np.linspace(0, 1, n_folds + 2))
    folds = []
    for i in range(1, n_folds + 1):
        fit = np.flatnonzero(steps <= edges[i])
        score = np.flatnonzero((steps > edges[i]) & (steps <= edges[i + 1]))
        if len(fit) and len(score):
            folds.append((fit, score))
    return folds


def forward_oof(make_model, X, y, folds):
    """Out-of-fold fraud probabilities on the scored blocks of `folds`."""
    from sklearn.base import clone

    indices, probabilities = [], []
    for fit, score in folds:
        model = clone(make_model).fit(X.iloc[fit], y.iloc[fit])
        fraud = list(model.classes_).index(1)
        indices.append(score)
        probabilities.append(model.predict_proba(X.iloc[score])[:, fraud])
    order = np.concatenate(indices)
    return order, np.concatenate(probabilities)


def tune(pipeline, X, y, folds):
    from sklearn.model_selection import RandomizedSearchCV

    search = RandomizedSearchCV(
        pipeline.set_params(classifier__n_jobs=1),
        PARAMETER_SPACE,
        n_iter=SEARCH_ITERATIONS,
        scoring="average_precision",
        cv=folds,
        refit=False,
        random_state=RANDOM_STATE,
        n_jobs=-1,
        error_score="raise",
    )
    search.fit(X, y)
    return search.best_params_, float(search.best_score_)


def paired_bootstrap(y, p_candidate, p_baseline, t_candidate, t_baseline, n: int = 1000, seed: int = 0) -> dict:
    """95% intervals for candidate minus baseline on resampled holdout rows.
    Runs after every choice is fixed; it only describes uncertainty."""
    from sklearn.metrics import average_precision_score, f1_score

    rng = np.random.default_rng(seed)
    y = np.asarray(y)
    diffs = {"f1": [], "average_precision": []}
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        if y[i].sum() == 0:
            continue
        diffs["f1"].append(
            f1_score(y[i], p_candidate[i] >= t_candidate, zero_division=0)
            - f1_score(y[i], p_baseline[i] >= t_baseline, zero_division=0)
        )
        diffs["average_precision"].append(
            average_precision_score(y[i], p_candidate[i]) - average_precision_score(y[i], p_baseline[i])
        )
    return {
        k: {
            "mean_difference": round(float(np.mean(v)), 4),
            "ci95": [round(float(np.percentile(v, 2.5)), 4), round(float(np.percentile(v, 97.5)), 4)],
            "resamples": len(v),
        }
        for k, v in diffs.items()
    }


def run(output_dir: Path = RESEARCH_DIR) -> dict:
    import joblib

    output_dir = safe_output_dir(output_dir)
    X, y, _production = load_data()  # production artefact unused: in-sample on the holdout
    cutoff, training, holdout = temporal_split(X)

    X_train, y_train = X[training].reset_index(drop=True), y[training].reset_index(drop=True)
    folds = forward_chaining_folds(X_train["step"])
    fraud_per_fold = [int(y_train.iloc[score].sum()) for _, score in folds]

    # --- Every choice, for both variants, uses the training period only. ---
    frozen = {}
    for name, features in VARIANT_FEATURES.items():
        X_fit = feature_frame(X_train, features)
        best_params, cv_ap = tune(build_pipeline(features), X_fit, y_train, folds)
        model = build_pipeline(features).set_params(**best_params)
        order, oof = forward_oof(model, X_fit, y_train, folds)
        threshold = select_f1_threshold(y_train.iloc[order], oof)
        model.fit(X_fit, y_train)
        frozen[name] = {"model": model, "threshold": threshold, "params": best_params, "cv_ap": cv_ap}

    # --- Models and thresholds are frozen; score the holdout once. --------
    X_hold, y_hold = X[holdout], y[holdout].to_numpy()
    probabilities = {}
    for name, entry in frozen.items():
        model = entry["model"]
        fraud = list(model.classes_).index(1)
        probabilities[name] = model.predict_proba(feature_frame(X_hold, VARIANT_FEATURES[name]))[:, fraud]
    results = {name: classification_metrics(y_hold, probabilities[name], frozen[name]["threshold"]) for name in frozen}
    candidate, candidate_threshold = frozen["without_step"]["model"], frozen["without_step"]["threshold"]
    p_candidate, p_baseline = probabilities["without_step"], probabilities["with_step"]
    baseline_threshold = frozen["with_step"]["threshold"]
    uncertainty = paired_bootstrap(y_hold, p_candidate, p_baseline, candidate_threshold, baseline_threshold)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "protocol": PROTOCOL,
        "training_steps": f"1-{cutoff}",
        "holdout_steps": f"{cutoff + 1}-{int(X['step'].max())}",
        "training_rows": int(training.sum()),
        "training_fraud_rows": int(y[training].sum()),
        "holdout_rows": int(holdout.sum()),
        "holdout_fraud_rows": int(y[holdout].sum()),
        "chronological_fold_fraud_rows": fraud_per_fold,
        "candidate_features": CANDIDATE_FEATURES,
        "variants": {
            name: {
                "features": VARIANT_FEATURES[name],
                "best_params": {k.replace("classifier__", ""): v for k, v in e["params"].items()},
                "chronological_cv_average_precision": round(e["cv_ap"], 4),
                "threshold": round(e["threshold"], 6),
            }
            for name, e in frozen.items()
        },
        "search": {"iterations": SEARCH_ITERATIONS, "random_state": RANDOM_STATE, "space": PARAMETER_SPACE},
        "threshold_source": "max-F1 on forward-chaining out-of-fold probabilities, training period only",
        "holdout_results": results,
        "paired_bootstrap_without_step_minus_with_step": uncertainty,
        "note": "Fair comparison: both variants tuned, thresholded and frozen identically on the training period. The production artefact (trained on steps 1-737) is not used; its holdout score would be in-sample.",
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    # Trusted local output; never written into api/models/.
    joblib.dump(candidate, output_dir / "model.joblib")
    (output_dir / "threshold.json").write_text(
        json.dumps({"threshold": candidate_threshold, "features": CANDIDATE_FEATURES}, indent=2) + "\n"
    )
    (output_dir / "metrics.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
    return report


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, default=str))
