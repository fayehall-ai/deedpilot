"""Python port of lib/deal/statute.ts — covered states only."""

from __future__ import annotations

from typing import Any

# Kept in sync with lib/deal/statute.ts asOf 2026-07
STATUTE_PARAMS: dict[str, dict[str, Any]] = {
    "TX": {
        "state": "TX",
        "saleType": "Redeemable Deed",
        "redemption": {
            "tiers": [
                {"throughDays": 365, "penalty": 0.25},
                {"throughDays": 730, "penalty": 0.5},
            ],
            "maxDays": 730,
            "extendedFor": "homestead and agricultural-use property (2 years); all other property is 180 days",
        },
        "quietTitle": {
            "typicalLow": 2500,
            "typicalHigh": 6000,
            "typicalMonths": 4,
            "required": True,
        },
        "closingCosts": 400,
        "assessmentRatio": 1.0,
        "assessmentBasis": "Texas appraises at 100% of market value (Tex. Tax Code § 23.01).",
        "statute": "Tex. Tax Code § 34.21 (right of redemption)",
        "asOf": "2026-07",
        "sources": [
            "https://statutes.capitol.texas.gov/Docs/TX/htm/TX.34.htm",
        ],
        "caveats": [
            "Treat homestead-looking residential as potentially 2-year redemption.",
            "The 25% is a flat penalty, not annual interest.",
        ],
    },
    "GA": {
        "state": "GA",
        "saleType": "Redeemable Deed",
        "redemption": {
            "tiers": [
                {"throughDays": 365, "penalty": 0.2},
                {"throughDays": 730, "penalty": 0.3},
                {"throughDays": 1095, "penalty": 0.4},
            ],
            "maxDays": 1095,
            "extendedFor": "redemption open until barment notice",
        },
        "quietTitle": {
            "typicalLow": 3000,
            "typicalHigh": 7500,
            "typicalMonths": 6,
            "required": True,
        },
        "closingCosts": 350,
        "assessmentRatio": 0.4,
        "assessmentBasis": "Georgia assesses at 40% of FMV (O.C.G.A. § 48-5-7).",
        "statute": "O.C.G.A. § 48-4-40 through § 48-4-48",
        "asOf": "2026-07",
        "sources": ["https://law.justia.com/codes/georgia/title-48/chapter-4/article-3/"],
        "caveats": ["12-month period is a minimum until barment."],
    },
    "FL": {
        "state": "FL",
        "saleType": "Tax Deed",
        "redemption": None,
        "quietTitle": {
            "typicalLow": 2500,
            "typicalHigh": 5500,
            "typicalMonths": 4,
            "required": True,
        },
        "closingCosts": 500,
        "assessmentRatio": 0.85,
        "assessmentBasis": "Just value; SOH caps can compress assessed below market.",
        "statute": "Fla. Stat. ch. 197",
        "asOf": "2026-07",
        "sources": [
            "http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0197/0197.html"
        ],
        "caveats": [
            "Governmental liens can survive a Florida tax deed.",
            "Federal tax liens retain a 120-day IRS redemption right.",
        ],
    },
    "AZ": {
        "state": "AZ",
        "saleType": "Tax Lien",
        "redemption": {
            "tiers": [{"throughDays": 1095, "penalty": 0.16}],
            "maxDays": 1095,
            "extendedFor": "interest bid down from 16% statutory max",
        },
        "quietTitle": {
            "typicalLow": 2000,
            "typicalHigh": 5000,
            "typicalMonths": 5,
            "required": True,
        },
        "closingCosts": 300,
        "assessmentRatio": 0.85,
        "assessmentBasis": "Limited Property Value lags full cash value.",
        "statute": "A.R.S. Title 42, ch. 18",
        "asOf": "2026-07",
        "sources": ["https://www.azleg.gov/arsDetail/?title=42"],
        "caveats": ["Arizona sells liens, not deeds — usual outcome is redemption."],
    },
    "MI": {
        "state": "MI",
        "saleType": "Tax Deed",
        "redemption": None,
        "quietTitle": {
            "typicalLow": 1500,
            "typicalHigh": 4000,
            "typicalMonths": 3,
            "required": False,
        },
        "closingCosts": 300,
        "assessmentRatio": 0.5,
        "assessmentBasis": "SEV is 50% of true cash value; often stale on auction lists.",
        "statute": "MCL 211.78 et seq.",
        "asOf": "2026-07",
        "sources": ["https://www.legislature.mi.gov/Laws/MCL?objectName=MCL-211-78K"],
        "caveats": ["Foreclosure judgment is comparatively clean title."],
    },
    "IL": {
        "state": "IL",
        "saleType": "Tax Lien",
        "redemption": {
            # Statutory ceiling: 18% per six-month period (35 ILCS 200/21-355).
            # Almost never what a bidder receives — see bidDown.
            "tiers": [
                {"throughDays": 182, "penalty": 0.18},
                {"throughDays": 365, "penalty": 0.36},
                {"throughDays": 547, "penalty": 0.54},
                {"throughDays": 730, "penalty": 0.72},
                {"throughDays": 912, "penalty": 0.9},
            ],
            "maxDays": 912,
            "extendedFor": (
                "owner-occupied principal residence of 1-6 dwelling units (30 months); "
                "most other property redeems at 24 months"
            ),
            "bidDown": {
                "statutoryMax": 0.18,
                "observedMedian": 0.0,
                "observedMean": 0.0188,
                "n": 64526,
                "observedSource": (
                    "https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json "
                    "(Cook County annual tax sale, winning_bid_percent)"
                ),
                "note": (
                    "81.4% of recorded Cook County liens cleared at a 0% penalty bid. "
                    "Institutional buyers take these for the deed remainder rather than "
                    "the interest, so expected return on the redemption path is near zero."
                ),
            },
        },
        "quietTitle": {
            "typicalLow": 2000,
            "typicalHigh": 5500,
            "typicalMonths": 6,
            "required": True,
        },
        "closingCosts": 350,
        "assessmentRatio": 0.3333,
        "assessmentBasis": (
            "35 ILCS 200/9-145: property outside Cook County is assessed at 33 1/3% "
            "of fair cash value."
        ),
        "countyAssessmentRatios": {
            "17031": {
                "ratio": 0.1,
                "basis": (
                    "Cook County Classification Ordinance: Class 2 residential is "
                    "assessed at 10% of market value, not the statutory 33 1/3%."
                ),
            },
        },
        "statute": "35 ILCS 200, Art. 21 (sale and redemption); Art. 22 (tax deed)",
        "asOf": "2026-07",
        "sources": [
            "https://www.ilga.gov/legislation/ilcs/ilcs5.asp?ActID=596&ChapterID=8",
            "https://www.ilga.gov/legislation/ilcs/documents/003502000K21-355.htm",
            "https://www.ilga.gov/legislation/ilcs/documents/003502000K9-145.htm",
            "https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json",
        ],
        "caveats": [
            "Penalty is bid DOWN from 18%; recorded Cook sales cleared at a 0% median "
            "across 64,526 liens. Price on the acquisition thesis, not the interest.",
            "Cook County assesses residential at ~10%, not the statutory 33 1/3%.",
            "Title is perfected by petition for tax deed under Art. 22, not a classic "
            "quiet-title action; costs here are market practice, not statute.",
        ],
    },
    "CA": {
        "state": "CA",
        "saleType": "Tax Deed",
        # Redemption ends at 5pm the last business day before the sale, so a
        # California tax deed carries no post-sale redemption at all.
        "redemption": None,
        "quietTitle": {
            "typicalLow": 2500,
            "typicalHigh": 6000,
            "typicalMonths": 6,
            "required": False,
        },
        "closingCosts": 250,
        "assessmentRatio": 1.0,
        "assessmentBasis": (
            "Cal. Rev. & Tax. Code 401: property is assessed at full cash value."
        ),
        "derivedArvCaveat": (
            "California assesses at full cash value, but Proposition 13 fixes the base "
            "year and factors it forward at up to 2%/yr. On a long-held parcel the "
            "assessed value can sit far below market, so a derived ARV understates it."
        ),
        "statute": "Cal. Rev. & Tax. Code 3691-3731 (tax-defaulted property sales)",
        "asOf": "2026-07",
        "sources": [
            "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=401",
            "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3691",
            "https://www.boe.ca.gov/proptaxes/prop13.htm",
        ],
        "caveats": [
            "No post-sale redemption; the owner's right ends before the sale.",
            "Prop 13 means assessed value systematically understates market value on "
            "long-held parcels. Do not treat a ratio-derived ARV as an appraisal.",
            "San Diego lists mark pre-sale cures as 'REDEEMED' — that is not a "
            "post-sale redemption and is quarantined in the label rules.",
        ],
    },
}


def statute_for(state: str) -> dict[str, Any] | None:
    return STATUTE_PARAMS.get(state)


def has_statute_params(state: str) -> bool:
    return state in STATUTE_PARAMS
