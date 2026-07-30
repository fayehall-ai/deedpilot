"""
Outcome Archivist — import past-sale results without poisoning the models.

This is the agent that caused the worst bug in the system, and the redesign is
entirely about making that failure impossible rather than about importing faster.

What happened: 92,208 rows arrived across several states with no statement of
what their fields meant. ``redeemed=False`` is a schema default, and Cook County
publishes which liens sold and never revisits them, so 70,109 non-observations
were counted as observed non-redemptions. Weighted by row count, they buried the
expert prior and pinned Illinois tax liens at ``p_redeem = 0.02`` — the simulator
concluded that an Illinois lien almost never redeems, when redemption is the
entire reason to buy one. Confidence scales with ``n``, so the system got *more*
certain as more rows arrived.

The rule that follows, enforced here rather than documented:

    A source may not contribute rows until ``labels.py`` states what its rows
    observe. No rule, no import.

That makes adding a source a reviewed code change. The friction is the feature:
it is the step that would have caught Cook County's bid-down prices before they
reached a fitted parameter.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from .history import append_outcome, load_outcomes, outcomes_path
from .labels import Disposition, PriceKind, classify
from .schemas import HistoricalOutcome


class UnlabelledSourceError(ValueError):
    """Raised when a row's source has no semantics rule in ``labels.py``."""


@dataclass
class AdmissionResult:
    """What the Archivist decided about one batch, and why."""

    admitted: list[HistoricalOutcome] = field(default_factory=list)
    #: Rows whose source has no label rule at all — the hard stop.
    unlabelled: list[tuple[HistoricalOutcome, str]] = field(default_factory=list)
    #: Rows classified but quarantined (pre-sale cures, premium bids, crawl junk).
    quarantined: list[tuple[HistoricalOutcome, str]] = field(default_factory=list)
    #: Rows already present, matched by id.
    duplicates: list[HistoricalOutcome] = field(default_factory=list)
    #: Rows that failed a structural sanity check.
    rejected: list[tuple[HistoricalOutcome, str]] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "admitted": len(self.admitted),
            "unlabelled": len(self.unlabelled),
            "quarantined": len(self.quarantined),
            "duplicates": len(self.duplicates),
            "rejected": len(self.rejected),
            "unlabelled_sources": sorted(
                {(o.source or "?")[:80] for o, _ in self.unlabelled}
            ),
            "quarantine_reasons": dict(Counter(r for _, r in self.quarantined)),
            "rejection_reasons": dict(Counter(r for _, r in self.rejected)),
        }


def _structural_issues(o: HistoricalOutcome) -> str | None:
    """
    Checks that hold regardless of source semantics.

    Deliberately thin. The Archivist's job is not to second-guess a county's
    published figures — it is to refuse rows that cannot mean anything.
    """
    if not o.id:
        return "missing id"
    if not o.state or len(o.state) != 2:
        return "state must be a 2-letter postal code"
    if o.winning_bid is not None and o.winning_bid < 0:
        return "negative winning bid"
    if o.opening_bid is not None and o.opening_bid < 0:
        return "negative opening bid"
    if o.redeemed and o.ownership_taken:
        return "redeemed and ownership_taken are mutually exclusive"
    if o.sale_date and len(o.sale_date) not in (7, 10):
        return f"unparseable sale_date {o.sale_date!r}"
    return None


def admit(
    rows: Iterable[HistoricalOutcome],
    *,
    existing_ids: set[str] | None = None,
    allow_quarantined: bool = False,
) -> AdmissionResult:
    """
    Decide which rows may enter the corpus.

    ``allow_quarantined`` stores classified-but-unusable rows so the corpus keeps
    a record of what was seen. They still never reach a fitted parameter —
    ``calibrate_priors`` and the world model filter on the same labels — but
    keeping them makes a later reclassification possible without re-crawling.
    The Maryland premium bids are the case in point: 2,524 rows that become
    usable the moment someone works out the field mapping.
    """
    if existing_ids is None:
        existing_ids = {o.id for o in load_outcomes()}

    result = AdmissionResult()
    seen: set[str] = set()

    for row in rows:
        issue = _structural_issues(row)
        if issue:
            result.rejected.append((row, issue))
            continue

        if row.id in existing_ids or row.id in seen:
            result.duplicates.append(row)
            continue

        label = classify(row)
        if label.rule_id == "unclassified":
            result.unlabelled.append(
                (
                    row,
                    f"no label rule matches source {row.source!r} — add one to labels.py "
                    "stating what this source's price and disposition fields observe",
                )
            )
            continue

        if label.quarantined:
            if allow_quarantined:
                result.admitted.append(row)
                seen.add(row.id)
            result.quarantined.append((row, label.reason))
            continue

        result.admitted.append(row)
        seen.add(row.id)

    return result


def import_batch(
    rows: Sequence[HistoricalOutcome],
    *,
    dry_run: bool = True,
    allow_quarantined: bool = False,
    strict: bool = True,
    path: Path | None = None,
) -> dict[str, Any]:
    """
    Import a batch, refusing unlabelled sources.

    ``strict`` (the default) raises when any row's source lacks a label rule,
    rather than importing the rest and leaving a partial batch. A new source is
    supposed to stop the pipeline until somebody writes down what it means — that
    is the entire point, and silently importing 90% of it would defeat it.
    """
    result = admit(rows, allow_quarantined=allow_quarantined)

    if strict and result.unlabelled:
        sources = sorted({(o.source or "?") for o, _ in result.unlabelled})
        raise UnlabelledSourceError(
            f"{len(result.unlabelled)} row(s) from {len(sources)} unlabelled source(s). "
            "Add a rule to labels.py stating what each source's price_kind and "
            "disposition actually observe, then re-run.\n  "
            + "\n  ".join(s[:120] for s in sources[:5])
        )

    written = 0
    if not dry_run:
        for row in result.admitted:
            append_outcome(row, path)
            written += 1

    return {
        "dry_run": dry_run,
        "written": written,
        "path": str(path or outcomes_path()),
        **result.summary(),
    }


def corpus_report() -> dict[str, Any]:
    """
    What the corpus observes today, by source.

    The number to read is not the row count. It is how many rows carry a
    comparable clearing price and how many carry an observed disposition — the
    two things a model can actually be fitted on.
    """
    rows = load_outcomes()
    by_source: dict[str, dict[str, Any]] = {}

    for o in rows:
        label = classify(o)
        entry = by_source.setdefault(
            label.rule_id,
            {
                "rule": label.rule_id,
                "n": 0,
                "price_usable": 0,
                "redemption_observed": 0,
                "quarantined": 0,
                "price_kind": label.price_kind.value,
                "disposition": label.disposition.value,
                "reason": label.reason,
            },
        )
        entry["n"] += 1
        entry["price_usable"] += int(label.price_usable)
        entry["redemption_observed"] += int(label.redemption_observed)
        entry["quarantined"] += int(label.quarantined)

    total = len(rows)
    usable = sum(e["price_usable"] for e in by_source.values())
    observed = sum(e["redemption_observed"] for e in by_source.values())

    return {
        "n_rows": total,
        "n_price_usable": usable,
        "n_redemption_observed": observed,
        "share_price_usable": round(usable / total, 4) if total else 0.0,
        "share_redemption_observed": round(observed / total, 4) if total else 0.0,
        "by_rule": sorted(by_source.values(), key=lambda e: -e["n"]),
        "note": (
            "Row count is not the useful number. A source with no label rule "
            "contributes nothing, and a source whose price is a tax amount rather "
            "than a clearing price contributes no price signal however many rows "
            "it has."
        ),
    }


def load_jsonl(path: Path) -> list[HistoricalOutcome]:
    """Read a candidate batch from JSONL without touching the corpus."""
    rows: list[HistoricalOutcome] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(HistoricalOutcome.model_validate_json(line))
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"{path}:{line_no}: {e}") from e
    return rows
