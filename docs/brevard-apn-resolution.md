# Brevard account # → assessor APN

## Problem

Brevard clerk sale list PDFs label a column **Parcel Number**, but values are
**7-digit tax-deed account / application IDs** (e.g. `2105897`), not Brevard
County Property Appraiser (BCPAO) parcel IDs.

ATTOM / BatchData APN lookup therefore returns **no match** for ~130 Brevard
lots. Max-bid stays dark until a real APN or manual ARV is supplied.

## What we tried (automated)

| Source | Result |
|--------|--------|
| Clerk PDF | Only account # + opening bid (structured) |
| `bcpao.us` property search / API | **403** Cloudflare bot block |
| `brevard.realtdm.com` public case list | **403** / registration wall |
| ATTOM `apn` + FIPS `12009` | No match on account IDs |

## Manual / semi-manual workflow (works today)

For each Brevard lot of interest:

1. Open the lot in DeedPilot (parcel field shows account #).
2. **County records** sidebar → Brevard Property Appraiser search  
   (or https://www.bcpao.us/PropertySearch/).
3. Search by **account / alt key** if available; otherwise use case # from the
   sale list / RealTDM case file for address, then reverse-search APN.
4. Optional: RealTDM public case file  
   https://brevard.realtdm.com/public/cases/list — status **LA** or sale date
   for lands/list docs (may require accepting terms / not automation-friendly).
5. Enter **comps ARV** in the deal calculator, **or** once you have a real APN
   address, run **Fetch property details** (ATTOM/BatchData) if the lot was
   updated with a true parcel #.

## Product paths (future)

1. **Paid RealTDM / bulk export** if Brevard offers a data product.
2. **Human-in-the-loop** PAO enrichment queue (screenshot / copy APN).
3. Store `accountNumber` separate from `parcelNumber` so we stop sending
   account IDs to ATTOM (reduces quota burn).

## Related code

- Ingest: `lib/ingest/adapters/florida-clerks.ts` (pattern `brevard`)
- Assessor links: `lib/property/assessor-links.ts` FIPS `12009`
- Enrich order prefers non-numeric APNs first (`lib/property/enrich.ts`)
