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


def test_chronological_splits_keep_the_holdout_in_the_future():
    import pandas as pd
    from scripts.benchmark import chronological_splits, temporal_split

    X = pd.DataFrame({"step": list(range(1, 101))})
    (train_cut, holdout_cut), train, validation, holdout = chronological_splits(X)
    assert (train_cut, holdout_cut) == (60, 80)
    assert X.loc[train, "step"].max() < X.loc[validation, "step"].min()
    assert X.loc[validation, "step"].max() < X.loc[holdout, "step"].min()
    assert int(train.sum() + validation.sum() + holdout.sum()) == len(X)
    # Same future period as the two-way temporal split.
    _, _, late = temporal_split(X)
    assert (holdout == late).all()


def test_swap_feature_changes_only_that_column_and_draws_from_the_donor():
    import pandas as pd
    from scripts.benchmark import swap_feature

    target = pd.DataFrame({"step": [500, 600, 700], "amount": [1.0, 2.0, 3.0]})
    donor = pd.DataFrame({"step": [10, 20], "amount": [9.0, 9.0]})
    swapped = swap_feature(target, donor, "step", seed=1)
    assert set(swapped["step"]) <= {10, 20}
    assert swapped["amount"].tolist() == [1.0, 2.0, 3.0]
    assert target["step"].tolist() == [500, 600, 700]  # input untouched


def test_without_step_variant_removes_all_step_information():
    import pandas as pd
    from scripts.benchmark import VARIANTS

    X = pd.DataFrame({"step": [1, 400], "amount": [5.0, 6.0]})
    assert VARIANTS["without_step"](X)["step"].nunique() == 1
    assert VARIANTS["all_features"](X).equals(X)
