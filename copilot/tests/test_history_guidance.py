"""History guidance + historical backtest smoke tests."""

from deedpilot_copilot.agent import DeedCopilotAgent
from deedpilot_copilot.backtest_historical import run_historical_backtest
from deedpilot_copilot.history_guidance import (
    build_history_index,
    find_comparables,
    guidance_for_lot,
)
from deedpilot_copilot.schemas import Lot, SaleType


def test_find_comparables_mi():
    comps = find_comparables(
        state="MI",
        sale_type=SaleType.TAX_DEED,
        assessed_value=80_000,
        opening_bid=5_000,
        limit=5,
    )
    assert isinstance(comps, list)
    assert len(comps) >= 1
    assert comps[0]["state"] == "MI"


def test_guidance_for_lot_adds_history_fields():
    lot = Lot(
        lot_id="g1",
        fips="26163",
        state="MI",
        opening_bid=4_000,
        assessed_value=50_000,
        rehab_cost=10_000,
        sale_type=SaleType.TAX_DEED,
    )
    g = guidance_for_lot(lot, SaleType.TAX_DEED, oracle_max_bid=40_000)
    assert g.n >= 1
    assert g.key.startswith("MI|")
    assert g.suggested_buffer_usd >= 0
    assert 0.5 <= g.bid_fraction_of_ceiling <= 1.0
    assert g.comps


def test_agent_history_guided_never_over_oracle():
    lot = Lot(
        lot_id="g2",
        fips="26163",
        state="MI",
        opening_bid=3_000,
        assessed_value=60_000,
        rehab_cost=12_000,
        sale_type=SaleType.TAX_DEED,
    )
    traj = DeedCopilotAgent(use_history=True, use_llm_decide=False).run_lot(
        lot, seed="hist-g2"
    )
    assert "history_guided" in traj.tags or any(
        "History" in x for x in traj.reasoning_trace
    )
    if traj.action and traj.action.bid_amount and traj.maxbid_result and traj.maxbid_result.max_bid:
        assert traj.action.bid_amount <= traj.maxbid_result.max_bid + 1e-6


def test_build_history_index():
    idx = build_history_index()
    assert idx["nOutcomes"] > 1000
    assert idx["nBuckets"] >= 1
    assert "MI|Tax Deed" in idx["buckets"]


def test_historical_backtest_smoke():
    out = run_historical_backtest(limit=12, state="MI")
    assert out["n_sample"] >= 1
    assert out["n_over_oracle"] == 0
    assert "metrics" in out
    # With imputed assessed, agent should attempt some bids on MI deeds
    assert out["n_bids"] + out["n_passes"] == out["n_sample"]
