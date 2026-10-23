"""Tests for the research candidate path. No dataset, network or production
artefact writes are needed; models are fit on tiny synthetic frames."""

import numpy as np
import pandas as pd
import pytest

from scripts import train_candidate_no_step as cand


def synthetic(n=400, seed=0):
    rng = np.random.default_rng(seed)
    X = pd.DataFrame(
        {
            "step": np.repeat(np.arange(1, n // 4 + 1), 4)[:n],
            "type": rng.choice(["TRANSFER", "CASH_OUT", "PAYMENT"], n),
            "amount": rng.uniform(1, 1000, n),
            "oldbalanceOrg": rng.uniform(0, 1000, n),
            "oldbalanceDest": rng.uniform(0, 1000, n),
            "orig_txn_count_before": rng.integers(0, 3, n),
            "dest_txn_count_before": rng.integers(0, 3, n),
            "dest_is_merchant": rng.integers(0, 2, n),
        }
    )
    y = pd.Series((X["amount"] > 900).astype(int))
    return X, y


# Feature consistency --------------------------------------------------------


def test_candidate_features_are_production_features_minus_step():
    from api.cold_path.explain import FEATURE_ORDER  # the production order

    assert "step" not in cand.CANDIDATE_FEATURES
    assert cand.CANDIDATE_FEATURES == [f for f in FEATURE_ORDER if f != "step"]


def test_same_feature_frame_is_used_to_fit_and_predict():
    X, y = synthetic()
    model = cand.build_candidate_pipeline().set_params(classifier__n_estimators=5)
    model.fit(cand.candidate_frame(X), y)
    assert list(model.feature_names_in_) == cand.CANDIDATE_FEATURES
    # The pipeline selects its columns by name: an extra `step` column, even
    # with scrambled values, cannot change a single prediction.
    expected = model.predict_proba(cand.candidate_frame(X))
    scrambled = X.assign(step=np.random.default_rng(1).integers(1, 10_000, len(X)))
    assert np.array_equal(model.predict_proba(scrambled), expected)
    transformed = model.named_steps["preprocessor"].get_feature_names_out()
    assert not any("step" in name for name in transformed)


def test_candidate_frame_rejects_missing_features():
    X, _ = synthetic()
    with pytest.raises(ValueError):
        cand.candidate_frame(X.drop(columns=["amount"]))


# Chronological boundaries ------------------------------------------------------


def test_forward_chaining_folds_only_score_later_steps():
    steps = pd.Series(np.repeat(np.arange(1, 101), 3))
    folds = cand.forward_chaining_folds(steps)
    assert len(folds) == 3
    for fit, score in folds:
        assert steps.iloc[fit].max() < steps.iloc[score].min()
    scored = np.concatenate([score for _, score in folds])
    assert len(scored) == len(set(scored))  # each row scored at most once


# Threshold leakage prevention -------------------------------------------------


def test_out_of_fold_probabilities_come_from_models_fit_on_earlier_rows_only():
    X, y = synthetic()
    folds = cand.forward_chaining_folds(X["step"])
    seen = []

    class Recorder:
        def __init__(self):
            self.classes_ = np.array([0, 1])

        def get_params(self, deep=False):
            return {}

        def set_params(self, **_):
            return self

        def fit(self, X_fit, y_fit):
            seen.append(("fit", X_fit["step"].max()))
            return self

        def predict_proba(self, X_score):
            seen.append(("score", X_score["step"].min()))
            return np.tile([0.5, 0.5], (len(X_score), 1))

    order, p = cand.forward_oof(Recorder(), X, y, folds)
    for (kind_f, fit_max), (kind_s, score_min) in zip(seen[::2], seen[1::2]):
        assert (kind_f, kind_s) == ("fit", "score") and fit_max < score_min
    # Only scored (out-of-fold) rows feed the threshold; the first block never does.
    assert set(order) == set(np.concatenate([s for _, s in folds]))
    assert len(order) == len(p) < len(X)


def test_threshold_selection_receives_only_training_period_oof_predictions(monkeypatch, tmp_path):
    """For both variants, select_f1_threshold must receive exactly the
    out-of-fold labels and probabilities from forward-chaining blocks inside
    the training period: never the first block (no OOF prediction exists),
    never in-sample scores, never holdout rows."""
    X, y = synthetic(800)
    cutoff = int(X["step"].quantile(0.8))
    train_steps = X.loc[X["step"] <= cutoff, "step"].reset_index(drop=True)
    monkeypatch.setattr(cand, "load_data", lambda: (X, y, object()))
    monkeypatch.setattr(cand, "paired_bootstrap", lambda *a, **k: {})

    tuned, oof_calls, select_calls = [], [], []

    def spy_tune(pipeline, X_fit, y_fit, folds):
        tuned.append((len(X_fit), [(f.copy(), s_.copy()) for f, s_ in folds]))
        return {"classifier__n_estimators": 5}, 0.0

    real_oof = cand.forward_oof

    def spy_oof(model, X_fit, y_fit, folds):
        order, p = real_oof(model, X_fit, y_fit, folds)
        oof_calls.append((order.copy(), p.copy(), folds))
        return order, p

    def spy_select(y_true, probabilities):
        select_calls.append((y_true.copy(), np.asarray(probabilities).copy()))
        return 0.5

    monkeypatch.setattr(cand, "tune", spy_tune)
    monkeypatch.setattr(cand, "forward_oof", spy_oof)
    monkeypatch.setattr(cand, "select_f1_threshold", spy_select)

    report = cand.run(tmp_path / "out")

    n_train = len(train_steps)
    assert len(tuned) == len(oof_calls) == len(select_calls) == 2  # both variants
    # Both variants are tuned on the identical training rows and folds.
    assert tuned[0][0] == tuned[1][0] == n_train
    for (f0, s0), (f1, s1) in zip(tuned[0][1], tuned[1][1]):
        assert np.array_equal(f0, f1) and np.array_equal(s0, s1)

    for (order, p, folds), (y_true, probs) in zip(oof_calls, select_calls):
        scored = np.concatenate([score for _, score in folds])
        first_block = set(range(n_train)) - set(scored)
        # Exactly the OOF rows, in OOF order, with the OOF probabilities.
        assert list(y_true.index) == list(order)
        assert np.array_equal(probs, p)
        assert set(order) == set(scored) and not (set(order) & first_block)
        # All of them lie in the training period.
        assert train_steps.iloc[order].max() <= cutoff
        assert len(y_true) < n_train

    assert report["holdout_rows"] == len(X) - n_train
    assert set(report["holdout_results"]) == {"with_step", "without_step"}
    assert "paired_bootstrap_without_step_minus_with_step" in report
    assert "paired_bootstrap_candidate_minus_baseline" not in report
    assert report["protocol"] == cand.PROTOCOL and "identical chronological tuning" in report["protocol"]


def test_variants_differ_only_by_step():
    assert cand.VARIANT_FEATURES["with_step"] == ["step"] + cand.VARIANT_FEATURES["without_step"]


# Artefact path safety ------------------------------------------------------------


@pytest.mark.parametrize("path", [cand.PRODUCTION_MODELS_DIR, cand.PRODUCTION_MODELS_DIR / "research"])
def test_research_output_refuses_the_production_model_directory(path):
    with pytest.raises(ValueError):
        cand.safe_output_dir(path)
    with pytest.raises(ValueError):
        cand.run(path)  # refused before any data is loaded


def test_default_output_is_the_research_directory():
    out = cand.safe_output_dir(cand.RESEARCH_DIR)
    assert out.parts[-2:] == ("research", "candidate_no_step")
    assert cand.PRODUCTION_MODELS_DIR.resolve() not in out.parents
