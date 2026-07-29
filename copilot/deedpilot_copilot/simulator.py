"""
Outcome simulator — samples redemption / ownership using historical noise + priors.

Fidelity is intentionally conservative. Real tax-deed outcomes are sparse/noisy;
this module must never invent certainty. Historical outcomes (JSONL) calibrate
the noise model with expert-prior shrinkage when sample size is small.
"""

from __future__ import annotations

import hashlib
import random
from typing import Any

from .history import (
    apply_bid_arv_adjustment,
    expert_p_redeem,
    get_priors,
    resolve_bucket,
    sample_exit_mult,
    sample_holding_months,
    sample_qt_cost,
    sample_rehab,
    sample_surviving_liens,
)
from .maxbid import compute_maxbid
from .schemas import DealInputs, Lot, PredictedOutcome, SaleType, SimulatedOutcome
from .statute import statute_for


def _rng(seed: str) -> random.Random:
    h = hashlib.sha256(seed.encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def base_p_redeem(
    state: str,
    sale_type: SaleType,
    opening_bid: float | None,
    arv: float | None,
    *,
    use_history: bool = True,
) -> tuple[float, dict[str, Any]]:
    """
    Redemption probability + audit meta.

    When historical outcomes exist, use the shrunk empirical rate for
    (state, sale_type), then apply bid/ARV structural adjustment.
    Falls back to expert priors when history is empty.
    """
    meta: dict[str, Any] = {"source": "expert"}
    if use_history:
        try:
            priors = get_priors()
            bucket = resolve_bucket(priors, state, sale_type)
            p = bucket.p_redeem
            meta = {
                "source": "historical" if bucket.n > 0 else "expert",
                "bucket": bucket.key,
                "n": bucket.n,
                "p_redeem_raw": bucket.p_redeem_raw,
                "expert_p_redeem": bucket.expert_p_redeem,
                "prior_strength": priors.prior_strength,
                "n_outcomes_total": priors.n_outcomes,
            }
        except Exception:  # noqa: BLE001 — never break simulation on history load
            p = expert_p_redeem(state, sale_type)
            meta = {"source": "expert_fallback_error"}
    else:
        p = expert_p_redeem(state, sale_type)

    p = apply_bid_arv_adjustment(p, opening_bid, arv)
    return max(0.02, min(0.95, p)), meta


def predict_outcome(
    lot: Lot,
    bid_amount: float | None,
    sale_type: SaleType,
    lessons: list[dict[str, Any]] | None = None,
    *,
    use_history: bool = True,
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
    p, prior_meta = base_p_redeem(
        lot.state, sale_type, lot.opening_bid, arv, use_history=use_history
    )

    # Apply active lessons
    notes: list[str] = []
    if prior_meta.get("source") == "historical":
        notes.append(
            f"p_redeem from history bucket {prior_meta.get('bucket')} "
            f"n={prior_meta.get('n')} (shrunk)."
        )
    else:
        notes.append("Expert prior p_redeem (no/insufficient history bucket).")

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
    *,
    use_history: bool = True,
) -> SimulatedOutcome:
    """Sample one Monte Carlo path for training / backtest (history-calibrated noise)."""
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

    pred = predict_outcome(
        lot, bid_amount, sale_type, lessons, use_history=use_history
    )
    rng = _rng(seed or f"{lot.lot_id}:{bid_amount}")
    redeemed = rng.random() < pred.p_redeem

    statute = statute_for(lot.state)
    qt_cost = 0.0
    holding_months = 0.0
    penalty = 0.0
    cash_out = bid_amount
    noise_meta: dict[str, Any] = {"history": False}

    bucket = None
    if use_history:
        try:
            priors = get_priors()
            bucket = resolve_bucket(priors, lot.state, sale_type)
            noise_meta = {
                "history": True,
                "bucket": bucket.key,
                "n": bucket.n,
                "exit_mult_p50": bucket.exit_mult_p50,
                "lien_rate": bucket.lien_rate,
                "n_outcomes_total": priors.n_outcomes,
            }
        except Exception as e:  # noqa: BLE001
            noise_meta = {"history": False, "error": str(e)[:120]}

    if redeemed and statute and statute.get("redemption"):
        pen = statute["redemption"]["tiers"][0]["penalty"]
        penalty = bid_amount * pen
        cash_in = bid_amount + penalty
        profit = penalty
        ownership = False
        if bucket is not None:
            holding_months = sample_holding_months(
                bucket, statute, rng, redeemed=True
            )
        else:
            holding_months = rng.uniform(
                1, max(2, statute["redemption"]["maxDays"] / 30 / 2)
            )
    elif redeemed:
        # Deed states with rare post-sale redeem — treat as break-even + small cost
        cash_in = bid_amount * 0.98
        profit = cash_in - cash_out
        ownership = False
        holding_months = (
            sample_holding_months(bucket, statute, rng, redeemed=True)
            if bucket is not None
            else rng.uniform(1, 4)
        )
    else:
        ownership = True
        if bucket is not None:
            qt_cost = sample_qt_cost(bucket, statute, rng)
            holding_months = sample_holding_months(
                bucket, statute, rng, redeemed=False
            )
            liens = (
                lot.surviving_liens
                if lot.surviving_liens is not None
                else sample_surviving_liens(bucket, rng)
            )
            rehab = sample_rehab(bucket, lot.rehab_cost, rng)
            exit_mult = sample_exit_mult(bucket, rng)
            noise_meta["exit_mult_drawn"] = round(exit_mult, 4)
            noise_meta["liens_drawn"] = round(liens, 2)
            noise_meta["rehab_drawn"] = round(rehab, 2)
        else:
            if statute:
                qt = statute["quietTitle"]
                qt_cost = rng.uniform(qt["typicalLow"], qt["typicalHigh"])
                holding_months = qt["typicalMonths"] + rng.uniform(0, 3)
            else:
                qt_cost = rng.uniform(2000, 6000)
                holding_months = rng.uniform(3, 9)
            liens = lot.surviving_liens if lot.surviving_liens is not None else rng.choice(
                [0, 0, 0, 2500, 8000]
            )
            rehab = lot.rehab_cost if lot.rehab_cost else rng.uniform(5000, 25000)
            exit_mult = rng.uniform(0.72, 0.95)

        inputs = DealInputs(
            state=lot.state,
            sale_type=sale_type,
            opening_bid=lot.opening_bid,
            assessed_value=lot.assessed_value,
            arv_override=lot.arv_override,
            rehab_cost=rehab,
            surviving_liens=liens,
            holding_months=holding_months,
        )
        deal = compute_maxbid(inputs)
        arv = deal.arv_value or bid_amount * 1.5
        # Exit proceeds from historical exit-mult distribution around ARV
        exit_net = arv * exit_mult - qt_cost
        cash_in = max(0.0, exit_net)
        # Remaining cost drag (rehab/liens already partly in deal.total_costs)
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
            "noise": noise_meta,
            "prediction_notes": pred.notes,
        },
    )
