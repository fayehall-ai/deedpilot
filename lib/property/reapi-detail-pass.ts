/**
 * RealEstateAPI PropertyDetail for every parcel the spend policy allows.
 *
 * Shared by `scripts/enrich-reapi-detail.ts` (a terminal run) and
 * `/api/cron/reapi-enrich` (the Sunday CAPE run, on Vercel).
 *
 * Asks RealEstateAPI directly rather than walking the provider chain: in the
 * chain the free assessor layer answers first and a paid detail record is
 * never fetched for a parcel that has one, which is the point of this pass.
 *
 * Soonest sale first, then highest opening bid — a parcel enriched after its
 * sale is worth nothing. Parcels with a detail record under 90 days old are
 * skipped, so a stopped pass resumes where it left off without paying twice.
 * An empty wallet or rejected key stops the pass; the rest are not misses.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, counties, lots } from "../db/schema";
import { recordUsage } from "../ai/usage";
import { isConfirmedInventory } from "../db/inventory";
import { landOnlySql } from "../lots/land-only";
import { applyRecordToLot } from "./enrich";
import { realestateapiProvider } from "./providers/realestateapi";
import { paidLookupRefusal } from "./spend-policy";
import { ProviderUnavailableError } from "./types";

export interface ReapiPassOptions {
  /** Sales this many days out, from today. */
  days?: number;
  limit?: number;
  concurrency?: number;
  /** Epoch ms after which no new parcel is started. */
  deadline?: number;
  /**
   * Skip parcels asked about within this many hours. A parcel RealEstateAPI
   * cannot match has no record, so without this every tick of one night would
   * ask about it again.
   */
  skipAttemptedWithinHours?: number;
  /** Only these sales' parcels — a one-off top-up for a sale that was missed. */
  auctionIds?: string[];
  /** Count only; ask nothing. */
  dryRun?: boolean;
  onLog?: (line: string) => void;
}

export interface ReapiPassResult {
  selected: number;
  lookedUp: number;
  hit: number;
  miss: number;
  failed: number;
  /** Set when the provider became unusable — wallet, key — and the pass stopped. */
  stopped: string | null;
  /** Parcels left for the next pass because the deadline came first. */
  leftForNext: number;
}

export async function runReapiDetailPass(opts: ReapiPassOptions = {}): Promise<ReapiPassResult> {
  const days = opts.days ?? 56;
  const concurrency = opts.concurrency ?? 5;
  const log = opts.onLog ?? (() => {});

  if (!realestateapiProvider.configured()) throw new Error("REALESTATEAPI_API_KEY is not set");

  /* The spend policy, in SQL, so the selection and the per-lot check agree. */
  const rows = await db
    .select({
      id: lots.id,
      parcelNumber: lots.parcelNumber,
      addressLine: lots.addressLine,
      city: lots.city,
      zip: lots.zip,
      landUse: lots.landUse,
      buildingSqft: lots.buildingSqft,
      yearBuilt: lots.yearBuilt,
      lotStatus: lots.status,
      saleType: auctions.saleType,
      auctionStatus: auctions.status,
      delistedAt: auctions.delistedAt,
      saleDateConfirmed: auctions.saleDateConfirmed,
      listingKind: auctions.listingKind,
      announcedParcelCount: auctions.announcedParcelCount,
      saleDate: auctions.saleDate,
      state: counties.state,
      fips: counties.fips,
      countyName: counties.name,
    })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(
      and(
        sql`${auctions.saleDate} between current_date and current_date + ${days}::int`,
        sql`${auctions.saleType} <> 'Tax Lien'`,
        sql`${auctions.status} <> 'cancelled' and ${auctions.delistedAt} is null`,
        isConfirmedInventory(),
        eq(lots.status, "pending"),
        sql`not ${landOnlySql}`,
        sql`not exists (
          select 1 from lot_valuations v
          where v.lot_id = ${lots.id} and v.source = 'realestateapi'
            and v.raw ? 'propertyInfo' and v.fetched_at > now() - interval '90 days'
        )`,
        opts.auctionIds?.length ? inArray(auctions.id, opts.auctionIds) : undefined,
        opts.skipAttemptedWithinHours
          ? sql`(${lots.enrichmentAttemptedAt} is null
                 or ${lots.enrichmentAttemptedAt} < now() - make_interval(hours => ${opts.skipAttemptedWithinHours}::int))`
          : undefined,
      ),
    )
    .orderBy(auctions.saleDate, sql`${lots.openingBid} desc nulls last`, lots.id)
    .limit(opts.limit ?? 100_000);

  const result: ReapiPassResult = {
    selected: rows.length,
    lookedUp: 0,
    hit: 0,
    miss: 0,
    failed: 0,
    stopped: null,
    leftForNext: 0,
  };
  log(`${rows.length} parcel(s) to look up, sales in the next ${days} days`);
  if (opts.dryRun) return result;

  const started = Date.now();
  const queue = [...rows];
  const timeLeft = () => opts.deadline === undefined || Date.now() < opts.deadline;

  async function worker() {
    while (queue.length && !result.stopped && timeLeft()) {
      const r = queue.shift()!;
      /* Belt and braces: the same rule the enrichment chain applies. */
      const refusal = paidLookupRefusal({
        saleType: r.saleType,
        auctionStatus: r.auctionStatus,
        delisted: r.delistedAt !== null,
        saleDateConfirmed: r.saleDateConfirmed,
        listingKind: r.listingKind,
        announcedParcelCount: r.announcedParcelCount,
        lotStatus: r.lotStatus,
        addressLine: r.addressLine,
        landUse: r.landUse,
        buildingSqft: r.buildingSqft,
        yearBuilt: r.yearBuilt,
      });
      if (refusal) continue;

      await db.update(lots).set({ enrichmentAttemptedAt: new Date() }).where(eq(lots.id, r.id));
      void recordUsage({ provider: "realestateapi", operation: "enrich", requests: 1, countyFips: r.fips });
      try {
        const rec = await realestateapiProvider.lookup({
          state: r.state,
          fips: r.fips,
          countyName: r.countyName,
          parcelNumber: r.parcelNumber,
          addressLine: r.addressLine,
          city: r.city,
          zip: r.zip,
        });
        if (rec) {
          await applyRecordToLot(r.id, rec);
          result.hit++;
        } else result.miss++;
      } catch (e) {
        if (e instanceof ProviderUnavailableError) {
          result.stopped = e.message;
          return;
        }
        result.failed++;
        log(`fail ${r.id}: ${e instanceof Error ? e.message : e}`);
      }
      result.lookedUp++;
      if (result.lookedUp % 100 === 0) {
        const rate = result.lookedUp / ((Date.now() - started) / 1000);
        log(
          `${result.lookedUp}/${rows.length} · ${result.hit} hit · ${result.miss} miss · ${result.failed} failed · ${rate.toFixed(1)}/s · next sale ${r.saleDate}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  result.leftForNext = queue.length;
  log(
    `done in ${((Date.now() - started) / 60000).toFixed(1)} min — ${result.lookedUp} looked up, ${result.hit} hit, ${result.miss} miss, ${result.failed} failed` +
      (result.stopped ? ` — STOPPED: ${result.stopped}; the ${queue.length} not yet asked are not misses` : "") +
      (!result.stopped && queue.length ? ` — ${queue.length} left for the next pass` : ""),
  );
  return result;
}
