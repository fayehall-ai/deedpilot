"""Deterministic critique + strong-model structured reflection."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from .schemas import Trajectory

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lesson schema (same shape flywheel / LessonMemory already consume)
# ---------------------------------------------------------------------------


class ReflectionLessonOut(BaseModel):
    """One structured lesson — matches memory.add_from_text / flywheel keys."""

    scope: Literal["global", "state", "county", "sale_type"] = "global"
    scope_key: str | None = None
    lesson: str
    suggested_buffer_usd: float | None = None
    suggested_p_redeem_delta: float | None = None
    confidence: float = 0.5
    evidence_trajectory_ids: list[str] = Field(default_factory=list)

    @field_validator("confidence")
    @classmethod
    def _clip_confidence(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))

    @field_validator("lesson")
    @classmethod
    def _nonempty_lesson(cls, v: str) -> str:
        v = (v or "").strip()
        if len(v) < 8:
            raise ValueError("lesson text too short")
        return v


class LessonsBatch(BaseModel):
    lessons: list[ReflectionLessonOut] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Deterministic per-trajectory critique (oracle re-score)
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Rule-based reflection (fallback + hard safety net)
# ---------------------------------------------------------------------------


def reflect_on_batch_rules(trajectories: list[Trajectory]) -> list[dict[str, Any]]:
    """
    Deterministic reflection used when no LLM key is available, the model
    fails, or as a hard safety net merged under LLM lessons.
    """
    lessons: list[dict[str, Any]] = []

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
                    "source": "rules",
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
                "source": "rules",
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
                "source": "rules",
            }
        )

    return lessons


def _safety_lessons(trajectories: list[Trajectory]) -> list[dict[str, Any]]:
    """Hard safety lessons always retained even when the LLM path succeeds."""
    all_rules = reflect_on_batch_rules(trajectories)
    safety_markers = (
        "exceeded the trusted maxbid oracle",
        "state default / not county-verified",
    )
    return [
        ld
        for ld in all_rules
        if any(m in ld.get("lesson", "") for m in safety_markers)
    ]


# ---------------------------------------------------------------------------
# Strong-model structured reflection
# ---------------------------------------------------------------------------

_SYSTEM = """You are the reflection critic for DeedPilot, a tax-deed investment co-pilot.

Your job: review a batch of agent trajectories and emit structured lessons the
flywheel will store and apply on the next run.

Non-negotiable product rules you must reinforce when violated:
1. compute_maxbid is an oracle — agents must never invent walk-away prices or bid above max_bid.
2. lookup_atlas claims require citing asOf, sources, and is_state_default.
3. When is_state_default is true, rationale must say "state default / not county-verified".
4. Prefer pass when recommendation is insufficient-data or no-bid.
5. Lessons should be actionable: buffer USD deltas, p_redeem deltas, scope (global/state/county/sale_type).

Output ONLY via the provided schema. Prefer 1–6 high-signal lessons; skip fluff.
confidence is 0–1. evidence_trajectory_ids must be ids from the batch when possible.
suggested_buffer_usd / suggested_p_redeem_delta may be null when not applicable.
"""


def _trajectory_summary(t: Trajectory) -> dict[str, Any]:
    action = t.action
    mb = t.maxbid_result
    atlas = t.atlas_result
    return {
        "id": t.id,
        "lot_id": t.lot.lot_id,
        "fips": t.lot.fips,
        "state": t.lot.state,
        "county": t.lot.county_name,
        "opening_bid": t.lot.opening_bid,
        "assessed_value": t.lot.assessed_value,
        "rehab_cost": t.lot.rehab_cost,
        "sale_type": (t.lot.sale_type.value if t.lot.sale_type else None),
        "action": (
            {
                "bid_amount": action.bid_amount,
                "pass": action.pass_,
                "rationale": (action.rationale or "")[:400],
                "risk_buffers": action.risk_buffers,
            }
            if action
            else None
        ),
        "oracle": (
            {
                "max_bid": mb.max_bid,
                "recommendation": mb.recommendation,
                "confidence": mb.confidence,
                "projected_profit": mb.projected_profit,
                "warnings": (mb.warnings or [])[:5],
            }
            if mb
            else None
        ),
        "atlas": (
            {
                "sale_type": atlas.sale_type,
                "is_state_default": atlas.is_state_default,
                "as_of": atlas.as_of,
                "inherited": atlas.inherited,
                "sources_n": len(atlas.sources or []),
            }
            if atlas
            else None
        ),
        "profit_loss": t.profit_loss,
        "predicted": (
            t.predicted_outcome.model_dump() if t.predicted_outcome else None
        ),
        "critique": t.critique,
        "sources_used": (t.sources_used or [])[:8],
        "reasoning_trace_tail": (t.reasoning_trace or [])[-4:],
    }


def _build_reflection_prompt(trajectories: list[Trajectory]) -> str:
    batch = [_trajectory_summary(t) for t in trajectories]
    return (
        "Reflect on this trajectory batch and produce structured lessons.\n\n"
        f"BATCH_JSON:\n{json.dumps(batch, indent=2, default=str)}\n"
    )


def _normalize_lesson_dict(ld: dict[str, Any], *, source: str) -> dict[str, Any]:
    """Validate + normalize to the flywheel lesson dict schema."""
    item = ReflectionLessonOut.model_validate(ld)
    out = item.model_dump()
    out["source"] = source
    return out


def _lesson_key(ld: dict[str, Any]) -> str:
    return f"{ld.get('scope')}|{ld.get('scope_key')}|{(ld.get('lesson') or '')[:80].lower()}"


def _merge_lessons(
    primary: list[dict[str, Any]],
    safety: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    for ld in primary + safety:
        k = _lesson_key(ld)
        if k in seen:
            continue
        seen.add(k)
        merged.append(ld)
    return merged


def reflect_on_batch_llm(
    trajectories: list[Trajectory],
    *,
    max_tokens: int = 4096,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    Call the strong-model chain (Grok → Claude) for structured lessons.

    Returns (lessons, meta). Raises on total failure so caller can fall back.
    """
    from .llm import NoProviderAvailableError, run_structured

    if not trajectories:
        return [], {"provider": None, "model": None, "n": 0}

    result = run_structured(
        system=_SYSTEM,
        prompt=_build_reflection_prompt(trajectories),
        schema=LessonsBatch,
        schema_name="LessonsBatch",
        max_tokens=max_tokens,
    )
    raw_lessons = (result.data or {}).get("lessons") or []
    source = f"llm:{result.provider}:{result.model}"
    lessons: list[dict[str, Any]] = []
    for ld in raw_lessons:
        try:
            lessons.append(_normalize_lesson_dict(ld, source=source))
        except Exception as e:  # noqa: BLE001 — drop bad rows, keep batch
            logger.warning("dropping invalid LLM lesson: %s (%s)", e, ld)

    meta = {
        "provider": result.provider,
        "model": result.model,
        "used_fallback": result.used_fallback,
        "n": len(lessons),
        "source": source,
    }
    return lessons, meta


def _want_llm(use_llm: bool | None) -> bool:
    if use_llm is not None:
        return use_llm
    mode = (os.environ.get("DEEDPILOT_REFLECT_MODE") or "auto").strip().lower()
    if mode in ("rules", "rule", "off", "0", "false"):
        return False
    if mode in ("llm", "on", "1", "true"):
        return True
    # auto
    return True


def reflect_on_batch(
    trajectories: list[Trajectory],
    *,
    use_llm: bool | None = None,
) -> list[dict[str, Any]]:
    """
    Structured batch reflection for the flywheel.

    Prefer a strong-model call (Grok primary, Claude fallback) that returns the
    same lesson dict schema as the rule-based path:

      scope, scope_key, lesson, suggested_buffer_usd?, suggested_p_redeem_delta?,
      confidence, evidence_trajectory_ids

    Falls back to deterministic rules when:
      - use_llm=False / DEEDPILOT_REFLECT_MODE=rules
      - no XAI_API_KEY / ANTHROPIC_API_KEY
      - the provider chain fails

    When the LLM path succeeds, hard safety lessons (oracle overbid, state-default
    disclosure) from the rule engine are still merged in so product constraints
    cannot be soft-prompted away.
    """
    if not trajectories:
        return []

    if not _want_llm(use_llm):
        return reflect_on_batch_rules(trajectories)

    try:
        from .llm import NoProviderAvailableError, configured_providers, load_env

        load_env()
        if not configured_providers():
            logger.info("reflect_on_batch: no LLM keys — using rules")
            return reflect_on_batch_rules(trajectories)

        lessons, meta = reflect_on_batch_llm(trajectories)
        safety = _safety_lessons(trajectories)
        merged = _merge_lessons(lessons, safety)
        logger.info(
            "reflect_on_batch: llm provider=%s model=%s n_llm=%s n_merged=%s",
            meta.get("provider"),
            meta.get("model"),
            meta.get("n"),
            len(merged),
        )
        # Annotate meta on first lesson for run logs (optional; flywheel ignores extras)
        if merged and meta:
            merged[0] = {**merged[0], "reflection_meta": meta}
        return merged
    except Exception as e:  # noqa: BLE001 — always degrade to rules
        logger.warning("reflect_on_batch: LLM path failed (%s) — using rules", e)
        return reflect_on_batch_rules(trajectories)
