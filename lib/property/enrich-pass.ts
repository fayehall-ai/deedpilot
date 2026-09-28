/**
 * The enrichment pass: value and place the parcels of upcoming sales, on a
 * weekly budget, without anyone running a script.
 *
 * Enrichment used to be a sequence of terminal commands — cadastre, geocode,
 * RentCast, the full chain — each run by hand, state by state. This is the
 * part of that sequence worth running unattended:
 *
 *   Placing.  Parcels with a street address and no coordinate go to the Census
 *             geocoder, which is free. A coordinate is what site intel (flood,
 *             terrain, neighbourhood) needs before it will look at a parcel.
 *   Valuing.  Parcels of upcoming sales with no assessed value go through the
 *             provider chain — the state's assessor layer first, which is free,
 *             then the paid aggregators — until the week's budget is spent, and
 *             through the free layer alone after that.
 *
 * Soonest sale first, and within a sale the largest opening bid first: a parcel
 * enriched after its sale is worth nothing, and an opening bid is the best
 * proxy for value available before value is known (see `enrichLotsMissingAssessed`).
 *
 * A parcel is stamped before it is asked about, so one that no provider can
 * match is not bought again on the next tick; it is retried after a fortnight,
 * by which time a crawl may have added the address it lacked.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { apiUsage, auctions, counties, lots } from "../db/schema";
import { DEFAULT_RATES, estimateCents } from "../ai/usage";
import { DESK_TIMEZONE } from "../desk-time";
import { enrichLotById } from "./enrich";
import { addressVariants, geocodeAddress } from "./geocode";
import { hasCadastre } from "./pipeline";

/** Do not ask about the same parcel again within this long. */
const RETRY_DAYS = 14;
/**
 * The most a single parcel can cost: RealEstateAPI, the only paid provider, at
 * its per-request rate. The pass reserves this before each paid lookup, so the
 * budget cannot be overshot by more than one parcel even though usage rows are
 * written asynchronously. Charging for providers that are no longer asked would
 * quietly shrink the budget — it cost 14¢ a parcel while three were dead.
 */
const WORST_CASE_CENTS = DEFAULT_RATES.realestateapi?.perRequest ?? 0;

/** Cents spent on paid parcel lookups since Monday at the desk. */
export async function enrichmentSpendThisWeek(): Promise<number> {
  const rows = await db
    .select({
      provider: apiUsage.provider,
      requests: sql<number>`coalesce(sum(${apiUsage.requests}), 0)::int`,
    })
    .from(apiUsage)
    .where(
      and(
        eq(apiUsage.operation, "enrich"),
        sql`${apiUsage.at} >= date_trunc('week', now() AT TIME ZONE ${DESK_TIMEZONE}) AT TIME ZONE ${DESK_TIMEZONE}`,
      ),
    )
    .groupBy(apiUsage.provider);
  return rows.reduce((n, r) => n + estimateCents({ provider: r.provider, operation: "enrich", requests: r.requests }), 0);
}

export interface EnrichmentPassResult {
  located: number;
  attempted: number;
  valued: number;
  /** True once the week's budget ran out and only free providers were asked. */
  freeOnly: boolean;
  spentCents: number;
  budgetCents: number;
  stoppedBy: "deadline" | "done" | "providers unavailable";
}

/** Parcels of sales still to come — the only ones worth paying to enrich. */
const upcoming = sql`${lots.auctionId} IN (
  SELECT id FROM auctions WHERE sale_date >= current_date AND delisted_at IS NULL
)`;

export async function runEnrichmentPass(opts: {
  /** Epoch ms by which the pass must stop taking new parcels. */
  deadline: number;
  budgetDollars: number;
  maxLocate?: number;
  maxValue?: number;
}): Promise<EnrichmentPassResult> {
  const result: EnrichmentPassResult = {
    located: 0,
    attempted: 0,
    valued: 0,
    freeOnly: false,
    spentCents: await enrichmentSpendThisWeek(),
    budgetCents: opts.budgetDollars * 100,
    stoppedBy: "done",
  };
  const timeLeft = () => Date.now() < opts.deadline;

  // ---- place --------------------------------------------------------------------

  const toLocate = await db
    .select({ id: lots.id, address: lots.addressLine, state: sql<string>`(SELECT state FROM counties WHERE fips = ${lots.countyFips})` })
    .from(lots)
    .where(
      and(
        upcoming,
        eq(lots.status, "pending"),
        isNull(lots.latitude),
        /*
         * A real house number is the minimum a geocoder can place: a bare street
         * name matches the whole road, and counties write "0 UNKNOWN" for parcels
         * with no situs address at all.
         */
        sql`${lots.addressLine} ~ '^[1-9][0-9]*[A-Za-z]?[ -]'`,
        sql`${lots.addressLine} !~* 'unknown'`,
        sql`(${lots.geocodeAttemptedAt} IS NULL
             OR ${lots.geocodeAttemptedAt} < now() - make_interval(days => ${RETRY_DAYS}))`,
      ),
    )
    .limit(opts.maxLocate ?? 60);

  for (const l of toLocate) {
    if (!timeLeft()) return { ...result, stoppedBy: "deadline" };
    await db.update(lots).set({ geocodeAttemptedAt: new Date() }).where(eq(lots.id, l.id));
    let hit = null;
    /* Two forms at most, ten seconds each: one slow address must not eat the run. */
    for (const variant of addressVariants(String(l.address)).slice(0, 2)) {
      hit = await geocodeAddress(variant, l.state, 10_000);
      if (hit) break;
    }
    if (!hit) continue;
    await db
      .update(lots)
      .set({ latitude: String(hit.lat), longitude: String(hit.lon) })
      .where(eq(lots.id, l.id));
    result.located++;
  }

  // ---- value --------------------------------------------------------------------

  const toValue = await db
    .select({ id: lots.id, fips: lots.countyFips, state: counties.state })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(
      and(
        sql`${auctions.saleDate} >= current_date AND ${auctions.delistedAt} IS NULL`,
        eq(lots.status, "pending"),
        isNull(lots.assessedValue),
        sql`(${lots.parcelNumber} IS NOT NULL OR ${lots.addressLine} IS NOT NULL)`,
        sql`(${lots.enrichmentAttemptedAt} IS NULL
             OR ${lots.enrichmentAttemptedAt} < now() - make_interval(days => ${RETRY_DAYS}))`,
      ),
    )
    .orderBy(auctions.saleDate, sql`${lots.openingBid} desc nulls last`, lots.id)
    .limit(opts.maxValue ?? 200);

  /* Shared across the pass so a provider that dies on the first parcel is not asked again. */
  const unavailable = new Set<string>();
  for (const l of toValue) {
    if (!timeLeft()) return { ...result, stoppedBy: "deadline" };
    result.freeOnly = result.spentCents + WORST_CASE_CENTS > result.budgetCents;
    /*
     * Past the budget, a county with no free assessor layer has nobody to ask.
     * Skipped rather than stamped, so the parcel is first in line when Monday
     * resets the budget instead of locked out for a fortnight.
     */
    if (result.freeOnly && !hasCadastre(l.fips, l.state)) continue;

    await db.update(lots).set({ enrichmentAttemptedAt: new Date() }).where(eq(lots.id, l.id));
    result.attempted++;
    try {
      const r = await enrichLotById(l.id, { freeOnly: result.freeOnly }, unavailable);
      if (r.updated) result.valued++;
      /* Reserve the worst case for a paid attempt; the real rows catch up on the next pass. */
      if (!result.freeOnly) result.spentCents += WORST_CASE_CENTS;
    } catch (e) {
      /* `lookupProperty` throws only when no provider could be asked at all. */
      if (unavailable.size) return { ...result, stoppedBy: "providers unavailable" };
      throw e;
    }
  }
  return result;
}
