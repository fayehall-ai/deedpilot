"""
Turn recorded historical outcomes into agent guidance + UI comparables.

Outputs
-------
- In-process stats for the Python agent (buffers, p_redeem context, comps).
- ``data/history_index.json`` — compact per-(state, sale_type) index the
  Next.js app can load without scanning 90k JSONL rows on every request.
"""

from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .history import get_priors, load_outcomes, outcomes_path, real_outcomes_only, resolve_bucket
from .schemas import HistoricalOutcome, Lot, SaleType, utc_now

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_INDEX_PATH = DATA_DIR / "history_index.json"


def _percentile(sorted_vals: list[float], q: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = (len(sorted_vals) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    w = idx - lo
    return sorted_vals[lo] * (1 - w) + sorted_vals[hi] * w


def _key(state: str, sale_type: str | SaleType) -> str:
    st = sale_type.value if isinstance(sale_type, SaleType) else sale_type
    return f"{state}|{st}"


@dataclass
class HistoryGuidance:
    """What the agent should layer on top of the maxbid oracle for this lot."""

    key: str
    n: int
    p_redeem: float | None
    p_redeem_source: str
    median_winning_bid: float | None
    p75_winning_bid: float | None
    median_bid_to_assessed: float | None
    # Extra USD to subtract from oracle max_bid (risk buffer from history)
    suggested_buffer_usd: float
    # Fraction of oracle ceiling to target (e.g. 0.85) when history is thin-margin
    bid_fraction_of_ceiling: float
    notes: list[str]
    comps: list[dict[str, Any]]


def _comp_dict(o: HistoricalOutcome) -> dict[str, Any]:
    return {
        "id": o.id,
        "state": o.state,
        "fips": o.fips,
        "county": o.county_name,
        "saleType": o.sale_type.value,
        "saleDate": o.sale_date,
        "openingBid": o.opening_bid,
        "winningBid": o.winning_bid,
        "assessedValue": o.assessed_value,
        "arvEstimate": o.arv_estimate,
        "bidToAssessed": (
            round(o.winning_bid / o.assessed_value, 4)
            if o.winning_bid and o.assessed_value and o.assessed_value > 0
            else None
        ),
        "redeemed": o.redeemed,
        "ownershipTaken": o.ownership_taken,
        "source": o.source,
        "provenance": o.provenance,
    }


def find_comparables(
    *,
    state: str,
    sale_type: str | SaleType,
    assessed_value: float | None = None,
    opening_bid: float | None = None,
    fips: str | None = None,
    limit: int = 12,
    outcomes: list[HistoricalOutcome] | None = None,
) -> list[dict[str, Any]]:
    """
    Nearest historical sold/recorded auctions for UI + agent rationale.

    Ranking: same fips first, then closest bid-to-assessed or winning bid to
    the subject lot's economics.
    """
    st = sale_type.value if isinstance(sale_type, SaleType) else sale_type
    rows = real_outcomes_only(outcomes if outcomes is not None else load_outcomes())
    pool = [
        o
        for o in rows
        if o.state == state
        and o.sale_type.value == st
        and (o.winning_bid is not None or o.ownership_taken or o.redeemed)
    ]
    if not pool:
        # Fall back to state-only
        pool = [
            o
            for o in rows
            if o.state == state and (o.winning_bid is not None or o.ownership_taken)
        ]

    subject_ratio = None
    if opening_bid and assessed_value and assessed_value > 0:
        subject_ratio = opening_bid / assessed_value
    elif assessed_value and assessed_value > 0:
        subject_ratio = None

    def score(o: HistoricalOutcome) -> tuple[float, float, float]:
        same_fips = 0.0 if (fips and o.fips == fips) else 1.0
        ratio = None
        if o.winning_bid and o.assessed_value and o.assessed_value > 0:
            ratio = o.winning_bid / o.assessed_value
        if subject_ratio is not None and ratio is not None:
            ratio_dist = abs(ratio - subject_ratio)
        elif assessed_value and o.assessed_value:
            ratio_dist = abs(math.log1p(o.assessed_value) - math.log1p(assessed_value))
        elif opening_bid and o.winning_bid:
            ratio_dist = abs(math.log1p(o.winning_bid) - math.log1p(opening_bid))
        else:
            ratio_dist = 99.0
        # Prefer sold ownership / known winning bids
        quality = 0.0 if o.winning_bid else 1.0
        return (same_fips, ratio_dist, quality)

    pool_sorted = sorted(pool, key=score)
    return [_comp_dict(o) for o in pool_sorted[:limit]]


def guidance_for_lot(
    lot: Lot,
    sale_type: SaleType,
    *,
    outcomes: list[HistoricalOutcome] | None = None,
    oracle_max_bid: float | None = None,
) -> HistoryGuidance:
    """
    History-derived buffer + bid aggressiveness for one lot.

    Buffer logic (conservative):
    - If historical median winning bid << oracle ceiling, prefer bidding closer
      to market (smaller buffer) but never above oracle.
    - If history shows high bid-to-assessed relative to this opening, add buffer.
    - Thin n → small buffer, rely on expert prior notes.
    """
    key = _key(lot.state, sale_type)
    rows = real_outcomes_only(outcomes if outcomes is not None else load_outcomes())
    bucket_rows = [
        o
        for o in rows
        if o.state == lot.state and o.sale_type == sale_type and o.winning_bid is not None
    ]
    notes: list[str] = []

    # p_redeem from calibrated priors
    try:
        priors = get_priors()
        nb = resolve_bucket(priors, lot.state, sale_type)
        p_redeem = nb.p_redeem
        p_src = f"prior_bucket:{nb.key}:n={nb.n}"
    except Exception:  # noqa: BLE001
        p_redeem = None
        p_src = "unavailable"

    wins = sorted(float(o.winning_bid) for o in bucket_rows if o.winning_bid)
    ratios = sorted(
        o.winning_bid / o.assessed_value
        for o in bucket_rows
        if o.winning_bid and o.assessed_value and o.assessed_value > 0
    )
    med_win = _percentile(wins, 0.5)
    p75_win = _percentile(wins, 0.75)
    med_ratio = _percentile(ratios, 0.5)

    buffer = 0.0
    bid_frac = 0.9

    n = len(bucket_rows)
    if n >= 20 and med_win is not None and oracle_max_bid and oracle_max_bid > 0:
        # If market typically clears far below oracle, don't bid full ceiling
        if med_win < oracle_max_bid * 0.55:
            bid_frac = 0.82
            notes.append(
                f"History n={n}: median sold ${med_win:,.0f} is well below oracle "
                f"${oracle_max_bid:,.0f} — target ~{bid_frac:.0%} of ceiling."
            )
        elif med_win > oracle_max_bid * 0.95:
            buffer += min(5000.0, oracle_max_bid * 0.03)
            notes.append(
                f"History n={n}: median sold ${med_win:,.0f} near/above oracle — "
                f"add ${buffer:,.0f} caution buffer."
            )
        else:
            notes.append(
                f"History n={n}: median sold ${med_win:,.0f} vs oracle ${oracle_max_bid:,.0f}."
            )
    elif n > 0:
        notes.append(f"History n={n} for {key} — limited sample; light guidance only.")
    else:
        notes.append(f"No winning-bid history for {key}; oracle-only decision.")

    if (
        med_ratio is not None
        and lot.opening_bid
        and lot.assessed_value
        and lot.assessed_value > 0
    ):
        open_ratio = lot.opening_bid / lot.assessed_value
        if open_ratio > med_ratio * 1.4:
            extra = min(4000.0, (open_ratio - med_ratio) * lot.assessed_value * 0.15)
            buffer += extra
            notes.append(
                f"Opening/assessed {open_ratio:.2%} is hot vs hist median {med_ratio:.2%} "
                f"— +${extra:,.0f} buffer."
            )

    if p_redeem is not None and p_redeem >= 0.45 and sale_type in (
        SaleType.REDEEMABLE_DEED,
        SaleType.TAX_LIEN,
        SaleType.HYBRID,
    ):
        # High redeem → ownership path less likely; still don't invent maxbid
        notes.append(
            f"Historical/shrunk p_redeem≈{p_redeem:.0%} — size position for redemption outcome."
        )

    comps = find_comparables(
        state=lot.state,
        sale_type=sale_type,
        assessed_value=lot.assessed_value,
        opening_bid=lot.opening_bid,
        fips=lot.fips,
        limit=8,
        outcomes=rows,
    )

    return HistoryGuidance(
        key=key,
        n=n,
        p_redeem=p_redeem,
        p_redeem_source=p_src,
        median_winning_bid=round(med_win, 2) if med_win is not None else None,
        p75_winning_bid=round(p75_win, 2) if p75_win is not None else None,
        median_bid_to_assessed=round(med_ratio, 4) if med_ratio is not None else None,
        suggested_buffer_usd=round(buffer, 2),
        bid_fraction_of_ceiling=bid_frac,
        notes=notes,
        comps=comps,
    )


def build_history_index(
    *,
    path: Path | None = None,
    comps_per_bucket: int = 24,
) -> dict[str, Any]:
    """Build compact index for Next.js + API."""
    rows = real_outcomes_only(load_outcomes())
    by: dict[str, list[HistoricalOutcome]] = defaultdict(list)
    for o in rows:
        by[_key(o.state, o.sale_type)].append(o)

    buckets: dict[str, Any] = {}
    for key, group in sorted(by.items()):
        wins = sorted(float(o.winning_bid) for o in group if o.winning_bid)
        ratios = sorted(
            o.winning_bid / o.assessed_value
            for o in group
            if o.winning_bid and o.assessed_value and o.assessed_value > 0
        )
        n_redeemed = sum(1 for o in group if o.redeemed)
        n_owned = sum(1 for o in group if o.ownership_taken)
        # Sample comps: prefer with winning_bid, recent sale_date
        with_bid = [o for o in group if o.winning_bid is not None]
        with_bid.sort(key=lambda o: o.sale_date or "", reverse=True)
        comps = [_comp_dict(o) for o in with_bid[:comps_per_bucket]]
        if len(comps) < min(8, comps_per_bucket):
            # fill with redeemed-only etc
            rest = [o for o in group if o not in with_bid][: comps_per_bucket - len(comps)]
            comps.extend(_comp_dict(o) for o in rest)

        state, sale_type = key.split("|", 1)
        try:
            priors = get_priors()
            nb = resolve_bucket(priors, state, sale_type)
            p_redeem = nb.p_redeem
        except Exception:  # noqa: BLE001
            p_redeem = None

        buckets[key] = {
            "state": state,
            "saleType": sale_type,
            "n": len(group),
            "nWithWinningBid": len(wins),
            "nRedeemed": n_redeemed,
            "nOwnershipTaken": n_owned,
            "pRedeem": p_redeem,
            "medianWinningBid": round(_percentile(wins, 0.5) or 0, 2) if wins else None,
            "p25WinningBid": round(_percentile(wins, 0.25) or 0, 2) if wins else None,
            "p75WinningBid": round(_percentile(wins, 0.75) or 0, 2) if wins else None,
            "medianBidToAssessed": round(_percentile(ratios, 0.5) or 0, 4) if ratios else None,
            "comps": comps,
        }

    index = {
        "builtAt": utc_now(),
        "sourcePath": str(outcomes_path()),
        "nOutcomes": len(rows),
        "nBuckets": len(buckets),
        "buckets": buckets,
    }
    out = path or DEFAULT_INDEX_PATH
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2), encoding="utf-8")
    return index


def load_history_index(path: Path | None = None) -> dict[str, Any] | None:
    p = path or DEFAULT_INDEX_PATH
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))
