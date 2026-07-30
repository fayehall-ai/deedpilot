# Statute proposals — REVIEW REQUIRED

Generated drafts. **Nothing here is in use.** Each entry must be checked
against its cited statute before being moved into `lib/deal/statute.ts`.

These numbers set the walk-away price. An assessment ratio wrong by 2.5x
silently shifts every max bid in the state, fails no test, and reaches the
subscriber before anyone notices. Read the citations.

## IL

**Validation: passed** — safe to review, *not* safe to merge unchecked.

**Drafter's stated uncertainty:** Most confident on sale type, statutory redemption windows, 18% per-period cap, and 33 1/3% assessment ratio (all directly from ILCS). Least confident on quietTitle dollar range ($2k–$5.5k) and typicalMonths (6) and on closingCosts ($350): these are market-practice estimates for tax-deed counsel/filing/service plus recording, not published statutory amounts, and vary by county and whether a follow-on quiet-title/title-curative action is needed for insurability. Reviewer should replace quietTitle/closingCosts with current local counsel quotes. Also confirm whether the calculator should model bid-down rates below 18% or always stress-test at the cap; tiers here use the cap. Cook County classification ratios are NOT 0.3333 — flag parcels there separately.

### Citations

| Field | Source | asOf |
|---|---|---|
| `assessmentRatio` | https://www.ilga.gov/legislation/ilcs/documents/003502000K9-145.htm | 2024-11 |
| `redemption` | https://www.ilga.gov/legislation/ilcs/documents/003502000K21-350.htm | 2024-11 |
| `quietTitle` | https://www.ilga.gov/legislation/ilcs/documents/003502000K22-30.htm | 2024-11 |
| `closingCosts` | https://www.ilga.gov/legislation/ilcs/documents/003502000K22-85.htm | 2024-11 |

### Proposed entry

```ts
  IL: {
    state: "IL",
    saleType: "Tax Lien",
      // redemption: https://www.ilga.gov/legislation/ilcs/documents/003502000K21-350.htm (2024-11)
    redemption: {
      tiers: [
        { throughDays: 182, penalty: 0.18 },
        { throughDays: 365, penalty: 0.36 },
        { throughDays: 547, penalty: 0.54 },
        { throughDays: 730, penalty: 0.72 },
        { throughDays: 912, penalty: 0.9 },
      ],
      maxDays: 912,
      extendedFor: "owner-occupied principal residence improved with 1–6 dwelling units (or vacant residential that was principal residence)",
    },
      // quietTitle: https://www.ilga.gov/legislation/ilcs/documents/003502000K22-30.htm (2024-11)
    quietTitle: {
      typicalLow: 2000,
      typicalHigh: 5500,
      typicalMonths: 6,
      required: true,
    },
      // closingCosts: https://www.ilga.gov/legislation/ilcs/documents/003502000K22-85.htm (2024-11)
    closingCosts: 350,
      // assessmentRatio: https://www.ilga.gov/legislation/ilcs/documents/003502000K9-145.htm (2024-11)
    assessmentRatio: 0.3333,
    assessmentBasis: "Statewide non-Cook property is assessed at 33 1/3% of fair cash value by statute; Cook County uses a classified system (e.g. residential ~10%, commercial ~25%) under home-rule authority, so the statutory 1/3 ratio does not apply there.",
    statute: "35 ILCS 200, Art. 21 (esp. §§ 21-215, 21-350); tax deed Art. 22",
    asOf: "2026-07",
    sources: [
      "https://www.ilga.gov/legislation/ilcs/ilcs5.asp?ActID=596&ChapterID=8",
      "https://www.ilga.gov/legislation/ilcs/documents/003502000K21-215.htm",
      "https://www.ilga.gov/legislation/ilcs/documents/003502000K21-350.htm",
      "https://www.ilga.gov/legislation/ilcs/documents/003502000K9-145.htm",
      "https://www.ilga.gov/legislation/ilcs/documents/003502000K22-30.htm",
    ],
    caveats: [
      "Penalty rate is bid down at auction from a statutory maximum of 18% per six-month period (or fraction thereof); tiers above use the 18% cap. Actual purchased certificates often carry a lower bid-in rate, so accrued penalty is lower.",
      "Redemption is 2 years (730 days) for most parcels; 2 years 6 months (≈912 days) only when the property was the owner's principal residence (1–6 units or vacant residential) for the statutory look-back. Commercial, industrial, vacant non-residential, and larger residential stay at 2 years.",
      "Cook County and downstate counties run separate sale calendars; Cook also runs a scavenger sale for long-delinquent parcels under different minimum-bid rules (35 ILCS 200/21-145 et seq.).",
      "Post-sale title is cleared by petition for tax deed under Art. 22, not a classic quiet-title action. Costs/timelines below are market practice for the tax-deed proceeding (and any follow-on QT/title-insurance curative work), not amounts fixed by statute.",
      "Assessment ratio 0.3333 is wrong for Cook County classified property — use class-specific ratios there or walk-away math will be systematically off.",
    ],
  },
```

## CA

**Validation: passed** — safe to review, *not* safe to merge unchecked.

**Drafter's stated uncertainty:** Least sure about quietTitle dollar/month ranges and closingCosts — both are practice estimates, not statute; RTC confirms a one-year challenge window and strong deed language but does not set attorney-fee or recording-cost schedules. County recording fees vary; $250 is a placeholder midpoint for reviewer substitution. assessmentRatio 1.00 is statutory full value and high-confidence; Prop 13 lag vs current FMV is the operational risk, not the ratio itself.

### Citations

| Field | Source | asOf |
|---|---|---|
| `assessmentRatio` | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=401 | 2025-01 |
| `redemption` | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3711 | 2025-01 |
| `quietTitle` | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3725 | 2025-01 |
| `closingCosts` | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3708 | 2025-01 |

### Proposed entry

```ts
  CA: {
    state: "CA",
    saleType: "Tax Deed",
      // redemption: https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3711 (2025-01)
    redemption: null,
      // quietTitle: https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3725 (2025-01)
    quietTitle: {
      typicalLow: 2500,
      typicalHigh: 6000,
      typicalMonths: 6,
      required: false,
    },
      // closingCosts: https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3708 (2025-01)
    closingCosts: 250,
      // assessmentRatio: https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=401 (2025-01)
    assessmentRatio: 1,
    assessmentBasis: "Statute requires assessment at full cash value (100% ratio); the taxable value is the Prop 13 base-year full cash value factored forward, not a fractional statutory ratio.",
    statute: "Cal. Rev. & Tax. Code §§ 3691–3731 (Div. 1, Pt. 6)",
    asOf: "2026-07",
    sources: [
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=401",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3691",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3711",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3725",
      "https://www.boe.ca.gov/proptaxes/prop13.htm",
    ],
    caveats: [
      "No post-sale redemption: once the tax collector’s deed is issued, the former owner’s redemption right has already ended (it ran only until 5 p.m. on the last business day before the sale).",
      "quietTitle figures are market-practice estimates, not statutory amounts; the tax deed is presumptively valid under RTC § 3711 and a quiet-title action is optional though often used for marketable title/insurance.",
      "closingCosts are a rough fixed allowance for deed recording and related clerk fees; county transfer-tax treatment of tax deeds varies and is not included.",
      "Prop 13 base-year assessments often sit well below current open-market value on long-held parcels, so AV/assessmentRatio systematically understates true FMV — do not treat the ratio-implied value as an appraisal.",
      "Some non-residential commercial property can reach power-to-sell after 3 years of tax-default rather than 5 (RTC § 3691); residential is generally 5 years.",
    ],
  },
```
