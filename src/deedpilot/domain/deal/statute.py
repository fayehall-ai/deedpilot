"""
Structured statutory parameters for the deal maths.

The atlas stores redemption rules as prose, which is right for reading and
useless for arithmetic. This module serves the same rules as numbers, for the
covered states only -- every entry carries its statute citation and a check
date, and a state without an entry returns None so the engine degrades to
"we cannot compute this, here is the prose" instead of inventing a number.

These figures move with legislation. `staleness_months` exists so a caller can
refuse to price against a citation nobody has re-read in a year.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from deedpilot.config import settings

#: Everything downstream reads these two tables and nothing else.
_STATUTE_FILE = "statute.json"


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    path = settings().data_dir / _STATUTE_FILE
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. Statutory parameters are required to price anything; "
            "this file is checked in and should never be absent."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def reload() -> None:
    """Drop the in-process cache, after the data file is regenerated."""
    _load.cache_clear()


def statute_for(state: str) -> dict[str, Any] | None:
    """
    Statutory parameters for a state, or None where they have not been verified.

    None is a load-bearing answer. It is the difference between "Arkansas
    redemption is 10%" and "nobody has read the Arkansas statute for this
    codebase yet", and the engine must never blur the two.
    """
    return _load()["statuteParams"].get(state.strip().upper())


def covered_states() -> list[str]:
    """States with verified statutory parameters, sorted."""
    return sorted(_load()["statuteParams"])


def floor_ratio_for(state: str) -> dict[str, Any] | None:
    """
    Observed value-to-opening-bid ratio for a state, where it has been measured.

    Only states with enough usable pairs have an entry; the rest get no floor
    at all, which is the correct answer rather than a missing one. A national
    average would be wrong in both directions at once -- the ratio runs 0.76 at
    the 10th percentile to 24.20 at the 90th, and state medians differ by 6x.
    """
    return _load()["floorRatios"].get(state.strip().upper())


def floor_ratios_as_of() -> str:
    """When the floor table was measured, for display beside any figure from it."""
    return str(_load()["floorRatiosAsOf"])


def staleness_months(state: str, *, now: datetime | None = None) -> int | None:
    """
    Months since this state's statutory parameters were last checked.

    None when the state is uncovered or carries no `asOf`. Surfaced rather than
    enforced here: the engine reports age, and the caller decides what age is
    too old for the decision it is making.
    """
    params = statute_for(state)
    if not params or not params.get("asOf"):
        return None
    try:
        checked = datetime.strptime(str(params["asOf"]), "%Y-%m").replace(tzinfo=UTC)
    except ValueError:
        return None
    ref = now or datetime.now(UTC)
    return (ref.year - checked.year) * 12 + (ref.month - checked.month)
