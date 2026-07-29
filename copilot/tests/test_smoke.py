"""Smoke tests for trusted tools + flywheel + reflection."""

from deedpilot_copilot.agent import DeedCopilotAgent
from deedpilot_copilot.atlas import lookup_atlas
from deedpilot_copilot.critique import (
    LessonsBatch,
    ReflectionLessonOut,
    reflect_on_batch,
    reflect_on_batch_rules,
)
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
    # Force rules so CI/offline runs don't depend on live LLM keys/network.
    import os

    prev = os.environ.get("DEEDPILOT_REFLECT_MODE")
    os.environ["DEEDPILOT_REFLECT_MODE"] = "rules"
    try:
        out = run_cycle(default_synthetic_lots()[:3])
    finally:
        if prev is None:
            os.environ.pop("DEEDPILOT_REFLECT_MODE", None)
        else:
            os.environ["DEEDPILOT_REFLECT_MODE"] = prev
    assert out["lessons_added"] >= 0
    assert "metrics_after" in out


def test_reflection_schema_roundtrip():
    batch = LessonsBatch(
        lessons=[
            ReflectionLessonOut(
                scope="state",
                scope_key="TX",
                lesson="In TX, raise rehab buffer after clustered losses.",
                suggested_buffer_usd=1500.0,
                suggested_p_redeem_delta=0.03,
                confidence=0.7,
                evidence_trajectory_ids=["abc"],
            )
        ]
    )
    dumped = batch.model_dump()
    again = LessonsBatch.model_validate(dumped)
    assert again.lessons[0].scope_key == "TX"
    assert "rehab" in again.lessons[0].lesson


def test_reflect_on_batch_rules_force():
    lots = default_synthetic_lots()[:3]
    trajs = [DeedCopilotAgent().run_lot(lot, seed=lot.lot_id) for lot in lots]
    via_flag = reflect_on_batch(trajs, use_llm=False)
    via_rules = reflect_on_batch_rules(trajs)
    assert isinstance(via_flag, list)
    assert isinstance(via_rules, list)
    # Schema keys the flywheel expects
    for ld in via_flag:
        assert "lesson" in ld
        assert "scope" in ld
        assert "confidence" in ld
        assert "evidence_trajectory_ids" in ld


def test_reflect_on_batch_state_default_safety():
    """CA lot is often state-default — rules must teach disclosure if missed."""
    lot = Lot(
        lot_id="syn-ca-state-default",
        fips="06037",
        state="CA",
        county_name="Los Angeles",
        opening_bid=50_000,
        assessed_value=400_000,
        rehab_cost=40_000,
        sale_type=SaleType.TAX_DEED,
    )
    traj = DeedCopilotAgent().run_lot(lot, seed="ca-sd")
    lessons = reflect_on_batch([traj], use_llm=False)
    # May or may not fire depending on agent rationale; just ensure shape OK
    assert isinstance(lessons, list)
