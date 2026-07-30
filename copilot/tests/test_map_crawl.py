"""County-map source index + sold-price extraction (no live network)."""

from pathlib import Path

from deedpilot_copilot.map_history_crawl import (
    DEFAULT_SOURCES,
    extract_past_links,
    extract_sold_amounts,
    load_county_sources,
    outcomes_from_sold_hits,
)
from deedpilot_copilot.schemas import SaleType


def test_county_sources_export_present():
    assert DEFAULT_SOURCES.exists(), (
        "Run: node copilot/scripts/export_county_sources.mjs --map ../tax-deed-map"
    )
    src = load_county_sources()
    assert src["nCounties"] >= 500
    assert src["nUniqueHosts"] >= 100
    # Every researched county should carry at least one link when platform URL set
    with_plat = sum(1 for c in src["counties"] if c.get("auctionPlatformUrl"))
    assert with_plat >= 500


def test_extract_sold_amounts():
    html = """
    <html><body>
    <div>Lot 12 Sold for $4,000.00</div>
    <div>Winning bid: $15,250.50 Parcel: 01-02-03-004</div>
    </body></html>
    """
    hits = extract_sold_amounts(html)
    amts = {h["amount"] for h in hits}
    assert 4000.0 in amts
    assert 15250.50 in amts


def test_outcomes_from_hits_are_recorded():
    hits = [{"amount": 5000.0, "context": "Sold for $5,000", "parcel": "ABC"}]
    rows = outcomes_from_sold_hits(
        hits,
        fips="48201",
        state="TX",
        source_url="https://example.gov/sales",
        sale_type=SaleType.REDEEMABLE_DEED,
    )
    assert len(rows) == 1
    assert rows[0].provenance == "recorded"
    assert rows[0].winning_bid == 5000.0
    assert rows[0].ownership_taken is True


def test_extract_past_links():
    html = '''
    <a href="/upcoming">Upcoming</a>
    <a href="/past-results">Past Results</a>
    <a href="https://other.com/archive">Archive</a>
    '''
    links = extract_past_links(html, "https://example.gov/tax-sales")
    assert any("past-results" in u for u in links)
