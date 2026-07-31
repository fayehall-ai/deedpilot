"""Split integrity and the observed-only prior fit."""

from __future__ import annotations

import pytest

from deedpilot_copilot.history import calibrate_priors, load_outcomes
from deedpilot_copilot.labels import clearing_price_rows
from deedpilot_copilot.schemas import HistoricalOutcome, SaleType
from deedpilot_copilot.splits import (
    LeakageError,
    SplitPolicy,
    assert_no_leakage,
    get_split_rows,
    load_splits,
    partition,
    split_of,
)


def _row(**kw) -> HistoricalOutcome:
    base = dict(
        id="x",
        state="MI",
        sale_type=SaleType.TAX_DEED,
        redeemed=False,
        ownership_taken=True,
        provenance="recorded",
        source="https://www.tax-sale.info/listings/auction/1",
        winning_bid=1000.0,
    )
    base.update(kw)
    return HistoricalOutcome(**base)


def test_split_assignment_is_temporal():
    p = SplitPolicy(cut_val="2024-01-01", cut_test="2025-01-01")
    assert split_of(_row(id="a", sale_date="2022-06-01"), p) == "train"
    assert split_of(_row(id="b", sale_date="2024-03-01"), p) == "val"
    assert split_of(_row(id="c", sale_date="2025-09-01"), p) == "test"


def test_undated_rows_are_excluded_not_guessed():
    p = SplitPolicy()
    assert split_of(_row(id="d", sale_date=None), p) == "excluded"
    assert split_of(_row(id="e", sale_date="2024"), p) == "excluded"


def test_splits_are_disjoint_and_exhaustive():
    p = SplitPolicy()
    rows = [
        _row(id=f"r{i}", sale_date=d)
        for i, d in enumerate(
            ["2019-01-01", "2024-02-02", "2025-05-05", None, "2023-12-31"]
        )
    ]
    parts = partition(rows, p)
    ids = [o.id for group in parts.values() for o in group]
    assert sorted(ids) == sorted(o.id for o in rows)
    assert len(ids) == len(set(ids))


def test_leakage_guard_rejects_held_out_rows():
    p = SplitPolicy()
    rows = [_row(id="t", sale_date="2025-06-01")]
    with pytest.raises(LeakageError):
        assert_no_leakage(rows, allowed=("train",), policy=p, context="unit")
    # Train rows pass.
    assert_no_leakage(
        [_row(id="ok", sale_date="2020-01-01")], allowed=("train",), policy=p
    )


def test_p_redeem_not_swamped_by_unobserved_rows():
    """
    70k Illinois rows with no redemption follow-up must not outvote the prior.

    This is the regression that mattered: counting default-False as observed
    non-redemption drove IL Tax Lien to 0.02 against an expert prior of 0.72.
    """
    il = [
        _row(
            id=f"il-{i}",
            state="IL",
            sale_type=SaleType.TAX_LIEN,
            source="https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json",
            notes="Cook County Annual Tax Sale sold PIN. Lien not deed.",
            sale_date="2013-01-01",
        )
        for i in range(500)
    ]
    priors = calibrate_priors(il, cache=False)
    bucket = priors.buckets["IL|Tax Lien"]
    assert bucket.n == 500
    assert bucket.n_redemption_observed == 0
    assert bucket.p_redeem_source == "expert"
    assert bucket.p_redeem == pytest.approx(0.72, abs=1e-3)


def test_michigan_p_redeem_is_observed():
    mi = [_row(id=f"mi-{i}", sale_date="2022-01-01") for i in range(50)]
    priors = calibrate_priors(mi, cache=False)
    bucket = priors.buckets["MI|Tax Deed"]
    assert bucket.n_redemption_observed == 50
    assert bucket.p_redeem_source == "observed"
    assert bucket.p_redeem < 0.1


def test_expert_overlay_does_not_borrow_other_states_counts():
    """A state with no data must not report another state's observations."""
    from deedpilot_copilot.history import resolve_bucket

    mi = [_row(id=f"mi-{i}", sale_date="2022-01-01") for i in range(50)]
    priors = calibrate_priors(mi, cache=False)
    tx = resolve_bucket(priors, "TX", SaleType.REDEEMABLE_DEED)
    assert tx.n_redemption_observed == 0
    assert tx.p_redeem_source == "expert"


def test_unobserved_ownership_fields_are_reported():
    priors = calibrate_priors([_row(id="m", sale_date="2022-01-01")], cache=False)
    assert "exit_price" in priors.unobserved_fields
    assert "quiet_title_cost" in priors.unobserved_fields


def test_corpus_splits_have_held_out_price_rows():
    rows = load_outcomes()
    if not rows:
        pytest.skip("no corpus on disk")
    load_splits()
    for split in ("val", "test"):
        assert len(clearing_price_rows(get_split_rows(split))) > 0
