"""
Honest evaluation harness.

What this replaces was not an evaluation. ``run_backtest`` computed a baseline
and then discarded it (``vs_baseline_profit=0.0`` was hardcoded); what it did
compute summed the *agent's own* P&L and called it the baseline. Its
"calibration error" was a dollar figure — mean |predicted profit − simulated
profit| — around $30,000, gating promotion on a number whose units make it
incomparable across lots and whose ground truth was itself simulated.

The rules here:

1. **Held-out only.** Every number comes from val or test rows the fitting code
   never saw. The split guard runs on entry.
2. **Real baselines.** A policy is only interesting relative to the alternatives
   a person would actually consider — pass everything, bid the opening, bid the
   ceiling, bid a fixed fraction of it (the behaviour shipping today).
3. **Ground truth is the recorded clearing price**, not a simulation. We know
   what the room paid, so we know whether a bid would have won.
4. **No circular ARV.** The existing historical backtest imputes assessed value
   as ``winning_bid * 4`` — deriving the property's worth from the very price
   the policy is being scored against, which leaks the answer into the decision.
   Here ARV comes from the county's *training* median, so a row's own outcome
   never informs its own valuation.

Absolute surplus is not a P&L claim: it inherits the ARV multiplier assumption
below and the corpus records no exit prices. It is a comparison device, and it
shifts every policy equally.
"""

from __future__ import annotations

import statistics
from typing import Any, Callable

from pydantic import BaseModel, Field

from .labels import clearing_price_rows
from .maxbid import compute_maxbid
from .schemas import DealInputs, DealResult, HistoricalOutcome, Lot, SaleType
from .search import optimize_bid
from .splits import Split, get_split_rows, load_splits, split_of

#: Tax-sale clearing prices run far below market. This converts a county's
#: training-median clearing price into an assessed-value proxy so the oracle has
#: something to work with on rows that publish no valuation. It is an assumption,
#: applied identically to every policy.
ARV_FROM_PRICE_MULT = 4.0


class PolicyResult(BaseModel):
    policy: str
    n: int
    n_bid: int
    n_pass: int
    n_won: int
    win_rate: float
    mean_bid: float
    #: Dollars paid above what the auction actually cleared at, on wins.
    mean_overpay_when_won: float
    total_overpay: float
    capital_deployed: float
    #: Hard gate. Any value above zero fails promotion regardless of returns.
    n_oracle_violations: int
    mean_surplus: float
    total_surplus: float
    #: Mean of the worst decile of per-lot surplus — tail risk, not average risk.
    cvar10_surplus: float
    notes: list[str] = Field(default_factory=list)


def county_arv_priors(train_rows: list[HistoricalOutcome] | None = None) -> dict[str, float]:
    """
    Median clearing price per county, from training rows only.

    Used to give the oracle a non-circular valuation anchor on corpora that
    publish prices but no assessed values.
    """
    rows = train_rows if train_rows is not None else get_split_rows("train")
    by: dict[str, list[float]] = {}
    for o in clearing_price_rows(rows):
        if not o.winning_bid or o.winning_bid <= 0:
            continue
        for key in filter(None, (o.fips, f"{o.state}|{(o.county_name or '').lower()}", o.state)):
            by.setdefault(key, []).append(float(o.winning_bid))
    return {k: statistics.median(v) for k, v in by.items() if v}


def _arv_proxy(o: HistoricalOutcome, priors: dict[str, float]) -> float | None:
    """County-prior assessed proxy. Never reads this row's own winning bid."""
    if o.assessed_value and o.assessed_value > 0:
        return o.assessed_value
    for key in filter(None, (o.fips, f"{o.state}|{(o.county_name or '').lower()}", o.state)):
        if key in priors:
            return priors[key] * ARV_FROM_PRICE_MULT
    return None


def _lot_and_deal(
    o: HistoricalOutcome, priors: dict[str, float]
) -> tuple[Lot, DealResult] | None:
    assessed = _arv_proxy(o, priors)
    if assessed is None:
        return None
    lot = Lot(
        lot_id=o.id,
        fips=o.fips or "",
        state=o.state,
        county_name=o.county_name,
        opening_bid=o.opening_bid,
        assessed_value=assessed,
        sale_type=o.sale_type,
        metadata={"assessed_from": "county_train_median_prior"},
    )
    deal = compute_maxbid(
        DealInputs(
            state=o.state,
            sale_type=o.sale_type,
            opening_bid=o.opening_bid,
            assessed_value=assessed,
        )
    )
    return lot, deal


# ---------------------------------------------------------------------------
# Policies: (lot, deal, outcome) -> bid or None to pass
# ---------------------------------------------------------------------------

Policy = Callable[[Lot, DealResult, HistoricalOutcome], float | None]


def policy_always_pass(lot: Lot, deal: DealResult, o: HistoricalOutcome) -> float | None:
    return None


def policy_opening_only(lot: Lot, deal: DealResult, o: HistoricalOutcome) -> float | None:
    if deal.recommendation != "bid" or not lot.opening_bid:
        return None
    return min(lot.opening_bid, deal.max_bid or 0.0) or None


def policy_oracle_ceiling(lot: Lot, deal: DealResult, o: HistoricalOutcome) -> float | None:
    if deal.recommendation != "bid" or deal.max_bid is None or deal.max_bid <= 0:
        return None
    return deal.max_bid


def _fixed_fraction(frac: float) -> Policy:
    def _p(lot: Lot, deal: DealResult, o: HistoricalOutcome) -> float | None:
        if deal.recommendation != "bid" or deal.max_bid is None or deal.max_bid <= 0:
            return None
        return deal.max_bid * frac

    return _p


def policy_search(lot: Lot, deal: DealResult, o: HistoricalOutcome) -> float | None:
    year = int(o.sale_date[:4]) if (o.sale_date or "")[:4].isdigit() else None
    plan = optimize_bid(lot, deal, o.sale_type, year=year)
    return plan.bid


#: The alternatives a bidder would actually weigh. ``fixed_fraction_0.90`` is the
#: behaviour shipping today, so it is the bar the search has to clear.
POLICIES: dict[str, Policy] = {
    "always_pass": policy_always_pass,
    "opening_only": policy_opening_only,
    "oracle_ceiling": policy_oracle_ceiling,
    "fixed_fraction_0.90": _fixed_fraction(0.90),
    "search": policy_search,
}


def _surplus(deal: DealResult, bid: float) -> float:
    """Oracle-derived value of winning at ``bid`` (see search._profit_if_own)."""
    if deal.max_bid is None or deal.projected_profit is None:
        return 0.0
    return deal.projected_profit + (deal.max_bid - bid)


def evaluate_policy(
    name: str,
    policy: Policy,
    rows: list[HistoricalOutcome],
    priors: dict[str, float],
) -> PolicyResult:
    n_bid = n_won = n_viol = 0
    bids: list[float] = []
    overpays: list[float] = []
    surpluses: list[float] = []
    capital = 0.0
    n_scored = 0
    notes: list[str] = []

    for o in rows:
        built = _lot_and_deal(o, priors)
        if built is None:
            continue
        n_scored += 1
        lot, deal = built
        bid = policy(lot, deal, o)

        if bid is None or bid <= 0:
            surpluses.append(0.0)  # passing is a real option worth exactly zero
            continue

        n_bid += 1
        bids.append(bid)
        if deal.max_bid is not None and bid > deal.max_bid + 1e-6:
            n_viol += 1

        actual = float(o.winning_bid or 0.0)
        if actual > 0 and bid + 1e-6 >= actual:
            n_won += 1
            capital += bid
            overpays.append(bid - actual)
            surpluses.append(_surplus(deal, bid))
        else:
            # Outbid: no capital committed, no value captured.
            surpluses.append(0.0)

    tail = sorted(surpluses)[: max(1, len(surpluses) // 10)] if surpluses else [0.0]
    if n_scored < len(rows):
        notes.append(
            f"{len(rows) - n_scored} rows unscored — no county valuation prior available."
        )

    return PolicyResult(
        policy=name,
        n=n_scored,
        n_bid=n_bid,
        n_pass=n_scored - n_bid,
        n_won=n_won,
        win_rate=round(n_won / n_bid, 4) if n_bid else 0.0,
        mean_bid=round(statistics.mean(bids), 2) if bids else 0.0,
        mean_overpay_when_won=round(statistics.mean(overpays), 2) if overpays else 0.0,
        total_overpay=round(sum(overpays), 2),
        capital_deployed=round(capital, 2),
        n_oracle_violations=n_viol,
        mean_surplus=round(statistics.mean(surpluses), 2) if surpluses else 0.0,
        total_surplus=round(sum(surpluses), 2),
        cvar10_surplus=round(statistics.mean(tail), 2),
        notes=notes,
    )


def evaluate_policies(
    split: Split = "val",
    *,
    limit: int | None = None,
    policies: dict[str, Policy] | None = None,
) -> dict[str, Any]:
    """
    Score every policy on a held-out split.

    ``split`` must be val or test — evaluating on train would measure memory.
    """
    if split not in ("val", "test"):
        raise ValueError(f"refusing to evaluate on '{split}': use val or test")

    rows = [o for o in get_split_rows(split) if o.winning_bid and o.winning_bid > 0]
    rows = [o for o in clearing_price_rows(rows)]
    if limit:
        rows = rows[:limit]

    priors = county_arv_priors()
    results = {
        name: evaluate_policy(name, fn, rows, priors)
        for name, fn in (policies or POLICIES).items()
    }

    ranked = sorted(
        (r for r in results.values() if r.n_oracle_violations == 0),
        key=lambda r: r.total_surplus,
        reverse=True,
    )
    return {
        "split": split,
        "n_rows": len(rows),
        "policy_cut_dates": {
            "val": load_splits().cut_val,
            "test": load_splits().cut_test,
        },
        "results": {k: v.model_dump() for k, v in results.items()},
        "ranking_by_total_surplus": [r.policy for r in ranked],
        "assumptions": [
            f"ARV proxy = county training-median clearing price x {ARV_FROM_PRICE_MULT}.",
            "Ground truth is the recorded clearing price; a bid wins iff it meets it.",
            "Surplus is oracle-derived value, not realised P&L — the corpus records "
            "no exit prices.",
        ],
    }


def promotion_gate(
    candidate: PolicyResult,
    incumbent: PolicyResult,
    *,
    min_relative_gain: float = 0.0,
) -> dict[str, Any]:
    """
    Should the candidate policy replace the incumbent?

    Oracle violations are disqualifying on their own — a policy that bids above
    the walk-away price is unsafe at any return.
    """
    reasons: list[str] = []
    ok = True

    if candidate.n_oracle_violations > 0:
        ok = False
        reasons.append(
            f"{candidate.n_oracle_violations} bids exceeded the oracle ceiling — "
            "disqualifying."
        )

    gain = candidate.total_surplus - incumbent.total_surplus
    rel = (gain / abs(incumbent.total_surplus)) if incumbent.total_surplus else None
    if gain <= 0:
        ok = False
        reasons.append(
            f"total surplus {candidate.total_surplus:,.0f} does not beat incumbent "
            f"{incumbent.total_surplus:,.0f}."
        )
    elif rel is not None and rel < min_relative_gain:
        ok = False
        reasons.append(
            f"relative gain {rel:.2%} below required {min_relative_gain:.2%}."
        )

    if candidate.cvar10_surplus < incumbent.cvar10_surplus:
        reasons.append(
            f"tail risk worsened: CVaR10 {candidate.cvar10_surplus:,.0f} vs "
            f"{incumbent.cvar10_surplus:,.0f} (not disqualifying, but noted)."
        )

    if ok and not reasons:
        reasons.append(
            f"surplus +{gain:,.0f} with zero oracle violations and no tail regression."
        )

    return {
        "promote": ok,
        "candidate": candidate.policy,
        "incumbent": incumbent.policy,
        "surplus_gain": round(gain, 2),
        "relative_gain": round(rel, 4) if rel is not None else None,
        "reasons": reasons,
    }
