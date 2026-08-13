# New Mexico — SUPERSEDES `statute-nm-2026-08-01.md`

The August draft blocked on one thing: *"do not merge `assessmentRatio` without a
statute cite and class note."* That question is now answered, and it turns out
not to be what is blocking New Mexico.

**NM would light up 0 of its lots even with a perfect ratio.** The blocker is
data, not statute.

## The ratio question, answered — and the draft's framing was wrong

Verified against the text rather than a summary. The cited section says:

> **§ 7-36-15** — *"the value of property for property taxation purposes shall be
> its market value"*

It never mentions taxable value, one-third, or an assessment ratio. The verifier
found where the figure actually lives:

> *"The one-third figure is the separate 'tax ratio' in § 7-37-3 ('The tax ratio
> is thirty-three and one-third percent.'), not part of the valuation methods in
> 7-36-15."*

N.M. Const. art. VIII, § 1 caps *"the percentage of value against which tax rates
are assessed"* at the same 33⅓%.

So New Mexico carries **two** numbers, and `assessmentRatio` depends entirely on
which one a county assessor publishes:

| If the published figure is | then `assessmentRatio` is |
|---|---|
| "value" / full value (§ 7-36-15) | **1.0** — like California |
| "taxable value" (§ 7-37-3 tax ratio) | **0.3333** |

Guessing wrong is a **3× error in ARV**, in the direction that makes parcels look
three times more valuable than they are. This is the same trap the CA entry
documents, and the reason `assessmentRatio` is specified as a fraction of market
value rather than "whatever the assessor prints".

**It cannot be resolved from the statute** — only by measuring what our data
holds, the way Arkansas was settled at 0.2000 across 1,669 of 1,669 parcels.

## `redemption: null` — verified

The August draft carried this on "high confidence" reasoning. It is now checked
against the text, and **supported**:

> **§ 7-38-70(B)** — *"If the real property was sold substantially in accordance
> with the Property Tax Code, the deed conveys all of the former property owner's
> interest in the real property as of the date the state's lien for real property
> taxes arose in accordance with the Property Tax Code, subject only to perfected
> interests in the real property existing before the date the property tax lien
> arose."*

The deed conveys *all* of the former owner's interest, leaving none to redeem.
Subsection C then bars any challenge after two years, and subsection D limits
those challenges to four enumerated grounds — non-taxability, notice failure,
pre-sale payment, or a timely installment agreement.

Three details worth carrying into the entry:

- The conveyance effect is conditional on the sale being *"substantially in
  accordance with the Property Tax Code"* — it is not automatic.
- The two-year bar runs from **the date of sale**, not from deed delivery. That
  is the right clock for `auctionToMarketableMonths`, which also starts at the
  auction.
- The section was last amended in 1982, so unlike Louisiana there is no recent
  act to check behind it.

Caveat on provenance: the cited justia URL was unfetchable and the text was read
via a search fallback (casemine, legalfix, findlaw). The section and quote are
checkable, but this is a second-hand read of a primary source, not a direct one.

## Why it cannot be measured yet

Of 630 NM lots crawled, **zero** carry an assessed value. Populated fields:

```
630 100%  opening_bid, legal_description, owner_name, status, source_url
612  97%  parcel_number
186  30%  address_line
  0   0%  assessed_value, taxes_owed, land_use, acreage, year_built, lat/long
```

The PTD notice publishes a minimum bid and a legal description, not a valuation.
So `compute_maxbid` returns `insufficient-data` for every NM parcel regardless of
what ratio we merge — there is nothing to apply it to. The August draft's
instruction *"Do not invent a ratio to light up the 186 lots"* was right, and
understated: there is nothing to light up.

## Enrichment is blocked on a credential

`assessed_value` would come from the property API. Measured today:

| Provider | Lookup | Status |
|---|---|---|
| **ATTOM** | parcel number | **HTTP 401 Unauthorized** |
| RentCast | address only | HTTP 200, healthy |
| BatchData | address, APN on some plans | configured |

ATTOM is the one that looks up by **parcel number**, and parcel number is the
only strong identifier New Mexico publishes (97%). The key in `.env.local` is
present but rejected.

Address lookup cannot substitute, because NM's `address_line` is not an address.
It is notice prose:

> `IN LOS RANCHOS DE ALBUQUERQUE ON ALMA ENCANTADA CT NW`

No house number, and `city` and `zip` are empty for all 630. RentCast returned no
match on the first lot for exactly this reason before the batch aborted.

**One renewed ATTOM key unblocks the ratio measurement, the valuations, and the
state.** That is the whole critical path.

## A data defect found on the way, and its real cause

93 parcels appeared under **two** counties — 186 rows — with Albuquerque
addresses filed under both Bernalillo (35001, correct) and Catron (35003, a
different corner of the state).

The cause is **not** the `nm-ptd` adapter, which reads the state index properly
and stamps `saleDateConfirmed: true`. Both bad auctions came from the
speculative-coverage path:

```json
{"saleDateEstimated": true, "scheduleConfidence": "unresearched"}
```

external ids `35001|2026-08-06` and `35003|2026-08-08` — guessed dates, both now
past, no source PDF, generic titles. A generic scan attached one notice's parcels
(`AuctionAdvertisement-22-2.pdf`) to two placeholder auctions in two counties.

`purgeSkeletons` does not catch them: it targets `lot_count = 0` with a future
date, and these have 93 lots each and past dates. `scripts/purge-nm-placeholder-auctions.ts`
removes exactly these two by external id, refusing to run against anything
`nm-ptd:`-prefixed or anything not marked `saleDateEstimated`.

### Hardening applied regardless

The statutory notice names its own county — *"public auction, in X County"* —
and `parseNoticeHeader` was already extracting it into `raw.noticeCounty`, where
nothing read it. The adapter cross-checked the notice **date** against the index
and not the **county**. It now does both, on the file's own stated doctrine that
the notice is the legal publication and the index is a summary of it. Because
`externalId` is keyed on FIPS, a corrected county collapses a would-be duplicate
at the source instead of downstream.

This did not cause the 186 rows, but it closes the same failure mode in the path
that *is* authoritative — a notice whose filename names no county (like
`AuctionAdvertisement-22-2.pdf`) is exactly what the index cannot attribute.

## Market practice — searched, and honest about a gap

- **Quiet title: `unknown`.** No New Mexico attorney fee page, bar survey,
  legal-aid guide or court self-help page states a dollar figure. The pass
  refused to substitute a national range, which is the correct behaviour.
- **Closing costs: `sourced`, $25–$50.** County clerk recording fees under
  NMSA 1978 § 14-8-15 ($25 for 1–10 index entries). No documentary stamp or
  transfer tax. No separate PTD deed-issuance fee in the auction terms.
- **Surviving liens:** a § 7-38-67 sale extinguishes only the tax lien. The deed
  conveys the owner's interest as of the date the lien arose (1 January of the
  tax year), subject to interests perfected before that date (§ 7-38-70(B)).
  Mortgages, municipal liens and improvement-district assessments can survive.
  Parcel-specific title search required.

### The duration split matters here

Former owners may challenge the conveyance in district court for **two years**
after the sale. Practitioners may wait that window out before filing, so:

- `quietTitle.months` (filing → decree): **unknown**
- `auctionToMarketableMonths`: **≥ 24**, and it is the figure carry is charged
  against

This is the same split Arkansas forced, where a five-month action sat inside an
eighteen-month hold.

## Recommendation

**Do not promote NM.** Not because the statute is unclear — it is now clearer
than Arkansas's was — but because a merged entry would change nothing while
implying the state is priced.

Order of operations:

1. **Renew the ATTOM key.** Blocks everything below.
2. Enrich NM by parcel number, then measure assessed ÷ market across the corpus.
   A tight cluster at 1.0 or 0.3333 settles `assessmentRatio` from data.
3. Get one New Mexico quiet-title figure from a practitioner. Nothing published
   states one, so this is the one number search cannot supply.
4. Then promote, with `auctionToMarketableMonths: 24`.

## Human checklist

- [ ] Renew `ATTOM_API_KEY` (currently 401)
- [ ] Run `scripts/purge-nm-placeholder-auctions.ts --apply` to drop the 186
      duplicate rows (dry run prints the target and refuses published notices)
- [ ] Confirm whether NM assessors publish full value or taxable value — settle
      by measurement after enrichment, not by reading
- [ ] Source one NM quiet-title / confirmation cost
- [ ] Decide whether to wait out the two-year § 7-38-70(B) window before filing
