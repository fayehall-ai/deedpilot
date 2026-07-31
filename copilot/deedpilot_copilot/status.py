"""
Status snapshot for the product's /status page.

The copilot's evaluation lives in Python; the site that has to show it is
TypeScript on Vercel, where no Python runtime exists. Rather than stand up a
service for a page that changes when a model is refitted — a few times a week at
most — this exports one committed JSON artifact the Next.js route reads
server-side. Same shape of decision as `scripts/export-atlas-for-copilot.ts`,
pointed the other way.

Committing the snapshot also means the numbers on the page are diffable. A
calibration figure that shifts shows up in review as a changed line rather than
silently redrawing itself.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .archivist import corpus_report
from .evaluate import evaluate_policies
from .history import get_priors
from .schemas import utc_now
from .splits import get_split_rows, splits_summary
from .world_model import evaluate_clearing_price_model, get_model

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_STATUS_PATH = DATA_DIR / "status.json"


def build_status() -> dict[str, Any]:
    """Everything the status page shows, computed once."""
    corpus = corpus_report()
    priors = get_priors()
    splits = splits_summary()
    model = get_model()

    buckets = [
        {
            "key": key,
            "state": b.state,
            "saleType": b.sale_type,
            "n": b.n,
            "nObserved": b.n_redemption_observed,
            "pRedeem": b.p_redeem,
            "expertPRedeem": b.expert_p_redeem,
            "source": b.p_redeem_source,
        }
        for key, b in sorted(priors.buckets.items(), key=lambda kv: -kv[1].n)
    ]

    model_block: dict[str, Any] = {"fitted": False}
    if model is not None and model.n_train:
        model_block = {
            "fitted": True,
            "nTrain": model.n_train,
            "nCounties": len(model.by_county),
            "states": sorted(model.by_state),
            "yearSlope": model.year_slope,
            "levels": model.levels,
            "val": evaluate_clearing_price_model(model, get_split_rows("val")),
            "test": evaluate_clearing_price_model(model, get_split_rows("test")),
        }

    policies = {
        split: {
            name: {
                "nBid": r["n_bid"],
                "nWon": r["n_won"],
                "winRate": r["win_rate"],
                "meanBid": r["mean_bid"],
                "meanOverpay": r["mean_overpay_when_won"],
                "totalSurplus": r["total_surplus"],
                "cvar10": r["cvar10_surplus"],
                "oracleViolations": r["n_oracle_violations"],
            }
            for name, r in evaluate_policies(split)["results"].items()  # type: ignore[arg-type]
        }
        for split in ("val", "test")
    }

    return {
        "generatedAt": utc_now(),
        "corpus": {
            "nRows": corpus["n_rows"],
            "nPriceUsable": corpus["n_price_usable"],
            "nRedemptionObserved": corpus["n_redemption_observed"],
            "sharePriceUsable": corpus["share_price_usable"],
            "byRule": corpus["by_rule"],
            "note": corpus["note"],
        },
        "priors": {
            "buckets": buckets,
            # Named so the page can state plainly which simulator inputs are
            # assumptions rather than measurements.
            "unobservedFields": priors.unobserved_fields,
            "nQuarantined": priors.n_quarantined,
        },
        "splits": {
            "policy": {
                "cutVal": splits["policy"]["cut_val"],
                "cutTest": splits["policy"]["cut_test"],
            },
            "counts": splits["counts"],
            "clearingPrice": splits["n_clearing_price"],
        },
        "worldModel": model_block,
        "policies": policies,
    }


def export_status(path: Path | None = None) -> Path:
    path = path or DEFAULT_STATUS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(build_status(), indent=2, default=str), encoding="utf-8")
    return path
