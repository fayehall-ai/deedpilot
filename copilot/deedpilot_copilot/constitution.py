"""
Constitutional rules for the copilot — checked on every action.

These are non-negotiable product safety constraints, not soft style hints.
"""

CONSTITUTION = [
    "Never invent a walk-away price. Only use compute_maxbid oracle output.",
    "Never bid above the oracle max_bid after applying explicit risk buffers.",
    "When atlas.is_state_default is true, state that fact in the rationale and lower confidence.",
    "Always cite atlas asOf and sources when making jurisdiction claims.",
    "If data is insufficient for ARV, recommendation must be pass / insufficient-data.",
    "Prefer government sources of record over auction platforms blocked by policy.",
    "Do not claim profitability guarantees; outputs are research co-pilot advice.",
    "Unknown must be explicit — never paper over missing county research.",
]


def check_action_constitution(
    *,
    bid_amount: float | None,
    oracle_max_bid: float | None,
    is_state_default: bool,
    rationale: str,
    sources_used: list[str],
) -> list[str]:
    """Return list of constitutional violations (empty = pass)."""
    violations: list[str] = []
    if bid_amount is not None and oracle_max_bid is not None and bid_amount > oracle_max_bid + 1e-6:
        violations.append("bid_above_oracle_max_bid")
    if is_state_default and "state default" not in rationale.lower() and "not county" not in rationale.lower():
        violations.append("missing_state_default_disclosure")
    if bid_amount is not None and bid_amount > 0 and not sources_used:
        violations.append("missing_sources")
    return violations
