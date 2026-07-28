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
| Parcel-level target | FL, GA, TX, AZ, MI — 578 counties |
| **Ingesting today** | **TX (28 counties) · MI (74 counties)** |

Live as of the last run: **120 auctions, 2,665 lots**, 0 rejected.

## Commands

```bash
npm run dev
npm run build
npm run db:push / db:seed / db:studio
npm run ingest -- --adapter tx-lgbs [--county 48201] [--limit N] [--dry-run]
npm run ingest -- --all
```

## Plans

Free (atlas + calendar) · Starter $49 · Pro $149 · Team $349 —
`lib/billing/plans.ts` is the single source of truth for limits, read by the
pricing page and the server-side gate alike.

## Not done yet

- **Auth, Stripe checkout, entitlement enforcement.** Plans and limits are
  defined; nothing is wired to Stripe and no route is gated.
- **Live auction-day co-pilot.** The research half ships; the real-time bidding
  sidebar does not.
- **FL, GA, AZ adapters.** FL needs 67 county-clerk sources (RealAuction is
  policy-blocked); GA is mostly in-person courthouse sales with no live feed;
  AZ is annual February lien auctions.
- **Assessor enrichment.** `lot_valuations` is modelled but unpopulated, so
  Michigan lots have no assessed value and ARV can't be derived there.
- **Interactive atlas map.** TopoJSON for all 3,142 counties is in
  `public/geo/`; the current atlas is list-based.
- **Transitive CVEs** from the Next scaffold (`postcss`, `sharp`, eslint chain).
