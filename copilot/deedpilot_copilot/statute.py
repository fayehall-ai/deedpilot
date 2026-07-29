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
}


def statute_for(state: str) -> dict[str, Any] | None:
    return STATUTE_PARAMS.get(state)


def has_statute_params(state: str) -> bool:
    return state in STATUTE_PARAMS
