"""Label semantics — the rules that decide what the corpus actually observes."""

from __future__ import annotations

import pytest

from deedpilot_copilot.labels import (
    Disposition,
    PriceKind,
    classify,
    clearing_price_rows,
    label_summary,
    redemption_observed_rows,
)
from deedpilot_copilot.schemas import HistoricalOutcome, SaleType


def _row(**kw) -> HistoricalOutcome:
    base = dict(
        id="x-1",
        state="MI",
        sale_type=SaleType.TAX_DEED,
        redeemed=False,
        ownership_taken=True,
        provenance="recorded",
    )
    base.update(kw)
    return HistoricalOutcome(**base)


def test_cook_county_lien_price_is_not_a_clearing_price():
    """Illinois bids down the penalty rate; the dollar figure is taxes owed."""
    row = _row(
        id="il-cook-1",
        state="IL",
        sale_type=SaleType.TAX_LIEN,
        winning_bid=2280.0,
        source="https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json",
        notes="Cook County Annual Tax Sale sold PIN. Buyer=X. winning_bid_percent=0. Lien not deed.",
    )
    lab = classify(row)
    assert lab.price_kind is PriceKind.TAX_AMOUNT_BID_DOWN
    assert lab.price_usable is False
    # The sale is observed; what happened afterwards is not.
    assert lab.disposition is Disposition.SOLD_TO_INVESTOR
    assert lab.redemption_observed is False


def test_pre_sale_cure_is_not_a_post_sale_redemption():
    row = _row(
        id="ca-sandiego-1",
        state="CA",
        redeemed=True,
        ownership_taken=False,
        source="https://www.sdttc.com/content/dam/ttc/docs/x.pdf",
        notes="San Diego list status REDEEMED (owner cured). APN=None.",
    )
    lab = classify(row)
    assert lab.disposition is Disposition.CURED_PRE_SALE
    assert lab.redemption_observed is False
    assert lab.quarantined is True


def test_michigan_no_redemption_is_a_real_observation():
    """Redemption is extinguished at the foreclosure judgment, so False is data."""
    row = _row(
        id="mi-1",
        winning_bid=3900.0,
        source="https://www.tax-sale.info/listings/auction/712",
        notes="MI tax deed sold at Title Check auction. Lot 7.",
    )
    lab = classify(row)
    assert lab.redemption_observed is True
    assert lab.price_usable is True
    assert lab.price_kind is PriceKind.CLEARING_PRICE


def test_map_crawl_rows_are_quarantined():
    """A regex pulled '42' out of an Arizona statute heading and stored it."""
    row = _row(
        id="map-a8a9752e",
        state="AZ",
        sale_type=SaleType.TAX_LIEN,
        winning_bid=42.0,
        source="https://www.azleg.gov/arsDetail/?title=42",
        notes="Extracted sold price from county-map source page. Context: 42-18102",
    )
    lab = classify(row)
    assert lab.quarantined is True
    assert lab.price_usable is False


def test_maryland_premium_bid_quarantined():
    row = _row(
        id="md-howard-1",
        state="MD",
        sale_type=SaleType.TAX_LIEN,
        winning_bid=143183.0,
        opening_bid=2739.0,
        source="https://opendata.howardcountymd.gov/resource/etp2-fnbu.json",
        notes="Howard County MD open-data tax sale row (bid_amount).",
    )
    lab = classify(row)
    assert lab.price_kind is PriceKind.PREMIUM_BID
    assert lab.quarantined is True


def test_filters_agree_with_per_row_classification():
    rows = [
        _row(id="mi-1", winning_bid=1000.0, source="https://www.tax-sale.info/x"),
        _row(
            id="il-1",
            state="IL",
            sale_type=SaleType.TAX_LIEN,
            winning_bid=500.0,
            source="https://datacatalog.cookcountyil.gov/y",
        ),
    ]
    assert [o.id for o in clearing_price_rows(rows)] == ["mi-1"]
    assert [o.id for o in redemption_observed_rows(rows)] == ["mi-1"]

    summary = label_summary(rows)
    assert summary["n_rows"] == 2
    assert summary["n_price_usable"] == 1
    assert summary["n_redemption_observed"] == 1


def test_every_corpus_row_is_classified():
    """An unclassified row means a source was added without stating its semantics."""
    from deedpilot_copilot.history import load_outcomes

    rows = load_outcomes()
    if not rows:
        pytest.skip("no corpus on disk")
    assert label_summary(rows)["by_rule"].get("unclassified", 0) == 0
