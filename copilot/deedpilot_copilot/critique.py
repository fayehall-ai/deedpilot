"""Deterministic critique + structured reflection stubs."""

from __future__ import annotations

from typing import Any

from .schemas import Trajectory


def deterministic_critique(traj: Trajectory) -> dict[str, Any]:
    """Re-score action against trusted maxbid oracle."""
    issues: list[str] = []
    score = 1.0

    if not traj.maxbid_result:
        return {"score": 0.0, "issues": ["missing maxbid oracle result"], "passed": False}

    mb = traj.maxbid_result
    action = traj.action
    if not action:
        return {"score": 0.0, "issues": ["no action"], "passed": False}

    if action.bid_amount is None or action.pass_:
        # Pass is correct when recommendation is no-bid / insufficient
        if mb.recommendation in ("no-bid", "insufficient-data"):
            issues.append("correct_pass")
        else:
            issues.append("passed_on_bid_opportunity")
            score -= 0.25
    else:
        if mb.max_bid is not None and action.bid_amount > mb.max_bid:
            issues.append("bid_above_oracle_ceiling")
            score -= 0.5
        if mb.recommendation == "no-bid":
            issues.append("bid_against_no_bid_oracle")
            score -= 0.4
        if mb.recommendation == "insufficient-data":
            issues.append("bid_with_insufficient_data")
            score -= 0.6

    if traj.atlas_result and traj.atlas_result.is_state_default:
        if "unknown" not in action.rationale.lower() and "state default" not in action.rationale.lower():
            issues.append("did_not_flag_state_default_uncertainty")
            score -= 0.15

    if traj.atlas_result and not traj.sources_used:
        issues.append("missing_source_citations")
        score -= 0.2

    pl = traj.profit_loss
    if pl is not None and pl < 0 and action.bid_amount:
        issues.append("realized_loss")
        score -= 0.1

    score = max(0.0, min(1.0, score))
    return {
        "score": round(score, 3),
        "issues": issues,
        "passed": score >= 0.6,
        "oracle_recommendation": mb.recommendation,
        "oracle_max_bid": mb.max_bid,
    }


def reflect_on_batch(trajectories: list[Trajectory]) -> list[dict[str, Any]]:
    """
    Lightweight rule-based reflection (stand-in for Claude 4 / Grok-class critic).

    Produces structured lessons the flywheel can store. Replace this function
    with an LLM call that returns the same schema when an API key is available.
    """
    lessons: list[dict[str, Any]] = []

    # Group losses by state
    by_state: dict[str, list[Trajectory]] = {}
    for t in trajectories:
        by_state.setdefault(t.lot.state, []).append(t)

    for state, ts in by_state.items():
        losses = [t for t in ts if (t.profit_loss or 0) < 0 and t.action and t.action.bid_amount]
        if len(losses) >= 2:
            lessons.append(
                {
                    "scope": "state",
                    "scope_key": state,
                    "lesson": (
                        f"In {state}, recent batch had {len(losses)} losing bids. "
                        f"Increase rehab/lien buffers and respect oracle max_bid strictly."
                    ),
                    "suggested_buffer_usd": 2000.0,
                    "suggested_p_redeem_delta": 0.05,
                    "confidence": 0.55,
                    "evidence_trajectory_ids": [t.id for t in losses[:5]],
                }
            )

    overbids = [
        t
        for t in trajectories
        if t.action
        and t.action.bid_amount
        and t.maxbid_result
        and t.maxbid_result.max_bid is not None
        and t.action.bid_amount > t.maxbid_result.max_bid
    ]
    if overbids:
        lessons.append(
            {
                "scope": "global",
                "scope_key": None,
                "lesson": (
                    f"{len(overbids)} bids exceeded the trusted maxbid oracle. "
                    "Never override compute_maxbid with model arithmetic."
                ),
                "suggested_buffer_usd": 0.0,
                "suggested_p_redeem_delta": 0.0,
                "confidence": 0.9,
                "evidence_trajectory_ids": [t.id for t in overbids[:5]],
            }
        )

    state_default_misses = [
        t
        for t in trajectories
        if t.atlas_result
        and t.atlas_result.is_state_default
        and t.action
        and "state default" not in t.action.rationale.lower()
    ]
    if state_default_misses:
        lessons.append(
            {
                "scope": "global",
                "scope_key": None,
                "lesson": (
                    "When atlas falls back to state defaults, rationale must explicitly say "
                    "'state default / not county-verified' and lower confidence."
                ),
                "confidence": 0.75,
                "evidence_trajectory_ids": [t.id for t in state_default_misses[:5]],
            }
        )

    return lessons
