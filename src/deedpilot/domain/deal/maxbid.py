"""
Max-bid engine.

This is deterministic arithmetic, deliberately kept out of the language model.
The agent writes the narrative around these numbers; it never produces the
walk-away price. Someone is going to raise a paddle based on this output, so
every figure is traceable to an input or a cited statute, and anything we do
not know is reported as unknown rather than defaulted to a flattering value.

The model, in one line::

    max_bid = ARV*(1 - margin) - selling_costs - rehab - title - closing
              - holding - surviving_liens

i.e. the highest bid that still clears your target margin after every cost of
turning a tax-sale parcel into resaleable, insurable property.

Ported from the TypeScript original at `lib/deal/maxbid.ts`, and held to it by
`tests/test_maxbid_parity.py`, which runs both implementations over a shared
case table and asserts the figures match to the cent.
"""

from __future__ import annotations

from typing import Any

from deedpilot.domain.models import (
    ArvBasis,
    BidDownObservation,
    Confidence,
    CostLine,
    DealInputs,
    DealResult,
    Recommendation,
    RedemptionOutlook,
)

from .statute import floor_ratio_for, floor_ratios_as_of, statute_for

DEFAULT_TARGET_MARGIN = 0.30
DEFAULT_SELLING_COST_RATE = 0.08
#: Taxes, insurance, utilities, securing the property -- per month, of ARV.
MONTHLY_HOLDING_RATE = 0.0015
MIN_MONTHLY_HOLDING = 75.0


def _js_round(n: float) -> int:
    """
    Round half away from zero at .5, the way JavaScript's `Math.round` does.

    Not a stylistic detail. Python's built-in `round` is banker's rounding --
    it breaks ties toward the even integer, so `round(412.5)` is 412 while
    `Math.round(412.5)` is 413. Every cost line, every max bid and every
    holding figure passes through a rounding step, so using the built-in would
    have silently moved money by a cent, in one direction, on exactly the
    inputs that land on a half. The parity suite caught it on a holding-cost
    note; the same tie could have landed on a walk-away price.

    `floor(n + 0.5)` reproduces `Math.round` over the range money occupies.
    """
    from math import floor

    return floor(n + 0.5)


def _round2(n: float) -> float:
    """Round to cents the way the TypeScript engine does, so parity holds."""
    return _js_round(n * 100) / 100


def _money(n: float) -> str:
    """
    `$1,234` -- whole dollars, grouped.

    Mirrors the TypeScript's `toLocaleString("en-US", {style: "currency",
    currency: "USD", maximumFractionDigits: 0})`, used wherever a figure is
    quoted as an amount of money in prose.
    """
    return f"${n:,.0f}"


def _plain(n: float) -> str:
    """
    `1,234.6` -- grouped, up to three decimals, trailing zeros dropped.

    Mirrors JavaScript's *bare* `Number.prototype.toLocaleString()`, which is a
    different format from `_money` above: it keeps up to three fraction digits
    rather than rounding to whole dollars. The original used both, and the two
    sites are not interchangeable -- a ceiling of $2,824.60 rendered through
    the money formatter reads as $2,825, which is a ceiling four dollars above
    the one the engine actually computed. At an auction that is the wrong
    direction to round.
    """
    text = f"{n:,.3f}".rstrip("0").rstrip(".")
    return text or "0"


def _floor_from(inputs: DealInputs) -> tuple[float, str] | None:
    """
    A last-resort floor from the opening bid, where the state has been measured.

    Tax-sale opening bids are taxes plus costs, so they carry *some* signal
    about value -- but only some. Across observed inventory the ratio runs 0.76
    at the 10th percentile to 24.20 at the 90th, and state medians differ from
    each other by 6x, so this is per-state or it is nothing. States without a
    measured entry get no floor at all rather than a national average that
    would be wrong in both directions at once.

    The conservative quartile is used, not the median. A floor exists to stop
    the page saying "not enough data" and to give research a starting
    magnitude; if it is going to be wrong, it should be wrong low, because the
    expensive direction at an auction is the optimistic one.
    """
    bid = inputs.opening_bid
    if bid is None or bid <= 0:
        return None
    ratio = floor_ratio_for(inputs.state)
    if not ratio:
        return None

    return (
        bid * ratio["p25"],
        (
            f"Assumed floor, not a valuation of this parcel. No assessed value, provider "
            f"estimate or comps were available, so this is the opening bid of {_money(bid)} "
            f"times {ratio['p25']} — the conservative quartile of the value-to-opening-bid "
            f"ratio across {ratio['n']:,} {inputs.state} parcels where both figures are known "
            f"(measured {floor_ratios_as_of()}). The middle half of those parcels ran "
            f"{ratio['p25']}x to {ratio['p75']}x, so the true figure could plausibly be "
            f"{_money(bid * ratio['p75'])}. Treat this as a starting magnitude for research, "
            f"never as a reason to bid — enter real comps before you do."
        ),
    )


def _derive_arv(inputs: DealInputs, statute: dict[str, Any] | None) -> ArvBasis:
    """
    Establish the after-repair value, in strict order of trustworthiness.

    comps > provider market estimate > assessed / ratio > measured floor > none.
    Guessing an ARV is how a bidder ends up 3x over market, so the bottom of
    that ladder is None and not a national average.
    """
    if inputs.arv_override is not None and inputs.arv_override > 0:
        return ArvBasis(
            value=inputs.arv_override,
            basis="Your comparable-sales estimate.",
            derived=False,
        )

    # A provider's market estimate, ahead of the assessed-value derivation. It
    # is an *as-is* market figure, not an after-repair one, and the basis says
    # so -- a tax-sale parcel is rarely in the condition an AVM assumes, and
    # treating the two as identical is how a max bid comes out optimistic. It
    # is still a better input than assessed / ratio, which is the same guess
    # with an extra division in front of it, and it is the only one available
    # at all in states with no statutory ratio.
    if inputs.market_value is not None and inputs.market_value > 0:
        return ArvBasis(
            value=inputs.market_value,
            from_market=True,
            derived=True,
            basis=(
                f"Provider market estimate of {_money(inputs.market_value)}. This is an as-is "
                f"valuation, not an after-repair one — enter your own comparable-sales figure "
                f"if the property needs work."
            ),
        )

    if inputs.assessed_value is None or inputs.assessed_value <= 0:
        floor = _floor_from(inputs)
        return ArvBasis(
            value=floor[0] if floor else None,
            basis=(
                floor[1]
                if floor
                else (
                    "The county published no assessed value for this parcel, no property "
                    "provider returned a market estimate, and no comparable-sales figure has "
                    "been entered."
                )
            ),
            derived=floor is not None,
            assumed=floor is not None,
        )

    if not statute:
        floor = _floor_from(inputs)
        return ArvBasis(
            value=floor[0] if floor else None,
            basis=(
                floor[1]
                if floor
                else (
                    f"This parcel has an assessed value, but {inputs.state} has no verified "
                    f"assessment ratio on file, so it cannot be converted to a market value. "
                    f"Enter a comparable-sales estimate to price it."
                )
            ),
            derived=True,
            assumed=floor is not None,
        )

    # A county override beats the state ratio. Cook County assesses residential
    # at 10% against Illinois' statutory 33-1/3%; using the state figure there
    # triples the implied market value of the largest block of parcels we hold.
    overrides = statute.get("countyAssessmentRatios") or {}
    override = overrides.get(inputs.fips) if inputs.fips else None
    ratio = override["ratio"] if override else statute["assessmentRatio"]
    basis = override["basis"] if override else statute["assessmentBasis"]

    return ArvBasis(
        value=inputs.assessed_value / ratio,
        basis=f"Assessed {_money(inputs.assessed_value)} ÷ {ratio} assessment ratio. {basis}",
        derived=True,
        county_override=override is not None,
    )


def compute_maxbid(inputs: DealInputs | dict[str, Any]) -> DealResult:
    """
    The walk-away price. Never LLM-generated, in any code path, ever.

    Accepts a `DealInputs` or a plain dict in either snake_case or camelCase,
    so the HTTP layer, the MCP tool and the ingestion pipeline all reach the
    same arithmetic without a translation step that could drift.
    """
    if not isinstance(inputs, DealInputs):
        inputs = DealInputs.model_validate(inputs)

    statute = statute_for(inputs.state)
    warnings: list[str] = []

    target_margin = (
        inputs.target_margin if inputs.target_margin is not None else DEFAULT_TARGET_MARGIN
    )
    selling_cost_rate = (
        inputs.selling_cost_rate
        if inputs.selling_cost_rate is not None
        else DEFAULT_SELLING_COST_RATE
    )
    arv = _derive_arv(inputs, statute)

    if not statute:
        # The covered states are deliberately not enumerated -- see the matching
        # note in lib/deal/maxbid.ts. Naming them made a bidder-facing string
        # change whenever an unrelated state was researched, and broke four
        # frozen golden cases on every addition.
        warnings.append(
            f"{inputs.state} is outside the states with verified statutory parameters. "
            f"Costs and redemption terms are not modelled — "
            f"treat any figure here as unverified."
        )

    if arv.value is None:
        # The basis carries the specific reason; this only says what to do
        # about it. "Not enough data" on its own reads as a defect in the
        # product rather than as a missing input the reader can supply in ten
        # seconds, and it does not distinguish a parcel nobody has valued from
        # a state whose assessment ratio has not been researched.
        return DealResult(
            max_bid=None,
            recommendation="insufficient-data",
            confidence="low",
            arv=arv,
            costs=[],
            total_costs=0.0,
            projected_profit=None,
            bid_room=None,
            redemption=None,
            statute=statute,
            warnings=[
                *warnings,
                f"{arv.basis} Enter a comparable-sales estimate and every figure recalculates — "
                f"the engine needs one number, not a full appraisal.",
            ],
        )

    # --- Costs -------------------------------------------------------------
    costs: list[CostLine] = [
        CostLine(
            label="Selling costs on exit",
            amount=_round2(arv.value * selling_cost_rate),
            note=(
                f"{selling_cost_rate * 100:.1f}% of ARV — agent commission plus seller-side "
                f"closing."
            ),
            assumed=inputs.selling_cost_rate is None,
        )
    ]

    rehab = inputs.rehab_cost if inputs.rehab_cost is not None else 0.0
    costs.append(
        CostLine(
            label="Rehab",
            amount=rehab,
            note=(
                "No rehab budget entered — assumed $0. Tax-sale parcels are sold unseen and "
                "un-inspected; this is rarely correct."
                if inputs.rehab_cost is None
                else "Your rehab estimate."
            ),
            assumed=inputs.rehab_cost is None,
        )
    )
    if inputs.rehab_cost is None:
        warnings.append(
            "Rehab is assumed to be $0. You cannot inspect these properties before bidding — "
            "budget for the worst plausible condition."
        )

    if statute:
        qt = statute["quietTitle"]
        # The expected cost of clearing title, not the cost of doing it.
        #
        # "required" used to change only this line's label while the full
        # midpoint was charged either way, so a Michigan parcel reserved $2,750
        # against a line telling the operator the work was "often unnecessary".
        # Weighting by likelihood makes the number mean what the label says.
        likelihood = qt.get("likelihood", 1)
        title_cost = ((qt["typicalLow"] + qt["typicalHigh"]) / 2) * likelihood
        title_range = (
            f"${qt['typicalLow']:,}–${qt['typicalHigh']:,}, "
            f"~{qt['typicalMonths']} months"
        )
        share = _js_round(likelihood * 100)
        costs.append(
            CostLine(
                label=(
                    "Quiet title (required)"
                    if likelihood >= 1
                    else f"Quiet title ({share}% of parcels)"
                ),
                amount=_round2(title_cost),
                note=(
                    f"Midpoint of the typical {statute['state']} range "
                    f"({title_range})."
                    if likelihood >= 1
                    else (
                        f"{share}% of the midpoint of the typical "
                        f"{statute['state']} range ({title_range}) — the share "
                        f"of {statute['state']} parcels that need an action at all."
                    )
                ),
                assumed=True,
            )
        )
        costs.append(
            CostLine(
                label="Deed recording and transfer",
                amount=statute["closingCosts"],
                note=f"Typical {statute['state']} recording and deed issuance cost.",
                assumed=True,
            )
        )
        # Listed separately rather than summed into the line above, so a reader
        # can see which part came off a published fee schedule and which part
        # is a margin somebody chose.
        if statute.get("extraClosingBuffer"):
            costs.append(
                CostLine(
                    label="Closing contingency",
                    amount=statute["extraClosingBuffer"],
                    note=(
                        "Publication, service and filing incidentals. Not a lien allowance — "
                        "surviving assessments are parcel-specific and are not covered by this."
                    ),
                    assumed=True,
                )
            )

    # Auction-to-marketable, not filing-to-decree. Where a state makes a
    # purchaser wait out a challenge window before suing, the lawsuit's length
    # is not the holding period -- Arkansas's five-month action sits inside an
    # eighteen-month hold.
    if inputs.holding_months is not None:
        holding_months = inputs.holding_months
    elif statute:
        holding_months = statute.get("auctionToMarketableMonths") or (
            statute["quietTitle"]["typicalMonths"] + 2
        )
    else:
        holding_months = 6

    monthly_holding = max(arv.value * MONTHLY_HOLDING_RATE, MIN_MONTHLY_HOLDING)
    costs.append(
        CostLine(
            label=f"Holding costs ({holding_months} months)",
            amount=_round2(monthly_holding * holding_months),
            note=(
                f"Taxes, insurance, and securing the property at "
                f"~${_js_round(monthly_holding):,}/month."
            ),
            assumed=inputs.holding_months is None,
        )
    )

    surviving_liens = inputs.surviving_liens if inputs.surviving_liens is not None else 0.0
    costs.append(
        CostLine(
            label="Surviving liens",
            amount=surviving_liens,
            note=(
                "Assumed $0 — not verified. Municipal code-enforcement liens, special "
                "assessments, and federal tax liens can survive the sale."
                if inputs.surviving_liens is None
                else "Your lien estimate."
            ),
            assumed=inputs.surviving_liens is None,
        )
    )
    if inputs.surviving_liens is None and statute:
        caveats = statute.get("caveats") or []
        warnings.append(
            "Surviving liens assumed $0. "
            + (caveats[0] if caveats else "Verify what survives in this jurisdiction.")
        )

    # A ratio can be legally correct and still produce a misleading ARV.
    # California assesses at full cash value, so its ratio is honestly 1.0 --
    # but Proposition 13 freezes the base year, so a long-held parcel's
    # assessed value can sit far under market and the derived ARV understates.
    if arv.derived and statute and statute.get("derivedArvCaveat"):
        warnings.append(statute["derivedArvCaveat"])
    if arv.derived and statute and statute.get("countyAssessmentRatios") and not arv.county_override:
        counties = list(statute["countyAssessmentRatios"])
        warnings.append(
            f"{inputs.state} has {len(counties)} "
            f"count{'y' if len(counties) == 1 else 'ies'} on a different assessment ratio "
            f"({', '.join(counties)}). No FIPS was supplied, so the statewide ratio was used — "
            f"pass `fips` if this parcel is in one of them."
        )

    total_costs = _round2(sum(c.amount for c in costs))

    # --- The ceiling -------------------------------------------------------
    max_bid = _round2(arv.value * (1 - target_margin) - total_costs)
    projected_profit = _round2(arv.value * target_margin)

    # --- Redemption --------------------------------------------------------
    redemption: RedemptionOutlook | None = None
    red = statute.get("redemption") if statute else None
    if red:
        first_tier = red["tiers"][0]
        # Texas's short window is 180 days; Georgia's and Arizona's first tier
        # is a full year. Use the shortest realistic window for the best case.
        shortest_days = 180 if inputs.state == "TX" else first_tier["throughDays"]
        # An annual rate is already annual. Dividing it across its own window is
        # what made Arizona's 16% report as 5.33% and Kentucky's 12% as 1.09%.
        is_annual = red.get("interestKind") == "annual"
        redemption = RedemptionOutlook(
            window_days=red["maxDays"],
            flat_penalty=first_tier["penalty"],
            penalty_at_max_bid=_round2(max(max_bid, 0) * first_tier["penalty"]),
            annualised_best_case=(
                first_tier["penalty"]
                if is_annual
                else _round2((first_tier["penalty"] * 365) / shortest_days)
            ),
            extended_for=red.get("extendedFor"),
            note=(
                f"{inputs.state} sells liens: the expected outcome is redemption with interest, "
                f"not ownership. Taking title needs a separate foreclosure after "
                f"{red['maxDays']} days."
                if statute["saleType"] == "Tax Lien"
                else (
                    f"{first_tier['penalty'] * 100:.0f}% per year accrues while the owner can "
                    f"still redeem. It is interest, not a flat penalty — redeeming early costs "
                    f"them less."
                )
                if is_annual
                else (
                    f"A {first_tier['penalty'] * 100:.0f}% flat penalty applies if the owner "
                    f"redeems. It is a penalty, not annual interest — the rate does not change "
                    f"with how early they redeem."
                )
            ),
        )

        bid_down = red.get("bidDown")
        if bid_down:
            redemption.market_penalty = BidDownObservation(
                observed_median=bid_down["observedMedian"],
                observed_mean=bid_down["observedMean"],
                n=bid_down["n"],
                penalty_at_max_bid_observed=_round2(
                    max(max_bid, 0) * bid_down["observedMedian"]
                ),
                source=bid_down["observedSource"],
                note=bid_down["note"],
            )
            # The ceiling is not the expectation, and a bidder reading only the
            # headline penalty would price this instrument an order of
            # magnitude wrong. Surface it as a warning, not a footnote.
            warnings.append(
                f"{inputs.state} bids the penalty DOWN from "
                f"{bid_down['statutoryMax'] * 100:.0f}%. Across {bid_down['n']:,} recorded sales "
                f"the rate cleared at a {bid_down['observedMedian'] * 100:.0f}% median "
                f"({bid_down['observedMean'] * 100:.2f}% mean). Do not underwrite this on the "
                f"statutory rate."
            )

    # --- Recommendation ----------------------------------------------------
    recommendation: Recommendation = "bid"
    if max_bid <= 0:
        recommendation = "no-bid"
        warnings.append(
            "Costs exceed what the property can support at your target margin. There is no bid "
            "at which this clears."
        )
    elif inputs.opening_bid is not None and inputs.opening_bid > max_bid:
        recommendation = "no-bid"
        warnings.append(
            f"The opening bid of ${_plain(inputs.opening_bid)} is already above your ceiling "
            f"of ${_plain(max_bid)}."
        )

    # A "bid" off an assumed floor is the most dangerous output this function
    # can produce: a green light computed from a number nobody measured. It is
    # not suppressed -- a floor with no recommendation is just "not enough
    # data" with extra steps -- but it never stands unqualified.
    if arv.assumed and recommendation == "bid":
        warnings.append(
            "This ceiling rests on an assumed floor, not a valuation of this parcel. It is a "
            "research starting point, not a green light — get comps or an assessor figure "
            "before bidding."
        )

    # An assumed floor is always low confidence, whatever else lines up. The
    # middle half of the observed spread is a 2-5x band depending on the state,
    # so every figure computed from one carries that band with it.
    confidence: Confidence
    if arv.assumed:
        confidence = "low"
    elif not arv.derived and inputs.rehab_cost is not None and statute:
        confidence = "high"
    elif statute and arv.value is not None:
        confidence = "medium"
    else:
        confidence = "low"

    return DealResult(
        max_bid=max_bid,
        recommendation=recommendation,
        confidence=confidence,
        arv=arv,
        costs=costs,
        total_costs=total_costs,
        projected_profit=projected_profit,
        bid_room=(
            _round2(max_bid - inputs.opening_bid) if inputs.opening_bid is not None else None
        ),
        redemption=redemption,
        statute=statute,
        warnings=warnings,
    )
