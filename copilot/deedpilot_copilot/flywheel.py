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
from .memory import LessonMemory
from .schemas import Lot, SaleType, Trajectory, utc_now


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


def run_cycle(
    lots: list[Lot] | None = None,
    *,
    out_dir: Path | None = None,
    promote: bool = True,
) -> dict[str, Any]:
    lots = lots or default_synthetic_lots()
    out_dir = out_dir or Path(__file__).resolve().parent.parent / "data" / "runs"
    out_dir.mkdir(parents=True, exist_ok=True)

    memory = LessonMemory()
    agent = DeedCopilotAgent(memory=memory)

    trajectories: list[Trajectory] = []
    for lot in lots:
        traj = agent.run_lot(lot, seed=lot.lot_id)
        trajectories.append(traj)

    # Critique already on each traj; reflect batch
    lesson_dicts = reflect_on_batch(trajectories)
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
    agent2 = DeedCopilotAgent(memory=memory)
    trajectories2 = [agent2.run_lot(lot, seed=lot.lot_id + "-v2") for lot in lots]

    metrics_before = run_backtest(trajectories)
    metrics_after = run_backtest(trajectories2)
    metrics_after.vs_baseline_profit = metrics_after.total_profit - metrics_before.total_profit
    metrics_after.promoted = promote and metrics_after.total_profit >= metrics_before.total_profit - 1e-6

    stamp = utc_now().replace(":", "").replace(".", "")[:15]
    run_path = out_dir / f"cycle_{stamp}.json"
    payload = {
        "created_at": utc_now(),
        "n_lots": len(lots),
        "lessons": [s.model_dump() for s in stored],
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
    }
