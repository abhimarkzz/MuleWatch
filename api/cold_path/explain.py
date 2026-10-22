"""Local explanation of the Random Forest's score for one transaction.

Tree-path decomposition (Saabas): in every tree, each split on the decision
path moves the predicted fraud probability from the parent's value to the
child's; that change is credited to the split feature. Averaged over the
forest, the result is exact:

    predict_proba(x)[fraud] == base_value + sum(contributions)

It needs only the trained pipeline, not the training data. Contributions
describe how the model scored this row, not causal effects, and correlated
features can share credit unevenly.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

# Same order as api/main.py /predict and the training pipeline.
FEATURE_ORDER = [
    "step",
    "amount",
    "oldbalanceOrg",
    "oldbalanceDest",
    "orig_txn_count_before",
    "dest_txn_count_before",
    "dest_is_merchant",
    "type",
]

METHOD = "random_forest_tree_path_decomposition"


def _original_feature(name: str) -> str:
    """Maps 'categorical__type_TRANSFER' / 'numeric__amount' to 'type' / 'amount'."""
    name = name.split("__", 1)[-1]
    return "type" if name.startswith("type_") else name


def explain_prediction(pipeline: Any, features: dict, top_n: int = 8) -> dict:
    missing = [f for f in FEATURE_ORDER if f not in features]
    if missing:
        raise ValueError(f"missing features: {', '.join(missing)}")

    preprocessor = pipeline.named_steps["preprocessor"]
    forest = pipeline.named_steps["classifier"]
    fraud = list(forest.classes_).index(1)

    row = pd.DataFrame([{f: features[f] for f in FEATURE_ORDER}])
    transformed = preprocessor.transform(row)
    if hasattr(transformed, "toarray"):
        transformed = transformed.toarray()
    transformed = np.asarray(transformed, dtype=np.float32)
    names = [_original_feature(n) for n in preprocessor.get_feature_names_out()]

    contributions = np.zeros(transformed.shape[1])
    base = 0.0
    for tree_model in forest.estimators_:
        tree = tree_model.tree_
        path = tree_model.decision_path(transformed).indices
        values = tree.value[:, 0, :]
        probabilities = values[path, fraud] / values[path].sum(axis=1)
        base += probabilities[0]
        for parent, change in zip(path[:-1], np.diff(probabilities)):
            contributions[tree.feature[parent]] += change

    count = len(forest.estimators_)
    base /= count
    contributions /= count

    grouped: dict[str, float] = {}
    for name, value in zip(names, contributions):
        grouped[name] = grouped.get(name, 0.0) + float(value)

    probability = float(pipeline.predict_proba(row)[0][fraud])
    ranked = sorted(grouped.items(), key=lambda item: abs(item[1]), reverse=True)

    return {
        "method": METHOD,
        "fraud_probability": round(probability, 6),
        "base_value": round(base, 6),
        "contributions": [
            {"feature": name, "value": features[name], "contribution": round(value, 6)}
            for name, value in ranked[:top_n]
        ],
        "reconstruction_error": round(abs(base + sum(grouped.values()) - probability), 9),
        "note": "How this model scored the transaction; not a causal or legal finding.",
    }
