# TDC shared-drive extraction — 2026-08-01

Source: Google shared drive **"The Tax Deed Collective Resources"**
(`0AIXYjt9jB7GZUk9PVA`, account `faye@thetaxdeedcollective.com`, 281 files).

**Nothing here is in production.** This is an inventory and a conflict list, not
a merge. Everything below needs statute verification before it touches
`lib/atlas/` or `lib/deal/` — see "Provenance" for why that matters more than
usual with this particular source.

## Provenance — read this first

The 50-state documents are a **secondary educational compilation**, not a
statutory digest. Three separate signals say so:

- The compilation's own SC section hedges: tiered rates are "commonly
  referenced by counties... subject to statutory limits and county calculation
  rules" — it does not cite a rate-setting section.
- `2. TDC County Framework.docx` is a **ChatGPT prompt template**. The county
  frameworks are its output. San Bernardino's own text says it was produced by
  "TDC CAPE" and marks itself `Status: Manual Date Verification Required`.
- The Ohio playbook's 88 county sections are byte-identical (see below).

So this drive is a **lead-generation source for the coverage loop**, not a
citation source. It tells us where to look and what to double-check. It does not
settle anything. Merging its numbers directly would import exactly the false
precision `ResolvedCountyRule.inherited` exists to prevent.

## Sale-type conflicts with `lib/atlas/states.ts`

Twelve states where the drive's classification disagrees with ours. Each needs a
statute check to resolve; the drive is *not* automatically right.

| State | DeedPilot | TDC 50-state | Note |
|---|---|---|---|
| AL | Tax Lien | Hybrid (Lien / Redeemable Deed) | Counties elect per 2018 legislation, lien sales from 2019. Ours flattens a real county-level choice. |
| CT | Redeemable Deed | Hybrid (Redeemable Deed / Lien Assignment) | |
| DE | Tax Deed | Redeemable Deed | Drive claims 15% premium, ~90 days to court confirmation. |
| MA | Hybrid | Tax Lien | |
| MO | Tax Lien | Redeemable Deed | |
| ND | Tax Lien | Tax Deed | |
| OK | Hybrid | Tax Deed | Relevant — Tulsa/Oklahoma County inventory is in this drive. |
| OR | Tax Deed | Redeemable Deed | |
| **SC** | **Tax Lien** | **Redeemable Deed** | **Answers an open question in `proposals/statute-sc-2026-08-01.md`.** |
| TX | Redeemable Deed | Tax Deed | Both defensible — TX is a deed sale *with* a post-sale redemption right. Probably a labelling difference, not an error. Worth keeping ours. |
| VT | Tax Lien | Redeemable Deed | |
| WV | Tax Lien | Hybrid (Lien followed by Deed) | |

Rate/redemption discrepancies worth a look:

| State | DeedPilot `returns` | TDC rate |
|---|---|---|
| MD | 6–24% per annum, varies by county | Varies by county (6% to 20%) |
| MT | 10% per annum plus penalties | 2% penalty + 5/6 of 1% per month |
| TN | 10% per annum statutory penalty | 12% per annum |
| VT | Up to 12% per annum | 1% per month |

Full parsed table: `scratchpad/tdc_states.tsv` (50 states × system / rate /
redemption).

## South Carolina — partially unblocks the open proposal

`proposals/statute-sc-2026-08-01.md` lists five blocking questions. The drive
answers two and a half:

- **Sale type** — Redeemable Deed, not Tax Lien. Resolves the proposal's
  "confirm vs Redeemable Deed wording" TODO, and contradicts `states.ts`.
- **Redemption** — 1 year from sale. Confirms the draft's `maxDays: 365`.
- **Interest schedule** — tiered 3% / 6% / 9% / 12% by quarter of redemption.
  Matches the draft's assumed quarterly shape, but the drive gives **no
  statutory subsection**, so this still does not clear the "cite it" bar.
- **Premium, not interest.** The drive states the SC figure is "calculated on
  the bid amount" — a flat premium. `states.ts` currently records SC as
  "3–12% **per annum**". These are different instruments and the distinction is
  the one `RedemptionTier` was written to preserve (cf. the TX/GA flat-penalty
  note in `lib/deal/statute.ts`). If the drive is right, annualising SC would
  overstate the return exactly the way pricing an IL lien at the 18% cap does.
  Resolve this before encoding SC tiers — it changes the arithmetic, not just
  the wording.
- **Statute** — S.C. Code Title 12, Ch. 51. Confirms the draft.

Still unanswered, and still blocking:

- **Assessment ratio** — not in the drive for SC. ARV derivation stays dark.
- **Quiet title cost/practice** — not addressed for SC.
- **What survives the sale** — only a generic checklist, nothing SC-specific.

One material correction to the proposal's live-inventory worry. The proposal
asks whether Greenville's 3,461 rows are "the next monthly auction." The drive
says SC county sales are **annual, typically fall** (Greenville, Richland,
Charleston). If we ingested those rows on a monthly-cycle assumption, the sale
date semantics are wrong. `docs/self-improving-coverage-loop.md` should treat
"annual" as the SC default.

SC county sale pages the drive supplies:
`greenvillecounty.org/TaxCollector/TaxSaleFAQ.aspx`,
`richlandcountysc.gov/Government/Departments/Taxes/Treasurer`,
`charlestoncounty.org/departments/delinquent-tax/`.

## Ohio — real statute, fake county coverage

`Ohio_88_County_Tax_Sale_Playbook.docx` presents as 88 researched counties. It
is not. Measured:

- 88 county sections
- **1** unique statutory-framework paragraph — all 88 are byte-identical
- 74 of 88 carry the generic lens line ("county seat, strongest suburban
  township/city nodes, logistics corridors")
- **14** counties have real submarket names: Butler, Cuyahoga, Delaware,
  Franklin, Greene, Hamilton, Licking, Lorain, Lucas, Medina, Montgomery,
  Stark, Summit, Warren

Treat it as **one state rule set + 14 counties of `growthNeighborhoods`**. Any
other reading manufactures 74 counties of research that was never done.

The statewide facts are genuinely useful and citable:

- ORC 5721.30–5721.43 (certificates + foreclosure), ORC Ch. 2329 (judicial sale)
- **ORC 5721.37** — certificate holder may request foreclosure any time after
  1 year from certificate sale
- **ORC 5721.39** — court may transfer fee simple free and clear of subordinate
  liens, so junior liens are generally cut off. Directly feeds `survivingLiens`.
- **ORC 2329.211** — residential judicial sale deposits tier at
  **$2,000 / $5,000 / $10,000** by appraised value. Concrete `depositRules`.
- Many counties route sales through the Official Public Sheriff Sale Website
  operated by **Realauction**; others stay on-location. Format is per-county.

## The Excel model vs `lib/deal/maxbid.ts`

`The Tax Deed Collective - Excel Analysis.xlsx` is an independent
practitioner max-bid model — worth diffing against ours, since it encodes what
their subscribers already expect a walk-away number to mean.

Its formula:

```
Maximum Bid   = ARV × 0.70  +  Total Debits        (all debits negative)
Rehab         = −ARV × rehab%
Title Insur.  = −ARV × 0.007
Broker Fees   = −ARV × broker%
Title Clearance = −1,950                            ← their quiet-title figure
Homeowners Ins. = −600
Utilities     = −150 electric, −150 gas, −120 water
Misc Forecast = −(3rd-party avg × 0.01)
Taxes/HOA     = −(taxes × 0.333) − (HOA × 4)
Expected Profit = ARV + Total Expenses
Wholesale     = ARV + Debits − 20,000
Target List   = ARV × 1.05
```

Points of comparison:

- **All-in factor 0.70** is a flat haircut. Ours derives the walk-away from
  statutory redemption + quiet title. Theirs is cruder but is the number their
  audience is anchored on — worth knowing when we show a different one.
- **Title clearance $1,950** is far below our `quietTitle.typicalLow` (SC draft
  uses $2,000–$5,500). Their number looks like uncontested title-curative work,
  not a quiet-title action. Do not adopt it.
- **ARV is comp-driven**: avg $/sqft × subject sqft, comps filtered to ±15%
  sqft, plus a 6-source third-party average (Homes, Xome, Movoto, Realtor,
  Redfin, Zillow). We have no comp engine — this is the shape one would take.
- **"target 20k min per deal"** — an explicit profit floor. We have no
  equivalent constraint in `maxbid.ts`.
- Subjective 1–10 scores for neighborhood / external influence / schools /
  crime feed the sheet but nothing downstream. Correctly excluded from ours.

## County framework template ≅ our `CountyRule`

`2. TDC County Framework.docx` is a research prompt whose sections map almost
field-for-field onto `lib/atlas/types.ts`:

| Template section | `CountyRule` field |
|---|---|
| Governing Statute | `statute` |
| Sale Type | `type` / `saleType` |
| Redemption Period | `redemption` |
| Interest Rate/Penalty | `returns` |
| Format | `auctionFormat` |
| Platform Link | `auctionPlatform` |
| Frequency | `auctionFrequency` |
| Deposit Rules | `depositRules` |
| Tax Collector/Treasurer | `taxCollector` |
| Clerk of Court/Recorder | `clerkOfCourt` |
| Property Appraiser/Assessor | `propertyAppraiser` |
| Surviving Liens | `survivingLiens` |
| Quiet Title Requirement | `quietTitle` |
| GIS Map | `gisMap` |
| Top 3 High-Growth Neighborhoods | `growthNeighborhoods[]` |

The convergence is worth noting: our schema and their research workflow
independently landed on the same field set. Their filled-in frameworks
(Chatham, Richmond, San Bernardino, DeKalb, Riverside, Clark NV, Tulsa) are
therefore near drop-in `CountyRule` candidates — after statute verification,
and with `asOf`/`sources` populated honestly.

Chatham GA is the most complete worked example: statute (O.C.G.A. §48-4-40,
§48-4-42), venue (Savannah Civic Center, Bryan Room), first-Tuesday cadence,
payment by 2:00 PM day-of in cashier's check/money order/cash, explicit
defeasible-title and no-trespass-for-12-months warnings, and three named
submarkets with rationale.

## Auction platforms → `lib/ingest/adapters`

The drive names the platform layer directly, with screenshots of each:
**RealAuction** (deed + lien), **GovEase**, **Grant Street**, **Bid4Assets**,
**LienAuction**, **CivicSource**, **Publicans**, **PBFCM**, **LGBS**,
**SRI**, plus `tax-sale.info`, `iltaxsale.com`, `cosl.org` (Arkansas),
`nysauctions.com`.

Worth checking against `lib/ingest/policy.ts` — any of these not represented is
a coverage gap with a known access surface.

## Live auction inventory already in the drive

Per-county CSV + PDF pairs, mostly dated 5-26 and 2026-04-15:

Brevard FL · Clark NV · Cuyahoga OH · DeKalb GA · Fulton GA (in-rem) ·
Los Angeles CA · Philadelphia PA (labelled RedeemableDeed) · Riverside CA ·
Ventura CA · Tulsa OK · Oklahoma County OK

Two of these intersect open work directly: **Brevard** has its own
`docs/brevard-apn-resolution.md`, and the CA counties (LA, Riverside,
San Bernardino, Ventura) sit against `proposals/statute-il-ca-2026-07-30.md`.
These are recorded-sale corpora we do not have to scrape.

## Suggested order of work

1. **Resolve the 12 sale-type conflicts** against primary statute. Highest value
   because `saleType` drives map colour, filtering, *and* deal maths — a wrong
   bucket is wrong everywhere at once.
2. **SC**: adopt Redeemable Deed + annual sale cadence; keep the proposal
   blocked on assessment ratio and quiet-title cost, which the drive does not
   supply.
3. **OH**: add the state rule set with the four ORC citations above, plus 14
   counties of `growthNeighborhoods`. Explicitly do **not** add the other 74.
4. **Ingest**: reconcile the platform list against `policy.ts`.
5. **Corpus**: evaluate the 11 county CSVs as recorded-sale inputs for
   `copilot/`.

Extracted text for all 16 documents is under
`scratchpad/txt/` (~900k chars); originals under `scratchpad/dl/`.
