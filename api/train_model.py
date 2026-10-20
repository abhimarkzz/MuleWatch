import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from sklearn.base import clone
from sklearn.metrics import (
    auc,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
)
from sklearn.model_selection import (
    RandomizedSearchCV,
    StratifiedKFold,
    cross_val_predict,
    train_test_split,
)


# ------------------------------------------------------------
# MULEWATCH - MODEL TUNING AND EVALUATION
# ------------------------------------------------------------

ROOT_DIR = Path(__file__).resolve().parent.parent

DATASET_PATH = (
    ROOT_DIR
    / "data"
    / "processed"
    / "paysim_sample_100k.csv"
)

MODEL_PATH = (
    ROOT_DIR
    / "api"
    / "models"
    / "fraud_detection_rf.joblib"
)

THRESHOLD_PATH = (
    ROOT_DIR
    / "api"
    / "models"
    / "fraud_threshold.json"
)

REPORT_PATH = (
    ROOT_DIR
    / "api"
    / "models"
    / "evaluation_metrics.json"
)

FEATURE_COLUMNS = [
    "step",
    "amount",
    "oldbalanceOrg",
    "oldbalanceDest",
    "orig_txn_count_before",
    "dest_txn_count_before",
    "dest_is_merchant",
    "type",
]

RANDOM_STATE = 42


def add_previous_transaction_counts(
    df: pd.DataFrame,
    account_column: str,
) -> pd.Series:
    """
    Count transactions for an account at strictly earlier steps.

    Transactions at the same step are not counted as prior events
    because the dataset does not provide their exact ordering.
    """

    step_counts = (
        df.groupby([account_column, "step"], sort=True)
        .size()
        .rename("transactions_at_step")
        .reset_index()
    )

    step_counts["count_before"] = (
        step_counts.groupby(account_column, sort=False)[
            "transactions_at_step"
        ].cumsum()
        - step_counts["transactions_at_step"]
    )

    lookup = step_counts.set_index(
        [account_column, "step"]
    )["count_before"]

    row_keys = pd.MultiIndex.from_frame(
        df[[account_column, "step"]]
    )

    counts = lookup.reindex(row_keys).to_numpy(dtype=np.int64)

    return pd.Series(counts, index=df.index)


def prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build the eight features accepted by the existing pipeline."""

    required_columns = [
        "step",
        "type",
        "amount",
        "nameOrig",
        "oldbalanceOrg",
        "nameDest",
        "oldbalanceDest",
        "isFraud",
    ]

    missing = [
        column
        for column in required_columns
        if column not in df.columns
    ]

    if missing:
        raise ValueError(
            f"Missing required dataset columns: {missing}"
        )

    if df[required_columns].isnull().any().any():
        raise ValueError(
            "Missing values were found in required columns."
        )

    features = pd.DataFrame(index=df.index)

    features["step"] = pd.to_numeric(
        df["step"], errors="raise"
    )
    features["amount"] = pd.to_numeric(
        df["amount"], errors="raise"
    )
    features["oldbalanceOrg"] = pd.to_numeric(
        df["oldbalanceOrg"], errors="raise"
    )
    features["oldbalanceDest"] = pd.to_numeric(
        df["oldbalanceDest"], errors="raise"
    )

    features["orig_txn_count_before"] = (
        add_previous_transaction_counts(df, "nameOrig")
    )

    features["dest_txn_count_before"] = (
        add_previous_transaction_counts(df, "nameDest")
    )

    features["dest_is_merchant"] = (
        df["nameDest"].astype(str).str.startswith("M").astype(int)
    )

    features["type"] = df["type"].astype(str)

    # Keep the exact input order expected by the saved pipeline.
    return features[FEATURE_COLUMNS]


def threshold_metrics(
    y_true: np.ndarray,
    fraud_scores: np.ndarray,
    threshold: float,
) -> dict:
    """Calculate fraud-class metrics at one probability threshold."""

    y_pred = (fraud_scores >= threshold).astype(int)

    tn, fp, fn, tp = confusion_matrix(
        y_true,
        y_pred,
        labels=[0, 1],
    ).ravel()

    return {
        "threshold": float(threshold),
        "precision": float(
            precision_score(
                y_true, y_pred, pos_label=1, zero_division=0
            )
        ),
        "recall": float(
            recall_score(
                y_true, y_pred, pos_label=1, zero_division=0
            )
        ),
        "f1_score": float(
            f1_score(
                y_true, y_pred, pos_label=1, zero_division=0
            )
        ),
        "true_positives": int(tp),
        "false_positives": int(fp),
        "false_negatives": int(fn),
        "true_negatives": int(tn),
    }


def json_safe(value):
    """Convert NumPy scalar values into standard JSON values."""

    if isinstance(value, np.generic):
        return value.item()

    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    return str(value)


def main() -> None:
    if not DATASET_PATH.is_file():
        raise FileNotFoundError(
            f"Dataset not found: {DATASET_PATH}"
        )

    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Existing pipeline not found: {MODEL_PATH}"
        )

    # 1. Load the existing pipeline as a configuration template.
    print("Loading existing MuleWatch pipeline...")
    original_model = joblib.load(MODEL_PATH)

    if not hasattr(original_model, "named_steps"):
        raise TypeError(
            "Expected a scikit-learn Pipeline with named steps."
        )

    if "classifier" not in original_model.named_steps:
        raise ValueError(
            "Expected a pipeline step named 'classifier'."
        )

    if not hasattr(
        original_model.named_steps["classifier"],
        "n_estimators",
    ):
        raise TypeError(
            "The classifier is not compatible with the "
            "Random Forest tuning configuration."
        )

    expected_features = getattr(
        original_model,
        "feature_names_in_",
        None,
    )

    if (
        expected_features is not None
        and list(expected_features) != FEATURE_COLUMNS
    ):
        raise ValueError(
            "Feature order mismatch.\n"
            f"Pipeline: {list(expected_features)}\n"
            f"Evaluator: {FEATURE_COLUMNS}"
        )

    # 2. Load labelled data.
    print("Loading PaySim sample...")
    df = pd.read_csv(DATASET_PATH)

    if "isFraud" not in df.columns:
        raise ValueError("The dataset has no isFraud label.")

    y_numeric = pd.to_numeric(
        df["isFraud"], errors="coerce"
    )

    if y_numeric.isnull().any() or not y_numeric.isin([0, 1]).all():
        raise ValueError(
            "isFraud must contain only numeric labels 0 and 1."
        )

    y = y_numeric.astype(int).to_numpy()

    fraud_count = int((y == 1).sum())

    if fraud_count < 30:
        raise ValueError(
            f"Only {fraud_count} fraud cases are available. "
            "Use a larger labelled dataset before tuning."
        )

    print(f"Total rows: {len(df):,}")
    print(f"Fraud cases: {fraud_count:,}")
    print(f"Fraud prevalence: {100 * y.mean():.4f}%")

    # 3. Prepare the features.
    print("\nPreparing prediction-time features...")
    X = prepare_features(df)

    # Keep the test set isolated from hyperparameter and threshold
    # selection. Stratification preserves the class proportions.
    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.20,
        random_state=RANDOM_STATE,
        stratify=y,
    )

    print(f"\nTraining rows: {len(X_train):,}")
    print(f"Test rows: {len(X_test):,}")
    print(f"Training fraud cases: {int(y_train.sum()):,}")
    print(f"Test fraud cases: {int(y_test.sum()):,}")

    # 4. Tune model parameters by Average Precision rather than accuracy.
    #
    # Search uses the pipeline's existing ColumnTransformer, so the
    # categorical encoding and feature transformations are retained.
    base_model = clone(original_model)

    # Avoid nested parallelism during cross-validation.
    base_model.set_params(classifier__n_jobs=1)

    parameter_search = {
        "classifier__n_estimators": [150, 250, 350],
        "classifier__class_weight": [
            None,
            "balanced",
            "balanced_subsample",
        ],
        "classifier__max_depth": [
            None,
            12,
            20,
            30,
        ],
        "classifier__min_samples_split": [
            2,
            5,
            10,
        ],
        "classifier__min_samples_leaf": [
            1,
            2,
            4,
        ],
        "classifier__max_features": [
            "sqrt",
            0.7,
        ],
    }

    search_cv = StratifiedKFold(
        n_splits=3,
        shuffle=True,
        random_state=RANDOM_STATE,
    )

    search = RandomizedSearchCV(
        estimator=base_model,
        param_distributions=parameter_search,
        n_iter=8,
        scoring="average_precision",
        cv=search_cv,
        refit=True,
        random_state=RANDOM_STATE,
        n_jobs=2,
        verbose=1,
        error_score="raise",
        return_train_score=False,
    )

    print(
        "\nTuning 8 Random Forest configurations with "
        "3-fold cross-validation..."
    )
    print("This may take several minutes.")

    search.fit(X_train, y_train)

    best_model = search.best_estimator_

    print("\nBest cross-validation Average Precision:")
    print(f"{search.best_score_:.4f}")

    print("\nBest parameters:")
    for parameter, value in search.best_params_.items():
        print(f"  {parameter}: {value}")

    # 5. Select a threshold from out-of-fold probabilities on the
    # training split. The held-out test labels are not used here.
    print("\nSelecting the decision threshold from training folds...")

    threshold_cv = StratifiedKFold(
        n_splits=3,
        shuffle=True,
        random_state=RANDOM_STATE + 1,
    )

    oof_probabilities = cross_val_predict(
        best_model,
        X_train,
        y_train,
        cv=threshold_cv,
        method="predict_proba",
        n_jobs=2,
    )

    class_labels = np.asarray(best_model.classes_)
    fraud_indices = np.flatnonzero(class_labels == 1)

    if len(fraud_indices) != 1:
        raise ValueError(
            f"Could not identify fraud class 1: {class_labels}"
        )

    fraud_index = int(fraud_indices[0])
    oof_fraud_scores = oof_probabilities[:, fraud_index]

    precision_values, recall_values, thresholds = (
        precision_recall_curve(
            y_train,
            oof_fraud_scores,
            pos_label=1,
        )
    )

    # precision and recall have one more element than thresholds.
    # Find the threshold with the highest out-of-fold F1-score.
    denominator = (
        precision_values[:-1] + recall_values[:-1]
    )

    f1_values = np.divide(
        2 * precision_values[:-1] * recall_values[:-1],
        denominator,
        out=np.zeros_like(denominator),
        where=denominator != 0,
    )

    if len(thresholds) == 0:
        raise ValueError(
            "Could not select a threshold from training predictions."
        )

    best_threshold_index = int(np.argmax(f1_values))
    best_threshold = float(thresholds[best_threshold_index])

    print(f"Selected threshold: {best_threshold:.6f}")
    print(f"Training OOF F1-score: {f1_values[best_threshold_index]:.4f}")

    # 6. Evaluate once on the held-out test set.
    print("\nEvaluating on the held-out test set...")

    test_probabilities = best_model.predict_proba(X_test)
    test_fraud_scores = test_probabilities[:, fraud_index]

    default_metrics = threshold_metrics(
        y_test,
        test_fraud_scores,
        0.5,
    )

    tuned_metrics = threshold_metrics(
        y_test,
        test_fraud_scores,
        best_threshold,
    )

    # PR-AUC depends on the ranking scores, not the selected threshold.
    precision_curve, recall_curve, _ = precision_recall_curve(
        y_test,
        test_fraud_scores,
        pos_label=1,
    )

    test_pr_auc = auc(recall_curve, precision_curve)
    test_average_precision = average_precision_score(
        y_test,
        test_fraud_scores,
    )

    # 7. Build a transparent report. Do not include accuracy.
    report = {
        "model": "RandomForestClassifier",
        "dataset": str(DATASET_PATH.relative_to(ROOT_DIR)),
        "total_dataset_rows": int(len(df)),
        "training_rows": int(len(X_train)),
        "test_rows": int(len(X_test)),
        "training_fraud_cases": int(y_train.sum()),
        "test_fraud_cases": int(y_test.sum()),
        "fraud_prevalence": float(y.mean()),
        "optimization_metric": "average_precision",
        "best_cross_validation_average_precision": float(
            search.best_score_
        ),
        "best_parameters": {
            key: json_safe(value)
            for key, value in search.best_params_.items()
        },
        "test_pr_auc": float(test_pr_auc),
        "test_average_precision": float(test_average_precision),
        "test_at_default_threshold": default_metrics,
        "test_at_f1_tuned_threshold": tuned_metrics,
        "selected_threshold": best_threshold,
        "note": (
            "Metrics come from a held-out random test split. "
            "The dataset contains few fraud cases, so estimates "
            "may be unstable. No accuracy score is reported."
        ),
    }

    # 8. Save the tuned threshold.
    THRESHOLD_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with THRESHOLD_PATH.open("w", encoding="utf-8") as file:
        json.dump(
            {
                "threshold": best_threshold,
                "selection_method": (
                    "Maximum F1-score using out-of-fold "
                    "probabilities from the training split"
                ),
            },
            file,
            indent=2,
        )

    # 9. Once evaluation is complete, refit the selected configuration
    # on all available labelled data for deployment.
    # The test scores above remain from the untouched test evaluation.
    print("\nRefitting the selected model on all available data...")

    production_model = clone(best_model)
    production_model.set_params(classifier__n_jobs=-1)
    production_model.fit(X, y)

    # Overwrite the existing model file only after successful training.
    joblib.dump(production_model, MODEL_PATH)

    with REPORT_PATH.open("w", encoding="utf-8") as file:
        json.dump(report, file, indent=2)

    print("\n" + "=" * 60)
    print("MULEWATCH - TUNED MODEL EVALUATION")
    print("=" * 60)
    print(f"Test samples:          {len(y_test):,}")
    print(f"Actual fraud cases:    {int(y_test.sum()):,}")
    print(f"Actual legitimate:     {int((y_test == 0).sum()):,}")

    print("\n--- Default threshold (0.50) ---")
    print(f"Precision:             {default_metrics['precision']:.4f}")
    print(f"Recall:                {default_metrics['recall']:.4f}")
    print(f"F1-score:              {default_metrics['f1_score']:.4f}")

    print("\n--- F1-tuned threshold ---")
    print(f"Threshold:             {best_threshold:.6f}")
    print(f"Precision:             {tuned_metrics['precision']:.4f}")
    print(f"Recall:                {tuned_metrics['recall']:.4f}")
    print(f"F1-score:              {tuned_metrics['f1_score']:.4f}")

    print("\n--- Ranking metrics ---")
    print(f"PR-AUC:                {test_pr_auc:.4f}")
    print(f"Average Precision:     {test_average_precision:.4f}")

    print("\n--- Tuned-threshold confusion matrix ---")
    print(f"True positives:        {tuned_metrics['true_positives']}")
    print(f"False positives:       {tuned_metrics['false_positives']}")
    print(f"False negatives:       {tuned_metrics['false_negatives']}")
    print(f"True negatives:        {tuned_metrics['true_negatives']}")

    print("\nAccuracy was intentionally not calculated or reported.")
    print(f"\nModel saved:     {MODEL_PATH}")
    print(f"Threshold saved: {THRESHOLD_PATH}")
    print(f"Report saved:    {REPORT_PATH}")
    print("=" * 60)

    if int(y_test.sum()) < 100:
        print(
            "\nWARNING: The test set has fewer than 100 fraud cases. "
            "Use a larger dataset for more reliable conclusions."
        )


if __name__ == "__main__":
    main()