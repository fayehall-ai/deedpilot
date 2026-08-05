# Statute proposal — NM — REVIEW REQUIRED

Generated for the coverage loop (186 live NM lots, 0 auto-priceable because
`STATUTE_PARAMS` lacks NM). **Nothing here is in use.** Check every citation
before merging into `lib/deal/statute.ts`.

These numbers set the walk-away price.

## NM

**Validation:** not machine-validated against cartographer invariants yet —
hand draft from atlas + PTD public materials.

**Drafter uncertainty:** High confidence that post-sale redemption is none once
the Property Tax Division deed auction completes (3-year delinquency path).
Medium confidence on assessment ratio practice (NM uses taxable value /
fractional assessment regimes that vary by property class — **do not merge
`assessmentRatio` without a statute cite and class note**). Quiet-title and
closing costs are market guesses only.

### Context

- Live inventory: state PTD auction ads (PDF), Bernalillo-heavy sample.
- Atlas: Tax Deed; redemption none after state auction; 3-year delinquency.
- Proposal file earlier failed cartographer LLM run (Grok 403 credits).

### Proposed entry (draft — incomplete without ratio cite)

```ts
  NM: {
    state: "NM",
    saleType: "Tax Deed",
    // Owner's opportunity to redeem ends before/at the PTD public auction.
    redemption: null,
    quietTitle: { typicalLow: 2000, typicalHigh: 5000, typicalMonths: 4, required: true },
    closingCosts: 300,
    // TODO: replace with cited assessment ratio by class. Placeholder intentionally
    // omitted so this file cannot be copy-pasted into statute.ts half-finished.
    // assessmentRatio: ???,
    // assessmentBasis: "cite NMSA + current DFA/PTD guidance",
    statute: "NMSA 1978, Ch. 7, Art. 38 (Property Tax Code)",
    asOf: "2026-08",
    sources: [
      "https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/",
      "https://nmonesource.com/nmos/nmsa/en/nav_date.do",
    ],
    caveats: [
      "State-run PTD auction — not county-level deed sales for most parcels.",
      "Assessment basis must be verified by property class before any ARV derivation.",
      "Parcel numbers on auction ads can join to county assessor for enrichment.",
    ],
  },
```

### Human checklist before merge

- [ ] Confirm no post-sale redemption for PTD auction deeds
- [ ] Assessment ratio / taxable value formula with statute + class table
- [ ] Quiet title practice for NM tax deeds (insurer requirements)
- [ ] Whether surviving liens differ for municipal special assessments
- [ ] Cartographer invariant validation

### Coverage-loop note

Until ratio is cited, max-bid for NM should remain `insufficient-data` even if
assessor enrichment fills `assessed_value`. Do not invent a ratio to light up
the 186 lots.
