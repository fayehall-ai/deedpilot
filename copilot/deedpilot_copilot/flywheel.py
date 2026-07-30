"""
Self-improvement flywheel:

  run → critique → reflect → store lessons → re-evaluate

Scaffold improves first (lessons/buffers). Model fine-tuning is optional later.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .agent import DeedCopilotAgent
from .backtest import run_backtest
from .critique import reflect_on_batch
from .evaluate import POLICIES, PolicyResult, county_arv_priors, evaluate_policy, promotion_gate
from .labels import clearing_price_rows
from .memory import LessonMemory
from .schemas import HistoricalOutcome, Lot, SaleType, Trajectory, utc_now
from .splits import get_split_rows


def default_synthetic_lots() -> list[Lot]:
    """Synthetic auction lots for smoke cycles (replace with historical data)."""
    return [
        Lot(
            lot_id="syn-tx-001",
            fips="48201",
            state="TX",
            county_name="Harris",
            opening_bid=12000,
            assessed_value=180000,
            rehab_cost=25000,
            sale_type=SaleType.REDEEMABLE_DEED,
        ),
        Lot(
            lot_id="syn-ga-001",
            fips="13121",
            state="GA",
            county_name="Fulton",
            opening_bid=8000,
            assessed_value=60000,  # 40% ratio → ARV 150k
            rehab_cost=20000,
            sale_type=SaleType.REDEEMABLE_DEED,
        ),
        Lot(
            lot_id="syn-fl-001",
            fips="12086",
            state="FL",
            county_name="Miami-Dade",
            opening_bid=25000,
            assessed_value=220000,
            rehab_cost=30000,
            sale_type=SaleType.TAX_DEED,
        ),
        Lot(
            lot_id="syn-az-001",
            fips="04013",
            state="AZ",
            county_name="Maricopa",
            opening_bid=5000,
            assessed_value=90000,
            sale_type=SaleType.TAX_LIEN,
        ),
        Lot(
            lot_id="syn-mi-001",
            fips="26163",
            state="MI",
            county_name="Wayne",
            opening_bid=3000,
            assessed_value=40000,  # SEV 50% → ARV 80k
            rehab_cost=15000,
            sale_type=SaleType.TAX_DEED,
        ),
        Lot(
            lot_id="syn-ca-state-default",
            fips="06037",
            state="CA",
            county_name="Los Angeles",
            opening_bid=50000,
            assessed_value=400000,
            rehab_cost=40000,
            sale_type=SaleType.TAX_DEED,
        ),
        # Overpriced opener — should pass
        Lot(
            lot_id="syn-overpriced",
            fips="48201",
            state="TX",
            county_name="Harris",
            opening_bid=200000,
            assessed_value=100000,
            rehab_cost=50000,
            sale_type=SaleType.REDEEMABLE_DEED,
        ),
    ]


def historical_lots(limit: int = 60, *, split: str = "train") -> list[Lot]:
    """
    Real lots for the reflection batch, drawn from one split.

    The cycle used to reflect on seven hand-written synthetic lots while 92k
    recorded rows sat on disk, which is why it kept producing zero lessons: none
    of the rule triggers (repeated losses in a state, oracle overbids,
    undisclosed state defaults) fire on seven lots that were built to behave.
    """
    priors = county_arv_priors()
    rows = [o for o in clearing_price_rows(get_split_rows(split)) if o.winning_bid]
    # Spread across counties so the batch surfaces geographic variety.
    by_county: dict[str, list[HistoricalOutcome]] = {}
    for o in rows:
        by_county.setdefault(o.fips or o.state, []).append(o)

    picked: list[Lot] = []
    keys = sorted(by_county)
    i = 0
    while len(picked) < limit and keys:
        progressed = False
        for k in list(keys):
            group = by_county[k]
            if i >= len(group):
                keys.remove(k)
                continue
            o = group[i]
            assessed = priors.get(o.fips or "") or priors.get(o.state)
            if assessed:
                picked.append(
                    Lot(
                        lot_id=o.id,
                        fips=o.fips or "",
                        state=o.state,
                        county_name=o.county_name,
                        opening_bid=o.opening_bid,
                        assessed_value=assessed * 4.0,
                        sale_type=o.sale_type,
                        metadata={
                            "sale_date": o.sale_date,
                            "actual_winning_bid": o.winning_bid,
                            "assessed_from": "county_train_median_prior",
                        },
                    )
                )
            progressed = True
            if len(picked) >= limit:
                break
        if not progressed:
            break
        i += 1
    return picked


def run_cycle(
    lots: list[Lot] | None = None,
    *,
    out_dir: Path | None = None,
    promote: bool = True,
) -> dict[str, Any]:
    lots = lots or historical_lots() or default_synthetic_lots()
    out_dir = out_dir or Path(__file__).resolve().parent.parent / "data" / "runs"
    out_dir.mkdir(parents=True, exist_ok=True)

    memory = LessonMemory()
    # Decide mode from DEEDPILOT_DECIDE_MODE (auto/llm/rules); history on by default
    agent = DeedCopilotAgent(memory=memory, use_history=True)

    trajectories: list[Trajectory] = []
    for lot in lots:
        traj = agent.run_lot(lot, seed=lot.lot_id)
        trajectories.append(traj)

    # Critique already on each traj; strong-model (or rules) structured reflection
    lesson_dicts = reflect_on_batch(trajectories)
    reflection_source = None
    if lesson_dicts:
        reflection_source = lesson_dicts[0].get("source") or (
            (lesson_dicts[0].get("reflection_meta") or {}).get("source")
        )
    stored = []
    for ld in lesson_dicts:
        stored.append(
            memory.add_from_text(
                ld["lesson"],
                scope=ld.get("scope", "global"),
                scope_key=ld.get("scope_key"),
                trajectory_ids=ld.get("evidence_trajectory_ids"),
                suggested_buffer_usd=ld.get("suggested_buffer_usd"),
                suggested_p_redeem_delta=ld.get("suggested_p_redeem_delta"),
                confidence=float(ld.get("confidence") or 0.5),
            )
        )

    # Second pass with updated memory (scaffold improvement)
    agent2 = DeedCopilotAgent(memory=memory, use_history=True)
    trajectories2 = [agent2.run_lot(lot, seed=lot.lot_id + "-v2") for lot in lots]

    # Simulated before/after remain as diagnostics only. They are not evidence:
    # both passes run the same lots through the same noise model, so a delta
    # between them measures seed variance, not skill.
    metrics_before = run_backtest(trajectories)
    metrics_after = run_backtest(trajectories2)
    metrics_after.vs_baseline_profit = metrics_after.total_profit - metrics_before.total_profit

    # The real gate: held-out sales, recorded clearing prices as ground truth,
    # candidate policy against the one shipping today. Test is never touched.
    gate = evaluate_promotion(promote=promote)
    metrics_after.promoted = bool(gate["promote"])
    metrics_after.notes = list(metrics_after.notes) + gate["reasons"]

    stamp = utc_now().replace(":", "").replace(".", "")[:15]
    run_path = out_dir / f"cycle_{stamp}.json"
    payload = {
        "created_at": utc_now(),
        "n_lots": len(lots),
        "lot_source": "historical_train_split" if lots and lots[0].metadata.get(
            "assessed_from"
        ) else "synthetic_fallback",
        "reflection_source": reflection_source,
        "lessons": [s.model_dump() for s in stored],
        "promotion_gate": gate,
        "metrics_before": metrics_before.model_dump(),
        "metrics_after": metrics_after.model_dump(),
        "trajectories_v1": [t.model_dump(by_alias=True) for t in trajectories],
        "trajectories_v2": [t.model_dump(by_alias=True) for t in trajectories2],
    }
    run_path.write_text(json.dumps(payload, indent=2))

    return {
        "run_path": str(run_path),
        "metrics_before": metrics_before.model_dump(),
        "metrics_after": metrics_after.model_dump(),
        "lessons_added": len(stored),
        "reflection_source": reflection_source,
        "promotion_gate": gate,
    }


def evaluate_promotion(
    *,
    candidate: str = "search",
    incumbent: str = "fixed_fraction_0.90",
    promote: bool = True,
    limit: int | None = None,
) -> dict[str, Any]:
    """
    Decide promotion on the validation split against the shipping policy.

    Deliberately does not look at test. Test exists to answer "did we fool
    ourselves on val", and it can only do that if no promotion decision has ever
    consulted it.
    """
    rows = [
        o
        for o in clearing_price_rows(get_split_rows("val"))
        if o.winning_bid and o.winning_bid > 0
    ]
    if limit:
        rows = rows[:limit]
    if not rows:
        return {
            "promote": False,
            "reasons": ["No validation rows with recorded clearing prices."],
            "split": "val",
        }

    priors = county_arv_priors()
    cand = evaluate_policy(candidate, POLICIES[candidate], rows, priors)
    inc = evaluate_policy(incumbent, POLICIES[incumbent], rows, priors)
    gate = promotion_gate(cand, inc)
    gate["split"] = "val"
    gate["n_rows"] = len(rows)
    gate["candidate_metrics"] = cand.model_dump()
    gate["incumbent_metrics"] = inc.model_dump()
    if not promote:
        gate["promote"] = False
        gate["reasons"] = list(gate["reasons"]) + ["promote=False requested by caller."]
    return gate
