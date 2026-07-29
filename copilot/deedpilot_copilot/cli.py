"""CLI: deedpilot-copilot cycle | backtest | lookup | maxbid | priors | seed-history"""

from __future__ import annotations

import json
from typing import Optional

import typer
from rich import print as rprint

from .agent import DeedCopilotAgent
from .atlas import lookup_atlas
from .flywheel import default_synthetic_lots, run_cycle
from .maxbid import compute_maxbid
from .schemas import DealInputs, Lot, SaleType

app = typer.Typer(help="DeedPilot self-improving tax-deed copilot")


@app.command("lookup")
def lookup(fips: str):
    """Trusted tool: lookup_atlas"""
    r = lookup_atlas(fips)
    rprint(r.model_dump())


@app.command("maxbid")
def maxbid(
    state: str,
    sale_type: str = "Redeemable Deed",
    assessed: Optional[float] = None,
    arv: Optional[float] = None,
    opening: Optional[float] = None,
    rehab: Optional[float] = None,
):
    """Trusted oracle: compute_maxbid"""
    st = SaleType(sale_type)
    res = compute_maxbid(
        DealInputs(
            state=state,
            sale_type=st,
            assessed_value=assessed,
            arv_override=arv,
            opening_bid=opening,
            rehab_cost=rehab,
        )
    )
    rprint(res.model_dump())


@app.command("run-lot")
def run_lot(
    fips: str,
    state: str,
    assessed: float,
    opening: float = 0,
    rehab: float = 0,
):
    """Run full agent trajectory on one lot."""
    lot = Lot(
        lot_id=f"cli-{fips}",
        fips=fips,
        state=state,
        opening_bid=opening or None,
        assessed_value=assessed,
        rehab_cost=rehab or None,
    )
    traj = DeedCopilotAgent().run_lot(lot)
    rprint(json.loads(traj.model_dump_json(by_alias=True)))


@app.command("cycle")
def cycle():
    """Run one self-improvement flywheel cycle on synthetic lots."""
    result = run_cycle(default_synthetic_lots())
    rprint(result)


@app.command("seed-history")
def seed_history(force: bool = typer.Option(False, help="Overwrite existing outcomes file")):
    """Write synthetic seed historical outcomes and calibrate simulator priors."""
    from .history import calibrate_priors, ensure_seed_outcomes, generate_seed_outcomes, write_outcomes

    if force:
        n = write_outcomes(generate_seed_outcomes())
        priors = calibrate_priors(cache=True)
        rprint({"wrote": n, "n_outcomes": priors.n_outcomes, "buckets": len(priors.buckets)})
    else:
        path = ensure_seed_outcomes(force=False)
        from .history import get_priors, load_outcomes

        outs = load_outcomes()
        priors = get_priors(force_reload=True)
        rprint(
            {
                "path": str(path),
                "n_outcomes": len(outs),
                "n_buckets": len(priors.buckets),
                "provenance": priors.provenance_counts,
            }
        )


@app.command("calibrate-priors")
def calibrate_priors_cmd():
    """Re-fit simulator noise model from data/historical_outcomes.jsonl."""
    from .history import calibrate_priors, priors_path, priors_summary

    priors = calibrate_priors(cache=True)
    rprint(priors_summary(priors))
    rprint({"priors_path": str(priors_path())})


@app.command("priors")
def priors_cmd():
    """Show calibrated simulator prior buckets."""
    from .history import get_priors, priors_summary

    rprint(priors_summary(get_priors()))


if __name__ == "__main__":
    app()
