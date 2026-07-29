"""Backtest harness — measure agent vs pure oracle baseline honesty metrics."""

from __future__ import annotations

from .schemas import BacktestMetrics, Trajectory


def run_backtest(trajectories: list[Trajectory]) -> BacktestMetrics:
    n = len(trajectories)
    if n == 0:
        return BacktestMetrics(
            n_lots=0,
            n_bids=0,
            n_passes=0,
            total_profit=0.0,
            mean_profit_per_lot=0.0,
            win_rate=0.0,
            calibration_error=0.0,
            vs_baseline_profit=0.0,
            promoted=False,
            notes=["empty"],
        )

    bids = [t for t in trajectories if t.action and t.action.bid_amount]
    passes = [t for t in trajectories if t.action and (t.action.pass_ or not t.action.bid_amount)]
    profits = [t.profit_loss or 0.0 for t in trajectories]
    total = sum(profits)
    wins = sum(1 for p in profits if p > 0)

    # Calibration: |predicted expected_profit sign vs realized|
    cal_errs = []
    for t in trajectories:
        if t.predicted_outcome and t.profit_loss is not None:
            cal_errs.append(abs(t.predicted_outcome.expected_profit - t.profit_loss))
    calibration_error = sum(cal_errs) / len(cal_errs) if cal_errs else 0.0

    # Baseline: always follow oracle max_bid exactly (mid) or pass
    baseline_profit = 0.0
    for t in trajectories:
        if not t.maxbid_result:
            continue
        if t.maxbid_result.recommendation != "bid" or t.maxbid_result.max_bid is None:
            continue
        # Use simulated outcome P/L as proxy when agent bid; else 0
        if t.simulated_or_real_outcome and t.action and t.action.bid_amount:
            # crude: baseline would have similar sim if bid at max
            baseline_profit += t.profit_loss or 0.0

    notes = []
    over_oracle = sum(
        1
        for t in bids
        if t.maxbid_result
        and t.maxbid_result.max_bid is not None
        and t.action
        and t.action.bid_amount
        and t.action.bid_amount > t.maxbid_result.max_bid
    )
    if over_oracle:
        notes.append(f"{over_oracle} bids exceeded oracle ceiling")

    return BacktestMetrics(
        n_lots=n,
        n_bids=len(bids),
        n_passes=len(passes),
        total_profit=round(total, 2),
        mean_profit_per_lot=round(total / n, 2),
        win_rate=round(wins / n, 3),
        calibration_error=round(calibration_error, 2),
        vs_baseline_profit=0.0,  # filled by flywheel comparing passes
        promoted=False,
        notes=notes,
    )
