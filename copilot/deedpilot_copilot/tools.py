"""
Trusted tool surface for DeedPilot.

Import these callables from agents, notebooks, tests, and HTTP adapters.
The LLM must never invent max_bid or county statute facts — only *use* these.

Example
-------
>>> from deedpilot_copilot import lookup_atlas, compute_maxbid, DealInputs
>>> atlas = lookup_atlas("48201")
>>> deal = compute_maxbid(DealInputs(
...     state="TX",
...     sale_type="Redeemable Deed",
...     assessed_value=200_000,
...     rehab_cost=20_000,
...     opening_bid=10_000,
... ))
>>> deal.max_bid, deal.recommendation
"""

from __future__ import annotations

from typing import Any

from .atlas import (
    atlas_meta,
    list_researched_fips,
    lookup_atlas,
    lookup_atlas_by_name,
    reload_atlas,
    resolve_atlas,
)
from .maxbid import compute_maxbid
from .policy import check_url_policy
from .schemas import AtlasResult, DealInputs, DealResult, SaleType

__all__ = [
    "TOOL_CATALOG",
    "atlas_meta",
    "check_url_policy",
    "compute_maxbid",
    "list_researched_fips",
    "lookup_atlas",
    "lookup_atlas_by_name",
    "reload_atlas",
    "resolve_atlas",
    "tool_envelope_atlas",
    "tool_envelope_maxbid",
    "AtlasResult",
    "DealInputs",
    "DealResult",
    "SaleType",
]


TOOL_CATALOG: list[dict[str, Any]] = [
    {
        "name": "lookup_atlas",
        "trusted": True,
        "description": (
            "Resolve county tax-sale rules by FIPS or state+county. "
            "Returns sale type, redemption, statute, inheritance, asOf, sources."
        ),
        "python": "lookup_atlas(fips) | resolve_atlas(fips=...) | resolve_atlas(state=..., county=...)",
        "http": [
            "GET /tools/atlas?fips=48201",
            "GET /tools/atlas?state=TX&county=harris",
            "GET /tools/lookup_atlas?fips=48201",
        ],
        "must_cite": ["as_of", "sources", "inherited", "is_state_default"],
    },
    {
        "name": "compute_maxbid",
        "trusted": True,
        "oracle": True,
        "description": (
            "Deterministic walk-away price from statute costs + ARV. "
            "Never override max_bid with model arithmetic."
        ),
        "python": "compute_maxbid(DealInputs(...))",
        "http": [
            "POST /tools/maxbid",
            "POST /tools/compute_maxbid",
        ],
        "body": {
            "state": "TX",
            "saleType": "Redeemable Deed",
            "assessedValue": 200000,
            "rehabCost": 20000,
            "openingBid": 10000,
        },
    },
    {
        "name": "check_policy",
        "trusted": True,
        "description": "Ingest / web tool host gate (allow, delay, block).",
        "python": "check_url_policy(url)",
        "http": ["GET /tools/check_policy?url=https://..."],
    },
]


def tool_envelope_atlas(result: AtlasResult) -> dict[str, Any]:
    """Stable HTTP/agent envelope for atlas (snake + camel-friendly dump)."""
    payload = result.model_dump(by_alias=True)
    return {
        "tool": "lookup_atlas",
        "trusted": True,
        "mustCite": result.must_cite,
        "asOf": result.as_of,
        "sources": result.sources,
        "result": payload,
        "provenance": {
            "isStateDefault": result.is_state_default,
            "inherited": result.inherited,
            "fips": result.fips,
            "state": result.state,
            "county": result.county,
        },
    }


def tool_envelope_maxbid(result: DealResult, inputs: DealInputs | None = None) -> dict[str, Any]:
    """Stable HTTP/agent envelope for maxbid oracle."""
    return {
        "tool": "compute_maxbid",
        "trusted": True,
        "oracle": True,
        "note": "Deterministic. Never override maxBid with model-generated numbers.",
        "inputs": inputs.model_dump(by_alias=True) if inputs is not None else None,
        "result": result.model_dump(by_alias=True),
    }
