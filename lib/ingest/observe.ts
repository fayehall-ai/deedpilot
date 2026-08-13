/**
 * Record what a crawl saw, including what it did not.
 *
 * The crawler already fetches every parcel on every visit and then throws the
 * observation away: `upsertLots` overwrites `opening_bid` and `status` from the
 * source, so a bid moving from $14,000 to $16,200 leaves only the second number,
 * and a parcel pulled before the sale leaves no evidence it was ever listed.
 *
 * One insert per parcel per crawl fixes that for no extra fetching, and the
 * resulting series is the only dataset in this system that **self-labels** —
 * every row states what it observed, from which run, at what time, from which
 * URL. That is what the imported corpus could not do, and why 70,109 Cook County
 * schema defaults could be mistaken for observed non-redemptions.
 *
 * ## The absent rows are the point
 *
 * Recording only what was present would give bid drift and nothing else. What
 * nobody has nationally is the **pre-sale attrition curve** — which parcels
 * leave, how many days before the sale, per county. The corpus holds 1,404 San
 * Diego pre-sale cures and nothing else, and no vendor sells this because it
 * requires having watched every county every day. Writing `present: false` for
 * the parcels a crawl did not return is what builds it.
 *
 * Nothing here interprets an absence. Why a parcel left is not observable from
 * the county publishing a shorter list; see `reconcile.ts`.
 */

import { and, eq, lt, sql } from "drizzle-orm";

async function conn() {
  const [{ db }, schema] = await Promise.all([import("../db"), import("../db/schema")]);
  return { db, ...schema };
}

/** Whole days from an observation to the sale. Negative once the sale has passed. */
export function daysToSale(saleDate: string, observedAt: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) return null;
  const sale = Date.parse(`${saleDate}T12:00:00Z`);
  const seen = Date.parse(`${observedAt.toISOString().slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(sale) || !Number.isFinite(seen)) return null;
  return Math.round((sale - seen) / 86_400_000);
}

export interface ObserveResult {
  present: number;
  absent: number;
}

/**
 * Snapshot one auction's parcels.
 *
 * Reads the lots table rather than taking the adapter's payload, so the row
 * recorded is what actually landed after judging and enrichment coalescing —
 * an observation of the system's own state, not of an intermediate value that
 * may never have been stored.
 *
 * `cutoff` is the same DB-side timestamp reconciliation uses: rows refreshed by
 * this crawl sit after it, so everything behind it was not returned.
 */
export async function observeAuction(opts: {
  auctionId: string;
  countyFips: string;
  saleDate: string;
  cutoff: Date;
  runId?: string;
}): Promise<ObserveResult> {
  const { db, lots, lotObservations } = await conn();
  const observedAt = new Date();
  const dts = daysToSale(opts.saleDate, observedAt);

  const rows = await db
    .select({
      id: lots.id,
      status: lots.status,
      openingBid: lots.openingBid,
      sourceUrl: lots.sourceUrl,
      lastSeenAt: lots.lastSeenAt,
    })
    .from(lots)
    .where(eq(lots.auctionId, opts.auctionId));

  if (rows.length === 0) return { present: 0, absent: 0 };

  const values = rows.map((r) => ({
    lotId: r.id,
    auctionId: opts.auctionId,
    countyFips: opts.countyFips,
    runId: opts.runId ?? null,
    observedAt,
    present: r.lastSeenAt >= opts.cutoff,
    status: r.status,
    openingBid: r.openingBid,
    daysToSale: dts,
    sourceUrl: r.sourceUrl,
  }));

  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(lotObservations).values(values.slice(i, i + CHUNK));
  }

  const present = values.filter((v) => v.present).length;
  return { present, absent: values.length - present };
}

// ---------------------------------------------------------------------------
// Derived signals — 5.2
// ---------------------------------------------------------------------------

export interface AttritionBucket {
  /** Days before the sale, bucketed. */
  window: string;
  observations: number;
  departures: number;
  rate: number;
}

/**
 * The pre-sale attrition curve: what share of a county's listed parcels stop
 * being published, by how close the sale is.
 *
 * A bidder plans travel and capital against a list. If a third of a county's
 * parcels evaporate in the final 72 hours, the expected value of any single
 * parcel has to discount the odds of getting to bid on it at all — and that is
 * a number no aggregator sells, because building it means having watched.
 */
export async function attritionCurve(countyFips?: string): Promise<AttritionBucket[]> {
  const { db } = await conn();
  const scope = countyFips ? sql`WHERE county_fips = ${countyFips}` : sql``;
  const rows = (await db.execute(sql`
    SELECT CASE
             WHEN days_to_sale > 21 THEN 'over 21 days'
             WHEN days_to_sale > 10 THEN '11-21 days'
             WHEN days_to_sale > 3  THEN '4-10 days'
             WHEN days_to_sale >= 0 THEN '0-3 days'
             ELSE 'after the sale'
           END AS window,
           count(*)::int AS observations,
           count(*) FILTER (WHERE NOT present)::int AS departures
    FROM lot_observations
    ${scope}
    GROUP BY 1
  `)) as unknown as { window: string; observations: number; departures: number }[];

  const order = ["over 21 days", "11-21 days", "4-10 days", "0-3 days", "after the sale"];
  return rows
    .map((r) => ({ ...r, rate: r.observations ? r.departures / r.observations : 0 }))
    .sort((a, b) => order.indexOf(a.window) - order.indexOf(b.window));
}

/**
 * Parcels whose opening bid moved between crawls.
 *
 * Tells you whether a posted opening bid is a number to plan against or a draft
 * the county keeps revising — which differs sharply by county and is currently
 * unknowable, because only the latest value is kept.
 */
export async function openingBidDrift(limit = 50) {
  const { db } = await conn();
  return (await db.execute(sql`
    WITH ranked AS (
      SELECT lot_id, county_fips, opening_bid, observed_at,
             lag(opening_bid) OVER (PARTITION BY lot_id ORDER BY observed_at) AS prior
      FROM lot_observations WHERE present AND opening_bid IS NOT NULL
    )
    SELECT lot_id, county_fips, prior, opening_bid AS current, observed_at
    FROM ranked
    WHERE prior IS NOT NULL AND prior <> opening_bid
    ORDER BY observed_at DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];
}

/**
 * Parcels offered at more than one sale.
 *
 * A re-offer is a strong negative signal — title defect, environmental problem,
 * or simply nobody wants it — and it is also how an absence gets its meaning in
 * arrears: a parcel that left and never returned behaved like a payoff, one
 * that reappears was pulled. Neither is knowable on the day.
 */
export async function reOfferChains(limit = 50) {
  const { db } = await conn();
  return (await db.execute(sql`
    SELECT l.dedupe_key, l.county_fips, count(DISTINCT l.auction_id)::int AS offerings,
           min(a.sale_date) AS first_sale, max(a.sale_date) AS latest_sale
    FROM lots l JOIN auctions a ON a.id = l.auction_id
    GROUP BY l.dedupe_key, l.county_fips
    HAVING count(DISTINCT l.auction_id) > 1
    ORDER BY offerings DESC, latest_sale DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];
}

/** How stable a county's list is, which is what a per-county re-crawl interval wants. */
export async function listingVolatility() {
  const { db } = await conn();
  return (await db.execute(sql`
    SELECT county_fips,
           count(DISTINCT observed_at)::int AS crawls,
           count(*)::int AS observations,
           count(*) FILTER (WHERE NOT present)::int AS departures,
           round(100.0 * count(*) FILTER (WHERE NOT present) / nullif(count(*), 0), 1) AS departure_pct
    FROM lot_observations
    GROUP BY county_fips
    HAVING count(DISTINCT observed_at) > 1
    ORDER BY departure_pct DESC NULLS LAST
  `)) as unknown as Record<string, unknown>[];
}
