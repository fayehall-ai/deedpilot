# Statute proposal — SC — REVIEW REQUIRED

Triggered by coverage loop: Greenville County (FIPS 45045) ingested **3,461**
live lots with opening bids but **0 assessed** and no `STATUTE_PARAMS` for SC,
so max-bid stays dark.

**Nothing here is in production.** Check citations before merging into
`lib/deal/statute.ts`.

## SC

**Atlas summary:** Tax Lien (often described as redeemable deed); 12-month
redemption; interest tiered ~3–12% depending on when redeemed (quarterly tiers).

### Open questions (block merge until answered)

- [ ] Exact interest schedule by statute (S.C. Code Title 12, Ch. 51)
- [ ] Assessment ratio for ARV derivation (state vs county practice)
- [ ] Whether Greenville's published table is **certificates** vs **deed** inventory
- [ ] Quiet title / tax title practice after redemption expires
- [ ] What survives the sale (municipal liens, HOA)

### Live inventory note

Greenville `TaxSaleProcedures` page yielded a large HTML table (3,700 raw rows,
239 rejected as duplicates). Many rows may be long-delinquent certificates, not
the next monthly auction only — **verify sale date semantics** before marketing
as "upcoming."

### Draft skeleton (do not merge without ratio)

```ts
  SC: {
    state: "SC",
    saleType: "Tax Lien", // confirm vs Redeemable Deed wording
    redemption: {
      tiers: [
        // TODO: statutory quarterly interest table as fractions
      ],
      maxDays: 365,
    },
    quietTitle: { typicalLow: 2000, typicalHigh: 5500, typicalMonths: 5, required: true },
    closingCosts: 300,
    // assessmentRatio: TODO cite
    statute: "S.C. Code Title 12, Ch. 51",
    asOf: "2026-08",
    sources: [
      "https://www.scstatehouse.gov/code/t12c051.php",
      "https://www.greenvillecounty.org/taxcollector/TaxSaleProcedures.aspx",
    ],
    caveats: [
      "Confirm instrument type on county list before pricing as lien vs deed.",
      "Do not derive ARV until assessment ratio is cited.",
    ],
  },
```

### Coverage-loop next actions

1. Human: statute + ratio review  
2. Eng: assessor enrichment for Greenville parcel IDs if present  
3. Eng: filter Greenville table to current sale window if multi-year certificates  
