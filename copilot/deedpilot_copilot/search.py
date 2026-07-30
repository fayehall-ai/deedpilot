"""
Bid search — pick the bid that maximises risk-adjusted value under the oracle.

The previous policy bid a fixed 90% of the oracle ceiling. That is a guess about
the room dressed as a decision: it overbids where the county clears at a tenth of
the ceiling, and it underbids where the ceiling is tight and competition is real.

This replaces the guess with an optimisation over two things the system actually
knows:

- **What winning costs** — ``world_model.p_win`` reads the CDF of the county's
  clearing-price distribution.
- **What winning is worth** — the oracle's own arithmetic. From
  ``max_bid = arv*(1-margin) - total_costs`` and ``projected_profit = arv*margin``
  it follows exactly that ``profit(B) = projected_profit + (max_bid - B)``. The
  value function is therefore *derived* from the oracle, never re-estimated, and
  no bid can be scored without one.

Every candidate is hard-clamped to the ceiling before it is ever scored, so the
search cannot produce a constitutional violation even if the value model is
wrong. Losing the auction is scored at exactly zero: no capital deployed, no
profit, which is what makes passing a real option rather than a penalty.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from .history import get_priors, resolve_bucket
from .schemas import DealResult, Lot, SaleType
from .statute import statute_for
from .world_model import PriceQuantiles, get_model, p_win, predict_quantiles

#: Weight on expected shortfall. 0 = risk-neutral EV maximiser; higher values
#: pull the bid down toward prices that survive a bad exit.
DEFAULT_RISK_AVERSION = 0.5

#: Candidate bids evaluated between the opening bid and the ceiling.
GRID_POINTS = 61


class BidCandidate(BaseModel):
    bid: float
    p_win: float
    expected_value: float
    downside_profit: float
    score: float


class BidPlan(BaseModel):
    """Result of the search. ``bid`` is None when passing is optimal."""

    bid: float | None
    pass_: bool = Field(False, alias="pass")
    ceiling: float | None
    p_win: float | None = None
    expected_value: float | None = None
    downside_profit: float | None = None
    p_redeem_used: float | None = None
    p_redeem_source: str | None = None
    risk_aversion: float = DEFAULT_RISK_AVERSION
    quantiles: PriceQuantiles | None = None
    candidates: list[BidCandidate] = Field(default_factory=list)
    rationale: list[str] = Field(default_factory=list)
    source: str = "search"

    model_config = {"populate_by_name": True}


def _profit_if_own(deal: DealResult, bid: float) -> float:
    """
    Oracle-derived profit on the ownership path.

    Identity, not an estimate: max_bid = arv*(1-m) - costs and
    projected_profit = arv*m, so arv - costs - bid = projected_profit +
    (max_bid - bid).
    """
    if deal.max_bid is None or deal.projected_profit is None:
        return 0.0
    return deal.projected_profit + (deal.max_bid - bid)


def _downside_if_own(deal: DealResult, bid: float, exit_mult_p10: float) -> float:
    """
    Profit when the exit lands in the bottom decile of the exit-multiple range.

    Note this multiple is an expert range, not a fitted one — no row in the
    corpus records an exit price (see ``SimulatorPriors.unobserved_fields``).
    It is used only to rank candidate bids against each other, where a shared
    conservative assumption still orders them correctly.
    """
    arv = deal.arv_value or 0.0
    return arv * exit_mult_p10 - deal.total_costs - bid


def _redeem_profit(state: str, bid: float) -> float:
    """Penalty collected if the owner redeems. Statutory, not modelled."""
    statute = statute_for(state)
    if statute and statute.get("redemption"):
        return bid * float(statute["redemption"]["tiers"][0]["penalty"])
    return 0.0


def optimize_bid(
    lot: Lot,
    deal: DealResult,
    sale_type: SaleType,
    *,
    ceiling: float | None = None,
    risk_aversion: float = DEFAULT_RISK_AVERSION,
    year: int | None = None,
    grid_points: int = GRID_POINTS,
) -> BidPlan:
    """
    Search the bid that maximises ``EV - risk_aversion * expected_shortfall``.

    ``ceiling`` defaults to the oracle max_bid and may be lowered by lesson or
    history buffers, never raised.
    """
    rationale: list[str] = []

    if deal.recommendation != "bid" or deal.max_bid is None:
        return BidPlan(
            bid=None,
            **{"pass": True},
            ceiling=deal.max_bid,
            rationale=[
                f"Oracle recommendation is '{deal.recommendation}' — pass without search."
            ],
        )

    ceiling = deal.max_bid if ceiling is None else min(ceiling, deal.max_bid)
    opening = lot.opening_bid or 0.0

    if ceiling <= 0:
        return BidPlan(
            bid=None, **{"pass": True}, ceiling=ceiling,
            rationale=["Ceiling is non-positive after buffers — pass."],
        )
    if opening > ceiling:
        return BidPlan(
            bid=None, **{"pass": True}, ceiling=ceiling,
            rationale=[
                f"Opening ${opening:,.0f} already exceeds ceiling ${ceiling:,.0f} — pass."
            ],
        )

    # Redemption probability and exit-tail assumption from calibrated priors.
    p_redeem, p_src, exit_p10 = 0.0, "unavailable", 0.72
    try:
        bucket = resolve_bucket(get_priors(), lot.state, sale_type)
        p_redeem = float(bucket.p_redeem)
        p_src = f"{bucket.p_redeem_source}:n_obs={bucket.n_redemption_observed}"
        exit_p10 = float(bucket.exit_mult_p10)
    except Exception as e:  # noqa: BLE001 — search must survive a cold prior cache
        rationale.append(f"Priors unavailable ({e}); redemption treated as 0.")

    model = get_model()
    quantiles = None
    if model is not None:
        quantiles = predict_quantiles(
            model,
            state=lot.state,
            fips=lot.fips,
            county_name=lot.county_name,
            year=year,
        )

    lo = max(opening, 1.0)
    hi = ceiling
    step = (hi - lo) / max(1, grid_points - 1)
    grid = [lo + i * step for i in range(grid_points)] if step > 0 else [lo]

    candidates: list[BidCandidate] = []
    for b in grid:
        b = min(b, ceiling)  # belt and braces: never score an illegal bid
        if quantiles is not None and quantiles.n_train > 0:
            pw = p_win(quantiles, b)
        else:
            # No price model for this geography. Fall back to the previous
            # behaviour's implicit assumption — a bid is simply available —
            # rather than fabricating a win curve.
            pw = 1.0
        own = _profit_if_own(deal, b)
        red = _redeem_profit(lot.state, b)
        value_if_won = p_redeem * red + (1 - p_redeem) * own
        ev = pw * value_if_won
        down = _downside_if_own(deal, b, exit_p10)
        shortfall = max(0.0, -down) * (1 - p_redeem) * pw
        candidates.append(
            BidCandidate(
                bid=round(b, 2),
                p_win=round(pw, 4),
                expected_value=round(ev, 2),
                downside_profit=round(down, 2),
                score=round(ev - risk_aversion * shortfall, 2),
            )
        )

    best = max(candidates, key=lambda c: c.score)

    if best.score <= 0:
        return BidPlan(
            bid=None,
            **{"pass": True},
            ceiling=round(ceiling, 2),
            p_redeem_used=round(p_redeem, 4),
            p_redeem_source=p_src,
            risk_aversion=risk_aversion,
            quantiles=quantiles,
            candidates=_thin(candidates),
            rationale=rationale
            + [
                "No bid at or below the oracle ceiling has positive risk-adjusted "
                f"value (best score ${best.score:,.0f} at ${best.bid:,.0f}) — pass."
            ],
            source="search",
        )

    if quantiles is not None and quantiles.n_train > 0:
        rationale.append(
            f"Clearing-price model {quantiles.group} (n={quantiles.n_train}): "
            f"median ${quantiles.values[3]:,.0f}, p75 ${quantiles.values[4]:,.0f}, "
            f"p90 ${quantiles.values[5]:,.0f}."
        )
        rationale.append(
            f"Bid ${best.bid:,.0f} clears an estimated {best.p_win:.0%} of comparable "
            f"sales, {(1 - best.bid / ceiling):.0%} below the ${ceiling:,.0f} ceiling."
        )
    else:
        rationale.append(
            "No clearing-price history for this geography — win probability is not "
            "modelled; bid sized on oracle value alone."
        )
    rationale.append(
        f"Expected value ${best.expected_value:,.0f}; bottom-decile exit gives "
        f"${best.downside_profit:,.0f} (risk aversion {risk_aversion})."
    )
    if p_redeem >= 0.4:
        rationale.append(
            f"p_redeem {p_redeem:.0%} ({p_src}) — redemption is the expected path; "
            "value is weighted toward the statutory penalty."
        )

    return BidPlan(
        bid=round(best.bid, 2),
        **{"pass": False},
        ceiling=round(ceiling, 2),
        p_win=best.p_win,
        expected_value=best.expected_value,
        downside_profit=best.downside_profit,
        p_redeem_used=round(p_redeem, 4),
        p_redeem_source=p_src,
        risk_aversion=risk_aversion,
        quantiles=quantiles,
        candidates=_thin(candidates),
        rationale=rationale,
        source="search",
    )


def _thin(candidates: list[BidCandidate], keep: int = 9) -> list[BidCandidate]:
    """Evenly sampled candidates for the UI / trajectory log."""
    if len(candidates) <= keep:
        return candidates
    stride = (len(candidates) - 1) / (keep - 1)
    return [candidates[round(i * stride)] for i in range(keep)]


def explain_plan(plan: BidPlan) -> dict[str, Any]:
    """Compact dict for API responses and trajectory records."""
    return {
        "bid": plan.bid,
        "pass": plan.pass_,
        "ceiling": plan.ceiling,
        "pWin": plan.p_win,
        "expectedValue": plan.expected_value,
        "downsideProfit": plan.downside_profit,
        "pRedeemUsed": plan.p_redeem_used,
        "pRedeemSource": plan.p_redeem_source,
        "clearingPriceGroup": plan.quantiles.group if plan.quantiles else None,
        "clearingPriceN": plan.quantiles.n_train if plan.quantiles else 0,
        "rationale": plan.rationale,
        "candidates": [c.model_dump() for c in plan.candidates],
    }
