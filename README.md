# DeedPilot

Tax deed and foreclosure auction intelligence. Every county's tax sale rules,
live auction inventory for the states with the most volume, and a co-pilot that
computes your walk-away price before you bid.

Working name — rename freely (`deedpilot` appears in `package.json`, the layout
header, and `USER_AGENT` in `lib/ingest/fetch.ts`).

## Why it exists

A $14,000 opening bid on a property assessed at $831,000 looks like a
life-changing deal. Then Georgia assesses at 40% of market value, Texas hands
the owner 180 days to redeem at a 25% penalty, a municipal lien survives the
sale, and no title insurer will write a policy until a $5,000 quiet title action
completes. DeedPilot does that arithmetic before the paddle goes up.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Postgres + Drizzle ·
Tailwind v4 · Claude (`claude-opus-5`) · Stripe

## Getting started

```bash
cp .env.example .env.local     # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm install
npm run db:push                # create tables
npm run db:seed                # seed 3,142 counties from the atlas
npm run ingest -- --all        # pull live auction inventory
npm run dev
```

Local Postgres via Homebrew:

```bash
brew services start postgresql@15
createdb deedpilot
# DATABASE_URL="postgresql://<you>@localhost:5432/deedpilot"
```

## Architecture

```
lib/atlas/      Rules for all 3,142 counties. Authored research, in code, not
                the DB — it's version-controlled content and the SEO surface.
                152 counties researched individually; the rest inherit state
                defaults, and every page labels which fields were inherited.

lib/deal/       Deterministic max-bid engine + per-state statutory parameters
                (redemption tiers, quiet-title cost, assessment ratios).
                No model output. Ever.

lib/ingest/     policy → fetch → adapter → judge → runner.
                Access policy is enforced in code, not documented in a comment.

lib/ai/         Claude risk briefs. Given the computed numbers as facts and
                told not to produce its own.

lib/db/         Drizzle schema. Only *observed* data lives here.

copilot/        Python co-pilot: the oracles as callables, a clearing-price
                world model fitted on recorded sales, a risk-adjusted bid
                search, and the self-improvement flywheel. See copilot/README.md
                — especially "What the corpus actually observes", which is the
                honest accounting of what 92k recorded rows do and do not
                support.
```

### The division that matters

`lib/deal/maxbid.ts` computes every number a user acts on. `lib/ai/brief.ts`
explains those numbers and flags risk. The model never produces a walk-away
price — a hallucinated one is the single output that could directly cost a
subscriber money at auction. If the AI is unavailable, the deal analysis still
renders in full.

### Ingestion: LLM-extracts / code-judges

Extraction may be fuzzy. Acceptance is not. `lib/ingest/judge.ts` splits two
outcomes that are usually conflated:

- **Rejected** — unidentifiable, or money that would mislead a bidder. Dropped.
- **Repaired** — one junk field on an otherwise good parcel (a `0000000000`
  ZIP). Field nulled, parcel kept, repair counted.

Discarding a real parcel to keep the dataset tidy costs the subscriber a deal.
Both counters land in `ingest_runs`; a spike in either means a source moved.

### Access policy is architectural

`realtaxdeed.com` and `realforeclose.com` (RealAuction) publish
`User-agent: * / Disallow: /`. RealAuction hosts most of Florida's tax deed
sales. They are marked `requires_agreement` in `lib/ingest/policy.ts`, and
`politeFetch` throws `PolicyBlockedError` rather than fetching — recorded as a
blocked county, visible on `/coverage`, not silently missing.

The resolution is to prefer the **government source of record**: county clerks
and tax collectors are the legal publishers of these lists, their sites are
robots-permissive, and they sit behind no platform ToS.

## Coverage

| | |
|---|---|
| Rules atlas | 50 states + DC, 3,142 counties |
| Researched in depth | 152 counties (sources + check dates) |
| Priceable (statutory params) | AZ, CA, FL, GA, IL, MI, TX — `lib/deal/statute.ts` |
| Parcel-level target | FL, GA, TX, AZ, MI — 578 counties |
| **Ingesting today** | **TX (28 counties) · MI (74 counties)** |

Live as of the last run: **128 sales, 3,090 lots** on published sale lists,
**2,861 of them auto-priceable (93%)**. A further 6,508 parcels are held as
*leads* — see "What counts as inventory" below.

### What counts as inventory

Counties publish delinquent rolls, lands-available inventory and actual sale
lists from the same page, in the same format. Only the last is something to bid
on, and the difference is not visible to a parser: a delinquent roll has
parcels, owners, addresses and dollar amounts, exactly like a sale list, and is
routinely 10-50x larger because most owners pay before any levy.

Every auction therefore carries two facts, asserted by the adapter and never
inferred:

- `listing_kind` — `sale_list` · `delinquent_list` · `lands_available` · `unknown`
- `sale_date_confirmed` — false when the date came from `nextSaleWindows`
  projecting the state's typical schedule rather than from the county

Only `sale_list` + confirmed counts as inventory, anywhere. Everything else is
reported under its own name on `/coverage`. This is not a display preference:
before it existed, Cobb County GA's delinquent roll (2,825 parcels) and
Greenville SC's procedures page (3,461) made up 65% of the headline lot count
under sale dates that were projected, and in Cobb's case did not exist — Cobb
held two sales in 2026, on May 5 and November 3.

## Commands

```bash
npm run dev
npm run build
npm run db:push / db:seed / db:studio
npm run ingest -- --adapter tx-lgbs [--county 48201] [--limit N] [--dry-run]
npm run ingest -- --all
npm run ingest -- --adapter mi-taxsaleinfo --enrich --limit 200   # SEV second pass
npm run ingest:fl                              # Florida clerk PDFs (Brevard first)

# National coverage meta-loop (see docs/self-improving-coverage-loop.md)
npm run flywheel:coverage -- --plan              # scoreboard + ranked work
npm run flywheel:coverage -- --cycle --limit 300 # purge skeletons + MI enrich
npm run enrich:mi -- --limit 500
npm run purge:skeletons
```

Florida focus: `docs/fl-sprint.md` — clerk list PDFs only; RealAuction stays blocked.

## Plans

Free (atlas + calendar) · Starter $49 · Pro $149 · Team $349 —
`lib/billing/plans.ts` is the single source of truth for limits, read by the
pricing page and the server-side gate alike.

## Coverage loop (in progress)

See `docs/self-improving-coverage-loop.md`. Nightly plan: scoreboard → rank work
→ safe actions (MI SEV enrich, skeleton purge) → human queue for statutes/labels.

**As of latest cycle (local):** skeletons purged; MI SEV enrichment climbing;
auto-priceable rate **93%** of confirmed inventory (2,861 / 3,090). Gold score
26.3%. Gold scoreboard on `/coverage` and `data/coverage-scoreboard.json`.

The rate jumped from 30% when listing provenance landed, without enriching a
single new lot: the old denominator counted 6,508 delinquent-roll and
lands-available parcels that contributed 25 assessed values between them. The
scoreboard now counts only what a subscriber can bid on, which also stops the
work plan from ranking "enrich 3,477 SC lots" as the top priority when none of
those parcels were for sale.

## Not done yet

- **Auth, Stripe checkout, entitlement enforcement.** Plans and limits are
  defined; nothing is wired to Stripe and no route is gated.
- **Live auction-day co-pilot.** The research half ships; the real-time bidding
  sidebar does not.
- **FL and AZ adapters.** FL needs 67 county-clerk sources (RealAuction is
  policy-blocked); AZ is annual February lien auctions.
- **GA real sale lists.** `lib/ingest/adapters/georgia.ts` currently pins Cobb
  to the county's *delinquent roll*, now correctly tagged `delinquent_list` and
  excluded from inventory. Cobb publishes the actual sale list roughly four
  weeks before each sale (2026: May 5, Nov 3), so GA needs a discovery pass that
  picks up the sale list when it appears rather than a standing URL. GA is
  otherwise in-person courthouse sales with no live feed, and PDF extract needs
  a working LLM (Grok credits / Claude fallback).
- **SC sale-date semantics.** Greenville's 3,461-row table and Charleston's list
  sit under dates projected by `nextSaleWindows`, so both are excluded from
  inventory. Confirm whether the Greenville table is the sale list or a standing
  certificate roll before promoting it — see `proposals/statute-sc-2026-08-01.md`.
- **Finish MI SEV enrichment** for remaining lots without assessed values
  (`npm run enrich:mi -- --limit 700` until dry).
- **Interactive atlas map.** TopoJSON for all 3,142 counties is in
  `public/geo/`; the current atlas is list-based.
- **Transitive CVEs** from the Next scaffold (`postcss`, `sharp`, eslint chain).
- **Grok API credits** — set `DEEDPILOT_DISABLE_GROK=1` to skip burned primary
  and use Claude for PDF extraction / cartographer.
