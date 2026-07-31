"""
The Python oracle must stay identical to the TypeScript one.

`compute_maxbid` exists twice — once for the product, once for the copilot — and
a divergence would mean the agent optimises against a different ceiling than the
subscriber sees. These pin the IL/CA additions and the two traps the review of
those proposals surfaced.
"""

from __future__ import annotations

import pytest

from deedpilot_copilot.maxbid import compute_maxbid
from deedpilot_copilot.schemas import DealInputs, SaleType
from deedpilot_copilot.statute import STATUTE_PARAMS, statute_for


def test_il_and_ca_are_now_priceable():
    assert "IL" in STATUTE_PARAMS
    assert "CA" in STATUTE_PARAMS
    assert len(STATUTE_PARAMS) == 7


@pytest.mark.parametrize("state,params", sorted(STATUTE_PARAMS.items()))
def test_every_entry_is_internally_coherent(state, params):
    assert params["state"] == state
    assert 0 < params["assessmentRatio"] <= 1
    assert params["quietTitle"]["typicalLow"] <= params["quietTitle"]["typicalHigh"]
    assert params["sources"]
    red = params.get("redemption")
    if red:
        prev_days, prev_penalty = -1, -1.0
        for tier in red["tiers"]:
            assert tier["throughDays"] > prev_days
            assert tier["penalty"] >= prev_penalty
            assert 0 <= tier["penalty"] <= 1
            prev_days, prev_penalty = tier["throughDays"], tier["penalty"]
        assert red["maxDays"] >= prev_days
    for fips, override in (params.get("countyAssessmentRatios") or {}).items():
        assert len(fips) == 5 and fips.isdigit()
        assert 0 < override["ratio"] <= 1


def _il(**kw):
    base = dict(
        state="IL", sale_type=SaleType.TAX_LIEN, assessed_value=30_000, rehab_cost=15_000
    )
    base.update(kw)
    return compute_maxbid(DealInputs(**base))


def test_cook_county_ratio_overrides_the_statewide_one():
    """
    Cook assesses residential at ~10%; Illinois' statutory ratio is 33 1/3%.

    Cook is 70,109 of our historical rows, so this is the largest single block
    of data we hold and the statewide ratio would misvalue all of it threefold.
    """
    statewide = _il()
    cook = _il(fips="17031")
    assert statewide.arv_value == pytest.approx(30_000 / 0.3333, rel=1e-4)
    assert cook.arv_value == pytest.approx(300_000)
    assert cook.max_bid > statewide.max_bid * 2


def test_omitting_fips_warns_when_the_state_has_overrides():
    assert any("17031" in w for w in _il().warnings)
    assert not any("No FIPS was supplied" in w for w in _il(fips="17031").warnings)


def test_a_county_override_does_not_leak_across_states():
    az = compute_maxbid(
        DealInputs(state="AZ", sale_type=SaleType.TAX_LIEN, fips="17031", assessed_value=30_000)
    )
    # Arizona's own ratio, not Cook's.
    assert az.arv_value == pytest.approx(30_000 / STATUTE_PARAMS["AZ"]["assessmentRatio"])


def test_bid_down_reports_the_market_rate_not_just_the_cap():
    """
    Illinois bids the penalty DOWN from 18%; recorded sales cleared at 0% median.

    Pricing the lien at the statutory cap overstates its return by roughly an
    order of magnitude — the mirror image of counting absent redemption data as
    observed non-redemption.
    """
    r = _il().redemption
    assert r["flatPenalty"] == 0.18
    market = r["marketPenalty"]
    assert market["observedMedian"] == 0.0
    assert market["n"] == 64_526
    assert market["penaltyAtMaxBidObserved"] < r["penaltyAtMaxBid"]
    assert any("bids the penalty DOWN" in w for w in _il().warnings)


def test_statutory_penalty_states_have_no_market_rate():
    tx = compute_maxbid(
        DealInputs(state="TX", sale_type=SaleType.REDEEMABLE_DEED, assessed_value=200_000)
    )
    assert "marketPenalty" not in tx.redemption
    assert not any("bids the penalty DOWN" in w for w in tx.warnings)


def test_prop13_caveat_fires_only_on_a_derived_arv():
    derived = compute_maxbid(
        DealInputs(state="CA", sale_type=SaleType.TAX_DEED, assessed_value=200_000)
    )
    assert derived.arv_value == 200_000  # full cash value, ratio 1.0
    assert any("Proposition 13" in w for w in derived.warnings)

    supplied = compute_maxbid(
        DealInputs(state="CA", sale_type=SaleType.TAX_DEED, arv_override=400_000)
    )
    assert not any("Proposition 13" in w for w in supplied.warnings)


def test_california_deed_has_no_post_sale_redemption():
    assert statute_for("CA")["redemption"] is None


def test_uncovered_state_message_is_derived():
    r = compute_maxbid(DealInputs(state="WY", sale_type=SaleType.TAX_DEED, assessed_value=50_000))
    assert r.recommendation == "insufficient-data"
    joined = " ".join(r.warnings)
    assert "IL" in joined and "CA" in joined, "stale hardcoded state list"
