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
def lookup(
    fips: Optional[str] = typer.Argument(None, help="County FIPS (SSCCC)"),
    state: Optional[str] = typer.Option(None, help="USPS state, e.g. TX"),
    county: Optional[str] = typer.Option(None, help="County name or slug"),
):
    """Trusted tool: lookup_atlas (fips or --state + --county)"""
    from .atlas import resolve_atlas

    if fips:
        r = lookup_atlas(fips)
    else:
        r = resolve_atlas(state=state, county=county)
    rprint(r.model_dump(by_alias=True))


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


@app.command("improve")
def improve_cmd(
    deep: bool = typer.Option(
        False, "--deep", help="Also re-import deep history (slow network)"
    ),
    skip_cycle: bool = typer.Option(False, help="Skip flywheel reflect cycle"),
    skip_backtest: bool = typer.Option(False, help="Skip historical backtest"),
    backtest_limit: int = typer.Option(40, help="Historical lots to sample"),
    backtest_state: Optional[str] = typer.Option("MI", help="Backtest state filter"),
    reflect_mode: Optional[str] = typer.Option(
        None, help="rules|llm|auto for DEEDPILOT_REFLECT_MODE"
    ),
    decide_mode: Optional[str] = typer.Option(
        None, help="rules|llm|auto for DEEDPILOT_DECIDE_MODE"
    ),
):
    """
    Full self-improvement pass: priors → history index → flywheel → backtest.

    This is the one command to run on a schedule so the copilot actually improves
    over time (data + lessons + evaluation). Does not fine-tune model weights.
    """
    from .improve import run_improve

    result = run_improve(
        deep_import=deep,
        skip_cycle=skip_cycle,
        skip_backtest=skip_backtest,
        backtest_limit=backtest_limit,
        backtest_state=backtest_state,
        reflect_mode=reflect_mode,
        decide_mode=decide_mode,
    )
    rprint(
        {
            "report_path": result.get("report_path"),
            "self_improving": result.get("self_improving"),
            "priors": result.get("steps", {}).get("calibrate_priors"),
            "index": result.get("steps", {}).get("history_index"),
            "cycle": {
                k: (result.get("steps", {}).get("flywheel_cycle") or {}).get(k)
                for k in (
                    "lessons_added",
                    "reflection_source",
                    "promoted",
                    "run_path",
                )
            },
            "backtest": {
                k: (result.get("steps", {}).get("historical_backtest") or {}).get(k)
                for k in (
                    "n_sample",
                    "n_bids",
                    "n_passes",
                    "n_over_oracle",
                    "n_under_market",
                )
            },
        }
    )


@app.command("seed-history")
def seed_history(
    force: bool = typer.Option(False, help="Deprecated — synthetic seed disabled"),
):
    """Deprecated: synthetic history is disabled. Use import-history instead."""
    rprint(
        {
            "error": "synthetic_seed_disabled",
            "hint": "Run: deedpilot-copilot import-history --years 2023,2024,2025",
        }
    )
    raise typer.Exit(code=1)


@app.command("import-history")
def import_history_cmd(
    years: str = typer.Option(
        "2023,2024,2025",
        help="Comma-separated years of MI past auctions to import",
    ),
    max_auctions: Optional[int] = typer.Option(
        None, help="Cap auctions per year (smoke tests)"
    ),
    include_unsold: bool = typer.Option(
        False, help="Keep unsold/minimum-bid-only lots"
    ),
    from_db: bool = typer.Option(
        False, help="Also export sold/redeemed lots from DATABASE_URL"
    ),
    from_map: bool = typer.Option(
        False,
        "--from-map",
        help="Crawl auction/tax links from tax-deed-map county research (all researched counties)",
    ),
    map_root: Optional[str] = typer.Option(
        None, help="Path to tax-deed-map repo (for re-export of county_sources.json)"
    ),
    max_counties: Optional[int] = typer.Option(
        None, help="Cap counties when using --from-map (smoke)"
    ),
    skip_mi_specialized: bool = typer.Option(
        False, help="With --from-map, skip full MI tax-sale.info re-import"
    ),
    deep: bool = typer.Option(
        False,
        "--deep",
        help="Deep multi-state import: expanded MI years, Cook/Howard open data, CA sale PDFs",
    ),
    replace: bool = typer.Option(
        True, help="Replace JSONL (drop synthetic); false merges with existing real rows"
    ),
):
    """
    Import *real* historical outcomes.

    Default: Michigan Title Check past sales.
    --from-map: walk tax-deed-map COUNTY_DATA links nationwide (policy-aware).
    --deep: government open-data APIs + expanded archives (Cook IL, Howard MD, SD/OC CA, MI 2018–2026).
    """
    import os
    import subprocess
    from pathlib import Path

    from .llm import load_env

    load_env()

    if deep:
        from .deep_history import deep_import_all

        year_list = [int(y.strip()) for y in years.split(",") if y.strip()]
        # If user left default 2023-2025, expand for deep mode
        if year_list == [2023, 2024, 2025]:
            year_list = list(range(2018, 2027))
        report = deep_import_all(mi_years=year_list, progress=True)
        rprint({"mode": "deep", **report})
        return

    if from_map:
        # Ensure county_sources.json is fresh from the map
        export_script = (
            Path(__file__).resolve().parent.parent / "scripts" / "export_county_sources.mjs"
        )
        cmd = ["node", str(export_script)]
        if map_root:
            cmd += ["--map", map_root]
        elif Path("/Users/fayehall/tax-deed-map").is_dir():
            cmd += ["--map", "/Users/fayehall/tax-deed-map"]
        try:
            subprocess.run(cmd, check=True)
        except Exception as e:  # noqa: BLE001
            rprint({"export_warning": str(e)})

        from .map_history_crawl import crawl_county_sources

        year_list = [int(y.strip()) for y in years.split(",") if y.strip()]
        report = crawl_county_sources(
            max_counties=max_counties,
            include_specialized_mi=not skip_mi_specialized,
            mi_years=year_list,
            progress=True,
        )
        rprint(
            {
                "mode": "from_map",
                "merged_n": report.get("merged_n"),
                "stats": report.get("stats"),
                "priors": report.get("priors"),
                "report": str(
                    Path(__file__).resolve().parent.parent / "data" / "map_crawl_report.json"
                ),
            }
        )
        return

    from .ingest_real_history import rebuild_real_history

    year_list = [int(y.strip()) for y in years.split(",") if y.strip()]
    db_url = os.environ.get("DATABASE_URL") if from_db else None
    result = rebuild_real_history(
        years=year_list,
        max_auctions_per_year=max_auctions,
        include_unsold=include_unsold,
        database_url=db_url,
        replace=replace,
        calibrate=True,
    )
    rprint(result)


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


@app.command("build-history-index")
def build_history_index_cmd():
    """Build compact history_index.json for the web app + comps API."""
    from .history_guidance import DEFAULT_INDEX_PATH, build_history_index

    idx = build_history_index()
    rprint(
        {
            "path": str(DEFAULT_INDEX_PATH),
            "n_outcomes": idx.get("nOutcomes"),
            "n_buckets": idx.get("nBuckets"),
            "built_at": idx.get("builtAt"),
        }
    )


@app.command("comparables")
def comparables_cmd(
    state: str,
    sale_type: str = "Tax Deed",
    assessed: Optional[float] = None,
    opening: Optional[float] = None,
    limit: int = 10,
):
    """List historical comps for a state/sale type (from recorded outcomes)."""
    from .history_guidance import find_comparables
    from .schemas import SaleType as ST

    try:
        st = ST(sale_type)
    except ValueError:
        st = sale_type  # type: ignore[assignment]
    comps = find_comparables(
        state=state.upper(),
        sale_type=st,
        assessed_value=assessed,
        opening_bid=opening,
        limit=limit,
    )
    rprint(comps)


@app.command("backtest-history")
def backtest_history_cmd(
    limit: int = typer.Option(60, help="Number of historical lots to sample"),
    state: Optional[str] = typer.Option(None, help="Filter state e.g. MI"),
    sale_type: Optional[str] = typer.Option(None, help='Filter e.g. "Tax Deed"'),
):
    """Run agent on recorded historical lots; score vs oracle + market."""
    from .backtest_historical import run_historical_backtest

    result = run_historical_backtest(limit=limit, state=state, sale_type=sale_type)
    # Compact summary for CLI
    summary = {k: v for k, v in result.items() if k != "comparisons"}
    summary["sample_comparisons"] = result.get("comparisons", [])[:5]
    rprint(summary)


@app.command("simulate")
def simulate_cmd(
    outcome_id: Optional[str] = typer.Argument(
        None, help="Historical outcome id (e.g. seed-tx-0001)"
    ),
    mode: str = typer.Option(
        "replay",
        help="replay | sample | costs_only",
    ),
    n: int = typer.Option(1, "--n", "-n", help="Monte Carlo paths when mode is sample/costs_only"),
    state: Optional[str] = typer.Option(None, "--state", help="Filter batch replay by state"),
    list_ids: bool = typer.Option(False, "--list", help="List historical outcome ids"),
    seed: Optional[str] = typer.Option(None, "--seed", help="RNG seed string"),
    bid: Optional[float] = typer.Option(None, "--bid", help="Override bid / cash out"),
):
    """
    Minimal historical-lot simulator.

    replay  — lock recorded redemption + costs
    sample  — re-draw redemption and ownership costs from noise model
    costs_only — lock redemption flag; re-draw ownership costs only
    """
    from .historical_sim import (
        batch_replay,
        list_outcomes,
        monte_carlo_historical,
        simulate_historical,
    )

    if list_ids:
        rows = list_outcomes(state=state, limit=50)
        rprint([{"id": r.id, "state": r.state, "redeemed": r.redeemed} for r in rows])
        return

    if outcome_id is None:
        # Aggregate replay of seed history
        summary = batch_replay(state=state, limit=None)
        rprint(summary)
        return

    if mode not in ("replay", "sample", "costs_only"):
        raise typer.BadParameter("mode must be replay | sample | costs_only")

    if mode == "replay" or n <= 1:
        out = simulate_historical(
            outcome_id, mode=mode, seed=seed, bid_amount=bid  # type: ignore[arg-type]
        )
        rprint(out.model_dump())
    else:
        rprint(
            monte_carlo_historical(
                outcome_id,
                n=n,
                mode=mode if mode != "replay" else "sample",  # type: ignore[arg-type]
                seed=seed,
                bid_amount=bid,
            )
        )


if __name__ == "__main__":
    app()
