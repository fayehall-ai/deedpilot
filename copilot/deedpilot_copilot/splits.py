"""
Frozen temporal splits over the historical corpus.

Auction outcomes are a time series. Random splits leak: the same county's spring
and fall sales land on both sides, and a model that has seen 2025 Genesee County
prices will look brilliant at "predicting" 2025 Genesee County prices. Every
number this repo reports as evidence of improvement has to come from a split the
fitting code never touched.

Design
------
- **Temporal.** Train on the past, validate on the next year, test on the newest.
- **Frozen.** The policy is written to ``data/splits.json`` with a digest. Later
  runs load it; changing the cut dates requires ``rebuild=True``, so a split
  cannot quietly drift to flatter a result.
- **Undated rows are excluded, not guessed.** ~2.4k rows carry no sale_date. They
  cannot be time-ordered, so they are dropped from every split rather than parked
  in train where they might be future rows leaking backwards.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Literal

from pydantic import BaseModel, Field

from .labels import classify
from .schemas import HistoricalOutcome, utc_now

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_SPLITS_PATH = DATA_DIR / "splits.json"

Split = Literal["train", "val", "test", "excluded"]

#: Default cuts. Chosen from the usable corpus (MI Title Check + CA county sales
#: run 2018–2026 at ~1.7–2.2k rows/yr): train through 2023, validate on 2024,
#: hold out 2025 and later.
DEFAULT_CUT_VAL = "2024-01-01"
DEFAULT_CUT_TEST = "2025-01-01"


class SplitPolicy(BaseModel):
    """The frozen rule that assigns a row to a split."""

    policy: Literal["temporal"] = "temporal"
    cut_val: str = DEFAULT_CUT_VAL
    cut_test: str = DEFAULT_CUT_TEST
    #: Quarantined rows (see labels.py) never enter any split.
    exclude_quarantined: bool = True
    created_at: str = Field(default_factory=utc_now)
    counts: dict[str, int] = Field(default_factory=dict)
    #: sha256 over the sorted row ids in each split — detects corpus drift.
    digests: dict[str, str] = Field(default_factory=dict)
    note: str = (
        "Temporal split. Undated rows are excluded because they cannot be "
        "ordered against the cut dates."
    )


def split_of(o: HistoricalOutcome, policy: SplitPolicy) -> Split:
    """Assign one row. Pure function of the row and the frozen policy."""
    if policy.exclude_quarantined and classify(o).quarantined:
        return "excluded"
    date = (o.sale_date or "").strip()
    if len(date) < 10:
        return "excluded"
    if date >= policy.cut_test:
        return "test"
    if date >= policy.cut_val:
        return "val"
    return "train"


def _digest(ids: Iterable[str]) -> str:
    h = hashlib.sha256()
    for i in sorted(ids):
        h.update(i.encode())
        h.update(b"\n")
    return h.hexdigest()[:16]


def partition(
    rows: list[HistoricalOutcome],
    policy: SplitPolicy,
) -> dict[str, list[HistoricalOutcome]]:
    out: dict[str, list[HistoricalOutcome]] = {
        "train": [],
        "val": [],
        "test": [],
        "excluded": [],
    }
    for o in rows:
        out[split_of(o, policy)].append(o)
    return out


def build_splits(
    rows: list[HistoricalOutcome] | None = None,
    *,
    cut_val: str = DEFAULT_CUT_VAL,
    cut_test: str = DEFAULT_CUT_TEST,
    path: Path | None = None,
    rebuild: bool = False,
) -> SplitPolicy:
    """
    Write (or load) the frozen split policy.

    Refuses to overwrite an existing policy unless ``rebuild=True``, so an
    evaluation cannot be improved by moving the goalposts.
    """
    path = path or DEFAULT_SPLITS_PATH
    if path.exists() and not rebuild:
        return load_splits(path)

    from .history import load_outcomes

    rows = rows if rows is not None else load_outcomes()
    policy = SplitPolicy(cut_val=cut_val, cut_test=cut_test)
    parts = partition(rows, policy)
    policy.counts = {k: len(v) for k, v in parts.items()}
    policy.digests = {k: _digest(o.id for o in v) for k, v in parts.items()}

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(policy.model_dump_json(indent=2), encoding="utf-8")
    return policy


def load_splits(path: Path | None = None) -> SplitPolicy:
    path = path or DEFAULT_SPLITS_PATH
    if not path.exists():
        return build_splits(path=path)
    return SplitPolicy.model_validate_json(path.read_text(encoding="utf-8"))


def get_split_rows(
    split: Split | tuple[Split, ...],
    rows: list[HistoricalOutcome] | None = None,
    *,
    policy: SplitPolicy | None = None,
) -> list[HistoricalOutcome]:
    """Rows belonging to one or more splits."""
    from .history import load_outcomes

    rows = rows if rows is not None else load_outcomes()
    policy = policy or load_splits()
    wanted = (split,) if isinstance(split, str) else split
    return [o for o in rows if split_of(o, policy) in wanted]


class LeakageError(AssertionError):
    """Raised when fitting data contains rows from a held-out split."""


def assert_no_leakage(
    rows: Iterable[HistoricalOutcome],
    *,
    allowed: tuple[Split, ...] = ("train",),
    policy: SplitPolicy | None = None,
    context: str = "fit",
) -> None:
    """
    Hard guard for any code path that fits parameters.

    Call this at the top of every fitting function. It is cheap, and it is the
    only thing standing between an honest metric and a flattering one.
    """
    policy = policy or load_splits()
    offenders: dict[str, int] = {}
    for o in rows:
        s = split_of(o, policy)
        if s not in allowed:
            offenders[s] = offenders.get(s, 0) + 1
    if offenders:
        raise LeakageError(
            f"{context}: received rows from held-out splits {offenders}; "
            f"only {allowed} may be used for fitting."
        )


def splits_summary(rows: list[HistoricalOutcome] | None = None) -> dict[str, Any]:
    """Human-readable split report including how much survives labelling."""
    from .history import load_outcomes
    from .labels import label_summary

    rows = rows if rows is not None else load_outcomes()
    policy = load_splits()
    parts = partition(rows, policy)

    def usable(group: list[HistoricalOutcome]) -> int:
        return sum(1 for o in group if classify(o).price_usable)

    return {
        "policy": policy.model_dump(),
        "n_rows": len(rows),
        "counts": {k: len(v) for k, v in parts.items()},
        "n_clearing_price": {k: usable(v) for k, v in parts.items()},
        "labels": label_summary(rows),
    }
