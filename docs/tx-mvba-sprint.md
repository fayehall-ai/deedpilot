# Texas expansion via MVBA

**Status: shipped.** `lib/ingest/adapters/mvba.ts`, covered by
`lib/ingest/mvba-parser.test.ts`. First live run: Eastland County (48133),
21 lots for the 2026-09-01 sale.

## Open: which Eastland identifier is the parcel

Eastland prints two account numbers per tract, slash-separated:

```
Account #215480001000000000000000001 / 52840
```

The adapter takes the first as `parcelNumber` and keeps the second in
`raw.additionalAccounts`. **That choice is unverified.** In Texas appraisal
districts the short number is usually the Property ID and the long one the
Geographic ID, and which of them ATTOM matches on has not been tested — the
ATTOM key was out of quota when this shipped.

This is exactly the shape of the Brevard failure
(`docs/brevard-apn-resolution.md`), where sending the wrong identifier left
~130 lots unpriceable and looked like a data problem rather than a choice.
Resolve by enriching a handful of Eastland lots on both numbers once the key is
renewed, then set the primary accordingly.

Note this is separate from the multi-tract rule. Eastland lists tracts as
individually numbered entries with their own minimum bids — cause
`24-067-DCTX-05321` correctly yields two lots at $6,000 and $3,880. The
one-lot-per-cause rule applies to tracts *inside* a single entry, as in Rusk.

## Why Texas

Texas is the largest tax-deed market in the country and DeedPilot covers
**6 of 254 counties** — every one of them via `taxsales.lgbs.com`, a single law
firm. LGBS is not the only publisher; Texas delinquent-tax suits are handled by
several firms, each posting sale notices as a public-notice function:

| Firm | Host | robots.txt (verified 2026-08-05) |
|---|---|---|
| LGBS | `taxsales.lgbs.com` | permissive — **already ingested** |
| MVBA | `mvbalaw.com` | `Disallow: /wp-admin/` only, `Crawl-delay: 10` |
| Perdue Brandon | `www.pbfcm.com` | no robots.txt served |

Texas sells on the **first Tuesday of each month**, so unlike most states in
early August this is in season: the 2026-09-01 sale is already posting.

## MVBA structure

`https://mvbalaw.com/tax-sales/month-sales/` is the index. It carries:

- Month headings with the exact sale date —
  `August Tax Sales (Tuesday, August 4, 2026)`,
  `September Tax Sales (Tuesday, September 1, 2026)`. This is a **published**
  date, so `saleDateConfirmed: true` is justified.
- One link per county, in three flavours:
  - **PDF** at `/wp-content/TaxUploads/MMYY_County.pdf` — e.g. `0926_Eastland.pdf`
  - **MVBA online sale** at `mvbataxsales.com/auction/...`
  - **GovEase** — e.g. McLennan routes to `liveauctions.govease.com/tx/txmclennan/...`

Roughly ten counties per month, which compounds: each month is a fresh set.

The PDFs extract cleanly with the existing `pdfToText`. **No LLM is needed**,
which matters given Grok credits are exhausted — this is a free parser path
like the Florida clerks.

## Entry layout

```
1 423-T-14398 The County of Bastrop, Texas v
Jose L. Lopez
1.112 Acre, more or less, being Lot 17, Block B, Cielo Vista
Ranch, Section Two, Bastrop County, Texas, 171 Higinia Run,
Del Valle, Texas
Account #109555
Judgment Through Tax Year: 2025
$12,500.00
```

Sequence number · cause number · style · legal description ending in a street
address · **Account #** (the assessor account — this is the parcel identifier)
· judgment tax year · **minimum bid**.

## Why the generic parser must not be used here

`parseStructuredPdfText` on `0826_Bastrop.pdf` returned 9 rows against a true
17, and the rows it did return were wrong in two ways that matter:

- `parcelNumber: "201801295"` — that is the **Instrument number** from a
  recorded document reference embedded in the legal description, not the
  account. Same class of error as the Brevard account-ID problem
  (`docs/brevard-apn-resolution.md`).
- `assessedValue: 10300` — that is the **minimum bid**, not an assessed value.
  Feeding it to the max-bid engine would invent an ARV equal to the opening
  bid, which makes every lot look like a break-even.
- `openingBid: 1.04` — not a real figure at all.

It also threw `Cannot read properties of null` on `0926_Eastland.pdf`.

## Traps a real parser has to handle

Found by testing three counties. Each of these produced wrong output on the
first attempt:

1. **Greedy matching across entries.** A regex anchored on the entry start and
   scanning forward to the first `$amount` will happily jump the boundary into
   the next entry. On `0826_Rusk.pdf` this paired cause `2024-029` with a
   different tract's account and a $50.00 bid. It looked entirely plausible.
   Fabricating an association is worse than dropping the row.

2. **`WITHDRAWN` in place of the amount.** Rusk entry 2 reads
   `Judgment Through Tax Year: 2025` / `WITHDRAWN`. These are not for sale and
   must not be emitted as lots with a null bid.

3. **Multi-tract causes.** One cause number can carry `TRACT 1:` … `TRACT 4:`,
   each with its own `Account #` and tax year, with a single minimum bid at the
   end. Rusk entry 3 is four mineral-interest tracts under one cause.

   The semantics matter: **the sale unit is the cause, not the tract.** A
   bidder buys the whole bundle for that one minimum bid. Emitting four lots
   each carrying the full bid would quadruple apparent inventory and misstate
   the price of each. The defensible output is one lot per cause, primary
   account first, remaining accounts in `raw`.

4. **Per-county layout drift.** `0926_Eastland.pdf` contains 21 `Account #`
   and 21 `Judgment Through Tax Year` markers but matched zero entries under a
   regex tuned to Bastrop. The data is there; the anchors differ. Anchoring on
   `Account #` rather than the entry start is more robust across counties.

5. **Mineral interests.** Rusk carries royalty-interest tracts
   (`0.001722 RI ROCKCLIFF ENER OPER…`). These are not real property in the
   sense the max-bid engine assumes, and no assessment ratio applies. They need
   a distinct `landUse` at minimum, and arguably exclusion from pricing.

## Statute note

Texas is already in `STATUTE_PARAMS` (`lib/deal/statute.ts`), and the PDFs
themselves confirm the entry's central caveat in the counties' own words:
*"two year right of redemption for homestead property and property appraised as
agricultural land… 180 day right of redemption for all other property"* and
*"redemption premium of 25 percent… during the first year or 50 percent during
the second year."*

Eastland adds **mineral interests** to the two-year class, which the current
`extendedFor` note does not mention.

## Suggested build

1. Parse the month index for sale dates and county links.
2. PDF counties: anchor on `Account #`, group by cause, skip `WITHDRAWN`,
   one lot per cause with extra accounts in `raw`.
3. Verify parsed entry counts against a manual read of at least three counties
   with different layouts before shipping — Bastrop, Rusk and Eastland cover
   the three shapes seen so far.
4. GovEase-routed counties (McLennan) already belong to the `govease` adapter;
   do not double-ingest them.
5. `mvbataxsales.com` online sales are a separate surface, not yet examined.

Perdue Brandon (`pbfcm.com`) is unexamined and would add more counties again.
