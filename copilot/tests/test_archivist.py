"""
Archivist admission control.

The regression these pin: a source with no stated semantics must not be able to
contribute rows, because that is precisely how 70k Cook County non-observations
became an observed 2% redemption rate for Illinois.
"""

from __future__ import annotations

import pytest

from deedpilot_copilot.archivist import (
    UnlabelledSourceError,
    admit,
    corpus_report,
    import_batch,
)
from deedpilot_copilot.schemas import HistoricalOutcome, SaleType


def _row(**kw) -> HistoricalOutcome:
    base = dict(
        id="new-1",
        state="MI",
        sale_type=SaleType.TAX_DEED,
        redeemed=False,
        ownership_taken=True,
        provenance="recorded",
        source="https://www.tax-sale.info/listings/auction/999",
        notes="MI tax deed sold at Title Check auction.",
        winning_bid=4200.0,
        sale_date="2026-08-15",
    )
    base.update(kw)
    return HistoricalOutcome(**base)


def test_labelled_source_is_admitted():
    result = admit([_row()], existing_ids=set())
    assert len(result.admitted) == 1
    assert not result.unlabelled


def test_unlabelled_source_is_refused():
    """A source nobody has written a rule for contributes nothing."""
    unknown = _row(
        id="mystery-1",
        source="https://someauctionsite.example.com/results",
        notes="Sold parcels.",
    )
    result = admit([unknown], existing_ids=set())
    assert not result.admitted
    assert len(result.unlabelled) == 1
    assert "labels.py" in result.unlabelled[0][1]


def test_strict_import_raises_on_unlabelled_source():
    """
    A new source stops the pipeline rather than importing the rest.

    Importing the labelled 90% and quietly dropping the remainder is how a
    corpus ends up with unexplained gaps that look like real market signal.
    """
    rows = [_row(), _row(id="mystery-2", source="https://unknown.example.com/x", notes="")]
    with pytest.raises(UnlabelledSourceError) as e:
        import_batch(rows, dry_run=True, strict=True)
    assert "labels.py" in str(e.value)
    assert "unknown.example.com" in str(e.value)


def test_non_strict_import_reports_but_does_not_raise():
    rows = [_row(), _row(id="mystery-3", source="https://unknown.example.com/x", notes="")]
    report = import_batch(rows, dry_run=True, strict=False)
    assert report["admitted"] == 1
    assert report["unlabelled"] == 1
    assert report["written"] == 0  # dry run writes nothing


def test_quarantined_rows_are_excluded_by_default():
    """Pre-sale cures are classified, and still must not enter as outcomes."""
    cure = _row(
        id="ca-cure-1",
        state="CA",
        redeemed=True,
        ownership_taken=False,
        winning_bid=None,
        source="https://www.sdttc.com/content/dam/ttc/docs/x.pdf",
        notes="San Diego list status REDEEMED (owner cured).",
    )
    result = admit([cure], existing_ids=set())
    assert not result.admitted
    assert len(result.quarantined) == 1
    assert "pre-sale" in result.quarantined[0][1] or "cured" in result.quarantined[0][1]


def test_quarantined_rows_can_be_retained_deliberately():
    """
    Maryland's 2,524 premium bids become usable if the mapping is worked out.

    Retaining them keeps that possible without re-crawling; the label still
    stops them reaching a fitted parameter.
    """
    md = _row(
        id="md-1",
        state="MD",
        sale_type=SaleType.TAX_LIEN,
        winning_bid=143183.0,
        source="https://opendata.howardcountymd.gov/resource/etp2-fnbu.json",
        notes="Howard County MD open-data tax sale row (bid_amount).",
    )
    kept = admit([md], existing_ids=set(), allow_quarantined=True)
    assert len(kept.admitted) == 1
    assert len(kept.quarantined) == 1


def test_duplicates_are_not_reimported():
    row = _row(id="dupe-1")
    result = admit([row, row], existing_ids=set())
    assert len(result.admitted) == 1
    assert len(result.duplicates) == 1

    against_existing = admit([row], existing_ids={"dupe-1"})
    assert not against_existing.admitted
    assert len(against_existing.duplicates) == 1


@pytest.mark.parametrize(
    "kw,reason",
    [
        ({"id": ""}, "missing id"),
        ({"state": "MICH"}, "postal code"),
        ({"winning_bid": -5.0}, "negative winning bid"),
        ({"redeemed": True, "ownership_taken": True}, "mutually exclusive"),
        ({"sale_date": "Aug 2026"}, "sale_date"),
    ],
)
def test_structurally_impossible_rows_are_rejected(kw, reason):
    result = admit([_row(**kw)], existing_ids=set())
    assert not result.admitted
    assert len(result.rejected) == 1
    assert reason in result.rejected[0][1]


def test_dry_run_writes_nothing(tmp_path):
    path = tmp_path / "out.jsonl"
    report = import_batch([_row()], dry_run=True, path=path)
    assert report["written"] == 0
    assert not path.exists()


def test_real_import_appends(tmp_path, monkeypatch):
    path = tmp_path / "out.jsonl"
    path.write_text("")
    monkeypatch.setenv("DEEDPILOT_HISTORICAL_OUTCOMES", str(path))
    report = import_batch([_row()], dry_run=False, path=path, strict=True)
    assert report["written"] == 1
    assert path.read_text().strip()


def test_corpus_report_leads_with_usable_not_total():
    report = corpus_report()
    if report["n_rows"] == 0:
        pytest.skip("no corpus on disk")
    assert report["n_price_usable"] <= report["n_rows"]
    assert report["n_redemption_observed"] <= report["n_rows"]
    # The headline count overstates what is fittable; the report must show both.
    assert report["share_price_usable"] < 1.0
    assert any(e["rule"] == "il_cook_bid_down" for e in report["by_rule"])
    cook = next(e for e in report["by_rule"] if e["rule"] == "il_cook_bid_down")
    assert cook["price_usable"] == 0, "Illinois bid-down prices carry no price signal"
    assert cook["redemption_observed"] == 0, "Cook publishes no redemption follow-up"
