# Florida sprint — clerk PDFs → max-bid

**Goal:** After MI/TX, make Florida the next state where a typical live lot
gets a walk-away price — without scraping RealAuction.

## Strategy

1. **Government list PDFs only** (Brevard pattern). RealAuction stays blocked.
2. **Durable adapter** `fl-clerks` discovers sale-date pages and list PDFs.
3. **Statute already exists** for FL (`lib/deal/statute.ts`) — assessment ratio 0.85, no post-sale redemption, quiet title required.
4. **ARV** is the remaining gate: clerk lists often omit assessed value.

## Adapter

```bash
npm run ingest -- --adapter fl-clerks
# alias: --adapter fl-counties
```

| Clerk | Pattern | Status |
|-------|---------|--------|
| Brevard | Index `tax-deed-sales` → sale page → `TAX DEED SALE MM-DD-YYYY.pdf` | **Live** (~130 upcoming lots) |
| Volusia | Static PDF `LandsAvailableForTaxes.pdf` (struck / available inventory) | **Live** (11 lots) |
| Sumter | WordPress `:taxdeeds=` JSON on tax-deed-sales page | **Live** (7 lots, opening bids) |
| Columbia | WordPress `:taxdeeds=` upcoming sales | **Live** (19 lots; bids often blank) |
| Marion | LAT purchase-amount PDF (lands available) | **Live** (2 lots, purchase amounts) |
| Okaloosa | WordPress lands-available JSON | **Live** (1 lot) |
| Calhoun | WordPress `:taxdeeds=` tax-deed-sales | **Live** (3 lots) |
| Others | — | Most large markets are RealAuction-only or bot-blocked SPAs |

### Re-run

```bash
npm run ingest:fl
```

## Current inventory (maintain this section)

See `npm run flywheel:coverage -- --plan` → FL rows.

As of continued FL sprint (2026-08-01, post Sumter/Columbia/Marion/Okaloosa):

- **7 counties**, **~173 lots** via `fl-clerks` (all free parsers; no Claude)
- Brevard: **130** · Volusia LAT: **11** · Columbia: **19** · Sumter: **7** · Calhoun: **3** · Marion LAT: **2** · Okaloosa LAT: **1**
- Opening bids present on most except Columbia/Calhoun (parcels only)
- Assessed / auto max-bid: **22 / 173** after first ATTOM pass (Sumter/Volusia/Marion/Calhoun/Okaloosa hits)
- Brevard (~130 lots) mostly **no ATTOM match** — clerk list uses account/file IDs, not assessor APNs
- Columbia parcels often miss ATTOM until format is known
- Assessor deep-links on lot page for these counties
- Re-enrich: `npm run enrich:lots -- --state FL --limit 50` (when ATTOM quota allows)
- Production: `ATTOM_API_KEY` set on Vercel; app at https://deedpilot.vercel.app
- Example enriched lots:
  - https://deedpilot.vercel.app/lots/cff74eb5-9ef5-41a0-9c60-e64f7c56c3fc (Marion)
  - https://deedpilot.vercel.app/lots/afbb7f36-7abc-4776-b87d-3d98e472dcc2 (Sumter)
- Next free inventory: more WP `:taxdeeds=` clerks when they schedule sales (Hardee/Dixie historical only)

## Assessed / ARV path

| Approach | Status |
|----------|--------|
| Clerk PDF fields | Opening bid yes; assessed usually no |
| Brevard PAO (bcpao.us) | Cloudflare / bot-blocked from our crawler |
| County deep-links on lot page | **Shipped** — open appraiser with parcel # |
| Property API enrich | **Shipped** — `ATTOM_API_KEY` (APN) / `RENTCAST_API_KEY` (address) |
| Comps override in UI | **Works today** — user enters ARV → max-bid fires |

```bash
# Batch enrich FL lots missing assessed (needs ATTOM or RentCast key)
npm run enrich:lots -- --state FL --limit 20
```

Lot page: **Fetch property details** button → `POST /api/lots/:id/enrich`.

**Product stance:** Do not invent ARV from opening bid (tax amount is not market value).

## Non-goals this sprint

- RealAuction / realtaxdeed.com
- Statewide generic prospect of all 67 counties
- SC/GA volume work

## Expand checklist (next clerk)

Before adding to `FL_CLERKS` in `lib/ingest/adapters/florida-clerks.ts`:

- [ ] Index page is government (.gov / clerk host)
- [ ] Sale list PDF is downloadable without login
- [ ] PDF has extractable text (not pure scan)
- [ ] `politeFetch` not policy-blocked
- [ ] Dry-run produces ≥1 judged lot with parcel or case id
