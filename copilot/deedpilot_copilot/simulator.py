"""
Outcome simulator — samples redemption / ownership using statute tiers + priors.

Fidelity is intentionally conservative. Real tax-deed outcomes are sparse/noisy;
this module must never invent certainty.
"""

from __future__ import annotations

import hashlib
import random
from typing import Any

from .maxbid import compute_maxbid
from .schemas import DealInputs, Lot, PredictedOutcome, SaleType, SimulatedOutcome
from .statute import statute_for


def _rng(seed: str) -> random.Random:
    h = hashlib.sha256(seed.encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def base_p_redeem(state: str, sale_type: SaleType, opening_bid: float | None, arv: float | None) -> float:
    """Expert priors — calibrated loosely; flywheel adjusts via lessons."""
    if sale_type == SaleType.TAX_LIEN:
        return 0.72
    if sale_type == SaleType.REDEEMABLE_DEED:
        p = 0.38
    elif sale_type == SaleType.TAX_DEED:
        p = 0.12
    else:
        p = 0.25

    # Cheap opening relative to ARV → more likely owner walks (lower redeem)
    if opening_bid and arv and arv > 0:
        ratio = opening_bid / arv
        if ratio < 0.05:
            p *= 0.85
        elif ratio > 0.35:
            p = min(0.85, p * 1.25)
    # State tweaks from atlas experience
    if state in ("TX", "GA"):
        p = min(0.9, p * 1.1)
    if state == "MI":
        p *= 0.7
    return max(0.02, min(0.95, p))


def predict_outcome(
    lot: Lot,
    bid_amount: float | None,
    sale_type: SaleType,
    lessons: list[dict[str, Any]] | None = None,
) -> PredictedOutcome:
    if bid_amount is None or bid_amount <= 0:
        return PredictedOutcome(
            p_redeem=0.0,
            expected_profit=0.0,
            expected_loss_if_own=0.0,
            notes="Pass — no capital at risk.",
        )

    inputs = DealInputs(
        state=lot.state,
        sale_type=sale_type,
        opening_bid=lot.opening_bid,
        assessed_value=lot.assessed_value,
        arv_override=lot.arv_override,
        rehab_cost=lot.rehab_cost,
        surviving_liens=lot.surviving_liens,
    )
    deal = compute_maxbid(inputs)
    arv = deal.arv_value or 0.0
    p = base_p_redeem(lot.state, sale_type, lot.opening_bid, arv)

    # Apply active lessons
    notes = []
    for lesson in lessons or []:
        if not lesson.get("active", True):
            continue
        scope = lesson.get("scope")
        key = lesson.get("scope_key")
        if scope == "state" and key == lot.state:
            delta = lesson.get("suggested_p_redeem_delta") or 0.0
            p = max(0.02, min(0.95, p + delta))
            notes.append(lesson.get("lesson", "")[:120])
        if scope == "sale_type" and key == sale_type.value:
            delta = lesson.get("suggested_p_redeem_delta") or 0.0
            p = max(0.02, min(0.95, p + delta))

    statute = statute_for(lot.state)
    if statute and statute.get("redemption"):
        pen = statute["redemption"]["tiers"][0]["penalty"]
        profit_if_redeem = bid_amount * pen
    else:
        profit_if_redeem = 0.0  # pure deed — redeem unlikely / pre-sale only

    # Ownership path: ARV - costs - bid roughly from deal projection
    if deal.max_bid is not None and deal.projected_profit is not None:
        # scale profit if bid differs from max
        overpay = max(0.0, bid_amount - (deal.max_bid or 0))
        profit_if_own = deal.projected_profit - overpay
    else:
        profit_if_own = -bid_amount * 0.3

    expected = p * profit_if_redeem + (1 - p) * profit_if_own
    return PredictedOutcome(
        p_redeem=round(p, 4),
        expected_profit=round(expected, 2),
        expected_loss_if_own=round(min(0.0, profit_if_own), 2),
        notes="; ".join(notes) if notes else "Prior-based prediction.",
    )


def simulate_outcome(
    lot: Lot,
    bid_amount: float | None,
    sale_type: SaleType,
    seed: str | None = None,
    lessons: list[dict[str, Any]] | None = None,
) -> SimulatedOutcome:
    """Sample one Monte Carlo path for training / backtest."""
    if bid_amount is None or bid_amount <= 0:
        return SimulatedOutcome(
            redeemed=False,
            ownership_taken=False,
            cash_in=0.0,
            cash_out=0.0,
            profit_loss=0.0,
            holding_months=0.0,
            quiet_title_cost=0.0,
            penalty_received=0.0,
            details={"action": "pass"},
        )

    pred = predict_outcome(lot, bid_amount, sale_type, lessons)
    rng = _rng(seed or f"{lot.lot_id}:{bid_amount}")
    redeemed = rng.random() < pred.p_redeem

    statute = statute_for(lot.state)
    qt_cost = 0.0
    holding_months = 0.0
    penalty = 0.0
    cash_out = bid_amount

    if redeemed and statute and statute.get("redemption"):
        pen = statute["redemption"]["tiers"][0]["penalty"]
        penalty = bid_amount * pen
        # Capital returned + penalty
        cash_in = bid_amount + penalty
        profit = penalty
        ownership = False
        holding_months = rng.uniform(1, max(2, statute["redemption"]["maxDays"] / 30 / 2))
    elif redeemed:
        # Deed states with rare post-sale redeem — treat as break-even + small cost
        cash_in = bid_amount * 0.98
        profit = cash_in - cash_out
        ownership = False
    else:
        ownership = True
        if statute:
            qt = statute["quietTitle"]
            qt_cost = rng.uniform(qt["typicalLow"], qt["typicalHigh"])
            holding_months = qt["typicalMonths"] + rng.uniform(0, 3)
        else:
            qt_cost = rng.uniform(2000, 6000)
            holding_months = rng.uniform(3, 9)

        inputs = DealInputs(
            state=lot.state,
            sale_type=sale_type,
            opening_bid=lot.opening_bid,
            assessed_value=lot.assessed_value,
            arv_override=lot.arv_override,
            rehab_cost=lot.rehab_cost or rng.uniform(5000, 25000),
            surviving_liens=lot.surviving_liens or rng.choice([0, 0, 0, 2500, 8000]),
            holding_months=holding_months,
        )
        deal = compute_maxbid(inputs)
        arv = deal.arv_value or bid_amount * 1.5
        # Exit proceeds noisy around ARV net of costs
        exit_net = arv * rng.uniform(0.72, 0.95) - qt_cost
        cash_in = max(0.0, exit_net)
        profit = cash_in - cash_out - (deal.total_costs - qt_cost) * 0.5

    return SimulatedOutcome(
        redeemed=redeemed,
        ownership_taken=ownership,
        cash_in=round(cash_in, 2),
        cash_out=round(cash_out, 2),
        profit_loss=round(profit, 2),
        holding_months=round(holding_months, 2),
        quiet_title_cost=round(qt_cost, 2),
        penalty_received=round(penalty, 2),
        details={
            "p_redeem_used": pred.p_redeem,
            "seed": seed,
        },
    )
