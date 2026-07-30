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
from .decide import decide
from .history_guidance import guidance_for_lot
from .maxbid import compute_maxbid
from .memory import LessonMemory
from .schemas import (
    DealInputs,
    Lot,
    SaleType,
    ToolCallRecord,
    Trajectory,
    utc_now,
)
from .search import optimize_bid
from .simulator import predict_outcome, simulate_outcome


def _apply_buffer(max_bid: float | None, buffer_usd: float) -> float | None:
    if max_bid is None:
        return None
    return max(0.0, max_bid - buffer_usd)


def _sale_year(lot: Lot) -> int | None:
    """Sale year from lot metadata, for the clearing-price model's time trend."""
    raw = str(lot.metadata.get("sale_date") or lot.metadata.get("saleDate") or "")
    return int(raw[:4]) if raw[:4].isdigit() else None


class DeedCopilotAgent:
    """Research co-pilot: atlas + maxbid are oracles; agent chooses bid/pass."""

    def __init__(
        self,
        memory: LessonMemory | None = None,
        *,
        use_history: bool = True,
        use_llm_decide: bool | None = None,
    ) -> None:
        self.memory = memory or LessonMemory()
        self.use_history = use_history
        # None = DEEDPILOT_DECIDE_MODE auto (LLM if keys, else policy)
        self.use_llm_decide = use_llm_decide

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
            f"warnings={len(deal.warnings)}. Lesson buffer=${buffer:,.0f}."
        )

        # 2b) Historical market guidance (never overrides oracle numbers)
        hist = None
        hist_buffer = 0.0
        bid_frac = 0.9
        if self.use_history:
            try:
                hist = guidance_for_lot(
                    lot, sale_type, oracle_max_bid=deal.max_bid
                )
                hist_buffer = float(hist.suggested_buffer_usd or 0.0)
                bid_frac = float(hist.bid_fraction_of_ceiling or 0.9)
                traj.tags.append("history_guided")
                traj.tool_calls.append(
                    ToolCallRecord(
                        tool="history_guidance",
                        args={"key": hist.key, "n": hist.n},
                        result_summary=(
                            f"n={hist.n} p_redeem={hist.p_redeem} "
                            f"med_win={hist.median_winning_bid} "
                            f"buffer=+${hist_buffer:,.0f} frac={bid_frac}"
                        ),
                        trusted=True,
                    )
                )
                traj.reasoning_trace.append(
                    "History: " + " ".join(hist.notes[:3])
                    if hist.notes
                    else f"History: n={hist.n} for {hist.key}."
                )
                if hist.comps:
                    top = hist.comps[0]
                    traj.reasoning_trace.append(
                        f"Comp: {top.get('county') or top.get('state')} "
                        f"sold ${top.get('winningBid')} "
                        f"(assessed {top.get('assessedValue')}) "
                        f"id={top.get('id')}"
                    )
            except Exception as e:  # noqa: BLE001 — never block agent on history
                traj.reasoning_trace.append(f"History guidance unavailable: {e}")

        total_buffer = buffer + hist_buffer

        # 3) Decide — LLM optional; always oracle-clamped (see decide.py)
        ceiling = _apply_buffer(deal.max_bid, total_buffer)
        opening = lot.opening_bid or 0.0

        # 2c) Risk-adjusted bid search over the clearing-price model. Supplies
        # the bid the deterministic policy will use; the ceiling still binds.
        plan = None
        search_bid = None
        search_note = None
        try:
            plan = optimize_bid(
                lot, deal, sale_type, ceiling=ceiling, year=_sale_year(lot)
            )
            search_bid = plan.bid
            if plan.quantiles and plan.quantiles.n_train:
                search_note = (
                    f"search p_win={plan.p_win:.0%} vs {plan.quantiles.group} "
                    f"(n={plan.quantiles.n_train})"
                )
            else:
                search_note = "search (no clearing-price model for this geography)"
            traj.tags.append("bid_search")
            traj.tool_calls.append(
                ToolCallRecord(
                    tool="optimize_bid",
                    args={"ceiling": ceiling, "risk_aversion": plan.risk_aversion},
                    result_summary=(
                        f"bid={plan.bid} pass={plan.pass_} pWin={plan.p_win} "
                        f"ev={plan.expected_value} group="
                        f"{plan.quantiles.group if plan.quantiles else None}"
                    ),
                    trusted=True,
                )
            )
            traj.reasoning_trace.extend(plan.rationale)
        except Exception as e:  # noqa: BLE001 — search is an optimisation, not a gate
            traj.reasoning_trace.append(f"Bid search unavailable: {e}")
        action, decide_meta = decide(
            lot=lot,
            deal=deal,
            atlas=atlas,
            ceiling=ceiling,
            opening=opening,
            bid_frac=bid_frac,
            total_buffer=total_buffer,
            lesson_buffer=buffer,
            hist_buffer=hist_buffer,
            hist_notes=list(hist.notes) if hist else None,
            hist_n=hist.n if hist else None,
            hist_med=hist.median_winning_bid if hist else None,
            comps_summary=list(hist.comps[:4]) if hist else None,
            use_llm=self.use_llm_decide,
            search_bid=search_bid,
            search_note=search_note,
        )
        traj.tags.append(f"decide:{decide_meta.get('source', 'policy')}")
        traj.tool_calls.append(
            ToolCallRecord(
                tool="decide",
                args={"use_llm": self.use_llm_decide},
                result_summary=(
                    f"source={decide_meta.get('source')} "
                    f"pass={action.pass_} bid={action.bid_amount} "
                    f"clamped={decide_meta.get('clamped')}"
                ),
                trusted=True,
            )
        )
        traj.reasoning_trace.append(
            f"Decide via {decide_meta.get('source')}: "
            f"{'pass' if action.pass_ else f'bid ${action.bid_amount}'}."
        )

        traj.action = action
        traj.predicted_outcome = predict_outcome(
            lot, action.bid_amount, sale_type, lessons, use_history=self.use_history
        )
        traj.simulated_or_real_outcome = simulate_outcome(
            lot,
            action.bid_amount,
            sale_type,
            seed=seed or traj.id,
            lessons=lessons,
            use_history=self.use_history,
        )
        traj.profit_loss = traj.simulated_or_real_outcome.profit_loss
        traj.critique = deterministic_critique(traj)
        traj.reasoning_trace.append(
            f"Simulated P/L={traj.profit_loss}; critique={traj.critique}"
        )
        return traj
