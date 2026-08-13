# Statute proposals — REVIEW REQUIRED

Generated drafts. **Nothing here is in use.** Each entry must be checked
against its cited statute before being moved into `lib/deal/statute.ts`.

These numbers set the walk-away price. An assessment ratio wrong by 2.5x
silently shifts every max bid in the state, fails no test, and reaches the
subscriber before anyone notices. Read the citations.

## LA

**Validation: passed** — safe to review, *not* safe to merge unchecked.

**Drafter's stated uncertainty:** High confidence on sale type, 3-year redemption, 5%+1%/mo formula, and 0.10 residential assessment ratio (constitutional text). Lowest confidence on (1) quiet-title dollar range and timeline — pure market practice, estimated $2k–$5k / ~6 months, no official tariff; (2) closingCosts $300 — rough parish-average guess for recording/stamps/deed issuance; (3) whether any narrow class of pre-reform adjudicated parcels still carries a 5-year window — I found no current general statute for 5 years and contradicted the atlas on that point. Reviewer should confirm monition cost samples with a Louisiana tax-title practitioner and verify no parish-specific blight ordinances alter the window for the target inventory.

### Citations

| Field | Source | asOf |
|---|---|---|
| `assessmentRatio` | https://www.legis.la.gov/legis/ConstArticle.aspx?article=VII&section=18 | 2024-12 |
| `redemption` | https://www.legis.la.gov/legis/ConstArticle.aspx?article=VII&section=25 | 2024-12 |
| `quietTitle` | https://law.justia.com/codes/louisiana/revised-statutes/title-47/rs-47-2271/ | 2024-12 |
| `closingCosts` | https://www.legis.la.gov/legis/Laws_Toc.aspx?folder=75&level=Parent | 2024-12 |

### Proposed entry

```ts
  LA: {
    state: "LA",
    saleType: "Redeemable Deed",
      // redemption: https://www.legis.la.gov/legis/ConstArticle.aspx?article=VII&section=25 (2024-12)
    redemption: {
      tiers: [
        { throughDays: 365, penalty: 0.17 },
        { throughDays: 730, penalty: 0.29 },
        { throughDays: 1095, penalty: 0.41 },
      ],
      maxDays: 1095,
    },
      // quietTitle: https://law.justia.com/codes/louisiana/revised-statutes/title-47/rs-47-2271/ (2024-12)
    quietTitle: {
      typicalLow: 2000,
      typicalHigh: 5000,
      typicalMonths: 6,
      required: true,
    },
      // closingCosts: https://www.legis.la.gov/legis/Laws_Toc.aspx?folder=75&level=Parent (2024-12)
    closingCosts: 300,
      // assessmentRatio: https://www.legis.la.gov/legis/ConstArticle.aspx?article=VII&section=18 (2024-12)
    assessmentRatio: 0.1,
    assessmentBasis: "Louisiana Constitution Article VII, §18 classifies property and fixes assessed value at 10% of fair market value for land and residential improvements, 15% for most other (commercial) property, and 25% for public-service property; residential tax-sale inventory is therefore converted at 0.10.",
    statute: "La. Const. art. VII, § 25; La. R.S. 47:2241–2247 (redemption); La. R.S. 47:2271–2280 (monition)",
    asOf: "2026-08",
    sources: [
      "https://www.legis.la.gov/legis/ConstArticle.aspx?article=VII&section=25",
      "https://www.legis.la.gov/legis/ConstArticle.aspx?article=VII&section=18",
      "https://law.justia.com/codes/louisiana/revised-statutes/title-47/rs-47-2241/",
      "https://law.justia.com/codes/louisiana/revised-statutes/title-47/rs-47-2243/",
      "https://law.justia.com/codes/louisiana/revised-statutes/title-47/rs-47-2271/",
    ],
    caveats: [
      "Redemption cost is not a flat tiered penalty: statute requires the tax-sale price + a 5% penalty + interest at 1% per month from the sale date until redemption (La. Const. art. VII §25; R.S. 47:2243). The tiers above are year-end snapshots of that formula (0.05 + 0.01 × months) for calculator use; mid-year redemptions must accrue month-by-month.",
      "Blighted property in a municipality may have a SHORTER redemption window under Const. art. VII §25(C) and implementing statutes, not a longer one. The rules-atlas note of a 5-year window for some blighted/adjudicated parcels appears to reflect pre-2009 law or limited legacy adjudications and is not the current general rule.",
      "Sales are conducted at the parish (not county) level; procedures and extra costs vary by parish tax collector.",
      "quietTitle figures are market-practice estimates for a monition or ordinary quiet-title action after the redemptive period, not statutory amounts.",
      "assessmentRatio 0.10 is correct for land and residential improvements; use 0.15 if the subject is commercial/other property.",
    ],
  },
```

## CO

**Validation: passed** — safe to review, *not* safe to merge unchecked.

**Drafter's stated uncertainty:** LEAST SURE: (1) assessmentRatio — Colorado is a dual-rate state; I used ~0.067 residential (recent statutory residential assessment rate) because a single number is required, but non-residential ~0.29 is equally important and the residential rate itself is amended often — reviewer must confirm the exact rate for the tax year and property class before any price math. (2) redemption tier penalties — statute is floating annual interest, not fixed fractions of bid; 0.14/0.28/0.42 assume ~14% simple interest and will be wrong when the published CO lien rate differs. (3) quietTitle typicalLow/High/Months and closingCosts are market-practice estimates with no authoritative statewide source; quietTitle provenance intentionally has null quote. Verify current lien interest rate from the Colorado Division of Property Taxation / banking board September fixing, current residential and non-residential assessment rates from DPT, and local recorder fees before use.

### Citations

| Field | Source | asOf |
|---|---|---|
| `assessmentRatio` | https://law.justia.com/codes/colorado/title-39/property-tax/article-1/section-39-1-104-2/ | 2024-10 |
| `redemption` | https://law.justia.com/codes/colorado/title-39/property-tax/article-12/section-39-12-103/ | 2024-10 |
| `quietTitle` | https://leg.colorado.gov/colorado-revised-statutes | 2024-10 |
| `closingCosts` | https://leg.colorado.gov/colorado-revised-statutes | 2024-10 |

### Proposed entry

```ts
  CO: {
    state: "CO",
    saleType: "Tax Lien",
      // redemption: https://law.justia.com/codes/colorado/title-39/property-tax/article-12/section-39-12-103/ (2024-10)
    redemption: {
      tiers: [
        { throughDays: 365, penalty: 0.14 },
        { throughDays: 730, penalty: 0.28 },
        { throughDays: 1095, penalty: 0.42 },
      ],
      maxDays: 1095,
    },
      // quietTitle: https://leg.colorado.gov/colorado-revised-statutes (2024-10)
    quietTitle: {
      typicalLow: 2000,
      typicalHigh: 6000,
      typicalMonths: 6,
      required: true,
    },
      // closingCosts: https://leg.colorado.gov/colorado-revised-statutes (2024-10)
    closingCosts: 200,
      // assessmentRatio: https://law.justia.com/codes/colorado/title-39/property-tax/article-1/section-39-1-104-2/ (2024-10)
    assessmentRatio: 0.067,
    assessmentBasis: "Residential actual value is multiplied by a legislatively set residential assessment rate under C.R.S. § 39-1-104.2 (about 6.7% in recent tax years) to produce assessed value; most non-residential property instead uses the general 29% rate (sometimes temporarily reduced) in C.R.S. § 39-1-104.",
    statute: "C.R.S. §§ 39-11-101 et seq., 39-11-120, 39-12-103",
    asOf: "2026-08",
    sources: [
      "https://leg.colorado.gov/colorado-revised-statutes",
      "https://law.justia.com/codes/colorado/title-39/property-tax/article-11/",
      "https://law.justia.com/codes/colorado/title-39/property-tax/article-12/section-39-12-103/",
      "https://law.justia.com/codes/colorado/title-39/property-tax/article-1/section-39-1-104/",
      "https://law.justia.com/codes/colorado/title-39/property-tax/article-1/section-39-1-104-2/",
    ],
    caveats: [
      "Colorado does not use flat statutory redemption penalties. The lien accrues interest at a floating annual rate equal to nine percentage points above the federal discount rate (Federal Reserve Bank of Kansas City primary credit rate) as of each September 1, rounded to the nearest full percent (C.R.S. § 39-12-103). The tier penalties above are simple-interest approximations at an illustrative 14% annual rate for calculator wiring only — replace with the published rate for the sale year.",
      "Redemption remains available until a treasurer's deed is actually issued. The holder may apply for deed only after three years from sale; statutory notice then adds weeks to months, so the practical window often exceeds 1095 days.",
      "Assessment ratio is not uniform. 0.067 approximates recent residential rates only. Non-residential property is generally assessed near 0.29 (or a temporary reduced rate near 0.279). Using the residential ratio on commercial/vacant land will mis-state every walk-away price by roughly 4×.",
      "Quiet-title cost and duration are market practice, not statute. A treasurer's deed is the statutory end of the lien process; investors and title underwriters commonly still require a quiet-title action for marketable/insurable title.",
      "Auction format (premium bid vs. bid-down of interest) and online vs. in-person sale vary by county; many counties run online lien sales in October/November.",
      "Closing-costs figure is a rough statewide placeholder for deed recording and related fixed fees; county recorder charges differ.",
    ],
  },
```
