"""
Oracle-bound decide node.

The LLM may choose bid vs pass and a bid *at or below* the ceiling.
It never invents a walk-away price — compute_maxbid remains the oracle.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from .schemas import AgentAction, AtlasResult, DealResult, Lot

logger = logging.getLogger(__name__)


class DecideProposal(BaseModel):
    """Structured decide output from a strong model."""

    pass_: bool = Field(
        False,
        alias="pass",
        description="True to pass (no bid).",
    )
    bid_amount: float | None = Field(
        None,
        description="Proposed bid in USD. Must be null when pass=true. Must be <= ceiling.",
    )
    rationale: str = Field(
        ...,
        min_length=12,
        description="Investor-facing rationale; cite state default / oracle if relevant.",
    )
    confidence: float = Field(
        0.5,
        ge=0.0,
        le=1.0,
        description="0–1 confidence in the action.",
    )

    model_config = {"populate_by_name": True}

    @field_validator("rationale")
    @classmethod
    def _strip_rationale(cls, v: str) -> str:
        return (v or "").strip()


_SYSTEM = """You are the decide node for DeedPilot, a tax-deed investment co-pilot.

Hard rules (non-negotiable):
1. You do NOT invent a walk-away price. The oracle max_bid / ceiling is given.
2. If you bid, bid_amount MUST be <= ceiling (after buffers). Prefer strictly under.
3. If oracle_recommendation is not "bid", or ceiling is null/<=0, you MUST pass.
4. When is_state_default is true, say "state default / not county-verified" in rationale.
5. Prefer pass when data is thin (insufficient-data) or opening already above ceiling.
6. Use history guidance (median sold, p_redeem, comps) only as market context — not as max_bid.
7. search_recommended_bid comes from a risk-adjusted optimiser scored on held-out
   sales, where it cut mean overpay ~57% against a fixed fraction of the ceiling.
   Treat it as the default. Depart from it only for a reason you can state, and
   bid above it only when the comps clearly show the room pays more.

Output only via the schema. Be concise and concrete in rationale.
"""


def _want_llm(use_llm: bool | None) -> bool:
    if use_llm is not None:
        return use_llm
    mode = (os.environ.get("DEEDPILOT_DECIDE_MODE") or "auto").strip().lower()
    if mode in ("rules", "rule", "policy", "off", "0", "false"):
        return False
    if mode in ("llm", "on", "1", "true"):
        return True
    return True  # auto


def policy_decide(
    *,
    lot: Lot,
    deal: DealResult,
    atlas: AtlasResult | None,
    ceiling: float | None,
    opening: float,
    bid_frac: float,
    total_buffer: float,
    hist_n: int | None = None,
    hist_med: float | None = None,
    lesson_buffer: float = 0.0,
    hist_buffer: float = 0.0,
    search_bid: float | None = None,
    search_note: str | None = None,
) -> AgentAction:
    """
    Deterministic decide (fallback and tests).

    When ``search_bid`` is supplied, the bid comes from the risk-adjusted
    optimiser in ``search.py`` — already bounded by the ceiling — instead of the
    fixed ``bid_frac`` heuristic. On held-out sales the optimiser cut mean
    overpay by ~57% against the fraction rule, so the heuristic survives only as
    the no-price-model fallback.
    """
    if deal.recommendation != "bid" or ceiling is None or ceiling <= 0:
        return AgentAction(
            bid_amount=None,
            pass_=True,
            rationale=(
                f"Pass: oracle={deal.recommendation}. "
                + (
                    "State default / not county-verified. "
                    if atlas and atlas.is_state_default
                    else ""
                )
                + "; ".join(deal.warnings[:2])
                + (f" History n={hist_n}." if hist_n is not None else "")
            ),
            risk_buffers={
                "lesson_buffer_usd": lesson_buffer,
                "history_buffer_usd": hist_buffer,
                "total_buffer_usd": total_buffer,
            },
        )

    if search_bid is not None and search_bid > 0:
        bid = min(search_bid, ceiling)
        sizing = search_note or "risk-adjusted bid search"
    else:
        target_ceiling = ceiling * bid_frac
        if opening > 0 and opening < target_ceiling:
            bid = min(target_ceiling, opening + 0.4 * (target_ceiling - opening))
        else:
            bid = target_ceiling
        sizing = f"history frac={bid_frac:.2f}"
    if deal.max_bid is not None:
        bid = min(bid, deal.max_bid - total_buffer)
    bid = max(0.0, bid)

    return AgentAction(
        bid_amount=round(bid, 2),
        pass_=False,
        rationale=(
            f"Bid ${bid:,.0f} under oracle ceiling ${ceiling:,.0f} "
            f"(raw maxBid ${deal.max_bid:,.0f} − buffers ${total_buffer:,.0f}; "
            f"{sizing}). "
            f"Cite atlas asOf={atlas.as_of if atlas else None}; "
            f"sources={len(atlas.sources) if atlas else 0}. "
            + (
                "State default / not county-verified. "
                if atlas and atlas.is_state_default
                else "County research present. "
            )
            + (
                f"History n={hist_n} med sold={hist_med}. "
                if hist_n is not None
                else ""
            )
            + (
                f"Growth priors: "
                f"{[g.get('name') for g in (atlas.growth_neighborhoods[:2] if atlas else [])]}."
            )
        ),
        risk_buffers={
            "lesson_buffer_usd": lesson_buffer,
            "history_buffer_usd": hist_buffer,
            "total_buffer_usd": total_buffer,
            "oracle_max_bid": deal.max_bid or 0,
            "history_bid_fraction": bid_frac,
            "history_n": float(hist_n or 0),
        },
    )


def clamp_action_to_oracle(
    proposal: DecideProposal | AgentAction,
    *,
    deal: DealResult,
    ceiling: float | None,
    total_buffer: float,
    bid_frac: float,
    lesson_buffer: float,
    hist_buffer: float,
    hist_n: float = 0.0,
) -> AgentAction:
    """Enforce oracle ceiling after any LLM or policy proposal."""
    if isinstance(proposal, DecideProposal):
        want_pass = proposal.pass_ or proposal.bid_amount is None
        bid = proposal.bid_amount
        rationale = proposal.rationale
    else:
        want_pass = proposal.pass_ or proposal.bid_amount is None
        bid = proposal.bid_amount
        rationale = proposal.rationale

    # Oracle hard pass
    if deal.recommendation != "bid" or ceiling is None or ceiling <= 0:
        return AgentAction(
            bid_amount=None,
            pass_=True,
            rationale=rationale
            if want_pass
            else f"Pass forced: oracle={deal.recommendation}. " + rationale,
            risk_buffers={
                "lesson_buffer_usd": lesson_buffer,
                "history_buffer_usd": hist_buffer,
                "total_buffer_usd": total_buffer,
                "oracle_clamped": 1.0,
            },
        )

    hard_cap = ceiling
    if deal.max_bid is not None:
        hard_cap = min(ceiling, max(0.0, deal.max_bid - total_buffer))
    soft_cap = hard_cap * bid_frac

    if want_pass:
        return AgentAction(
            bid_amount=None,
            pass_=True,
            rationale=rationale,
            risk_buffers={
                "lesson_buffer_usd": lesson_buffer,
                "history_buffer_usd": hist_buffer,
                "total_buffer_usd": total_buffer,
                "history_bid_fraction": bid_frac,
                "history_n": hist_n,
            },
        )

    bid_f = float(bid or 0.0)
    clamped = False
    if bid_f > hard_cap + 1e-6:
        bid_f = hard_cap
        clamped = True
    # Prefer soft_cap but allow up to hard_cap
    if bid_f > soft_cap + 1e-6:
        # keep but note aggressive
        pass
    bid_f = max(0.0, bid_f)
    if bid_f <= 0:
        return AgentAction(
            bid_amount=None,
            pass_=True,
            rationale="Pass: non-positive bid after oracle clamp. " + rationale,
            risk_buffers={
                "lesson_buffer_usd": lesson_buffer,
                "history_buffer_usd": hist_buffer,
                "total_buffer_usd": total_buffer,
            },
        )

    rationale_out = rationale
    if clamped:
        rationale_out = (
            f"Bid clamped to oracle ceiling ${hard_cap:,.0f}. " + rationale
        )

    return AgentAction(
        bid_amount=round(bid_f, 2),
        pass_=False,
        rationale=rationale_out,
        risk_buffers={
            "lesson_buffer_usd": lesson_buffer,
            "history_buffer_usd": hist_buffer,
            "total_buffer_usd": total_buffer,
            "oracle_max_bid": deal.max_bid or 0,
            "history_bid_fraction": bid_frac,
            "history_n": hist_n,
            "oracle_clamped": 1.0 if clamped else 0.0,
        },
    )


def llm_decide(
    *,
    lot: Lot,
    deal: DealResult,
    atlas: AtlasResult | None,
    ceiling: float | None,
    opening: float,
    bid_frac: float,
    total_buffer: float,
    hist_notes: list[str] | None = None,
    hist_n: int | None = None,
    hist_med: float | None = None,
    comps_summary: list[dict[str, Any]] | None = None,
    search_bid: float | None = None,
    search_note: str | None = None,
) -> DecideProposal:
    """Call Grok→Claude for a structured decide proposal (not yet clamped)."""
    from .llm import run_structured

    payload = {
        "lot": {
            "lot_id": lot.lot_id,
            "fips": lot.fips,
            "state": lot.state,
            "county": lot.county_name,
            "opening_bid": lot.opening_bid,
            "assessed_value": lot.assessed_value,
            "arv_override": lot.arv_override,
            "rehab_cost": lot.rehab_cost,
        },
        "oracle": {
            "max_bid": deal.max_bid,
            "recommendation": deal.recommendation,
            "confidence": deal.confidence,
            "warnings": (deal.warnings or [])[:6],
            "projected_profit": deal.projected_profit,
        },
        "ceiling_after_buffers": ceiling,
        "opening_bid": opening,
        "history_bid_fraction": bid_frac,
        "total_buffer_usd": total_buffer,
        "atlas": (
            {
                "is_state_default": atlas.is_state_default,
                "as_of": atlas.as_of,
                "sale_type": atlas.sale_type,
                "sources_n": len(atlas.sources or []),
            }
            if atlas
            else None
        ),
        "history_notes": (hist_notes or [])[:5],
        "history_n": hist_n,
        "history_median_winning_bid": hist_med,
        "comps": (comps_summary or [])[:4],
        # The optimiser's answer, given as the reference point. It beat the fixed
        # fraction rule on held-out sales, so departing from it needs a reason.
        "search_recommended_bid": search_bid,
        "search_note": search_note,
    }

    import json

    prompt = (
        "Decide bid or pass for this lot. Respect ceiling_after_buffers.\n\n"
        f"CONTEXT_JSON:\n{json.dumps(payload, indent=2, default=str)}\n"
    )
    result = run_structured(
        system=_SYSTEM,
        prompt=prompt,
        schema=DecideProposal,
        schema_name="DecideProposal",
        max_tokens=1200,
    )
    return DecideProposal.model_validate(result.data)


def decide(
    *,
    lot: Lot,
    deal: DealResult,
    atlas: AtlasResult | None,
    ceiling: float | None,
    opening: float,
    bid_frac: float,
    total_buffer: float,
    lesson_buffer: float = 0.0,
    hist_buffer: float = 0.0,
    hist_notes: list[str] | None = None,
    hist_n: int | None = None,
    hist_med: float | None = None,
    comps_summary: list[dict[str, Any]] | None = None,
    use_llm: bool | None = None,
    search_bid: float | None = None,
    search_note: str | None = None,
) -> tuple[AgentAction, dict[str, Any]]:
    """
    Decide bid/pass. Prefer LLM when keys available; always clamp to oracle.

    Returns (action, meta) where meta records source (llm|policy) and clamp flags.
    """
    meta: dict[str, Any] = {"source": "policy", "clamped": False}

    # Fast path: oracle already says no
    if deal.recommendation != "bid" or ceiling is None or ceiling <= 0:
        action = policy_decide(
            lot=lot,
            deal=deal,
            atlas=atlas,
            ceiling=ceiling,
            opening=opening,
            bid_frac=bid_frac,
            total_buffer=total_buffer,
            hist_n=hist_n,
            hist_med=hist_med,
            lesson_buffer=lesson_buffer,
            hist_buffer=hist_buffer,
            search_bid=search_bid,
            search_note=search_note,
        )
        meta["source"] = "policy_oracle_pass"
        return action, meta

    policy_action = policy_decide(
        lot=lot,
        deal=deal,
        atlas=atlas,
        ceiling=ceiling,
        opening=opening,
        bid_frac=bid_frac,
        total_buffer=total_buffer,
        hist_n=hist_n,
        hist_med=hist_med,
        lesson_buffer=lesson_buffer,
        hist_buffer=hist_buffer,
        search_bid=search_bid,
        search_note=search_note,
    )

    if not _want_llm(use_llm):
        meta["source"] = "policy"
        return policy_action, meta

    try:
        from .llm import configured_providers, load_env

        load_env()
        if not configured_providers():
            meta["source"] = "policy_no_keys"
            return policy_action, meta

        proposal = llm_decide(
            lot=lot,
            deal=deal,
            atlas=atlas,
            ceiling=ceiling,
            opening=opening,
            bid_frac=bid_frac,
            total_buffer=total_buffer,
            hist_notes=hist_notes,
            hist_n=hist_n,
            hist_med=hist_med,
            comps_summary=comps_summary,
            search_bid=search_bid,
            search_note=search_note,
        )
        action = clamp_action_to_oracle(
            proposal,
            deal=deal,
            ceiling=ceiling,
            total_buffer=total_buffer,
            bid_frac=bid_frac,
            lesson_buffer=lesson_buffer,
            hist_buffer=hist_buffer,
            hist_n=float(hist_n or 0),
        )
        meta["source"] = "llm"
        meta["clamped"] = bool(action.risk_buffers.get("oracle_clamped"))
        meta["llm_pass"] = proposal.pass_
        meta["llm_bid"] = proposal.bid_amount
        return action, meta
    except Exception as e:  # noqa: BLE001
        logger.warning("llm decide failed (%s) — policy fallback", e)
        meta["source"] = "policy_llm_fallback"
        meta["error"] = str(e)[:200]
        return policy_action, meta
