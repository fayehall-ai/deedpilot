"""
Scout mode: Discover new county sources and upcoming auctions.

For continuous broad scouting beyond the hardcoded adapters.
Uses atlas, registry, and optional LLM to find new sale pages.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Dict, Any

import typer
from rich import print as rprint

from .atlas import lookup_atlas, resolve_atlas

# Simple stub using known high-volume states + registry gaps
# In real use: crawl county .gov sites, use LLM to classify "has upcoming tax sale list"

SCOUT_STATES = ["FL", "GA", "TX", "AZ", "MI", "IL", "OH", "CA", "NC"]

def discover_gaps() -> List[Dict[str, Any]]:
    """Return counties without strong adapter coverage."""
    gaps = []
    for state in SCOUT_STATES:
        # In production, load full atlas or registry and filter
        try:
            # Placeholder: use resolve for examples
            atlas = resolve_atlas(state=state, county="example")
            gaps.append({"state": state, "note": "needs direct county URL or adapter"})
        except Exception:
            pass
    return gaps

def scout_new_sources(use_llm: bool = False) -> List[Dict]:
    """Main scout. Extend with web discovery or tax-deed-map crawl."""
    results = discover_gaps()
    if use_llm:
        # TODO: Call LLM (via existing agent) to suggest county pages
        # e.g. "Find public tax deed sale list URL for [county] [state] .gov"
        results.append({"state": "FL", "suggestion": "Use county clerk direct sites + LLM PDF extract"})
    return results

app = typer.Typer()

@app.command("scout")
def scout_cmd(
    llm: bool = typer.Option(False, "--llm", help="Use LLM to help discover"),
    limit: int = typer.Option(10, help="Max suggestions"),
):
    """Scout for new county auction sources and gaps."""
    results = scout_new_sources(use_llm=llm)[:limit]
    rprint({"scouted": len(results), "results": results})
    rprint("Run with --llm for AI-assisted discovery. Feed results into generic adapter or new adapter.")

if __name__ == "__main__":
    app()
