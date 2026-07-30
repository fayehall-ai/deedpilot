"""
Minimal historical-lot simulator.

Two modes on a recorded (or seed) auction row:

  replay  — lock the observed path (redemption flag + actual costs / P&L)
  sample  — keep lot economics (bid, ARV, opening) and re-draw redemption
            and/or ownership costs from the calibrated noise model

This is the unit of backtest fidelity: agents bid on historical *inputs*;
outcomes either play back reality or Monte Carlo around it.
"""

from __future__ import annotations

import hashlib
import random
import statistics
from typing import Any, Literal

from .history import (
    get_priors,
    load_outcomes,
    resolve_bucket,
    sample_exit_mult,
    sample_holding_months,
    sample_qt_cost,
    sample_rehab,
    sample_surviving_liens,
)
from .maxbid import compute_maxbid
from .schemas import (
    DealInputs,
    HistoricalOutcome,
    Lot,
    SaleType,
    SimulatedOutcome,
)
from .statute import statute_for
from .simulator import base_p_redeem, predict_outcome

SimMode = Literal["replay", "sample", "costs_only"]


def _rng(seed: str) -> random.Random:
    h = hashlib.sha256(seed.encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def get_outcome(outcome_id: str) -> HistoricalOutcome:
    """Load one historical row by id from data/historical_outcomes.jsonl."""
    for o in load_outcomes():
        if o.id == outcome_id:
            return o
    raise KeyError(f"Unknown historical outcome id: {outcome_id}")


def list_outcomes(
    *,
    state: str | None = None,
    sale_type: str | SaleType | None = None,
    limit: int | None = None,
) -> list[HistoricalOutcome]:
    st = sale_type.value if isinstance(sale_type, SaleType) else sale_type
    rows = load_outcomes()
    if state:
        rows = [r for r in rows if r.state == state.upper()]
    if st:
        rows = [r for r in rows if r.sale_type.value == st]
    if limit is not None:
        rows = rows[:limit]
    return rows


def lot_from_historical(h: HistoricalOutcome) -> Lot:
    """
    Auction *inputs* known (or estimable) at bid time.

    Uses opening bid / assessed / ARV / rehab from the record; winning bid is
    not forced onto the lot (that is the decision variable when replaying
    with an agent bid).
    """
    return Lot(
        lot_id=h.id,
        fips=h.fips or f"{h.state}-unknown",
        state=h.state,
        county_name=h.county_name,
        opening_bid=h.opening_bid,
        assessed_value=h.assessed_value,
        arv_override=h.arv_estimate,
        rehab_cost=h.rehab_cost,
        surviving_liens=h.surviving_liens,
        sale_type=h.sale_type,
        metadata={
            "historical_id": h.id,
            "sale_date": h.sale_date,
            "winning_bid": h.winning_bid,
            "provenance": h.provenance,
            "redeemed_actual": h.redeemed,
            "ownership_actual": h.ownership_taken,
        },
    )


def bid_from_historical(h: HistoricalOutcome) -> float | None:
    """Capital at risk: prefer recorded winning bid, else opening."""
    if h.winning_bid is not None and h.winning_bid > 0:
        return float(h.winning_bid)
    if h.opening_bid is not None and h.opening_bid > 0:
        return float(h.opening_bid)
    return None


def _penalty_rate(h: HistoricalOutcome) -> float:
    if h.penalty_rate is not None:
        return float(h.penalty_rate)
    statute = statute_for(h.state)
    if statute and statute.get("redemption"):
        return float(statute["redemption"]["tiers"][0]["penalty"])
    return 0.0


def replay_historical(
    h: HistoricalOutcome | str,
    *,
    bid_amount: float | None = None,
) -> SimulatedOutcome:
    """
    Replay the *recorded* path — no Monte Carlo.

    Uses observed redeemed / costs / exit / profit_loss when present.
    ``bid_amount`` overrides winning bid only for cash_out (counterfactual bid
    on a fixed outcome path — rare; default is recorded bid).
    """
    if isinstance(h, str):
        h = get_outcome(h)

    cash_out = float(bid_amount if bid_amount is not None else (bid_from_historical(h) or 0.0))
    if cash_out <= 0:
        return SimulatedOutcome(
            redeemed=False,
            ownership_taken=False,
            cash_in=0.0,
            cash_out=0.0,
            profit_loss=0.0,
            holding_months=0.0,
            quiet_title_cost=0.0,
            penalty_received=0.0,
            details={"mode": "replay", "action": "no_bid", "historical_id": h.id},
        )

    holding = float(h.holding_months or 0.0)
    if h.days_to_redeem is not None and not holding:
        holding = float(h.days_to_redeem) / 30.0

    if h.redeemed:
        pen_rate = _penalty_rate(h)
        penalty = cash_out * pen_rate
        # If recorded P/L exists and bid matches recorded, prefer it
        if (
            h.profit_loss is not None
            and bid_amount is None
            and h.winning_bid is not None
        ):
            profit = float(h.profit_loss)
            cash_in = cash_out + profit
            penalty = max(0.0, profit) if pen_rate > 0 else 0.0
        else:
            cash_in = cash_out + penalty
            profit = penalty if pen_rate > 0 else cash_in - cash_out
        return SimulatedOutcome(
            redeemed=True,
            ownership_taken=False,
            cash_in=round(cash_in, 2),
            cash_out=round(cash_out, 2),
            profit_loss=round(profit, 2),
            holding_months=round(holding, 2),
            quiet_title_cost=0.0,
            penalty_received=round(penalty, 2),
            details={
                "mode": "replay",
                "historical_id": h.id,
                "provenance": h.provenance,
                "penalty_rate": pen_rate,
                "sale_date": h.sale_date,
            },
        )

    # Ownership path
    qt = float(h.quiet_title_cost or 0.0)
    liens = float(h.surviving_liens or 0.0)
    rehab = float(h.rehab_cost or 0.0)
    exit_price = h.exit_price
    disposition_known = (
        h.profit_loss is not None or (exit_price is not None and exit_price > 0)
    )

    if h.profit_loss is not None and bid_amount is None:
        profit = float(h.profit_loss)
        cash_in = cash_out + profit  # reconstruct net cash-in consistent with P/L
    elif exit_price is not None and exit_price > 0:
        cash_in = max(0.0, float(exit_price) - qt)
        profit = cash_in - cash_out - liens - rehab * 0.5
    else:
        # Auction result only: capital at risk known, disposition not published.
        # Do not invent a full capital loss.
        cash_in = 0.0
        profit = 0.0

    return SimulatedOutcome(
        redeemed=False,
        ownership_taken=True,
        cash_in=round(cash_in, 2),
        cash_out=round(cash_out, 2),
        profit_loss=round(profit, 2),
        holding_months=round(holding, 2),
        quiet_title_cost=round(qt, 2),
        penalty_received=0.0,
        details={
            "mode": "replay",
            "historical_id": h.id,
            "provenance": h.provenance,
            "exit_price": exit_price,
            "surviving_liens": liens,
            "rehab_cost": rehab,
            "sale_date": h.sale_date,
            "disposition_known": disposition_known,
            "note": (
                None
                if disposition_known
                else "Auction sold price only — exit/rehab/P&L unknown until investor log."
            ),
        },
    )


def sample_historical(
    h: HistoricalOutcome | str,
    *,
    mode: Literal["sample", "costs_only"] = "sample",
    seed: str | None = None,
    bid_amount: float | None = None,
    use_history: bool = True,
) -> SimulatedOutcome:
    """
    Sample one alternate path for a historical lot.

    Parameters
    ----------
    mode
        ``sample`` — draw redemption *and* ownership costs from priors.
        ``costs_only`` — lock recorded redeemed/ownership; re-draw costs only
        when ownership is taken (redemption path still uses statute penalty).
    bid_amount
        Override capital at risk (default: recorded winning/opening bid).
    """
    if isinstance(h, str):
        h = get_outcome(h)

    lot = lot_from_historical(h)
    cash_out = float(bid_amount if bid_amount is not None else (bid_from_historical(h) or 0.0))
    if cash_out <= 0:
        return SimulatedOutcome(
            redeemed=False,
            ownership_taken=False,
            cash_in=0.0,
            cash_out=0.0,
            profit_loss=0.0,
            holding_months=0.0,
            quiet_title_cost=0.0,
            penalty_received=0.0,
            details={"mode": mode, "action": "no_bid", "historical_id": h.id},
        )

    sale_type = h.sale_type
    seed_s = seed or f"{h.id}:{mode}:{cash_out}"
    rng = _rng(seed_s)

    pred = predict_outcome(lot, cash_out, sale_type, use_history=use_history)
    p_redeem = pred.p_redeem

    if mode == "costs_only":
        redeemed = bool(h.redeemed)
    else:
        redeemed = rng.random() < p_redeem

    statute = statute_for(h.state)
    bucket = None
    noise_meta: dict[str, Any] = {"history": False}
    if use_history:
        try:
            priors = get_priors()
            bucket = resolve_bucket(priors, h.state, sale_type)
            noise_meta = {
                "history": True,
                "bucket": bucket.key,
                "n": bucket.n,
                "p_redeem": p_redeem,
            }
        except Exception as e:  # noqa: BLE001
            noise_meta = {"history": False, "error": str(e)[:120]}

    if redeemed:
        pen_rate = _penalty_rate(h)
        if pen_rate > 0:
            penalty = cash_out * pen_rate
            cash_in = cash_out + penalty
            profit = penalty
        else:
            # Pure deed / rare redeem: small friction
            cash_in = cash_out * 0.98
            penalty = 0.0
            profit = cash_in - cash_out
        holding = (
            sample_holding_months(bucket, statute, rng, redeemed=True)
            if bucket is not None
            else rng.uniform(1, 6)
        )
        return SimulatedOutcome(
            redeemed=True,
            ownership_taken=False,
            cash_in=round(cash_in, 2),
            cash_out=round(cash_out, 2),
            profit_loss=round(profit, 2),
            holding_months=round(holding, 2),
            quiet_title_cost=0.0,
            penalty_received=round(penalty, 2),
            details={
                "mode": mode,
                "historical_id": h.id,
                "p_redeem_used": p_redeem,
                "seed": seed_s,
                "noise": noise_meta,
                "locked_redemption": mode == "costs_only",
            },
        )

    # Ownership — sample actual costs
    if bucket is not None:
        qt = sample_qt_cost(bucket, statute, rng)
        holding = sample_holding_months(bucket, statute, rng, redeemed=False)
        # Prefer recorded rehab/liens as anchors when present; else sample
        if h.rehab_cost is not None and mode == "costs_only":
            # jitter around recorded rehab
            rehab = max(0.0, float(rng.gauss(h.rehab_cost, max(1000.0, h.rehab_cost * 0.15))))
        else:
            rehab = sample_rehab(bucket, h.rehab_cost, rng)
        if h.surviving_liens is not None and mode == "costs_only":
            liens = max(
                0.0,
                float(rng.gauss(h.surviving_liens, max(500.0, abs(h.surviving_liens) * 0.2 + 1))),
            )
        else:
            liens = (
                float(h.surviving_liens)
                if h.surviving_liens is not None and mode == "sample" and rng.random() < 0.3
                else sample_surviving_liens(bucket, rng)
            )
        exit_mult = sample_exit_mult(bucket, rng)
        # costs_only: pull exit toward recorded exit/ARV if available
        if mode == "costs_only" and h.exit_price and (h.arv_estimate or h.assessed_value):
            arv0 = float(h.arv_estimate or h.assessed_value or 0)
            if arv0 > 0:
                recorded_mult = h.exit_price / arv0
                exit_mult = 0.6 * recorded_mult + 0.4 * exit_mult
    else:
        if statute:
            qt = float(
                rng.uniform(
                    statute["quietTitle"]["typicalLow"],
                    statute["quietTitle"]["typicalHigh"],
                )
            )
            holding = float(statute["quietTitle"]["typicalMonths"] + rng.uniform(0, 3))
        else:
            qt = float(rng.uniform(2000, 6000))
            holding = float(rng.uniform(3, 9))
        rehab = float(h.rehab_cost if h.rehab_cost is not None else rng.uniform(5000, 25000))
        liens = float(h.surviving_liens if h.surviving_liens is not None else 0.0)
        exit_mult = float(rng.uniform(0.72, 0.95))

    arv = h.arv_estimate
    if arv is None and h.assessed_value is not None:
        deal_probe = compute_maxbid(
            DealInputs(
                state=h.state,
                sale_type=sale_type,
                assessed_value=h.assessed_value,
                arv_override=None,
            )
        )
        arv = deal_probe.arv_value
    if arv is None:
        arv = cash_out * 1.5

    exit_price = float(arv) * exit_mult
    cash_in = max(0.0, exit_price - qt)
    profit = cash_in - cash_out - liens - rehab * 0.5

    noise_meta = {
        **noise_meta,
        "exit_mult_drawn": round(exit_mult, 4),
        "exit_price_drawn": round(exit_price, 2),
        "liens_drawn": round(liens, 2),
        "rehab_drawn": round(rehab, 2),
        "qt_drawn": round(qt, 2),
        "arv_used": round(float(arv), 2),
    }

    return SimulatedOutcome(
        redeemed=False,
        ownership_taken=True,
        cash_in=round(cash_in, 2),
        cash_out=round(cash_out, 2),
        profit_loss=round(profit, 2),
        holding_months=round(holding, 2),
        quiet_title_cost=round(qt, 2),
        penalty_received=0.0,
        details={
            "mode": mode,
            "historical_id": h.id,
            "p_redeem_used": p_redeem,
            "seed": seed_s,
            "noise": noise_meta,
            "locked_redemption": mode == "costs_only",
        },
    )


def simulate_historical(
    h: HistoricalOutcome | str,
    *,
    mode: SimMode = "replay",
    seed: str | None = None,
    bid_amount: float | None = None,
    use_history: bool = True,
) -> SimulatedOutcome:
    """Dispatch replay | sample | costs_only for one historical lot."""
    if mode == "replay":
        return replay_historical(h, bid_amount=bid_amount)
    if mode in ("sample", "costs_only"):
        return sample_historical(
            h,
            mode=mode,  # type: ignore[arg-type]
            seed=seed,
            bid_amount=bid_amount,
            use_history=use_history,
        )
    raise ValueError(f"Unknown mode: {mode}")


def monte_carlo_historical(
    h: HistoricalOutcome | str,
    *,
    n: int = 100,
    mode: Literal["sample", "costs_only"] = "sample",
    seed: str | None = None,
    bid_amount: float | None = None,
    use_history: bool = True,
) -> dict[str, Any]:
    """
    Run n sample paths and summarize P/L / redeem rate vs the replay baseline.
    """
    if isinstance(h, str):
        h = get_outcome(h)
    if n < 1:
        raise ValueError("n must be >= 1")

    base_seed = seed or h.id
    paths = [
        sample_historical(
            h,
            mode=mode,
            seed=f"{base_seed}:mc:{i}",
            bid_amount=bid_amount,
            use_history=use_history,
        )
        for i in range(n)
    ]
    replay = replay_historical(h, bid_amount=bid_amount)
    pls = [p.profit_loss for p in paths]
    redeem_rate = sum(1 for p in paths if p.redeemed) / n
    ownership_rate = sum(1 for p in paths if p.ownership_taken) / n

    lot = lot_from_historical(h)
    bid = bid_amount if bid_amount is not None else bid_from_historical(h)
    p_model, meta = base_p_redeem(
        h.state,
        h.sale_type,
        h.opening_bid,
        h.arv_estimate or h.assessed_value,
        use_history=use_history,
    )

    return {
        "historical_id": h.id,
        "mode": mode,
        "n": n,
        "bid_amount": bid,
        "state": h.state,
        "sale_type": h.sale_type.value,
        "model_p_redeem": p_model,
        "p_redeem_meta": meta,
        "sample_redeem_rate": round(redeem_rate, 4),
        "sample_ownership_rate": round(ownership_rate, 4),
        "actual_redeemed": h.redeemed,
        "replay_profit_loss": replay.profit_loss,
        "mean_profit": round(statistics.mean(pls), 2),
        "median_profit": round(statistics.median(pls), 2),
        "stdev_profit": round(statistics.pstdev(pls), 2) if n > 1 else 0.0,
        "p10_profit": round(sorted(pls)[max(0, int(0.1 * (n - 1)))], 2),
        "p90_profit": round(sorted(pls)[min(n - 1, int(0.9 * (n - 1)))], 2),
        "win_rate": round(sum(1 for x in pls if x > 0) / n, 4),
        "lot": lot.model_dump(by_alias=True, mode="json"),
    }


def batch_replay(
    outcomes: list[HistoricalOutcome] | None = None,
    *,
    state: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Replay many historical lots; return aggregate actual P/L stats."""
    rows = outcomes if outcomes is not None else list_outcomes(state=state, limit=limit)
    sims = [replay_historical(r) for r in rows]
    pls = [s.profit_loss for s in sims]
    n = len(sims)
    if n == 0:
        return {"n": 0, "total_profit": 0.0}
    return {
        "n": n,
        "n_redeemed": sum(1 for s in sims if s.redeemed),
        "n_ownership": sum(1 for s in sims if s.ownership_taken),
        "total_profit": round(sum(pls), 2),
        "mean_profit": round(statistics.mean(pls), 2),
        "median_profit": round(statistics.median(pls), 2),
        "win_rate": round(sum(1 for x in pls if x > 0) / n, 4),
    }
