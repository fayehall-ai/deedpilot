"""
The coach's toolset.

Two kinds. The domain tools are the same functions `deedpilot.mcp.servers`
exposes over MCP, imported directly -- one definition, two transports, so an
MCP client and the in-process coach cannot disagree about what a tool does.
The coaching tools below are native: they exist to make the coach a coach
rather than a query interface.
"""

from __future__ import annotations

from strands import tool

from deedpilot.mcp.servers import (
    compute_max_bid,
    find_county,
    find_upcoming_auctions,
    get_best_valuation,
    get_county_rules,
    get_inventory_summary,
    get_parcel,
    get_site_signals,
    get_state_rules,
    get_statutory_parameters,
    search_county_names,
    search_parcels,
)

from .coaching import (
    bid_discipline_check,
    explain_sale_type,
    pre_auction_checklist,
)

#: Domain tools, unwrapped from their MCP registration back to plain callables.
#:
#: `FastMCP.tool()` returns the original function, so these are the same
#: objects the servers registered -- `@tool` below re-wraps them for Strands
#: without redefining a single line of behaviour.
_DOMAIN_FUNCTIONS = (
    get_county_rules,
    find_county,
    search_county_names,
    get_state_rules,
    compute_max_bid,
    get_statutory_parameters,
    get_inventory_summary,
    find_upcoming_auctions,
    search_parcels,
    get_parcel,
    get_best_valuation,
    get_site_signals,
)

COACH_TOOLS = [
    *(tool(fn) for fn in _DOMAIN_FUNCTIONS),
    pre_auction_checklist,
    explain_sale_type,
    bid_discipline_check,
]

__all__ = ["COACH_TOOLS"]
