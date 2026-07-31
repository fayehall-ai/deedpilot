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
from .evaluate import evaluate_policies
from .flywheel import historical_lots, run_cycle
from .history import calibrate_priors, load_outcomes, real_outcomes_only
from .history_guidance import build_history_index
from .labels import label_summary
from .llm import load_env
from .schemas import utc_now
from .splits import build_splits, splits_summary
from .world_model import train_and_evaluate

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

    # What the corpus actually observes, before anything is fitted to it.
    rows = real_outcomes_only(load_outcomes())
    report["steps"]["labels"] = label_summary(rows)

    # Frozen temporal splits. Loaded, not rebuilt, unless asked — a split that
    # moves between runs cannot support a promotion claim.
    build_splits()
    report["steps"]["splits"] = splits_summary(rows)["counts"]

    cal_rows = [
        o
        for o in rows
        if o.winning_bid is not None or o.ownership_taken or o.redeemed
    ]
    priors = calibrate_priors(cal_rows, cache=True)
    report["steps"]["calibrate_priors"] = {
        "n_outcomes": priors.n_outcomes,
        "n_quarantined": priors.n_quarantined,
        "n_buckets": len(priors.buckets),
        "provenance": priors.provenance_counts,
        "unobserved_fields": priors.unobserved_fields,
        "p_redeem_by_bucket": {
            k: {
                "p_redeem": b.p_redeem,
                "source": b.p_redeem_source,
                "n_observed": b.n_redemption_observed,
            }
            for k, b in priors.buckets.items()
        },
    }

    # Clearing-price world model: fit on train, scored on val and test.
    report["steps"]["world_model"] = train_and_evaluate()

    idx = build_history_index()
    report["steps"]["history_index"] = {
        "n_outcomes": idx.get("nOutcomes"),
        "n_buckets": idx.get("nBuckets"),
        "built_at": idx.get("builtAt"),
    }

    # Policy comparison on held-out sales. This is the number that means
    # something: recorded clearing prices as ground truth, against the policy
    # shipping today.
    report["steps"]["policy_eval_val"] = evaluate_policies("val")
    report["steps"]["policy_eval_test"] = evaluate_policies("test")

    if not skip_cycle:
        # Real lots from the train split, not hand-written synthetics.
        lots = historical_lots(limit=60)
        cycle = run_cycle(lots, promote=True)
        report["steps"]["flywheel_cycle"] = {
            "run_path": cycle.get("run_path"),
            "n_lots": len(lots),
            "lessons_added": cycle.get("lessons_added"),
            "reflection_source": cycle.get("reflection_source"),
            "promotion_gate": cycle.get("promotion_gate"),
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
        "held_out_gain": (
            (report["steps"].get("flywheel_cycle") or {}).get("promotion_gate") or {}
        ).get("relative_gain"),
        "note": (
            "This pass updates priors, the clearing-price world model, the comps "
            "index, lessons (if the cycle ran), and evaluation metrics. Promotion "
            "is decided on the validation split; test is reported but never gated "
            "on. It does not fine-tune model weights."
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
