"""
DeedPilot's capabilities, exposed over the Model Context Protocol.

Four servers rather than one, split along the line that matters: what each one
is allowed to assert.

    atlas      county rules. Reads a frozen, version-controlled file.
    pricing    the max-bid engine. Deterministic; the only source of a ceiling.
    inventory  observed sales and parcels. Reads the database.
    intel      what physically surrounds a parcel. Never returns a dollar.

The split is not cosmetic. Each server is separately deployable and separately
permissioned, so a read-only public assistant can be given `atlas` alone, while
only an authenticated session gets `inventory`. Collapsing them into one server
would make that an application-layer decision instead of an infrastructure one,
and application-layer access control is the kind that gets bypassed.

Every server here is a thin adapter. The logic lives in `deedpilot.domain` and
`deedpilot.data`, is unit-tested without MCP in the loop, and is reachable the
same way from the HTTP API -- so a tool and an endpoint cannot drift into
disagreeing about the same question.
"""

from __future__ import annotations

from typing import Any, Literal

from mcp.server.fastmcp import FastMCP

from deedpilot.data.repositories import inventory as inventory_repo
from deedpilot.domain import DealInputs, compute_maxbid
from deedpilot.domain.atlas import atlas, lookup_county, resolve_fips, search_counties, state_rule
from deedpilot.domain.deal import statute as statute_mod

# ---------------------------------------------------------------------------
# Atlas
# ---------------------------------------------------------------------------

atlas_server = FastMCP(
    "deedpilot-atlas",
    instructions=(
        "Tax-sale rules for all 3,142 U.S. counties. Every answer states whether it is "
        "county-level research or a state default -- pass that distinction on to the user "
        "verbatim rather than summarising it away."
    ),
)


@atlas_server.tool()
def get_county_rules(fips: str) -> dict[str, Any]:
    """
    Tax-sale rules for one county, by 5-digit FIPS code.

    Returns the sale type, redemption window, investor return, governing
    statute, auction logistics and county contacts -- plus `provenance`, which
    says whether this county was researched individually or is showing its
    state's defaults. Always relay `provenance` to the user.
    """
    county = lookup_county(fips)
    if county is None:
        return {"found": False, "error": f"No county with FIPS {fips!r}."}
    data = county.model_dump(mode="json")
    data["found"] = True
    data["provenance"] = county.provenance_note()
    return data


@atlas_server.tool()
def find_county(name: str, state: str) -> dict[str, Any]:
    """
    Resolve a county name to its FIPS code.

    Refuses rather than guesses. If a state has two entities sharing a name
    (Baltimore County and Baltimore city are different governments running
    different sales), this returns `ambiguous` with both candidates -- ask the
    user which they mean instead of picking one.
    """
    result = resolve_fips(name, state)
    if result.ok:
        return {
            "resolved": True,
            "fips": result.fips,
            "county": result.county.display_name,
            "matched_on": result.matched_on,
        }
    return {
        "resolved": False,
        "reason": result.reason,
        "detail": result.detail,
        "candidates": [
            {"fips": c.fips, "name": c.display_name} for c in result.candidates
        ],
    }


@atlas_server.tool()
def search_county_names(query: str, state: str | None = None, limit: int = 10) -> list[dict[str, str]]:
    """Free-text county search, for when the user's phrasing is loose."""
    return [
        {"fips": c.fips, "name": c.display_name, "sale_type": str(c.sale_type)}
        for c in search_counties(query, state=state, limit=limit)
    ]


@atlas_server.tool()
def get_state_rules(state: str) -> dict[str, Any]:
    """State-level tax-sale defaults: sale type, redemption, returns, statute."""
    rule = state_rule(state)
    if rule is None:
        return {"found": False, "error": f"No state rules on file for {state!r}."}
    counties = atlas().in_state(state)
    return {
        "found": True,
        "state": state.strip().upper(),
        **rule,
        "county_count": len(counties),
        "researched_counties": sum(1 for c in counties if not c.is_state_default),
    }


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------

pricing_server = FastMCP(
    "deedpilot-pricing",
    instructions=(
        "The deterministic max-bid engine. This is the ONLY source of a walk-away price. "
        "Never state a bid ceiling, projected profit or cost figure that did not come from "
        "`compute_max_bid` -- if you do not have a tool result, say you cannot price it yet."
    ),
)


@pricing_server.tool()
def compute_max_bid(
    state: str,
    sale_type: Literal["Tax Lien", "Tax Deed", "Redeemable Deed", "Hybrid"],
    fips: str | None = None,
    opening_bid: float | None = None,
    assessed_value: float | None = None,
    market_value: float | None = None,
    arv_override: float | None = None,
    rehab_cost: float | None = None,
    target_margin: float | None = None,
    holding_months: int | None = None,
    surviving_liens: float | None = None,
) -> dict[str, Any]:
    """
    Compute the highest defensible bid on a parcel.

    Deterministic arithmetic over statutory parameters -- not an estimate and
    not a model output. Returns the ceiling, the full cost stack with a note on
    each line saying where the number came from, the redemption outlook, and
    warnings.

    `recommendation` is one of `bid`, `no-bid` or `insufficient-data`. Treat
    `insufficient-data` as a real answer: it means the inputs cannot support a
    price, and the fix is named in `warnings`. Do not fill the gap yourself.

    Read `arv.assumed` before you speak. When it is true the valuation is a
    statistical floor from the opening bid, not a valuation of this parcel, and
    every downstream figure inherits that uncertainty -- say so out loud.
    """
    result = compute_maxbid(
        DealInputs(
            state=state,
            sale_type=sale_type,  # type: ignore[arg-type]
            fips=fips,
            opening_bid=opening_bid,
            assessed_value=assessed_value,
            market_value=market_value,
            arv_override=arv_override,
            rehab_cost=rehab_cost,
            target_margin=target_margin,
            holding_months=holding_months,
            surviving_liens=surviving_liens,
        )
    )
    payload = result.model_dump(mode="json")
    payload["staleness_months"] = statute_mod.staleness_months(state)
    return payload


@pricing_server.tool()
def get_statutory_parameters(state: str) -> dict[str, Any]:
    """
    Machine-readable statutory parameters: redemption tiers, quiet-title cost
    and duration, closing costs, assessment ratio, citation and check date.

    Returns `covered: false` for states nobody has researched yet. That is not
    a lookup failure -- it means no verified figures exist, and quoting a
    redemption rate for such a state would be inventing law.
    """
    params = statute_mod.statute_for(state)
    if params is None:
        return {
            "covered": False,
            "state": state.strip().upper(),
            "covered_states": statute_mod.covered_states(),
            "note": (
                f"{state.strip().upper()} has no verified statutory parameters on file. The "
                f"prose rules in the atlas still apply, but no arithmetic can be done from them."
            ),
        }
    return {
        "covered": True,
        **params,
        "staleness_months": statute_mod.staleness_months(state),
    }


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

inventory_server = FastMCP(
    "deedpilot-inventory",
    instructions=(
        "Observed auctions and parcels. Everything returned here is real inventory unless it "
        "says otherwise: a parcel off a delinquent roll is not for sale, and the tool tells you "
        "so in `not_inventory_because`. Never present a non-inventory parcel as biddable."
    ),
)


@inventory_server.tool()
async def get_inventory_summary() -> dict[str, Any]:
    """
    What DeedPilot currently tracks: biddable lots, auctions, states, counties,
    the next sale date, and a breakdown of parcels deliberately excluded.

    Use the excluded breakdown when a user asks why a number looks smaller than
    they expected. Counties publish delinquent rolls that look exactly like
    sale lists and are 10-50x larger; counting those would inflate the headline
    and mislead the user about what they can actually bid on.
    """
    stats = await inventory_repo.inventory_stats()
    return {
        "biddable_lots": stats.biddable_lots,
        "biddable_auctions": stats.biddable_auctions,
        "states": stats.states,
        "counties": stats.counties,
        "next_sale_date": stats.next_sale_date.isoformat() if stats.next_sale_date else None,
        "excluded_from_inventory": stats.excluded_by_kind,
        "note": (
            "Only confirmed sale lists count as inventory. Delinquent rolls, lands-available "
            "inventory, and sales whose date we projected rather than read from the county are "
            "excluded and reported separately."
        ),
    }


@inventory_server.tool()
async def find_upcoming_auctions(
    state: str | None = None,
    county_fips: str | None = None,
    within_days: int | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """
    Upcoming tax sales, soonest first.

    Includes registration and deposit deadlines where the county published
    them. Those deadlines are the most common way a first-time bidder loses a
    sale before it starts -- surface them unprompted.
    """
    return await inventory_repo.upcoming_auctions(
        state=state, county_fips=county_fips, within_days=within_days, limit=limit
    )


@inventory_server.tool()
async def search_parcels(
    state: str | None = None,
    county_fips: str | None = None,
    max_opening_bid: float | None = None,
    min_assessed_value: float | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """
    Search parcels in upcoming sales, highest assessed value first.

    Returns summaries only. Call `get_parcel` before discussing any specific
    parcel in depth -- the summary omits valuations and site signals, and site
    signals are where the deal-breakers live.
    """
    return await inventory_repo.search_lots(
        state=state,
        county_fips=county_fips,
        max_opening_bid=max_opening_bid,
        min_assessed_value=min_assessed_value,
        limit=limit,
    )


@inventory_server.tool()
async def get_parcel(lot_id: str) -> dict[str, Any]:
    """
    Everything observed about one parcel: listing details, every valuation on
    file, and the site signals, worst news first.

    `is_biddable_inventory` is false for parcels held but not for sale; when it
    is, `not_inventory_because` explains why in plain language. Say that out
    loud rather than quietly treating the parcel as biddable.
    """
    lot = await inventory_repo.get_lot(lot_id)
    if lot is None:
        return {"found": False, "error": f"No parcel with id {lot_id!r}."}
    return {"found": True, **lot}


@inventory_server.tool()
async def get_best_valuation(lot_id: str) -> dict[str, Any]:
    """
    The valuation the pricing engine should use for a parcel, and why that one.

    Feed `market_value` (preferred) or `assessed_total` into `compute_max_bid`.
    Passing the wrong one changes the ceiling substantially: an assessed figure
    still needs to be divided by the state's assessment ratio, and a market
    figure must not be.
    """
    val = await inventory_repo.best_valuation(lot_id)
    if val is None:
        return {
            "found": False,
            "note": (
                "No valuation on file for this parcel. The pricing engine will fall back to a "
                "statistical floor from the opening bid, which is a research starting point and "
                "not a valuation — tell the user that plainly."
            ),
        }
    return {"found": True, **val}


# ---------------------------------------------------------------------------
# Site intel
# ---------------------------------------------------------------------------

intel_server = FastMCP(
    "deedpilot-intel",
    instructions=(
        "What physically surrounds a parcel, from free public sources. This server never "
        "returns a dollar figure and never prices anything -- proximity is reported, and the "
        "pricing server remains the only thing that values a parcel."
    ),
)


@intel_server.tool()
async def get_site_signals(lot_id: str) -> dict[str, Any]:
    """
    Physical facts about a parcel's surroundings: rail lines, substations,
    transmission corridors, industrial neighbours, flood zone, slope, road
    access, tract vacancy.

    Returned worst-first. A tax notice says what is owed and an assessment says
    what the county thinks it is worth; neither says the parcel has no road
    touching it, which is how people buy something they cannot resell.

    Every distance is measured to the feature's real geometry and carries its
    source, so the user can check it on a map in thirty seconds.
    """
    lot = await inventory_repo.get_lot(lot_id)
    if lot is None:
        return {"found": False, "error": f"No parcel with id {lot_id!r}."}

    signals = lot.get("signals", [])
    if not signals:
        located = lot.get("latitude") is not None
        return {
            "found": True,
            "lot_id": lot_id,
            "signals": [],
            "note": (
                "No site intel gathered for this parcel yet — that is an absence of data, not "
                "an absence of hazards."
                if located
                else "This parcel has no coordinates on file, so no site intel could be gathered. "
                "Absence of signals here means nothing was looked at."
            ),
        }

    blockers = [
        s for s in signals if s["direction"] == "negative" and s["severity"] == "high"
    ]
    return {
        "found": True,
        "lot_id": lot_id,
        "address": lot.get("address"),
        "signal_count": len(signals),
        "high_severity_negative": blockers,
        "signals": signals,
        "note": (
            "No signal here produces a dollar figure. These are physical facts to verify, not "
            "an adjustment to any price."
        ),
    }


ALL_SERVERS: dict[str, FastMCP] = {
    "atlas": atlas_server,
    "pricing": pricing_server,
    "inventory": inventory_server,
    "intel": intel_server,
}
