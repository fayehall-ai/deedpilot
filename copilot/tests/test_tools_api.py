"""Trusted tools: Python callables + FastAPI surface."""

from fastapi.testclient import TestClient

from deedpilot_copilot import (
    TOOL_CATALOG,
    DealInputs,
    compute_maxbid,
    lookup_atlas,
    resolve_atlas,
)
from deedpilot_copilot.api import app
from deedpilot_copilot.schemas import SaleType

client = TestClient(app)


def test_public_imports_lookup_and_maxbid():
    atlas = lookup_atlas("48201")
    assert atlas.state == "TX"
    assert atlas.fips == "48201"
    assert atlas.must_cite

    deal = compute_maxbid(
        DealInputs(
            state="TX",
            sale_type=SaleType.REDEEMABLE_DEED,
            assessed_value=200_000,
            rehab_cost=20_000,
            opening_bid=10_000,
        )
    )
    assert deal.max_bid is not None
    assert deal.recommendation in ("bid", "no-bid")


def test_compute_maxbid_accepts_camel_dict():
    deal = compute_maxbid(
        {
            "state": "TX",
            "saleType": "Redeemable Deed",
            "assessedValue": 200_000,
            "rehabCost": 20_000,
            "openingBid": 10_000,
        }
    )
    assert deal.max_bid is not None
    dumped = deal.model_dump(by_alias=True)
    assert "maxBid" in dumped
    assert dumped["maxBid"] == deal.max_bid


def test_resolve_atlas_by_name():
    r = resolve_atlas(state="TX", county="harris")
    assert r.fips == "48201"
    assert r.state == "TX"


def test_tool_catalog_lists_oracles():
    names = {t["name"] for t in TOOL_CATALOG}
    assert "lookup_atlas" in names
    assert "compute_maxbid" in names


def test_fastapi_health_and_tools():
    h = client.get("/health")
    assert h.status_code == 200
    assert h.json()["ok"] is True

    t = client.get("/tools")
    assert t.status_code == 200
    assert len(t.json()["tools"]) >= 2


def test_fastapi_atlas_fips_and_alias_route():
    r1 = client.get("/tools/atlas", params={"fips": "48201"})
    assert r1.status_code == 200
    body = r1.json()
    assert body["tool"] == "lookup_atlas"
    assert body["trusted"] is True
    assert body["result"]["fips"] == "48201"
    assert body["provenance"]["state"] == "TX"

    r2 = client.get("/tools/lookup_atlas", params={"fips": "48201"})
    assert r2.status_code == 200
    assert r2.json()["result"]["fips"] == "48201"


def test_fastapi_atlas_by_county_slug():
    r = client.get("/tools/atlas", params={"state": "TX", "county": "harris"})
    assert r.status_code == 200
    assert r.json()["result"]["fips"] == "48201"


def test_fastapi_atlas_bad_request():
    r = client.get("/tools/atlas")
    assert r.status_code == 400


def test_fastapi_maxbid_camel_and_snake():
    camel = client.post(
        "/tools/maxbid",
        json={
            "state": "TX",
            "saleType": "Redeemable Deed",
            "assessedValue": 200000,
            "rehabCost": 20000,
            "openingBid": 10000,
        },
    )
    assert camel.status_code == 200
    cj = camel.json()
    assert cj["oracle"] is True
    assert cj["result"]["maxBid"] is not None
    assert cj["result"]["recommendation"] in ("bid", "no-bid", "insufficient-data")

    snake = client.post(
        "/tools/compute_maxbid",
        json={
            "state": "TX",
            "sale_type": "Redeemable Deed",
            "assessed_value": 200000,
            "rehab_cost": 20000,
            "opening_bid": 10000,
        },
    )
    assert snake.status_code == 200
    assert snake.json()["result"]["maxBid"] == cj["result"]["maxBid"]


def test_fastapi_maxbid_insufficient():
    r = client.post(
        "/tools/maxbid",
        json={"state": "TX", "saleType": "Redeemable Deed"},
    )
    assert r.status_code == 200
    assert r.json()["result"]["recommendation"] == "insufficient-data"
    assert r.json()["result"]["maxBid"] is None
