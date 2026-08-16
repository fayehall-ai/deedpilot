/**
 * Which parcel to enrich next, forever.
 *
 * ## The shape of the problem
 *
 * This is not a batch job that finishes. There are 25,702 parcels, four
 * sources, and a new sale list lands every week; the work is never done, and
 * any design that treats it as done starves whatever it did not get to. So the
 * scheduler answers one question — what is the single most valuable fetch to
 * make right now — and the worker just asks it repeatedly.
 *
 * ## What makes one fetch more valuable than another
 *
 * Four things, in this order:
 *
 * 1. **Perishability.** Intel on a parcel selling in five days is worth
 *    something; the same intel delivered the day after the sale is worth
 *    nothing at all. This dominates everything else, because it is the only
 *    factor with a deadline.
 *
 * 2. **Whether it is really for sale.** `sale_list` + confirmed date, the same
 *    line the coverage scoreboard draws. Enriching a delinquent roll would
 *    spend the whole loop on 5,650 parcels whose owners will pay before any
 *    levy — the exact mistake that once made Cobb County's roll look like 65%
 *    of national inventory.
 *
 * 3. **Stake.** Opening bid, descending. Every fetch costs the same and the
 *    parcels are not worth the same; on Arkansas inventory the opening bid
 *    tracks assessed value at r = 0.852, so bid order is a good proxy for
 *    value order.
 *
 * 4. **Ignorance.** A parcel with no signals at all beats one being refreshed.
 *    Breadth before depth: the first fetch on a parcel tells you whether there
 *    is a rail line behind it, and the second tells you it is still there.
 *
 * ## Why work is (lot, source) and not (lot)
 *
 * The sources have wildly different costs and freshness — FEMA answers in
 * 80ms and is re-asked twice a year, Overpass takes tens of seconds and is
 * re-asked yearly. Scheduling a whole parcel at a time would either re-fetch
 * bedrock elevation every time the flood map moved, or hold the flood map back
 * to the slowest source's clock. One unit per source keeps each on its own.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { configuredSignalSources } from "./index";

export interface IntelTask {
  lotId: string;
  source: string;
  /** Higher first. Carries the reasoning below, so a queue is inspectable. */
  priority: number;
  why: string;
  /** Context for logs and the ops console. */
  label: string;
  daysToSale: number | null;
}

export interface PlanOptions {
  /** Cap on tasks returned. The worker asks for what it can drain. */
  limit?: number;
  /** Restrict to one state, for a targeted backfill. */
  state?: string;
  /** Only this source. */
  source?: string;
  /** Include parcels that are not confirmed inventory. Off by default. */
  includeNonInventory?: boolean;
}

/**
 * Priority from days-to-sale.
 *
 * Steps rather than a curve, and the top step is deliberately narrow: inside a
 * week is when a bidder is actually doing diligence, and that is when the
 * information has to already be there. Past the sale date the parcel drops out
 * entirely — `daysToSale < 0` is filtered in SQL, not scored down here.
 */
function urgency(daysToSale: number | null): { score: number; why: string } {
  if (daysToSale === null) return { score: 0, why: "no confirmed sale date" };
  if (daysToSale <= 7) return { score: 120, why: `sells in ${daysToSale}d` };
  if (daysToSale <= 21) return { score: 80, why: `sells in ${daysToSale}d` };
  if (daysToSale <= 60) return { score: 40, why: `sells in ${daysToSale}d` };
  return { score: 10, why: `sells in ${daysToSale}d` };
}

/**
 * Build the next slice of work.
 *
 * One query, evaluated in the database, because the ranking has to consider
 * every parcel to pick the best one and pulling 25,702 rows into node to sort
 * them would be the slowest part of the loop by far.
 */
export async function planIntelWork(opts: PlanOptions = {}): Promise<IntelTask[]> {
  const limit = opts.limit ?? 25;
  const sources = configuredSignalSources().filter((s) => !opts.source || s.name === opts.source);
  if (sources.length === 0) return [];

  /*
   * A per-source TTL table, inlined as a VALUES list so the staleness test runs
   * in SQL. Keeping it here rather than in a config table means a source's
   * freshness lives next to the source that defines it.
   */
  const ttlValues = sql.join(
    sources.map((s) => sql`(${s.name}, ${s.ttlDays}::int)`),
    sql`, `,
  );

  const inventoryFilter = opts.includeNonInventory
    ? sql`true`
    : sql`a.listing_kind = 'sale_list' AND a.sale_date_confirmed`;

  const stateFilter = opts.state ? sql`AND c.state = ${opts.state.toUpperCase()}` : sql``;

  const rows = (await db.execute(sql`
    WITH src(name, ttl_days) AS (VALUES ${ttlValues}),
    candidates AS (
      SELECT
        l.id                AS lot_id,
        l.parcel_number,
        l.address_line,
        c.state,
        c.name              AS county,
        l.opening_bid,
        a.sale_date,
        (a.sale_date - CURRENT_DATE) AS days_to_sale
      FROM lots l
      JOIN auctions a  ON a.id = l.auction_id
      JOIN counties c  ON c.fips = l.county_fips
      WHERE l.latitude IS NOT NULL
        AND l.longitude IS NOT NULL
        -- A sale that has already happened cannot be researched in time.
        AND a.sale_date >= CURRENT_DATE
        AND ${inventoryFilter}
        ${stateFilter}
    )
    SELECT
      cand.lot_id,
      cand.parcel_number,
      cand.address_line,
      cand.state,
      cand.county,
      cand.opening_bid,
      cand.days_to_sale,
      src.name AS source,
      r.fetched_at,
      r.status AS last_status
    FROM candidates cand
    CROSS JOIN src
    LEFT JOIN lot_intel_runs r
           ON r.lot_id = cand.lot_id AND r.source = src.name
    WHERE
      -- Never asked.
      r.id IS NULL
      -- Or asked and the answer has expired.
      OR r.fetched_at < now() - (src.ttl_days || ' days')::interval
      /*
       * Or the ask failed. Retried on a short clock rather than the source's
       * own TTL: an Overpass 504 is a fact about an afternoon, not about the
       * parcel, and waiting a year to re-ask would turn a transient outage
       * into permanently missing data.
       */
      OR (r.status = 'failed' AND r.fetched_at < now() - interval '6 hours')
      /*
       * A skipped row means a precondition was missing — almost always
       * coordinates. Those arrive later from the cadastre backfill, so the
       * parcel becomes workable without anything about the source changing.
       */
      OR (r.status = 'skipped' AND r.fetched_at < now() - interval '1 day')
    ORDER BY
      -- Perishability first: see the urgency() bands above.
      CASE
        WHEN cand.days_to_sale <= 7  THEN 0
        WHEN cand.days_to_sale <= 21 THEN 1
        WHEN cand.days_to_sale <= 60 THEN 2
        ELSE 3
      END,
      -- Breadth before depth: a parcel nobody has looked at outranks a refresh.
      (r.id IS NOT NULL),
      cand.opening_bid DESC NULLS LAST,
      cand.lot_id
    LIMIT ${limit}
  `)) as unknown as {
    lot_id: string;
    parcel_number: string | null;
    address_line: string | null;
    state: string;
    county: string;
    opening_bid: string | null;
    days_to_sale: number | null;
    source: string;
    fetched_at: Date | null;
    last_status: string | null;
  }[];

  return rows.map((r) => {
    const days = r.days_to_sale === null ? null : Number(r.days_to_sale);
    const u = urgency(days);
    const fresh = r.fetched_at === null;
    const bid = r.opening_bid ? Number(r.opening_bid) : 0;

    return {
      lotId: r.lot_id,
      source: r.source,
      /*
       * Bid contributes a bounded term rather than a raw dollar amount: a
       * $760,267 Houston opening bid would otherwise swamp every urgency step
       * and put a parcel selling in eight months ahead of one selling on
       * Tuesday.
       */
      priority: u.score + (fresh ? 15 : 0) + Math.min(20, Math.log10(Math.max(bid, 1)) * 3),
      why: [
        u.why,
        fresh ? "never fetched" : `stale since ${r.fetched_at?.toISOString().slice(0, 10)}`,
        r.last_status === "failed" ? "last attempt failed" : null,
      ]
        .filter(Boolean)
        .join(", "),
      label: `${r.address_line ?? r.parcel_number ?? r.lot_id.slice(0, 8)} (${r.county}, ${r.state})`,
      daysToSale: days,
    };
  });
}

export interface IntelCoverage {
  source: string;
  ok: number;
  empty: number;
  failed: number;
  skipped: number;
  never: number;
}

/**
 * How far the loop has got, per source.
 *
 * `never` is the backlog and `skipped` is the part of it blocked on something
 * else — almost entirely on coordinates. Reported separately because they call
 * for different work: `never` needs the worker to keep running, `skipped` needs
 * the cadastre backfill, and conflating them would make a geocoding problem
 * look like a fetching problem.
 */
export async function intelCoverage(opts: { includeNonInventory?: boolean } = {}): Promise<IntelCoverage[]> {
  const sources = configuredSignalSources();
  if (sources.length === 0) return [];

  const inventoryFilter = opts.includeNonInventory
    ? sql`true`
    : sql`a.listing_kind = 'sale_list' AND a.sale_date_confirmed`;

  const ttlValues = sql.join(
    sources.map((s) => sql`(${s.name})`),
    sql`, `,
  );

  const rows = (await db.execute(sql`
    WITH src(name) AS (VALUES ${ttlValues}),
    inventory AS (
      SELECT l.id
      FROM lots l
      JOIN auctions a ON a.id = l.auction_id
      WHERE a.sale_date >= CURRENT_DATE AND ${inventoryFilter}
    )
    SELECT
      src.name AS source,
      count(*) FILTER (WHERE r.status = 'ok')::int      AS ok,
      count(*) FILTER (WHERE r.status = 'empty')::int   AS empty,
      count(*) FILTER (WHERE r.status = 'failed')::int  AS failed,
      count(*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
      count(*) FILTER (WHERE r.id IS NULL)::int         AS never
    FROM inventory i
    CROSS JOIN src
    LEFT JOIN lot_intel_runs r ON r.lot_id = i.id AND r.source = src.name
    GROUP BY src.name
    ORDER BY src.name
  `)) as unknown as IntelCoverage[];

  return rows;
}
