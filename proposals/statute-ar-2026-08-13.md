# Statute proposals — REVIEW REQUIRED

Generated drafts. **Nothing here is in use.** Each entry must be checked
against its cited statute before being moved into `lib/deal/statute.ts`.

These numbers set the walk-away price. An assessment ratio wrong by 2.5x
silently shifts every max bid in the state, fails no test, and reaches the
subscriber before anyone notices. Read the citations.

## AR

**Validation: passed** — safe to review, *not* safe to merge unchecked.

| Severity | Field | Issue |
|---|---|---|
| warning | `provenance.quietTitle` | cited from www.shamrocklands.com — prefer the state legislature or an official code publisher |

**Drafter's stated uncertainty:** Least sure about quietTitle dollar/month ranges and closingCosts fixed dollars — both are practice estimates without a statute or official fee schedule tying them to tax-deed purchasers; reviewer should replace with current Arkansas real-estate counsel quotes. Redemption=null and assessmentRatio=0.20 are statute-backed and higher confidence. Confirm current codification text on arkleg or Lexis in case of post-2023 amendment to §§ 26-26-303 or 26-37-202/203.

### Citations

| Field | Source | asOf |
|---|---|---|
| `assessmentRatio` | https://law.justia.com/codes/arkansas/2023/title-26/subtitle-3/chapter-26/subchapter-3/section-26-26-303/ | 2025-01 |
| `redemption` | https://law.justia.com/codes/arkansas/2023/title-26/subtitle-4/chapter-37/subchapter-2/section-26-37-202/ | 2025-01 |
| `quietTitle` | https://www.shamrocklands.com/blog/quiet-title-actions-in-arkansas-what-they-are-and-how-to-use-them-to-sell-your-land/ | 2026-08 |
| `closingCosts` | https://www.law.cornell.edu/regulations/arkansas/135-00-21-Ark-Code-R-001 | 2026-08 |

### Proposed entry

```ts
  AR: {
    state: "AR",
    saleType: "Tax Deed",
      // redemption: https://law.justia.com/codes/arkansas/2023/title-26/subtitle-4/chapter-37/subchapter-2/section-26-37-202/ (2025-01)
    redemption: null,
      // quietTitle: https://www.shamrocklands.com/blog/quiet-title-actions-in-arkansas-what-they-are-and-how-to-use-them-to-sell-your-land/ (2026-08)
    quietTitle: {
      typicalLow: 1500,
      typicalHigh: 7500,
      typicalMonths: 6,
      required: true,
    },
      // closingCosts: https://www.law.cornell.edu/regulations/arkansas/135-00-21-Ark-Code-R-001 (2026-08)
    closingCosts: 38,
      // assessmentRatio: https://law.justia.com/codes/arkansas/2023/title-26/subtitle-3/chapter-26/subchapter-3/section-26-26-303/ (2025-01)
    assessmentRatio: 0.2,
    assessmentBasis: "By statute, real and personal property is assessed at twenty percent (20%) of true and full market or actual value; the ratio is fixed in the code rather than set annually by local boards.",
    statute: "A.C.A. §§ 26-37-202, 26-37-203 (sale/conveyance and contest); assessment A.C.A. § 26-26-303",
    asOf: "2026-08",
    sources: [
      "https://law.justia.com/codes/arkansas/2023/title-26/subtitle-4/chapter-37/subchapter-2/section-26-37-202/",
      "https://law.justia.com/codes/arkansas/2023/title-26/subtitle-4/chapter-37/subchapter-2/section-26-37-203/",
      "https://law.justia.com/codes/arkansas/2023/title-26/subtitle-3/chapter-26/subchapter-3/section-26-26-303/",
      "https://www.cosl.org/",
      "https://www.arkleg.state.ar.us/",
    ],
    caveats: [
      "No post-sale statutory redemption: the owner's redemption right ends at 4:00 p.m. on the last business day before the sale (A.C.A. § 26-37-202). A separate 90-day window to contest validity of the conveyance under § 26-37-203 is a title/cloud risk, not a redemption that pays the purchaser a penalty, and can extend to two years after removal of disability for minors, incapacitated persons, and certain service members.",
      "Sales are statewide through the Commissioner of State Lands (COSL), not county collectors. COSL conveys by limited warranty deed and warrants nothing about marketability of title, so purchasers commonly quiet title.",
      "quietTitle typicalLow/typicalHigh/typicalMonths are market-practice estimates for an uncontested quiet-title action (attorney fees, filing, service, publication), not figures set by statute; costs rise sharply if contested or if curative work is needed.",
      "closingCosts is a rough fixed allowance for deed recording and miscellaneous issuance/recording items only; Arkansas real-estate transfer tax ($3.30 per $1,000 of consideration) is separate and scales with price, so it is not folded into this fixed figure.",
      "Assessment ratio applies to the assessor's market/appraised value; confirm the value on the notice or assessor record is the full appraised value before dividing by the ratio.",
      "Quiet title and closing costs are searched market estimates (inferred), not statute. No Arkansas Bar Association fee survey, legal-aid guide or court self-help page with published quiet-title attorney fees was located; the dollar figures come from a land-buyer blog, two attorney-firm blogs and a title-search company's investor guide, so they are not official and vary by complexity, number of defendants, contested status and county. High end of quiet-title range was widened upward because evidence is thin and an understated cost produces a real overbid loss. Most attorneys wait until after the one-year challenge period (Ark. Code § 18-12-609) before filing, so calendar time from auction to marketable title is often 15–24 months even if the lawsuit itself lasts only 3–9 months. Closing-cost range assumes a typical one- or two-page Limited Warranty Deed; extra pages or the $25 COSL collection fee (if billed separately from the auction bid) push the high end. Transfer tax is zero only because tax-sale deeds are statutorily exempt; a later resale after quiet title will incur the $3.30/$1 000 tax. Surviving-lien analysis is not exhaustive (HOA assessments, certain improvement-district liens and un-noticed municipal liens are thinly documented). 2025 legislative changes affecting tax-title procedures were noted by one source; current statutes and local practice must be confirmed with Arkansas counsel before bidding.",
      "Surviving liens — NOT priced into closingCosts: Mortgages, Arkansas state tax liens and judgment liens are generally extinguished if the Commissioner of State Lands gave proper statutory notice to the holders, because the tax lien has priority (Harrington Miller / arkansaslaw.com 'Defeating Liens After a Tax Deed Purchase'; Blazer Title Search Arkansas Tax Sale Investing Guide). IRS/federal tax liens require case-by-case review of filing dates versus the tax delinquency; they can often be defeated on long-delinquent parcels but the IRS retains a 120-day redemption right if notice was defective (same two sources). Municipal code-enforcement or clean-up liens need careful pre-bid review and may survive (Blazer). COSL rules explicitly state that 'all liens and encumbrances are not necessarily extinguished by tax sales' and that parcels remain subject to the lien of taxes for the preceding calendar year not yet due (135.00.21 Ark. Code R. 001). Easements, building restrictions and certain governmental interests also typically survive.",
    ],
  },
```
