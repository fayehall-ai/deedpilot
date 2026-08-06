/**
 * Orchestrates one adapter across its counties: discover -> list -> judge ->
 * upsert -> record.
 *
 * Failure policy: a county that throws does not stop the run. Ingestion here
 * spans hundreds of independently-maintained government sites, and one county
 * changing its HTML must not take the other 577 offline. Every outcome —
 * success, policy block, parse failure — lands in `ingest_runs`, because a
 * county that quietly stopped returning lots is otherwise indistinguishable
 * from a county with no sale scheduled.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, counties, ingestRuns, lots, lotValuations } from "../db/schema";
import { judgeAuctions, judgeLots } from "./judge";
import { PolicyBlockedError } from "./fetch";
import type { DiscoveredAuction, DiscoveredLot, SourceAdapter } from "./types";

export interface RunOptions {
  /** Limit the run to one county — the usual way to debug an adapter. */
  countyFips?: string;
  /** Parse and judge, but write nothing. */
  dryRun?: boolean;
  /** Cap counties processed, for smoke runs. */
  limit?: number;
  onProgress?: (msg: string) => void;
}

export interface CountyRunResult {
  countyFips: string;
  status: "ok" | "partial" | "failed" | "blocked";
  auctionsFound: number;
  lotsFound: number;
  rejected: number;
  repaired: number;
  error?: string;
}

export interface RunSummary {
  adapter: string;
  counties: CountyRunResult[];
  totals: {
    auctions: number;
    lots: number;
    rejected: number;
    repaired: number;
    failed: number;
    blocked: number;
  };
}

function toNumeric(v: number | undefined): string | null {
  return v === undefined ? null : String(v);
}

async function upsertAuction(a: DiscoveredAuction): Promise<string> {
  const [row] = await db
    .insert(auctions)
    .values({
      countyFips: a.countyFips,
      platform: a.platform,
      saleType: a.saleType,
      externalId: a.externalId,
      title: a.title,
      saleDate: a.saleDate,
      // Absent means unconfirmed. An adapter has to assert a published date and
      // a known document kind; neither is ever inferred on its behalf here.
      saleDateConfirmed: a.saleDateConfirmed ?? false,
      listingKind: a.listingKind ?? "unknown",
      startTime: a.startTime,
      status: a.status ?? "scheduled",
      registrationDeadline: a.registrationDeadline,
      depositDeadline: a.depositDeadline,
      sourceUrl: a.sourceUrl,
      raw: a.raw,
    })
    .onConflictDoUpdate({
      target: [auctions.countyFips, auctions.platform, auctions.externalId],
      set: {
        // saleType must update. It was omitted here originally, which meant an
        // auction kept whatever classification it was first written with, for
        // good — a re-run looked successful (lastSeenAt moved, lots refreshed)
        // while the legal classification driving the max-bid maths stayed
        // stale. Arkansas surfaced it: 46 auctions held "Redeemable Deed"
        // through a full re-ingest after the adapter was corrected to
        // "Tax Deed". The TDC drive lists 12 more states whose sale type may
        // need correcting, so this would have bitten again.
        saleType: sql`excluded.sale_type`,
        saleDate: sql`excluded.sale_date`,
        saleDateConfirmed: sql`excluded.sale_date_confirmed`,
        listingKind: sql`excluded.listing_kind`,
        startTime: sql`excluded.start_time`,
        status: sql`excluded.status`,
        title: sql`excluded.title`,
        sourceUrl: sql`excluded.source_url`,
        registrationDeadline: sql`excluded.registration_deadline`,
        depositDeadline: sql`excluded.deposit_deadline`,
        raw: sql`excluded.raw`,
        lastSeenAt: sql`now()`,
      },
    })
    .returning({ id: auctions.id });

  return row.id;
}

async function upsertLots(
  auctionId: string,
  countyFips: string,
  discovered: DiscoveredLot[],
): Promise<number> {
  if (discovered.length === 0) return 0;

  const values = discovered.map((l) => ({
    auctionId,
    countyFips,
    // judgeLots guarantees at least one of these is present.
    dedupeKey: (l.parcelNumber?.trim() || l.externalId!.trim())!,
    externalId: l.externalId,
    lotNumber: l.lotNumber,
    parcelNumber: l.parcelNumber,
    caseNumber: l.caseNumber,
    addressLine: l.addressLine,
    city: l.city,
    zip: l.zip,
    legalDescription: l.legalDescription,
    latitude: toNumeric(l.latitude),
    longitude: toNumeric(l.longitude),
    openingBid: toNumeric(l.openingBid),
    assessedValue: toNumeric(l.assessedValue),
    taxesOwed: toNumeric(l.taxesOwed),
    landUse: l.landUse,
    acreage: toNumeric(l.acreage),
    buildingSqft: l.buildingSqft,
    yearBuilt: l.yearBuilt,
    ownerName: l.ownerName,
    status: l.status ?? ("pending" as const),
    soldAmount: toNumeric(l.soldAmount),
    sourceUrl: l.sourceUrl,
    raw: l.raw,
  }));

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const batch = values.slice(i, i + CHUNK);
    await db
      .insert(lots)
      .values(batch)
      .onConflictDoUpdate({
        target: [lots.auctionId, lots.dedupeKey],
        set: {
          // Adapter-owned. The source is authoritative, so a re-run overwrites
          // — including back to null, because a bid the county withdrew must
          // not linger, and a lot that goes pending → sold has to move.
          openingBid: sql`excluded.opening_bid`,
          taxesOwed: sql`excluded.taxes_owed`,
          status: sql`excluded.status`,
          soldAmount: sql`excluded.sold_amount`,
          raw: sql`excluded.raw`,
          lastSeenAt: sql`now()`,

          // Enrichment-owned: coalesced so a re-ingest cannot erase them.
          //
          // `applyRecordToLot` writes these columns from ATTOM/RentCast, and
          // most adapters never collect them — Arkansas COSL publishes no
          // address and no assessed value at all. Plain `excluded.x` therefore
          // set them back to null on the next run, silently destroying paid
          // API work: the Arkansas plan is ~6,760 ATTOM lookups, and one
          // routine re-ingest afterwards would have wiped every one.
          //
          // COALESCE keeps the adapter authoritative when it actually has a
          // value, and preserves the enriched value when it does not.
          assessedValue: sql`coalesce(excluded.assessed_value, ${lots.assessedValue})`,
          addressLine: sql`coalesce(excluded.address_line, ${lots.addressLine})`,
          city: sql`coalesce(excluded.city, ${lots.city})`,
          zip: sql`coalesce(excluded.zip, ${lots.zip})`,
          latitude: sql`coalesce(excluded.latitude, ${lots.latitude})`,
          longitude: sql`coalesce(excluded.longitude, ${lots.longitude})`,
          landUse: sql`coalesce(excluded.land_use, ${lots.landUse})`,
          ownerName: sql`coalesce(excluded.owner_name, ${lots.ownerName})`,
        },
      });
    written += batch.length;
  }

  await db
    .update(auctions)
    .set({ lotCount: written })
    .where(eq(auctions.id, auctionId));

  return written;
}

export async function runAdapter(
  adapter: SourceAdapter,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const log = opts.onProgress ?? (() => {});
  const results: CountyRunResult[] = [];

  log(`[${adapter.name}] discovering counties…`);
  let bindings = await adapter.discoverCounties();
  if (opts.countyFips) bindings = bindings.filter((b) => b.countyFips === opts.countyFips);
  if (opts.limit) bindings = bindings.slice(0, opts.limit);
  log(`[${adapter.name}] ${bindings.length} county binding(s)`);

  for (const binding of bindings) {
    const started = Date.now();
    let runId: string | undefined;

    if (!opts.dryRun) {
      const [run] = await db
        .insert(ingestRuns)
        .values({ adapter: adapter.name, countyFips: binding.countyFips, status: "running" })
        .returning({ id: ingestRuns.id });
      runId = run.id;
    }

    const result: CountyRunResult = {
      countyFips: binding.countyFips,
      status: "ok",
      auctionsFound: 0,
      lotsFound: 0,
      rejected: 0,
      repaired: 0,
    };

    try {
      const rawAuctions = await adapter.listAuctions(binding);
      const judgedAuctions = judgeAuctions(rawAuctions, { countyFips: binding.countyFips });
      result.rejected += judgedAuctions.rejected.length;

      for (const r of judgedAuctions.rejected) {
        log(`[${adapter.name}] ${binding.countyFips} rejected auction: ${r.reasons.join("; ")}`);
      }

      for (const auction of judgedAuctions.accepted) {
        result.auctionsFound++;
        try {
          const rawLots = await adapter.listLots(auction);
          const judgedLots = judgeLots(rawLots);
          result.rejected += judgedLots.rejected.length;
          result.repaired += judgedLots.repairs.length;

          if (judgedLots.rejected.length) {
            const sample = judgedLots.rejected[0].reasons.join("; ");
            log(
              `[${adapter.name}] ${auction.externalId}: rejected ${judgedLots.rejected.length}/${rawLots.length} lots (e.g. ${sample})`,
            );
          }
          if (judgedLots.repairs.length) {
            const r0 = judgedLots.repairs[0];
            log(
              `[${adapter.name}] ${auction.externalId}: repaired ${judgedLots.repairs.length} field(s) (e.g. ${r0.field}=${JSON.stringify(r0.value)} — ${r0.reason})`,
            );
          }

          if (!opts.dryRun) {
            // Guard: only persist an auction + its lots if we actually extracted >0 parcels.
            // This stops generic-county (new states) from creating "skeleton" records
            // (calendar date only, no table/PDF success) that show up as county cards with Lots: 0.
            if (judgedLots.accepted.length > 0) {
              const auctionId = await upsertAuction(auction);
              result.lotsFound += await upsertLots(auctionId, binding.countyFips, judgedLots.accepted);
            } else {
              log(`[${adapter.name}] ${auction.externalId}: skipped persist (0 lots after judgment)`);
            }
          } else {
            result.lotsFound += judgedLots.accepted.length;
          }
        } catch (e) {
          // One bad auction shouldn't lose the rest of the county's sales.
          result.status = "partial";
          log(`[${adapter.name}] auction ${auction.externalId} failed: ${String(e)}`);
        }
      }
    } catch (e) {
      const blocked = e instanceof PolicyBlockedError;
      result.status = blocked ? "blocked" : "failed";
      result.error = e instanceof Error ? e.message : String(e);
      log(`[${adapter.name}] ${binding.countyFips} ${result.status}: ${result.error}`);
    }

    if (runId) {
      await db
        .update(ingestRuns)
        .set({
          // "blocked" is a policy outcome, not a system failure; it is
          // recorded as `partial` with the reason preserved in `error`.
          status:
            result.status === "ok" ? "ok" : result.status === "failed" ? "failed" : "partial",
          auctionsFound: result.auctionsFound,
          lotsFound: result.lotsFound,
          rejected: result.rejected,
          repaired: result.repaired,
          error: result.error,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
        })
        .where(eq(ingestRuns.id, runId));

      if (result.status === "ok") {
        await db
          .update(counties)
          .set({ lastIngestedAt: new Date() })
          .where(eq(counties.fips, binding.countyFips));
      }
    }

    results.push(result);
    log(
      `[${adapter.name}] ${binding.countyFips}: ${result.status} — ${result.auctionsFound} auction(s), ${result.lotsFound} lot(s), ${result.rejected} rejected`,
    );
  }

  return {
    adapter: adapter.name,
    counties: results,
    totals: {
      auctions: results.reduce((n, r) => n + r.auctionsFound, 0),
      lots: results.reduce((n, r) => n + r.lotsFound, 0),
      rejected: results.reduce((n, r) => n + r.rejected, 0),
      repaired: results.reduce((n, r) => n + r.repaired, 0),
      failed: results.filter((r) => r.status === "failed").length,
      blocked: results.filter((r) => r.status === "blocked").length,
    },
  };
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  limit?: number;
  /** Re-fetch lots that already have a valuation. Default false. */
  refresh?: boolean;
  onProgress?: (msg: string) => void;
}

export interface EnrichSummary {
  adapter: string;
  attempted: number;
  enriched: number;
  /** Lot no longer on the source — pulled from the sale between runs. */
  gone: number;
  failed: number;
}

/**
 * Second-pass enrichment: fetch per-parcel detail for lots the catalog left
 * thin.
 *
 * Costs one request per lot, so it is a separate command from the calendar
 * refresh. Writes to `lot_valuations` (the provenance record, keyed by source)
 * *and* denormalises onto `lots` so the deal engine and list views don't need
 * a join. A failure on one lot is logged and skipped — 2,000 lots is far too
 * many for one bad page to abort the run.
 */
export async function runEnrichment(
  adapter: SourceAdapter,
  opts: EnrichOptions = {},
): Promise<EnrichSummary> {
  const log = opts.onProgress ?? (() => {});

  if (!adapter.enrichLot) {
    throw new Error(`${adapter.name} does not support enrichment`);
  }
  const source = adapter.valuationSource ?? adapter.name;

  const candidates = await db
    .select({
      id: lots.id,
      externalId: lots.externalId,
      sourceUrl: lots.sourceUrl,
    })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .where(
      opts.refresh
        ? eq(auctions.platform, adapter.platform)
        : and(eq(auctions.platform, adapter.platform), isNull(lots.assessedValue)),
    )
    .limit(opts.limit ?? 10_000);

  log(`[${adapter.name}] ${candidates.length} lot(s) to enrich`);

  const summary: EnrichSummary = {
    adapter: adapter.name,
    attempted: 0,
    enriched: 0,
    gone: 0,
    failed: 0,
  };

  for (const [i, lot] of candidates.entries()) {
    summary.attempted++;
    try {
      const data = await adapter.enrichLot(lot);

      if (!data) {
        summary.gone++;
        await db.update(lots).set({ status: "withdrawn" }).where(eq(lots.id, lot.id));
        continue;
      }

      await db
        .update(lots)
        .set({
          // Only overwrite where enrichment actually found something; the
          // catalog pass may have parsed a usable address the detail page
          // renders differently.
          ...(data.parcelNumber ? { parcelNumber: data.parcelNumber } : {}),
          ...(data.assessedValue !== undefined
            ? { assessedValue: String(data.assessedValue) }
            : {}),
          ...(data.taxesOwed !== undefined ? { taxesOwed: String(data.taxesOwed) } : {}),
          ...(data.addressLine ? { addressLine: data.addressLine } : {}),
          ...(data.city ? { city: data.city } : {}),
          ...(data.legalDescription ? { legalDescription: data.legalDescription } : {}),
          lastSeenAt: new Date(),
        })
        .where(eq(lots.id, lot.id));

      if (data.assessedValue !== undefined) {
        await db
          .insert(lotValuations)
          .values({
            lotId: lot.id,
            source,
            assessedTotal: String(data.assessedValue),
            raw: { ...data.raw, note: data.assessedValueNote },
          })
          .onConflictDoUpdate({
            target: [lotValuations.lotId, lotValuations.source],
            set: {
              assessedTotal: sql`excluded.assessed_total`,
              raw: sql`excluded.raw`,
              fetchedAt: sql`now()`,
            },
          });
      }

      summary.enriched++;
    } catch (e) {
      summary.failed++;
      log(`[${adapter.name}] lot ${lot.externalId} failed: ${e instanceof Error ? e.message : e}`);
    }

    if ((i + 1) % 100 === 0) {
      log(
        `[${adapter.name}] ${i + 1}/${candidates.length} — ${summary.enriched} enriched, ${summary.gone} gone, ${summary.failed} failed`,
      );
    }
  }

  return summary;
}
