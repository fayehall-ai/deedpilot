"""Clearing-price model calibration and the bid search's oracle invariant."""

from __future__ import annotations

import math

import pytest

from deedpilot_copilot.evaluate import POLICIES, county_arv_priors, evaluate_policy
from deedpilot_copilot.labels import clearing_price_rows
from deedpilot_copilot.maxbid import compute_maxbid
from deedpilot_copilot.schemas import DealInputs, HistoricalOutcome, Lot, SaleType
from deedpilot_copilot.search import optimize_bid
from deedpilot_copilot.splits import LeakageError, get_split_rows
from deedpilot_copilot.world_model import (
    evaluate_clearing_price_model,
    fit_clearing_price_model,
    get_model,
    p_win,
    predict_quantiles,
)


def _row(i: int, price: float, county: str = "26049", date: str = "2020-05-05"):
    return HistoricalOutcome(
        id=f"mi-{county}-{i}",
        state="MI",
        fips=county,
        county_name="Test County",
        sale_type=SaleType.TAX_DEED,
        sale_date=date,
        winning_bid=price,
        redeemed=False,
        ownership_taken=True,
        provenance="recorded",
        source="https://www.tax-sale.info/listings/auction/1",
        notes="MI tax deed sold at Title Check auction.",
    )


def test_fit_refuses_held_out_rows():
    test_rows = get_split_rows("test")
    if not test_rows:
        pytest.skip("no corpus on disk")
    with pytest.raises(LeakageError):
        fit_clearing_price_model(test_rows[:20])


def test_quantiles_are_monotonic_and_positive():
    rows = [_row(i, 1000.0 * (1 + i % 20)) for i in range(200)]
    model = fit_clearing_price_model(rows)
    q = predict_quantiles(model, state="MI", fips="26049", year=2020)
    assert q.n_train == 200
    assert all(b >= a for a, b in zip(q.values, q.values[1:]))
    assert all(v > 0 for v in q.values)


def test_p_win_is_monotonic_in_bid():
    rows = [_row(i, 1000.0 * (1 + i % 20)) for i in range(200)]
    model = fit_clearing_price_model(rows)
    q = predict_quantiles(model, state="MI", fips="26049", year=2020)
    probs = [p_win(q, b) for b in (100, 1_000, 5_000, 20_000, 100_000)]
    assert all(b >= a for a, b in zip(probs, probs[1:]))
    assert probs[0] < 0.2 and probs[-1] > 0.8


def test_out_of_domain_state_refuses_to_predict():
    """Michigan's price level must not be quoted as a prior for Texas."""
    rows = [_row(i, 5000.0) for i in range(60)]
    model = fit_clearing_price_model(rows)
    q = predict_quantiles(model, state="TX", fips="48201")
    assert q.group == "out_of_domain"
    assert q.n_train == 0
    assert p_win(q, 50_000) == 0.0


def test_model_calibration_on_held_out_split():
    """Predicted quantiles should cover roughly their nominal rate out of time."""
    model = get_model()
    val = get_split_rows("val")
    if model is None or not clearing_price_rows(val):
        pytest.skip("no fitted model or corpus on disk")
    report = evaluate_clearing_price_model(model, val)
    assert report["n"] > 100
    # Loose bound: this is real market data, not a synthetic fixture.
    assert report["mean_abs_coverage_error"] < 0.12
    for level, cov in report["coverage"].items():
        assert 0.0 <= cov <= 1.0


def test_search_never_exceeds_the_oracle_ceiling():
    """The constitutional invariant. Holds regardless of what the model says."""
    for state, fips, sale, assessed, opening in [
        ("MI", "26049", SaleType.TAX_DEED, 40_000, 3_000),
        ("MI", "26163", SaleType.TAX_DEED, 120_000, 500),
        ("TX", "48201", SaleType.REDEEMABLE_DEED, 180_000, 12_000),
        ("GA", "13121", SaleType.REDEEMABLE_DEED, 60_000, 8_000),
    ]:
        lot = Lot(
            lot_id="t",
            fips=fips,
            state=state,
            opening_bid=opening,
            assessed_value=assessed,
            sale_type=sale,
        )
        deal = compute_maxbid(
            DealInputs(
                state=state,
                sale_type=sale,
                assessed_value=assessed,
                opening_bid=opening,
            )
        )
        plan = optimize_bid(lot, deal, sale)
        if plan.bid is not None:
            assert deal.max_bid is not None
            assert plan.bid <= deal.max_bid + 1e-6


def test_search_respects_a_lowered_ceiling():
    sale = SaleType.TAX_DEED
    lot = Lot(
        lot_id="t", fips="26049", state="MI", opening_bid=1_000,
        assessed_value=40_000, sale_type=sale,
    )
    deal = compute_maxbid(
        DealInputs(state="MI", sale_type=sale, assessed_value=40_000, opening_bid=1_000)
    )
    plan = optimize_bid(lot, deal, sale, ceiling=5_000)
    assert plan.bid is None or plan.bid <= 5_000 + 1e-6


def test_search_passes_when_oracle_says_no_bid():
    sale = SaleType.TAX_DEED
    lot = Lot(
        lot_id="t", fips="26049", state="MI", opening_bid=500_000,
        assessed_value=40_000, sale_type=sale,
    )
    deal = compute_maxbid(
        DealInputs(
            state="MI", sale_type=sale, assessed_value=40_000, opening_bid=500_000
        )
    )
    plan = optimize_bid(lot, deal, sale)
    assert plan.pass_ is True and plan.bid is None


def test_no_policy_violates_the_oracle_on_held_out_data():
    rows = [o for o in clearing_price_rows(get_split_rows("val")) if o.winning_bid]
    if not rows:
        pytest.skip("no corpus on disk")
    priors = county_arv_priors()
    sample = rows[:120]
    for name, fn in POLICIES.items():
        result = evaluate_policy(name, fn, sample, priors)
        assert result.n_oracle_violations == 0, f"{name} bid above the ceiling"


def test_evaluation_refuses_the_training_split():
    from deedpilot_copilot.evaluate import evaluate_policies

    with pytest.raises(ValueError):
        evaluate_policies("train")  # type: ignore[arg-type]
