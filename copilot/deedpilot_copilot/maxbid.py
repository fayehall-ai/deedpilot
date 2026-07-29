"""
Trusted oracle — Python port of lib/deal/maxbid.ts.

Deterministic arithmetic only. The LLM never invents max_bid.
"""

from __future__ import annotations

from .schemas import CostLine, DealInputs, DealResult
from .statute import statute_for

DEFAULTS = {
    "target_margin": 0.3,
    "selling_cost_rate": 0.08,
    "monthly_holding_rate": 0.0015,
    "min_monthly_holding": 75.0,
}


def _round2(n: float) -> float:
    return round(n * 100) / 100


def compute_maxbid(inputs: DealInputs) -> DealResult:
    """Hard tool: walk-away price from statute + costs. Never LLM-generated."""
    statute = statute_for(inputs.state)
    warnings: list[str] = []
    target_margin = inputs.target_margin if inputs.target_margin is not None else DEFAULTS["target_margin"]
    selling_cost_rate = (
        inputs.selling_cost_rate
        if inputs.selling_cost_rate is not None
        else DEFAULTS["selling_cost_rate"]
    )

    # ARV
    if inputs.arv_override is not None and inputs.arv_override > 0:
        arv_value = inputs.arv_override
        arv_basis = "User comparable-sales estimate."
        derived = False
    elif inputs.assessed_value is not None and inputs.assessed_value > 0 and statute:
        arv_value = inputs.assessed_value / statute["assessmentRatio"]
        arv_basis = (
            f"Assessed {inputs.assessed_value:,.0f} ÷ {statute['assessmentRatio']} "
            f"assessment ratio. {statute['assessmentBasis']}"
        )
        derived = True
    else:
        if not statute:
            warnings.append(
                f"{inputs.state} is outside covered statutes (FL, GA, TX, AZ, MI). "
                "Costs and redemption are not fully modelled."
            )
        return DealResult(
            max_bid=None,
            recommendation="insufficient-data",
            confidence="low",
            arv_value=None,
            arv_basis="No assessed value or ARV override provided.",
            costs=[],
            total_costs=0.0,
            projected_profit=None,
            bid_room=None,
            warnings=warnings
            + [
                "Cannot compute max bid without ARV. Add comps or assessed value.",
            ],
            statute=statute,
        )

    if not statute:
        warnings.append(
            f"{inputs.state} outside verified statutory parameters — treat figures as unverified."
        )

    costs: list[CostLine] = []
    costs.append(
        CostLine(
            label="Selling costs on exit",
            amount=_round2(arv_value * selling_cost_rate),
            note=f"{selling_cost_rate * 100:.1f}% of ARV — agent + seller closing.",
            assumed=inputs.selling_cost_rate is None,
        )
    )

    rehab = inputs.rehab_cost if inputs.rehab_cost is not None else 0.0
    costs.append(
        CostLine(
            label="Rehab",
            amount=rehab,
            note=(
                "No rehab budget — assumed $0 (rarely correct for tax sales)."
                if inputs.rehab_cost is None
                else "User rehab estimate."
            ),
            assumed=inputs.rehab_cost is None,
        )
    )
    if inputs.rehab_cost is None:
        warnings.append("Rehab assumed $0. Budget for unseen condition risk.")

    if statute:
        qt = statute["quietTitle"]
        title_cost = (qt["typicalLow"] + qt["typicalHigh"]) / 2
        costs.append(
            CostLine(
                label="Quiet title (required)" if qt["required"] else "Quiet title (often unnecessary)",
                amount=_round2(title_cost),
                note=(
                    f"Midpoint of typical {statute['state']} range "
                    f"(${qt['typicalLow']:,.0f}–${qt['typicalHigh']:,.0f}, "
                    f"~{qt['typicalMonths']} months)."
                ),
                assumed=True,
            )
        )
        costs.append(
            CostLine(
                label="Deed recording and transfer",
                amount=float(statute["closingCosts"]),
                note=f"Typical {statute['state']} recording cost.",
                assumed=True,
            )
        )

    holding_months = (
        inputs.holding_months
        if inputs.holding_months is not None
        else (statute["quietTitle"]["typicalMonths"] + 2 if statute else 6)
    )
    monthly_holding = max(
        arv_value * DEFAULTS["monthly_holding_rate"],
        DEFAULTS["min_monthly_holding"],
    )
    costs.append(
        CostLine(
            label=f"Holding costs ({holding_months} months)",
            amount=_round2(monthly_holding * holding_months),
            note=f"~${monthly_holding:,.0f}/month taxes, insurance, securing.",
            assumed=inputs.holding_months is None,
        )
    )

    surviving = inputs.surviving_liens if inputs.surviving_liens is not None else 0.0
    costs.append(
        CostLine(
            label="Surviving liens",
            amount=surviving,
            note=(
                "Assumed $0 — not verified."
                if inputs.surviving_liens is None
                else "User lien estimate."
            ),
            assumed=inputs.surviving_liens is None,
        )
    )
    if inputs.surviving_liens is None and statute and statute.get("caveats"):
        warnings.append("Surviving liens assumed $0. " + statute["caveats"][0])

    total_costs = _round2(sum(c.amount for c in costs))
    max_bid = _round2(arv_value * (1 - target_margin) - total_costs)
    projected_profit = _round2(arv_value * target_margin)

    redemption = None
    if statute and statute.get("redemption"):
        red = statute["redemption"]
        first = red["tiers"][0]
        shortest = 180 if inputs.state == "TX" else first["throughDays"]
        redemption = {
            "windowDays": red["maxDays"],
            "flatPenalty": first["penalty"],
            "penaltyAtMaxBid": _round2(max(max_bid, 0) * first["penalty"]),
            "annualisedBestCase": _round2((first["penalty"] * 365) / shortest),
            "extendedFor": red.get("extendedFor"),
            "note": (
                f"{inputs.state} sells liens: expected outcome is redemption, not ownership."
                if statute["saleType"] == "Tax Lien"
                else f"A {first['penalty'] * 100:.0f}% flat penalty applies on redemption."
            ),
        }

    recommendation: str = "bid"
    if max_bid <= 0:
        recommendation = "no-bid"
        warnings.append("Costs exceed target margin — no bid clears.")
    elif inputs.opening_bid is not None and inputs.opening_bid > max_bid:
        recommendation = "no-bid"
        warnings.append(
            f"Opening bid ${inputs.opening_bid:,.0f} exceeds ceiling ${max_bid:,.0f}."
        )

    if not derived and inputs.rehab_cost is not None and statute:
        confidence = "high"
    elif statute and arv_value is not None:
        confidence = "medium"
    else:
        confidence = "low"

    return DealResult(
        max_bid=max_bid,
        recommendation=recommendation,  # type: ignore[arg-type]
        confidence=confidence,  # type: ignore[arg-type]
        arv_value=arv_value,
        arv_basis=arv_basis,
        costs=costs,
        total_costs=total_costs,
        projected_profit=projected_profit,
        bid_room=(
            _round2(max_bid - inputs.opening_bid)
            if inputs.opening_bid is not None
            else None
        ),
        redemption=redemption,
        statute=statute,
        warnings=warnings,
    )
