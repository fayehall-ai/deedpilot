"""
The Python max-bid engine must agree with the TypeScript one it replaced.

This is the gate on the migration. `tests/cases/maxbid_golden.json` was
produced by running `lib/deal/maxbid.ts` over the shared case table, before
the TypeScript was retired. Every figure a subscriber acts on is compared to
the cent, and every warning and basis string is compared verbatim -- the prose
is part of the contract, because it is what tells a bidder whether a number
was measured or assumed.

If this file ever fails, the port drifted. Fix the port, not the golden file:
regenerating it from a TypeScript tree that no longer exists is not possible,
which is the point.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from deedpilot.domain import DealInputs, compute_maxbid

CASES_DIR = Path(__file__).parent / "cases"
GOLDEN = json.loads((CASES_DIR / "maxbid_golden.json").read_text(encoding="utf-8"))

#: Cents. The two engines round identically, so this is a float-representation
#: tolerance, not a licence to disagree.
TOLERANCE = 0.005

#: Prose that changed *on purpose* when the engine moved to Python, with the
#: reason. Every entry is a phrase the TypeScript emitted that no longer
#: describes the system, so keeping it would have been a lie rather than a
#: parity win.
#:
#: This list is the only sanctioned way for the two engines to disagree, and it
#: is deliberately narrow: substitutions are exact strings, applied to the
#: TypeScript side before comparison, and anything not listed here still fails.
#: Adding an entry is a code review conversation, not a way to make a red test
#: green.
INTENTIONAL_DIVERGENCES: list[tuple[str, str, str]] = [
    (
        "in lib/deal/statute.ts",
        "on file",
        "That file no longer exists. Naming a dead TypeScript path in a message "
        "shown to a bidder tells them to go look at something that is not there.",
    ),
    (
        "Enter a comparable-sales estimate below and every figure on this page recalculates",
        "Enter a comparable-sales estimate and every figure recalculates",
        "There is no 'below' and no single 'page' any more. The same warning is "
        "now spoken aloud by the voice channel and read by the coach, where "
        "pointing at a form field underneath is meaningless.",
    ),
]


def _normalise(text: str) -> str:
    """Apply the reviewed prose divergences to a TypeScript-era string."""
    for old, new, _reason in INTENTIONAL_DIVERGENCES:
        text = text.replace(old, new)
    return text


def _ids() -> list[str]:
    return [c["name"] for c in GOLDEN]


def _approx(actual: float | None, expected: float | None, field: str) -> None:
    if expected is None or actual is None:
        assert actual == expected, f"{field}: python={actual!r} typescript={expected!r}"
        return
    assert abs(actual - expected) <= TOLERANCE, (
        f"{field}: python={actual!r} typescript={expected!r}"
    )


@pytest.fixture(params=GOLDEN, ids=_ids())
def case(request: pytest.FixtureRequest) -> dict[str, Any]:
    return request.param


def test_headline_figures_match(case: dict[str, Any]) -> None:
    """max_bid, profit, bid room, total costs, ARV -- the numbers people act on."""
    got = compute_maxbid(DealInputs.model_validate(case["inputs"]))
    want = case["result"]

    _approx(got.max_bid, want["maxBid"], "max_bid")
    _approx(got.projected_profit, want["projectedProfit"], "projected_profit")
    _approx(got.bid_room, want["bidRoom"], "bid_room")
    _approx(got.total_costs, want["totalCosts"], "total_costs")
    _approx(got.arv.value, want["arv"]["value"], "arv.value")


def test_verdicts_match(case: dict[str, Any]) -> None:
    """
    Recommendation and confidence are the summary a novice reads first.

    A port that gets the arithmetic right and the verdict wrong is worse than
    one that fails loudly.
    """
    got = compute_maxbid(DealInputs.model_validate(case["inputs"]))
    want = case["result"]

    assert got.recommendation == want["recommendation"]
    assert got.confidence == want["confidence"]


def test_arv_provenance_flags_match(case: dict[str, Any]) -> None:
    """
    Whether the ARV was measured, derived, overridden or assumed.

    These flags drive how the figure is rendered and whether the coach is
    allowed to sound confident about it, so they are as load-bearing as the
    value itself.
    """
    got = compute_maxbid(DealInputs.model_validate(case["inputs"]))
    want = case["result"]["arv"]

    assert got.arv.derived == want["derived"]
    assert got.arv.assumed == bool(want.get("assumed", False))
    assert got.arv.from_market == bool(want.get("fromMarket", False))
    assert got.arv.county_override == bool(want.get("countyOverride", False))
    assert got.arv.basis == _normalise(want["basis"])


def test_cost_lines_match(case: dict[str, Any]) -> None:
    """Every line, in order, with its label, amount, note and assumed flag."""
    got = compute_maxbid(DealInputs.model_validate(case["inputs"]))
    want = case["result"]["costs"]

    assert [c.label for c in got.costs] == [c["label"] for c in want]
    for mine, theirs in zip(got.costs, want, strict=True):
        _approx(mine.amount, theirs["amount"], f"cost[{mine.label}].amount")
        assert mine.assumed == theirs["assumed"], f"cost[{mine.label}].assumed"
        assert mine.note == _normalise(theirs["note"]), f"cost[{mine.label}].note"


def test_redemption_matches(case: dict[str, Any]) -> None:
    """Including the bid-down observation, where the market sets the rate."""
    got = compute_maxbid(DealInputs.model_validate(case["inputs"]))
    want = case["result"].get("redemption")

    if want is None:
        assert got.redemption is None
        return

    assert got.redemption is not None
    assert got.redemption.window_days == want["windowDays"]
    _approx(got.redemption.flat_penalty, want["flatPenalty"], "flat_penalty")
    _approx(got.redemption.penalty_at_max_bid, want["penaltyAtMaxBid"], "penalty_at_max_bid")
    _approx(
        got.redemption.annualised_best_case,
        want["annualisedBestCase"],
        "annualised_best_case",
    )
    assert got.redemption.note == _normalise(want["note"])

    observed = want.get("marketPenalty")
    if observed is None:
        assert got.redemption.market_penalty is None
    else:
        assert got.redemption.market_penalty is not None
        _approx(
            got.redemption.market_penalty.penalty_at_max_bid_observed,
            observed["penaltyAtMaxBidObserved"],
            "market_penalty.penalty_at_max_bid_observed",
        )
        assert got.redemption.market_penalty.n == observed["n"]


def test_warnings_match_verbatim(case: dict[str, Any]) -> None:
    """
    Warnings are the safety surface, so they are compared as exact strings.

    A reworded warning is a product change and should break this test until
    someone regenerates the expectation deliberately.
    """
    got = compute_maxbid(DealInputs.model_validate(case["inputs"]))
    assert got.warnings == [_normalise(w) for w in case["result"]["warnings"]]


def test_case_table_covers_every_engine_branch() -> None:
    """
    The golden table is only as good as its coverage.

    Asserted explicitly so a future contributor cannot quietly narrow it: each
    of these is a distinct code path with a distinct way of costing a bidder
    money if it breaks.
    """
    results = [compute_maxbid(DealInputs.model_validate(c["inputs"])) for c in GOLDEN]

    assert any(r.recommendation == "bid" for r in results)
    assert any(r.recommendation == "no-bid" for r in results)
    assert any(r.recommendation == "insufficient-data" for r in results)
    assert any(r.confidence == "high" for r in results)
    assert any(r.confidence == "medium" for r in results)
    assert any(r.confidence == "low" for r in results)
    assert any(r.arv.assumed for r in results), "no floor-ratio case"
    assert any(r.arv.from_market for r in results), "no provider-market-estimate case"
    assert any(r.arv.county_override for r in results), "no county-ratio-override case"
    assert any(not r.arv.derived and r.arv.value for r in results), "no comps-override case"
    assert any(
        r.redemption and r.redemption.market_penalty for r in results
    ), "no bid-down case"
    assert any(r.statute is None for r in results), "no uncovered-state case"
