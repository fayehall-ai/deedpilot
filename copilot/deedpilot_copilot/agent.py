"""
DeedPilot investment copilot agent loop.

LangGraph-compatible shape without hard dependency:
  nodes: lookup_atlas → compute_maxbid → decide → simulate → critique

Planning may use an LLM; numbers always come from trusted tools.
"""

from __future__ import annotations

import uuid
from typing import Any

from .atlas import lookup_atlas
from .critique import deterministic_critique
from .maxbid import compute_maxbid
from .memory import LessonMemory
from .schemas import (
    AgentAction,
    DealInputs,
    Lot,
    SaleType,
    ToolCallRecord,
    Trajectory,
    utc_now,
)
from .simulator import predict_outcome, simulate_outcome


def _apply_buffer(max_bid: float | None, buffer_usd: float) -> float | None:
    if max_bid is None:
        return None
    return max(0.0, max_bid - buffer_usd)


class DeedCopilotAgent:
    """Research co-pilot: atlas + maxbid are oracles; agent chooses bid/pass."""

    def __init__(self, memory: LessonMemory | None = None) -> None:
        self.memory = memory or LessonMemory()

    def run_lot(self, lot: Lot, *, seed: str | None = None) -> Trajectory:
        traj = Trajectory(id=str(uuid.uuid4()), created_at=utc_now(), lot=lot)
        lessons = self.memory.as_dicts()

        # 1) Atlas
        atlas = lookup_atlas(lot.fips)
        traj.atlas_result = atlas
        traj.tool_calls.append(
            ToolCallRecord(
                tool="lookup_atlas",
                args={"fips": lot.fips},
                result_summary=(
                    f"{atlas.county}, {atlas.state} saleType={atlas.sale_type} "
                    f"stateDefault={atlas.is_state_default} asOf={atlas.as_of}"
                ),
                trusted=True,
            )
        )
        traj.sources_used.extend(atlas.sources or [])
        if atlas.as_of:
            traj.sources_used.append(f"atlas:asOf:{atlas.as_of}")
        traj.reasoning_trace.append(
            f"Atlas: {atlas.type_label} / {atlas.sale_type}. "
            f"Inherited={atlas.inherited}. state_default={atlas.is_state_default}."
        )
        if atlas.is_state_default:
            traj.reasoning_trace.append(
                "UNKNOWN at county grain: using state defaults — flag explicitly."
            )

        try:
            sale_type = SaleType(atlas.sale_type)
        except ValueError:
            sale_type = lot.sale_type or SaleType.TAX_DEED

        # Lesson buffers
        buffer = 0.0
        for lesson in lessons:
            if lesson.get("scope") == "state" and lesson.get("scope_key") == lot.state:
                buffer += float(lesson.get("suggested_buffer_usd") or 0)
            if lesson.get("scope") == "global":
                buffer += float(lesson.get("suggested_buffer_usd") or 0) * 0.25

        # 2) Maxbid oracle
        deal_in = DealInputs(
            state=lot.state,
            sale_type=sale_type,
            opening_bid=lot.opening_bid,
            assessed_value=lot.assessed_value,
            arv_override=lot.arv_override,
            rehab_cost=lot.rehab_cost,
            surviving_liens=lot.surviving_liens,
        )
        deal = compute_maxbid(deal_in)
        traj.maxbid_result = deal
        traj.tool_calls.append(
            ToolCallRecord(
                tool="compute_maxbid",
                args=deal_in.model_dump(),
                result_summary=(
                    f"maxBid={deal.max_bid} rec={deal.recommendation} "
                    f"conf={deal.confidence}"
                ),
                trusted=True,
            )
        )
        traj.reasoning_trace.append(
            f"Oracle maxBid={deal.max_bid} recommendation={deal.recommendation} "
            f"warnings={len(deal.warnings)}. Buffer=${buffer:,.0f} from lessons."
        )

        # 3) Decide (deterministic policy scaffold — LLM can replace this node)
        ceiling = _apply_buffer(deal.max_bid, buffer)
        opening = lot.opening_bid or 0.0

        if deal.recommendation != "bid" or ceiling is None or ceiling <= 0:
            action = AgentAction(
                bid_amount=None,
                pass_=True,
                rationale=(
                    f"Pass: oracle={deal.recommendation}. "
                    + (
                        "State default / not county-verified. "
                        if atlas.is_state_default
                        else ""
                    )
                    + "; ".join(deal.warnings[:2])
                ),
                risk_buffers={"lesson_buffer_usd": buffer},
            )
        else:
            # Bid midpoint of opening and ceiling when there is room
            if opening > 0 and opening < ceiling:
                bid = min(ceiling, opening + 0.4 * (ceiling - opening))
            else:
                bid = ceiling * 0.9
            action = AgentAction(
                bid_amount=round(bid, 2),
                pass_=False,
                rationale=(
                    f"Bid ${bid:,.0f} under oracle ceiling ${ceiling:,.0f} "
                    f"(raw maxBid ${deal.max_bid:,.0f} − buffer ${buffer:,.0f}). "
                    f"Cite atlas asOf={atlas.as_of}; sources={len(atlas.sources)}. "
                    + (
                        "State default / not county-verified. "
                        if atlas.is_state_default
                        else "County research present. "
                    )
                    + f"Growth priors: {[g.get('name') for g in atlas.growth_neighborhoods[:2]]}."
                ),
                risk_buffers={"lesson_buffer_usd": buffer, "oracle_max_bid": deal.max_bid or 0},
            )

        traj.action = action
        traj.predicted_outcome = predict_outcome(
            lot, action.bid_amount, sale_type, lessons
        )
        traj.simulated_or_real_outcome = simulate_outcome(
            lot, action.bid_amount, sale_type, seed=seed or traj.id, lessons=lessons
        )
        traj.profit_loss = traj.simulated_or_real_outcome.profit_loss
        traj.critique = deterministic_critique(traj)
        traj.reasoning_trace.append(
            f"Simulated P/L={traj.profit_loss}; critique={traj.critique}"
        )
        return traj
