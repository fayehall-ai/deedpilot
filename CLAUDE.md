# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

DeedPilot is tax-deed and foreclosure auction intelligence: every US county's tax-sale rules, live auction inventory, and a max-bid engine. Next.js 16 (App Router, Turbopack, `cacheComponents: true`) · TypeScript · Postgres (Neon) + Drizzle · Tailwind v4. A separate Python package lives in `copilot/`.

## Commands

```bash
npm run dev                      # next dev
npm run build                    # next build
npm run lint                     # eslint
npx tsc --noEmit -p .            # typecheck (a stale .next/dev/types cron/ingest error can be ignored)
npm run db:migrate               # apply every drizzle/*.sql, in order, every time
```

**Tests have no runner.** Each `*.test.ts` is a standalone script that throws on failure: `npx tsx lib/ingest/judge.test.ts`. Run the ones next to what you changed. Python: `cd copilot && pip install -e ".[dev]" && pytest -q`.

**Scripts** (`scripts/*.ts`, run through the `npm run` aliases in package.json) must `import "../lib/env"` first. Next loads `.env.local` itself; plain `tsx` does not.

## Deploying and operating

- Production deploys from GitHub `main` through the Vercel git integration. Commit and push; don't `vercel deploy` from a laptop. After changing an env var in Vercel, redeploy for it to take effect.
- **Every scheduled job runs on Vercel. Nothing runs on the developer's Mac.** The old launchd worker `com.deedpilot.intel` is disabled; don't reintroduce local workers.
- Schema changes go in a new `drizzle/NNNN_*.sql` that is safe to re-run (`IF NOT EXISTS` throughout). `scripts/migrate.ts` keeps no ledger. `lib/db/schema.ts` mirrors them.

### The Sunday CAPE pipeline (vercel.json, times in UTC Monday = Sunday night Pacific)

All crons authenticate with `cronAuthorised` (`lib/admin/cron-auth.ts`, `Bearer $CRON_SECRET`).

1. `/api/cron/scout-intake`: reads the newest spreadsheet in Drive `CAPE/Auction Scout` and runs `ingestWorkbook` (`lib/import/scout-ingest.ts`). Sales are added or filled, list links are recorded, and county crawls are queued.
2. `/api/cron/crawl-drain`: the dispatcher (`/api/cron/dispatch`) in drain-only mode. It runs only the `crawl` lane (county list crawls): no calendar planning, research or site intel.
3. `/api/cron/reapi-enrich`: `runReapiDetailPass` (`lib/property/reapi-detail-pass.ts`). RealEstateAPI PropertyDetail under the spend policy, with no weekly budget.
4. `/api/cron/cape`: briefing scripts (`lib/cape/produce.ts`, `scriptOnly`).
5. `/api/cron/frameworks`: `.docx` framework documents to Drive `CAPE/Frameworks` (`lib/framework/deliver.ts`).
6. `/api/cron/render`: one narrated video per tick to Drive `CAPE/Videos` (`lib/cape/render.ts` → `lib/cape/deliver.ts`).

Frameworks and videos go to the top `video_top_n` sales per weekly batch (the `pipeline_settings` table, edited on /admin). Drive access is a service account (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_CAPE_FOLDER_ID`). Every request goes through `lib/delivery/drive.ts`, which adds the shared-drive flags. `docs/RUNBOOK.md` is the operator's guide and predates this schedule.

## Architecture

**The division that matters.** `lib/deal/maxbid.ts` computes every number a user acts on, deterministically, from `lib/deal/statute.ts` (per-state redemption, quiet title, assessment ratios). Model output never produces a price. `lib/ai/brief.ts` and the CAPE scripts are handed the computed figures as facts. `verifyNarration` in `lib/cape/script.ts` rejects a script that speaks a number that isn't in them. Keep that direction when adding AI features.

**County rules** live in code, not the DB: `lib/atlas/county-rules.ts` (researched counties) inherits state defaults, and pages label inherited fields. `lib/atlas/calendar.ts` projects when a county sells. A window with `sweep: true` is only a date to look, not a sale date. The generic crawler must never file a list under one (`listAuctions` in `lib/ingest/adapters/generic.ts`).

**Ingestion** is `policy → fetch → adapter → judge → runner` (`lib/ingest/`).
- Adapters are registered in precedence order in `lib/ingest/adapters/index.ts`. `genericAdapter` must stay last: it matches almost any county page.
- The generic adapter parses tables and spreadsheets in code. It sends PDFs and scans to a model (`lib/ingest/extract.ts`, tier `transcribe`).
- `judge.ts` separates rejected lots from repaired ones.
- `runner.ts` upserts, keyed on `(auction_id, dedupe_key)`, where `dedupe_key` is the list's own parcel number. Enrichment-owned lot fields are `coalesce`d so a re-ingest can't erase them.
- `reconcile.ts` marks absences (`withdrawn` lots, `delisted_at` sales).

**Job queue.** `run_jobs` (`lib/admin/queue.ts`) is leased, prioritised and partitioned into lanes (`LANES.cape`, `render`, `dispatch`, `crawl`). The `adapter` column encodes the job kind (`cape-script:<auctionId>`, `cape-video:…`, `scout:<state>`, an ingest adapter name). A cron claims until its time budget runs out; a job that outlives its lease is re-claimed by the next tick.

**Enrichment and spend.**
- RealEstateAPI is the only paid property source. `lib/property/enrich.ts` chains the free state cadastre, then RealEstateAPI. ATTOM, BatchData, RentCast and web search are out of the chain; their modules stay in `providers/`.
- `lib/property/spend-policy.ts` (`paidLookupRefusal`) refuses paid lookups for lien sales, cancelled or unconfirmed-date sales, lots not `pending`, and land-only lots. Land-only is defined in `lib/lots/land-only.ts`, with a TS and a SQL form that must stay in sync.
- The provider (`lib/property/providers/realestateapi.ts`) tries APN forms, county-specific APN shapes, address, then a county-scoped AutoComplete search. It refuses any record whose county differs from the lot's, because `applyRecordToLot` overwrites lot fields.
- Raw payloads are kept in `lot_valuations.raw`.

**AI providers** are in `lib/ai/providers.ts`: Grok primary (`XAI_MODEL`, default grok-4.5; `XAI_TRANSCRIBE_MODEL` for list reading; `XAI_SEARCH_MODEL` grok-4.6 for cited web research), with Claude (`claude-opus-5`) as fallback. `runStructured` returns zod-validated JSON; `runSearched` browses and cites. Per-call spend is recorded through `recordUsage` (`lib/ai/usage.ts`).

**Site and queries.**
- `proxy.ts` is the site password gate. `/api/cron` is outside it.
- Public listings use `isConfirmedInventory()` (`lib/db/inventory.ts`), which hides projected dates.
- Lot pages: `app/lots/[id]/page.tsx`, with Street View via `/api/lots/[id]/streetview`, keeping the Google key server-side.
- Home-page address lookup: `app/lookup-action.ts`, which uses RealEstateAPI only (`lib/property/address-lookup.ts`).

## Conventions

- Match the codebase's comment style: block comments explain *why*, often with the measured incident that motivated the code. Commit messages follow the same register: a subject stating the change, then a body with the evidence.
- Every parcel-matching rule that can write to a lot is a place a wrong-property record can land. Check new matching paths against the county guard and the land-only rule.
