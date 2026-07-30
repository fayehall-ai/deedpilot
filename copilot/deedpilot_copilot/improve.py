"""
One-command self-improvement pass.

  calibrate priors → rebuild history index → flywheel cycle → historical backtest
  → write improve report

Optional: refresh history with --deep (slow network).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .backtest_historical import run_historical_backtest
from .flywheel import default_synthetic_lots, run_cycle
from .history import calibrate_priors, load_outcomes, real_outcomes_only
from .history_guidance import build_history_index
from .llm import load_env
from .schemas import utc_now

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
IMPROVE_DIR = DATA_DIR / "improve"


def run_improve(
    *,
    deep_import: bool = False,
    skip_cycle: bool = False,
    skip_backtest: bool = False,
    backtest_limit: int = 40,
    backtest_state: str | None = "MI",
    reflect_mode: str | None = None,
    decide_mode: str | None = None,
) -> dict[str, Any]:
    """
    Run a full improvement pass and persist a report under data/improve/.
    """
    load_env()
    if reflect_mode:
        os.environ["DEEDPILOT_REFLECT_MODE"] = reflect_mode
    if decide_mode:
        os.environ["DEEDPILOT_DECIDE_MODE"] = decide_mode

    report: dict[str, Any] = {
        "started_at": utc_now(),
        "steps": {},
    }

    if deep_import:
        from .deep_history import deep_import_all

        report["steps"]["deep_import"] = deep_import_all(progress=True)
    else:
        report["steps"]["deep_import"] = {"skipped": True}

    # Priors from whatever is on disk
    rows = real_outcomes_only(load_outcomes())
    cal_rows = [
        o
        for o in rows
        if o.winning_bid is not None or o.ownership_taken or o.redeemed
    ]
    priors = calibrate_priors(cal_rows, cache=True)
    report["steps"]["calibrate_priors"] = {
        "n_outcomes": priors.n_outcomes,
        "n_buckets": len(priors.buckets),
        "provenance": priors.provenance_counts,
    }

    idx = build_history_index()
    report["steps"]["history_index"] = {
        "n_outcomes": idx.get("nOutcomes"),
        "n_buckets": idx.get("nBuckets"),
        "built_at": idx.get("builtAt"),
    }

    if not skip_cycle:
        # Prefer history-backed lots when possible: mix synthetic + a few states
        lots = default_synthetic_lots()
        cycle = run_cycle(lots, promote=True)
        report["steps"]["flywheel_cycle"] = {
            "run_path": cycle.get("run_path"),
            "lessons_added": cycle.get("lessons_added"),
            "reflection_source": cycle.get("reflection_source"),
            "metrics_before": cycle.get("metrics_before"),
            "metrics_after": cycle.get("metrics_after"),
            "promoted": (cycle.get("metrics_after") or {}).get("promoted"),
        }
    else:
        report["steps"]["flywheel_cycle"] = {"skipped": True}

    if not skip_backtest:
        bt = run_historical_backtest(
            limit=backtest_limit,
            state=backtest_state,
        )
        report["steps"]["historical_backtest"] = {
            k: v for k, v in bt.items() if k != "comparisons"
        }
        report["steps"]["historical_backtest"]["sample_comparisons"] = bt.get(
            "comparisons", []
        )[:5]
    else:
        report["steps"]["historical_backtest"] = {"skipped": True}

    report["finished_at"] = utc_now()
    report["self_improving"] = {
        "history_informed": True,
        "flywheel_ran": not skip_cycle,
        "lessons_grow": (report["steps"].get("flywheel_cycle") or {}).get(
            "lessons_added", 0
        )
        > 0
        if not skip_cycle
        else False,
        "promoted": (report["steps"].get("flywheel_cycle") or {}).get("promoted"),
        "oracle_violations": (
            report["steps"].get("historical_backtest") or {}
        ).get("n_over_oracle"),
        "note": (
            "This pass updates priors, comps index, lessons (if cycle ran), "
            "and evaluation metrics. It does not fine-tune model weights."
        ),
    }

    IMPROVE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = utc_now().replace(":", "").replace(".", "")[:15]
    path = IMPROVE_DIR / f"improve_{stamp}.json"
    path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    report["report_path"] = str(path)
    # Also write latest pointer
    (IMPROVE_DIR / "latest.json").write_text(
        json.dumps(report, indent=2, default=str), encoding="utf-8"
    )
    return report
