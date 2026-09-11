"""
Native coaching tools.

These are the difference between a coach and a search box. Each one encodes
something an experienced buyer does automatically and a first-timer does not do
at all -- and each is deterministic, so the advice is the same on a bad day as
on a good one and can be tested.

`bid_discipline_check` is the one that earns its place. It is the moment in the
room where somebody decides to go one more increment, and it answers with
arithmetic instead of encouragement.
"""

from __future__ import annotations

from typing import Any, Literal

from strands import tool

from deedpilot.data.repositories import inventory as inventory_repo
from deedpilot.domain.atlas import lookup_county
from deedpilot.domain.deal import statute as statute_mod


@tool
async def pre_auction_checklist(lot_id: str | None = None, county_fips: str | None = None) -> dict[str, Any]:
    """
    The things that must be true before a first-time bidder raises a paddle.

    Returns a checklist tailored to the county and, when a parcel is given, to
    that parcel — including which items this system can already answer and
    which the user has to do themselves.

    Use this early with any novice. Most people who lose money at a tax sale
    did not misprice the parcel; they skipped one of these.
    """
    fips = county_fips
    parcel: dict[str, Any] | None = None

    if lot_id:
        parcel = await inventory_repo.get_lot(lot_id)
        if parcel is None:
            return {"error": f"No parcel with id {lot_id!r}."}
        fips = parcel["county_fips"]

    county = lookup_county(fips) if fips else None
    statute = statute_mod.statute_for(county.state) if county else None

    items: list[dict[str, Any]] = [
        {
            "step": "Register and fund before the deadline",
            "why": (
                "The most common way a first sale is lost. Registration and deposit windows "
                "close days before the auction, and a wire that lands the morning of is late."
            ),
            "who": "you",
            "status": "not_checked",
        },
        {
            "step": "Know what you are buying",
            "why": (
                f"{county.state_name} runs this as a {county.sale_type}. "
                f"{county.redemption}"
                if county
                else "Confirm whether your state sells liens or deeds. They are different assets."
            ),
            "who": "deedpilot",
            "status": "answered" if county else "not_checked",
        },
        {
            "step": "Confirm the parcel is actually in the sale",
            "why": (
                "Counties publish delinquent rolls and lands-available lists from the same page "
                "in the same format. Only a confirmed sale list is something to bid on."
            ),
            "who": "deedpilot",
            "status": (
                ("answered" if parcel.get("is_biddable_inventory") else "blocked")
                if parcel
                else "not_checked"
            ),
            "detail": (parcel or {}).get("not_inventory_because"),
        },
        {
            "step": "Check access and usability before value",
            "why": (
                "No road frontage, floodway, or unbuildable slope ends the deal regardless of "
                "price. Pricing a landlocked parcel is wasted diligence."
            ),
            "who": "deedpilot",
            "status": "answered" if parcel and parcel.get("signals") else "not_checked",
        },
        {
            "step": "Look at it, or have someone look at it",
            "why": (
                "You cannot inspect the inside, but you can see the roof, the lot, and the "
                "neighbours. A photo from the street has killed more bad buys than any model."
            ),
            "who": "you",
            "status": "not_checked",
        },
        {
            "step": "Search the title for what survives",
            "why": (
                statute["caveats"][0]
                if statute and statute.get("caveats")
                else "Municipal liens, special assessments and federal tax liens can survive a "
                "tax sale. Which ones is jurisdiction-specific."
            ),
            "who": "you",
            "status": "not_checked",
        },
        {
            "step": "Budget for clear title",
            "why": (
                f"A quiet title action in {county.state_name} typically runs "
                f"${statute['quietTitle']['typicalLow']:,}–${statute['quietTitle']['typicalHigh']:,} "
                f"over about {statute['quietTitle']['typicalMonths']} months. No title insurer "
                f"will write a policy until it completes."
                if statute
                else "Most tax deeds are uninsurable until a quiet title action completes. Price "
                "that in before you bid, not after."
            ),
            "who": "deedpilot",
            "status": "answered" if statute else "not_checked",
        },
        {
            "step": "Write down your walk-away price",
            "why": (
                "Decide it before the auction, while you are calm, and treat it as a hard stop. "
                "The whole point of computing a ceiling is that you do not renegotiate it in the "
                "room."
            ),
            "who": "both",
            "status": "not_checked",
        },
        {
            "step": "Know your exit",
            "why": (
                "Wholesale, rehab and hold, or resell as-is — each implies a different rehab "
                "budget and a different holding period, and those change the ceiling."
            ),
            "who": "you",
            "status": "not_checked",
        },
    ]

    return {
        "county": county.display_name if county else None,
        "sale_type": str(county.sale_type) if county else None,
        "parcel": parcel["address"] if parcel else None,
        "items": items,
        "coaching_note": (
            "Walk these in order and stop at the first one that fails. Items marked "
            "`who: deedpilot` I can answer now; items marked `you` need you to do something "
            "outside this conversation."
        ),
    }


@tool
def explain_sale_type(
    sale_type: Literal["Tax Lien", "Tax Deed", "Redeemable Deed", "Hybrid"],
    state: str,
) -> dict[str, Any]:
    """
    What the buyer actually receives, in plain language, for a given state.

    The single most consequential thing a novice gets wrong: a tax lien is not
    ownership, and a redeemable deed is ownership that can be undone. Use this
    the first time a sale type comes up, before any parcel or price.

    `state` is required. Without it this returns only the generic shape of the
    instrument, and a generic answer read as a state-specific one is worse than
    no answer — pass the two-letter state code every time.
    """
    explanations: dict[str, dict[str, str]] = {
        "Tax Lien": {
            "what_you_get": (
                "A certificate, not a property. You have paid someone else's taxes and are owed "
                "that money back with interest."
            ),
            "expected_outcome": (
                "Redemption. The owner pays and you collect interest. Most liens redeem — taking "
                "title is the unusual outcome, not the plan."
            ),
            "how_you_lose": (
                "Assuming you are buying a house. You are buying a debt, and if you want the "
                "property you have to foreclose separately, at your own cost, after the "
                "redemption period."
            ),
            "watch_for": (
                "Auctions where bidders compete by lowering the interest rate rather than raising "
                "the price. The statutory rate is a ceiling, not what you will earn."
            ),
        },
        "Tax Deed": {
            "what_you_get": (
                "The deed. You own it when the sale is confirmed and the deed is recorded."
            ),
            "expected_outcome": (
                "Ownership, immediately or close to it. This is the closest thing to buying a "
                "property at auction."
            ),
            "how_you_lose": (
                "Title, not ownership. A tax deed is usually uninsurable until a quiet title "
                "action clears it, so you own something you cannot easily sell or finance for "
                "months."
            ),
            "watch_for": (
                "What survives the sale. Some liens do — municipal code enforcement, special "
                "assessments, federal tax liens — and they follow the property to you."
            ),
        },
        "Redeemable Deed": {
            "what_you_get": (
                "The deed, subject to the former owner's right to buy it back within a set "
                "window by paying you a statutory penalty."
            ),
            "expected_outcome": (
                "Either a penalty return if they redeem, or the property if they do not. You "
                "have to be content with both, because you do not control which happens."
            ),
            "how_you_lose": (
                "Spending money on a property that gets redeemed out from under you. Do not "
                "renovate during the redemption period."
            ),
            "watch_for": (
                "The penalty is flat, not annual. A 25% penalty is 25% whether they redeem on "
                "day 3 or day 179 — annualising it produces a headline yield that is only true "
                "if they redeem on the last possible day."
            ),
        },
        "Hybrid": {
            "what_you_get": (
                "Depends on the county. Hybrid systems mix lien assignment with judicial "
                "foreclosure, and the mechanics differ within a single state."
            ),
            "expected_outcome": "County-specific. Do not generalise from a neighbouring county.",
            "how_you_lose": (
                "Applying another county's process. In hybrid states the procedural detail is "
                "where the money is, and it is not uniform."
            ),
            "watch_for": "Call the county. This is the case where the phone beats the website.",
        },
    }

    code = state.strip().upper()
    params = statute_mod.statute_for(code)
    payload: dict[str, Any] = {
        "sale_type": sale_type,
        "state": code,
        **explanations[sale_type],
    }

    if params:
        redemption = params.get("redemption") or {}
        tiers = redemption.get("tiers") or []
        payload["statutory_parameters_available"] = True
        payload["statutory_citation"] = params.get("statute")
        payload["verified_as_of"] = params.get("asOf")
        payload["sources"] = params.get("sources", [])
        payload["caveats"] = params.get("caveats", [])
        if tiers:
            payload["redemption_window_days"] = redemption.get("maxDays")
            payload["first_tier_penalty"] = tiers[0].get("penalty")
            payload["extended_for"] = redemption.get("extendedFor")
        # Stated affirmatively so the model cannot conclude the opposite. On
        # the first live conversation the coach told a Texas user that no
        # verified parameters existed for Texas -- they do -- because the tool
        # had been called without a state and returned nothing to contradict
        # the guess. A tool that is silent about what it knows invites the
        # model to fill in the silence.
        payload["note"] = (
            f"Verified statutory parameters ARE on file for {code} (checked "
            f"{params.get('asOf')}). Do not tell the user otherwise. Call "
            f"`get_statutory_parameters('{code}')` for the full figures, or `compute_max_bid` "
            f"to price a specific parcel."
        )
    else:
        payload["statutory_parameters_available"] = False
        payload["covered_states"] = statute_mod.covered_states()
        payload["note"] = (
            f"No verified statutory parameters on file for {code}. The general explanation "
            f"above holds and the atlas still has the prose rules — call `get_state_rules"
            f"('{code}')` for those — but no arithmetic can be done for this state, and the "
            f"specific redemption figures must not be guessed from a neighbouring state."
        )
    return payload


@tool
def bid_discipline_check(
    intended_bid: float,
    max_bid: float,
    opening_bid: float | None = None,
) -> dict[str, Any]:
    """
    Compare a bid the user is considering against the ceiling the engine
    computed, and say plainly what going ahead would cost.

    Call this whenever a user asks whether to bid higher, mentions a number
    above their ceiling, or says anything like "just one more". Both figures
    must come from elsewhere: `max_bid` from `compute_max_bid`, `intended_bid`
    from the user. This tool does arithmetic on them — it does not originate
    either.

    Returns the overage in dollars and as a share of the ceiling, and the
    verdict. The verdict is deliberately blunt: this is the moment discipline
    is either kept or lost, and hedged language is what loses it.
    """
    overage = round(intended_bid - max_bid, 2)
    within = overage <= 0

    if within:
        headroom = abs(overage)
        return {
            "within_ceiling": True,
            "headroom": headroom,
            "verdict": "clear",
            "coaching": (
                f"That is inside your ceiling with ${headroom:,.0f} to spare. The ceiling is the "
                f"constraint, not a target — there is no prize for bidding all of it."
            ),
        }

    over_pct = (overage / max_bid * 100) if max_bid > 0 else float("inf")
    profit_note = (
        f"Every dollar above ${max_bid:,.0f} comes straight out of your margin, not out of a "
        f"buffer. At ${intended_bid:,.0f} you are ${overage:,.0f} into it."
    )

    return {
        "within_ceiling": False,
        "overage": overage,
        "overage_pct_of_ceiling": round(over_pct, 1),
        "verdict": "stop",
        "coaching": (
            f"Stop. Your ceiling was ${max_bid:,.0f} and you are talking about ${intended_bid:,.0f}. "
            f"{profit_note} You worked that ceiling out when you were calm and nobody was bidding "
            f"against you; nothing has changed about the property since then, only the room. "
            f"Let it go — there is another sale."
        ),
        "if_you_disagree_with_the_ceiling": (
            "The honest way to raise it is to change an input and recompute: better comps, a "
            "lower rehab estimate, a longer hold you can actually finance. Re-run "
            "`compute_max_bid` with the new figure. Deciding the number is wrong because you "
            "want the parcel is not a recomputation."
        ),
    }
