"""
Trusted tool: lookup_atlas(fips)

Loads atlas_export.json produced by scripts/export-atlas-for-copilot.ts.
Agent MUST cite asOf and sources.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .schemas import AtlasResult, SaleType

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "atlas_export.json"


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    if not DATA_PATH.exists():
        raise FileNotFoundError(
            f"Missing {DATA_PATH}. Run: npx tsx scripts/export-atlas-for-copilot.ts"
        )
    return json.loads(DATA_PATH.read_text())


def _to_sale_type(label: str) -> str:
    if label.startswith("Hybrid"):
        return SaleType.HYBRID.value
    if label.startswith("Redeemable"):
        return SaleType.REDEEMABLE_DEED.value
    if label.startswith("Tax Lien"):
        return SaleType.TAX_LIEN.value
    if label.startswith("Tax Deed"):
        return SaleType.TAX_DEED.value
    return SaleType.TAX_DEED.value


def lookup_atlas(fips: str) -> AtlasResult:
    """Resolve county rules with inheritance flags + provenance."""
    data = _load()
    fips = fips.strip()

    for rule in data["resolvedRules"]:
        county = rule["county"]
        if county["fips"] != fips:
            continue
        growth = rule.get("growthNeighborhoods") or []
        return AtlasResult(
            fips=fips,
            state=county["state"],
            county=county["name"],
            sale_type=rule.get("saleType") or _to_sale_type(rule.get("type", "")),
            type_label=rule.get("type", ""),
            redemption=rule.get("redemption", ""),
            returns=rule.get("returns", ""),
            statute=rule.get("statute", ""),
            notes=rule.get("notes", ""),
            surviving_liens=rule.get("survivingLiens"),
            quiet_title=rule.get("quietTitle"),
            deposit_rules=rule.get("depositRules"),
            auction_format=rule.get("auctionFormat"),
            growth_neighborhoods=[
                {"name": g.get("name", ""), "why": g.get("why", "")} for g in growth
            ],
            is_state_default=bool(rule.get("isStateDefault")),
            inherited=list(rule.get("inherited") or []),
            as_of=rule.get("asOf"),
            sources=list(rule.get("sources") or []),
        )

    # Fall back: state-only for unresearched FIPS present in counties list
    states = data["states"]
    for c in data["counties"]:
        if c["fips"] != fips:
            continue
        st = states.get(c["state"])
        if not st:
            break
        return AtlasResult(
            fips=fips,
            state=c["state"],
            county=c["name"],
            sale_type=_to_sale_type(st["type"]),
            type_label=st["type"],
            redemption=st["redemption"],
            returns=st["returns"],
            statute=st["statute"],
            notes=st["notes"],
            is_state_default=True,
            inherited=["type", "redemption", "returns", "statute", "notes"],
            as_of=None,
            sources=[],
        )

    raise KeyError(f"Unknown FIPS: {fips}")


def list_researched_fips() -> list[str]:
    return list(_load().get("researchedFips") or [])
