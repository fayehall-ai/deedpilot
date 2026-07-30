"""Oracle-bound decide node tests."""

from deedpilot_copilot.agent import DeedCopilotAgent
from deedpilot_copilot.decide import clamp_action_to_oracle, policy_decide
from deedpilot_copilot.schemas import (
    AgentAction,
    AtlasResult,
    DealResult,
    Lot,
    SaleType,
)
from deedpilot_copilot.decide import DecideProposal


def _deal(rec: str = "bid", max_bid: float | None = 100_000) -> DealResult:
    return DealResult(
        max_bid=max_bid,
        recommendation=rec,  # type: ignore[arg-type]
        confidence="medium",
        arv_value=200_000,
        arv_basis="test",
        costs=[],
        total_costs=50_000,
        projected_profit=60_000,
        bid_room=20_000,
        warnings=[],
    )


def test_policy_pass_on_no_bid_oracle():
    lot = Lot(lot_id="t", fips="48201", state="TX", opening_bid=10_000)
    action = policy_decide(
        lot=lot,
        deal=_deal("no-bid", max_bid=0),
        atlas=None,
        ceiling=0,
        opening=10_000,
        bid_frac=0.9,
        total_buffer=0,
    )
    assert action.pass_ is True
    assert action.bid_amount is None


def test_clamp_over_ceiling():
    prop = DecideProposal(
        pass_=False,
        bid_amount=999_999,
        rationale="Trying to overbid the market for a home-run deal.",
        confidence=0.9,
    )
    action = clamp_action_to_oracle(
        prop,
        deal=_deal("bid", 50_000),
        ceiling=40_000,
        total_buffer=0,
        bid_frac=0.9,
        lesson_buffer=0,
        hist_buffer=0,
    )
    assert action.pass_ is False
    assert action.bid_amount is not None
    assert action.bid_amount <= 40_000 + 1e-6
    assert action.risk_buffers.get("oracle_clamped") == 1.0


def test_agent_policy_decide_never_over_oracle():
    lot = Lot(
        lot_id="t2",
        fips="26163",
        state="MI",
        opening_bid=5_000,
        assessed_value=80_000,
        rehab_cost=15_000,
        sale_type=SaleType.TAX_DEED,
    )
    traj = DeedCopilotAgent(use_history=True, use_llm_decide=False).run_lot(
        lot, seed="decide-test"
    )
    assert traj.action is not None
    assert any(t.startswith("decide:") for t in traj.tags)
    if traj.action.bid_amount and traj.maxbid_result and traj.maxbid_result.max_bid:
        assert traj.action.bid_amount <= traj.maxbid_result.max_bid + 1e-6
