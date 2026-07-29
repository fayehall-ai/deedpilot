"""
Trusted tool: lookup_atlas

Loads atlas_export.json produced by scripts/export-atlas-for-copilot.ts.
Agent MUST cite asOf / as_of, sources, inherited, and is_state_default.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .schemas import AtlasResult, SaleType

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "atlas_export.json"

# Fields the agent must surface when using atlas claims in rationale.
MUST_CITE = ["as_of", "sources", "inherited", "is_state_default"]


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    if not DATA_PATH.exists():
        raise FileNotFoundError(
            f"Missing {DATA_PATH}. Run: npx tsx scripts/export-atlas-for-copilot.ts"
        )
    return json.loads(DATA_PATH.read_text())


def reload_atlas() -> None:
    """Drop the in-process cache (after re-exporting atlas JSON)."""
    _load.cache_clear()


def _slug(text: str) -> str:
    s = text.strip().lower()
    s = re.sub(r"['’]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


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


def _from_resolved_rule(rule: dict[str, Any], fips: str) -> AtlasResult:
    county = rule["county"]
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
        must_cite=list(MUST_CITE),
    )


def _state_default_for_county(c: dict[str, Any], states: dict[str, Any]) -> AtlasResult | None:
    st = states.get(c["state"])
    if not st:
        return None
    return AtlasResult(
        fips=c["fips"],
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
        must_cite=list(MUST_CITE),
    )


def lookup_atlas(fips: str) -> AtlasResult:
    """
    Resolve county rules by FIPS (SSCCC), with inheritance flags + provenance.

    Raises
    ------
    KeyError
        Unknown FIPS.
    FileNotFoundError
        atlas_export.json missing — re-export from the TS atlas.
    """
    data = _load()
    fips = fips.strip()

    for rule in data["resolvedRules"]:
        if rule["county"]["fips"] == fips:
            return _from_resolved_rule(rule, fips)

    # Fall back: state-only for unresearched FIPS present in counties list
    for c in data["counties"]:
        if c["fips"] != fips:
            continue
        result = _state_default_for_county(c, data["states"])
        if result:
            return result
        break

    raise KeyError(f"Unknown FIPS: {fips}")


def lookup_atlas_by_name(state: str, county: str) -> AtlasResult:
    """
    Resolve by USPS state code + county name or slug (e.g. 'CA', 'los-angeles').

    Matches Next.js GET /api/tools/atlas?state=&county=.
    """
    data = _load()
    state = state.strip().upper()
    county_slug = _slug(county)
    if not state or not county_slug:
        raise KeyError("state and county are required")

    # Prefer researched / resolved rules
    for rule in data["resolvedRules"]:
        c = rule["county"]
        if c["state"] != state:
            continue
        if _slug(c["name"]) == county_slug or c["name"].lower() == county.strip().lower():
            return _from_resolved_rule(rule, c["fips"])

    for c in data["counties"]:
        if c["state"] != state:
            continue
        if _slug(c["name"]) == county_slug or c["name"].lower() == county.strip().lower():
            result = _state_default_for_county(c, data["states"])
            if result:
                return result

    raise KeyError(f"Unknown county: {state} / {county}")


def resolve_atlas(
    *,
    fips: str | None = None,
    state: str | None = None,
    county: str | None = None,
) -> AtlasResult:
    """
    Unified resolver used by HTTP and agents.

    Provide either ``fips`` or both ``state`` and ``county``.
    """
    if fips:
        return lookup_atlas(fips)
    if state and county:
        return lookup_atlas_by_name(state, county)
    raise ValueError("Provide fips=SSCCC or state= + county=")


def list_researched_fips() -> list[str]:
    return list(_load().get("researchedFips") or [])


def atlas_meta() -> dict[str, Any]:
    """Lightweight export metadata (no full county payload)."""
    data = _load()
    return {
        "exported_at": data.get("exportedAt"),
        "version": data.get("version"),
        "n_resolved_rules": len(data.get("resolvedRules") or []),
        "n_counties": len(data.get("counties") or []),
        "n_researched_fips": len(data.get("researchedFips") or []),
        "data_path": str(DATA_PATH),
    }
