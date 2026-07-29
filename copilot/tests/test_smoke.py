"""Smoke tests for trusted tools + flywheel."""

from deedpilot_copilot.agent import DeedCopilotAgent
from deedpilot_copilot.atlas import lookup_atlas
from deedpilot_copilot.flywheel import default_synthetic_lots, run_cycle
from deedpilot_copilot.maxbid import compute_maxbid
from deedpilot_copilot.schemas import DealInputs, Lot, SaleType


def test_lookup_harris():
    r = lookup_atlas("48201")
    assert r.state == "TX"
    assert r.fips == "48201"
    assert r.sale_type


def test_maxbid_tx_positive():
    res = compute_maxbid(
        DealInputs(
            state="TX",
            sale_type=SaleType.REDEEMABLE_DEED,
            assessed_value=200_000,
            rehab_cost=20_000,
            opening_bid=10_000,
        )
    )
    assert res.max_bid is not None
    assert res.recommendation in ("bid", "no-bid")


def test_maxbid_insufficient():
    res = compute_maxbid(
        DealInputs(state="TX", sale_type=SaleType.REDEEMABLE_DEED)
    )
    assert res.recommendation == "insufficient-data"
    assert res.max_bid is None


def test_agent_trajectory():
    lot = Lot(
        lot_id="t1",
        fips="48201",
        state="TX",
        opening_bid=12_000,
        assessed_value=180_000,
        rehab_cost=25_000,
    )
    traj = DeedCopilotAgent().run_lot(lot, seed="t1")
    assert traj.maxbid_result is not None
    assert traj.atlas_result is not None
    assert traj.action is not None
    assert traj.critique.get("score") is not None


def test_flywheel_cycle():
    out = run_cycle(default_synthetic_lots()[:3])
    assert out["lessons_added"] >= 0
    assert "metrics_after" in out
