"""
Backtest the agent on recorded historical lots.

For each historical outcome:
  1. Build a Lot from bid-time fields.
  2. Run DeedCopilotAgent (history-guided).
  3. Score:
     - policy: never bid above oracle max_bid
     - when disposition_known (profit_loss recorded or exit known): compare
       agent bid vs actual winning bid / replay P&L
     - otherwise: report market-relative bid (agent vs actual winning bid)
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from .agent import DeedCopilotAgent
from .backtest import run_backtest
from .historical_sim import lot_from_historical, replay_historical
from .history import load_outcomes, real_outcomes_only
from .memory import LessonMemory
from .schemas import HistoricalOutcome, SaleType


def _sample_outcomes(
    outcomes: list[HistoricalOutcome],
    *,
    state: str | None,
    sale_type: str | None,
    limit: int,
    require_winning_bid: bool = True,
) -> list[HistoricalOutcome]:
    rows = real_outcomes_only(outcomes)
    if state:
        rows = [o for o in rows if o.state == state.upper()]
    if sale_type:
        rows = [o for o in rows if o.sale_type.value == sale_type]
    if require_winning_bid:
        rows = [o for o in rows if o.winning_bid is not None and o.winning_bid > 0]
    # Prefer diversity: round-robin by state
    by_state: dict[str, list[HistoricalOutcome]] = {}
    for o in rows:
        by_state.setdefault(o.state, []).append(o)
    out: list[HistoricalOutcome] = []
    keys = list(by_state.keys())
    idx = {k: 0 for k in keys}
    while len(out) < limit and keys:
        progressed = False
        for k in list(keys):
            i = idx[k]
            if i >= len(by_state[k]):
                keys.remove(k)
                continue
            out.append(by_state[k][i])
            idx[k] = i + 1
            progressed = True
            if len(out) >= limit:
                break
        if not progressed:
            break
    return out


def run_historical_backtest(
    *,
    limit: int = 80,
    state: str | None = None,
    sale_type: str | None = None,
    memory: LessonMemory | None = None,
) -> dict[str, Any]:
    outcomes = load_outcomes()
    sample = _sample_outcomes(
        outcomes, state=state, sale_type=sale_type, limit=limit
    )
    agent = DeedCopilotAgent(memory=memory or LessonMemory())

    trajectories = []
    comparisons: list[dict[str, Any]] = []
    over_oracle = 0
    bids = 0
    passes = 0
    under_market = 0  # agent bid < actual winning (would not have won)
    at_or_over_market = 0
    disposition_known = 0

    for h in sample:
        lot = lot_from_historical(h)
        # Many Title Check past rows omit SEV/assessed. For maxbid to run we
        # impute a conservative ARV proxy from the sold price (metadata flagged).
        if lot.assessed_value is None and lot.arv_override is None and h.winning_bid:
            # Assume sold price is ~20–30% of market — use 4× as assessed proxy
            proxy = float(h.winning_bid) * 4.0
            lot.assessed_value = proxy
            lot.metadata["assessed_imputed"] = True
            lot.metadata["assessed_impute_rule"] = "winning_bid * 4"
        traj = agent.run_lot(lot, seed=f"hist-bt-{h.id}")
        trajectories.append(traj)

        action = traj.action
        agent_bid = action.bid_amount if action else None
        is_pass = bool(action and (action.pass_ or not agent_bid))
        if is_pass:
            passes += 1
        else:
            bids += 1

        oracle_max = traj.maxbid_result.max_bid if traj.maxbid_result else None
        if (
            agent_bid is not None
            and oracle_max is not None
            and agent_bid > oracle_max + 1e-6
        ):
            over_oracle += 1

        actual_win = h.winning_bid
        market_rel = None
        if agent_bid is not None and actual_win:
            market_rel = round(agent_bid - actual_win, 2)
            if agent_bid + 1e-6 < actual_win:
                under_market += 1
            else:
                at_or_over_market += 1

        replay = replay_historical(h)
        disp = bool((replay.details or {}).get("disposition_known"))
        if disp:
            disposition_known += 1

        hist = None
        if traj.reasoning_trace:
            # pull history guidance line if present
            hist = next((x for x in traj.reasoning_trace if x.startswith("History:")), None)

        comparisons.append(
            {
                "historical_id": h.id,
                "state": h.state,
                "sale_type": h.sale_type.value,
                "actual_winning_bid": actual_win,
                "agent_bid": agent_bid,
                "agent_pass": is_pass,
                "oracle_max_bid": oracle_max,
                "oracle_recommendation": (
                    traj.maxbid_result.recommendation if traj.maxbid_result else None
                ),
                "bid_minus_market": market_rel,
                "disposition_known": disp,
                "replay_profit_loss": replay.profit_loss if disp else None,
                "sim_profit_loss": traj.profit_loss,
                "history_note": hist,
                "critique_score": (traj.critique or {}).get("score"),
            }
        )

    metrics = run_backtest(trajectories)
    by_state = Counter(h.state for h in sample)

    return {
        "n_sample": len(sample),
        "by_state": dict(by_state),
        "n_bids": bids,
        "n_passes": passes,
        "n_over_oracle": over_oracle,
        "oracle_violation_rate": round(over_oracle / len(sample), 4) if sample else 0.0,
        "n_under_market": under_market,
        "n_at_or_over_market": at_or_over_market,
        "n_disposition_known": disposition_known,
        "metrics": metrics.model_dump(),
        "comparisons": comparisons,
        "notes": [
            "Policy success = zero bids above oracle max_bid.",
            "under_market = agent bid would not have cleared actual auction price.",
            "disposition_known is rare without investor exit logs; market-relative bid is primary signal.",
        ],
    }
