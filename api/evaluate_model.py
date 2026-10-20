import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from sklearn.base import clone
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    accuracy_score,  # Do not calculate or report accuracy.
    auc,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
)


ROOT_DIR = Path(__file__).resolve().parent.parent

DATASET_PATH = ROOT_DIR / "data" / "processed" / "paysim_sample_100k.csv"

MODEL_PATH = (
    ROOT_DIR / "api" / "models" / "fraud_detection_rf.joblib"
)

REPORT_PATH = (
    ROOT_DIR / "api" / "models" / "evaluation_metrics.json"
)

# Match the feature names and order found in the saved pipeline.
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


def add_previous_transaction_counts(
    df: pd.DataFrame,
    account_column: str,
    output_column: str,
) -> pd.Series:
    """
    Count prior transactions for each account using earlier steps.

    Transactions from the same step are not counted as prior
    transactions because PaySim's step field does not establish
    their exact order within a step.
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

    return pd.Series(
        lookup.reindex(row_keys).to_numpy(dtype=np.int64),
        index=df.index,
        name=output_column,
    )


def prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    """Create the eight features expected by the saved pipeline."""

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
            f"Dataset is missing required columns: {missing}"
        )

    if df[required_columns].isnull().any().any():
        raise ValueError(
            "The dataset contains missing values in required columns."
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

    features["type"] = df["type"].astype(str)

    # Historical activity features, computed without using labels.
    features["orig_txn_count_before"] = (
        add_previous_transaction_counts(
            df, "nameOrig", "orig_txn_count_before"
        )
    )

    features["dest_txn_count_before"] = (
        add_previous_transaction_counts(
            df, "nameDest", "dest_txn_count_before"
        )
    )

    # PaySim uses M-prefixed destination IDs for merchants.
    features["dest_is_merchant"] = (
        df["nameDest"]
        .astype(str)
        .str.startswith("M")
        .astype(int)
    )

    return features[FEATURE_COLUMNS]


def main() -> None:
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Saved model not found: {MODEL_PATH}"
        )

    if not DATASET_PATH.is_file():
        raise FileNotFoundError(
            f"Dataset not found: {DATASET_PATH}"
        )

    print("Loading saved MuleWatch model configuration...")
    saved_model = joblib.load(MODEL_PATH)

    saved_feature_names = getattr(
        saved_model, "feature_names_in_", None
    )

    if saved_feature_names is not None:
        if list(saved_feature_names) != FEATURE_COLUMNS:
            raise ValueError(
                "Feature mismatch.\n"
                f"Model expects: {list(saved_feature_names)}\n"
                f"Evaluator creates: {FEATURE_COLUMNS}"
            )

    print("Loading PaySim dataset...")
    df = pd.read_csv(DATASET_PATH)

    print(f"Dataset rows: {len(df):,}")

    y_series = pd.to_numeric(
        df["isFraud"], errors="coerce"
    )

    if y_series.isnull().any():
        raise ValueError("The isFraud label contains invalid values.")

    if not y_series.isin([0, 1]).all():
        raise ValueError("The isFraud label must contain only 0 and 1.")

    y = y_series.astype(int)

    if y.value_counts().get(1, 0) < 2:
        raise ValueError("Not enough fraud examples for evaluation.")

    print("\nPreparing prediction-time features...")
    X = prepare_features(df)

    print("\nSplitting the data into train and test subsets...")
    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.20,
        random_state=42,
        stratify=y,
    )

    print(f"Training rows: {len(X_train):,}")
    print(f"Test rows:     {len(X_test):,}")
    print(f"Training fraud cases: {int(y_train.sum()):,}")
    print(f"Test fraud cases:     {int(y_test.sum()):,}")

    # Clone the saved pipeline's configuration, then fit the new
    # copy only on the training split. Do not use the already-fitted
    # production model to score rows that may have trained it.
    print("\nTraining a fresh evaluation copy of the pipeline...")
    evaluation_model = clone(saved_model)
    evaluation_model.fit(X_train, y_train)

    print("Scoring the held-out test set...")
    y_pred = np.asarray(
        evaluation_model.predict(X_test)
    ).astype(int)

    if not hasattr(evaluation_model, "predict_proba"):
        raise TypeError("Model does not support probability predictions.")

    classes = np.asarray(evaluation_model.classes_)
    fraud_index = np.flatnonzero(classes == 1)

    if len(fraud_index) != 1:
        raise ValueError(
            f"Cannot identify fraud probability column: {classes}"
        )

    fraud_scores = evaluation_model.predict_proba(X_test)[
        :, fraud_index[0]
    ]

    # Calculate metrics for fraud class 1 only.
    precision = precision_score(
        y_test, y_pred, pos_label=1, zero_division=0
    )
    recall = recall_score(
        y_test, y_pred, pos_label=1, zero_division=0
    )
    f1 = f1_score(
        y_test, y_pred, pos_label=1, zero_division=0
    )

    # PR-AUC using the precision-recall curve.
    precision_curve, recall_curve, _ = precision_recall_curve(
        y_test, fraud_scores, pos_label=1
    )

    pr_auc = auc(recall_curve, precision_curve)

    # Average Precision is also useful for evaluating the rare class.
    average_precision = average_precision_score(
        y_test, fraud_scores
    )

    tn, fp, fn, tp = confusion_matrix(
        y_test, y_pred, labels=[0, 1]
    ).ravel()

    report = {
        "model": type(evaluation_model.named_steps["classifier"]).__name__
        if hasattr(evaluation_model, "named_steps")
        else type(evaluation_model).__name__,
        "evaluation_method": (
            "Stratified 80/20 split; fresh clone of the saved "
            "pipeline configuration trained on the 80% split"
        ),
        "dataset": str(DATASET_PATH.relative_to(ROOT_DIR)),
        "test_samples": int(len(y_test)),
        "actual_fraud_cases": int((y_test == 1).sum()),
        "actual_legitimate_cases": int((y_test == 0).sum()),
        "fraud_prevalence": float(y_test.mean()),
        "precision": float(precision),
        "recall": float(recall),
        "f1_score": float(f1),
        "pr_auc": float(pr_auc),
        "average_precision": float(average_precision),
        "confusion_matrix": {
            "true_positives": int(tp),
            "false_positives": int(fp),
            "false_negatives": int(fn),
            "true_negatives": int(tn),
        },
    }

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)

    with REPORT_PATH.open("w", encoding="utf-8") as file:
        json.dump(report, file, indent=2)

    print("\n" + "=" * 54)
    print("MULEWATCH — DAY 23 EVALUATION RESULTS")
    print("=" * 54)
    print(f"Test samples:              {len(y_test):,}")
    print(f"Actual fraud cases:        {int((y_test == 1).sum()):,}")
    print(f"Actual legitimate cases:   {int((y_test == 0).sum()):,}")
    print("-" * 54)
    print(f"Precision:                 {precision:.4f}")
    print(f"Recall:                    {recall:.4f}")
    print(f"F1-score:                  {f1:.4f}")
    print(f"PR-AUC:                    {pr_auc:.4f}")
    print(f"Average Precision:         {average_precision:.4f}")
    print("-" * 54)
    print(f"True positives:            {tp}")
    print(f"False positives:           {fp}")
    print(f"False negatives:           {fn}")
    print(f"True negatives:            {tn}")
    print("=" * 54)
    print("\nAccuracy was intentionally not calculated or reported.")
    print(f"Report saved to: {REPORT_PATH}")

    if int((y_test == 1).sum()) < 30:
        print(
            "\nWARNING: The test set contains fewer than 30 fraud cases. "
            "Metrics can be unstable because fraud is rare."
        )


if __name__ == "__main__":
    main()