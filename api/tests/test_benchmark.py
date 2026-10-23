"""Benchmark helper tests; no network, dataset or model needed."""

import numpy as np
import pytest

from scripts.benchmark import classification_metrics, percentile, summarize


def test_percentile_uses_nearest_rank():
    values = list(range(1, 101))
    assert percentile(values, 50) == 50
    assert percentile(values, 95) == 95
    assert percentile(values, 99) == 99
    assert percentile([7.0], 99) == 7.0
    assert percentile([], 50) is None


def test_summary_counts_errors_separately():
    s = summarize([100.0, 300.0, 200.0], errors=2)
    assert s["n"] == 3 and s["errors"] == 2
    assert s["p50_ms"] == 200.0 and s["max_ms"] == 300.0
    assert summarize([], 4)["p50_ms"] is None


def test_classification_metrics_confusion_and_rates():
    y = np.array([1, 1, 0, 0, 0])
    p = np.array([0.9, 0.2, 0.6, 0.1, 0.0])
    m = classification_metrics(y, p, threshold=0.5)
    assert m["confusion_matrix"] == {"tn": 2, "fp": 1, "fn": 1, "tp": 1}
    assert m["precision"] == 0.5 and m["recall"] == 0.5
    assert m["roc_auc"] == pytest.approx(0.8333, abs=1e-4)


def test_roc_auc_is_undefined_for_one_class():
    m = classification_metrics(np.array([0, 0, 0]), np.array([0.1, 0.7, 0.2]), threshold=0.5)
    assert m["roc_auc"] is None and m["average_precision"] is None
    assert m["confusion_matrix"]["fp"] == 1


def test_select_f1_threshold_picks_the_best_f1_cut():
    from scripts.benchmark import select_f1_threshold

    y = np.array([0, 0, 0, 1, 1, 0, 1])
    p = np.array([0.1, 0.2, 0.3, 0.6, 0.7, 0.65, 0.9])
    # Cut at 0.6 catches all three frauds with one false positive (F1 0.857),
    # better than any higher cut.
    assert select_f1_threshold(y, p) == pytest.approx(0.6)


def test_temporal_split_never_overlaps():
    import pandas as pd
    from scripts.benchmark import temporal_split

    X = pd.DataFrame({"step": list(range(1, 101))})
    cutoff, early, late = temporal_split(X)
    assert cutoff == 80
    assert X.loc[early, "step"].max() <= cutoff < X.loc[late, "step"].min()
    assert not (early & late).any() and (early | late).all()
