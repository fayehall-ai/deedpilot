import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, lots } from "../db/schema";
import { IMPORT_ID_SQL_PATTERN } from "./provenance";
import { validateOverrides } from "../admin/auction-override-fields";

/**
 * Folding an imported announcement into the crawl that superseded it.
 *
 * The import already refuses to duplicate a sale the crawler holds: on upload,
 * a county with one crawled auction on the same date absorbs the imported row
 * and keeps only its parcel count. That check runs *at upload time*, against
 * what existed then — and most imported sales are in counties nothing had
 * crawled yet, which is the whole reason they were queued for a crawl.
 *
 * So the duplicate arrives from the other direction, later. The crawl runs,
 * finds the county's real sale list, and writes its own auction keyed by the
 * platform's id. Now the same sale has two rows: the announcement, with a
 * count and no parcels, and the crawl, with parcels. Both satisfy the calendar
 * filter, and a bidder sees one county holding one sale twice on one day.
 *
 * This closes that loop. It is the same rule as the upload's, applied after the
 * fact and in the same direction: the crawl is first-party and wins, the
 * announcement contributes its count and goes.
 *
 * ## Why the announcement is deleted rather than hidden
 *
 * Hiding it — nulling the count, setting `delisted_at` — would leave a row that
 * the next upload of the same file would resurrect, because a re-upload
 * rewrites the fields on the row it owns. Deleting is what actually settles:
 * with the announcement gone, the county and date hold exactly one auction, so
 * the *next* upload takes the merge branch and contributes its count to the
 * crawl. The state converges instead of oscillating.
 *
 * Nothing is lost by it. An announcement carries no parcels — that is the
 * definition of the rows this touches — and what it carried that the crawl
 * cannot supply is moved across first: the announced count, the venue and
 * contact in `logistics` (no adapter reads those off a county page), and a
 * published start time, as an operator correction so the next crawl's upsert
 * does not revert it. Each only where the crawl holds none of its own.
 *
 * ## What it refuses to do
 *
 * Only a one-to-one pairing is folded. A county running eight precinct sales on
 * one day, or two districts against one crawl, is left exactly as it is and
 * reported, for the same reason the upload leaves it: choosing among several
 * candidates by position is a coin flip that leaves no trace. Those are the
 * thirteen collisions the upload already surfaced, and they need a person, not
 * a rule.
 */

export interface FoldResult {
  /** Announcements folded into the crawl that superseded them. */
  folded: number;
  /** Parcel counts carried across in the process. */
  countsMoved: number;
  /** Venues and contacts carried across. */
  logisticsMoved: number;
  /** County/date pairs left alone because the pairing was not one-to-one. */
  ambiguous: { countyFips: string; saleDate: string; imported: number; crawled: number }[];
}

/**
 * Fold superseded announcements, returning what it did.
 *
 * Safe to run repeatedly and safe to run while crawls are in flight: it only
 * acts on a pairing that is unambiguous at the moment it looks, and a pairing
 * that becomes unambiguous later is folded on the next pass.
 */
export async function foldSupersededImports(): Promise<FoldResult> {
  const result: FoldResult = { folded: 0, countsMoved: 0, logisticsMoved: 0, ambiguous: [] };

  /*
   * County/date groups holding both kinds of row, for sales that have not
   * happened yet. Past sales are left alone — a duplicate on a date nobody can
   * bid at is not worth a delete, and the history is more useful intact.
   */
  const groups = (await db.execute(sql`
    SELECT county_fips,
           sale_date::text AS sale_date,
           count(*) FILTER (WHERE external_id LIKE ${IMPORT_ID_SQL_PATTERN} AND lot_count = 0)::int AS imported,
           count(*) FILTER (WHERE external_id NOT LIKE ${IMPORT_ID_SQL_PATTERN})::int AS crawled
    FROM auctions
    WHERE sale_date >= current_date
    GROUP BY 1, 2
    HAVING count(*) FILTER (WHERE external_id LIKE ${IMPORT_ID_SQL_PATTERN} AND lot_count = 0) > 0
       AND count(*) FILTER (WHERE external_id NOT LIKE ${IMPORT_ID_SQL_PATTERN}) > 0
  `)) as unknown as { county_fips: string; sale_date: string; imported: number; crawled: number }[];

  for (const g of groups) {
    /*
     * The same announcement imported twice is one sale, not two. Galveston's
     * 10/06 sale and Pierce's 10/26 each came in as two identical rows, so the
     * pairing was two-to-one and never folded, and the crawl's parcels sat on
     * a third row beside two empty ones. Rows that agree on type, title and
     * source are collapsed to one first. Rows that differ — Adams County's
     * upset and judicial sales on one day — are still left for a person.
     */
    if (g.imported > 1 && g.crawled === 1) {
      const dupes = (await db.execute(sql`
        SELECT a.id, a.sale_type::text AS t, lower(coalesce(a.title, '')) AS title, a.source_url AS src
        FROM auctions a
        WHERE a.county_fips = ${g.county_fips} AND a.sale_date = ${g.sale_date}::date
          AND a.external_id LIKE ${IMPORT_ID_SQL_PATTERN} AND a.lot_count = 0
          AND NOT EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id)
        ORDER BY a.first_seen_at`)) as unknown as { id: string; t: string; title: string; src: string }[];
      const [keep, ...rest] = dupes;
      if (keep && dupes.length === g.imported && rest.every((d) => d.t === keep.t && d.title === keep.title && d.src === keep.src)) {
        for (const d of rest) await db.delete(auctions).where(eq(auctions.id, d.id));
        g.imported = 1;
      }
    }
    if (g.imported !== 1 || g.crawled !== 1) {
      result.ambiguous.push({
        countyFips: g.county_fips,
        saleDate: g.sale_date,
        imported: g.imported,
        crawled: g.crawled,
      });
      continue;
    }

    const where = and(eq(auctions.countyFips, g.county_fips), eq(auctions.saleDate, g.sale_date));

    const carried = {
      id: auctions.id,
      announced: auctions.announcedParcelCount,
      logistics: auctions.logistics,
      startTime: auctions.startTime,
      overrides: auctions.operatorOverrides,
    };
    const [announcement] = await db
      .select(carried)
      .from(auctions)
      .where(and(where, sql`${auctions.externalId} LIKE ${IMPORT_ID_SQL_PATTERN}`, eq(auctions.lotCount, 0)))
      .limit(1);
    const [crawl] = await db
      .select(carried)
      .from(auctions)
      .where(and(where, sql`${auctions.externalId} NOT LIKE ${IMPORT_ID_SQL_PATTERN}`))
      .limit(1);

    if (!announcement || !crawl) continue;

    /*
     * The guard the comment above depends on. `lot_count` is denormalised and
     * a row claiming zero while parcels exist would make this a destructive
     * delete rather than a tidy-up, so the parcels themselves are counted.
     */
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(lots)
      .where(eq(lots.auctionId, announcement.id));
    if (n > 0) continue;

    // Move what it carries first, so a failure between the two statements leaves
    // the announcement standing rather than losing any of it.
    const set: Partial<typeof auctions.$inferInsert> = {};
    if (announcement.announced !== null && crawl.announced === null) {
      set.announcedParcelCount = announcement.announced;
      result.countsMoved++;
    }
    if (announcement.logistics && !crawl.logistics) {
      set.logistics = announcement.logistics;
      result.logisticsMoved++;
    }
    const time = (announcement.overrides?.startTime as string | undefined) ?? announcement.startTime;
    if (time && !crawl.startTime && !crawl.overrides?.startTime && !validateOverrides({ startTime: time }).length) {
      set.operatorOverrides = { ...(crawl.overrides ?? {}), startTime: time };
    }
    if (Object.keys(set).length) await db.update(auctions).set(set).where(eq(auctions.id, crawl.id));

    await db.delete(auctions).where(eq(auctions.id, announcement.id));
    result.folded++;
  }

  return result;
}

/** Announced sales still waiting on a parcel list. The enrichment worklist. */
export async function parcelListCoverage(): Promise<{
  announced: number;
  withList: number;
  parcelsHeld: number;
  parcelsAnnounced: number;
}> {
  const [row] = await db
    .select({
      announced: sql<number>`count(*)::int`,
      withList: sql<number>`count(*) FILTER (WHERE ${auctions.lotCount} > 0)::int`,
      parcelsHeld: sql<number>`coalesce(sum(${auctions.lotCount}), 0)::int`,
      parcelsAnnounced: sql<number>`coalesce(sum(${auctions.announcedParcelCount}), 0)::int`,
    })
    .from(auctions)
    .where(
      and(
        gt(auctions.announcedParcelCount, 0),
        sql`${auctions.saleDate} >= current_date`,
        isNull(auctions.delistedAt),
      ),
    );
  return row;
}

/**
 * Why each announced sale does or does not have a parcel list yet.
 *
 * "11% covered" is a number nobody can act on. These buckets are the actions
 * behind it, and they are genuinely different work: a pending crawl needs
 * patience, a failing one needs a look at the error, a crawl that succeeded and
 * found nothing is adapter backlog, and a county with no job at all has no
 * located source and needs the Prospector before any of the rest can happen.
 *
 * Grouped by county rather than per auction for the job lookup, because
 * `run_jobs` is keyed by county — several sales in one county share its fate.
 */
export type CoverageReason =
  | "has_list"
  | "crawl_pending"
  | "crawl_failed"
  | "crawled_no_parcels"
  | "no_source";

export interface CoverageRow {
  reason: CoverageReason;
  sales: number;
  parcelsAnnounced: number;
  parcelsHeld: number;
}

export async function coverageBreakdown(): Promise<CoverageRow[]> {
  const rows = (await db.execute(sql`
    WITH announced AS (
      SELECT id, county_fips, lot_count, announced_parcel_count
      FROM auctions
      WHERE announced_parcel_count > 0
        AND sale_date >= current_date
        AND delisted_at IS NULL
    ),
    job AS (
      SELECT county_fips,
             bool_or(status IN ('queued','leased')) AS pending,
             bool_or(status = 'done')               AS done,
             bool_or(status = 'failed')             AS failed
      FROM run_jobs
      WHERE county_fips IS NOT NULL
      GROUP BY county_fips
    )
    SELECT CASE
             WHEN a.lot_count > 0        THEN 'has_list'
             WHEN j.pending              THEN 'crawl_pending'
             WHEN j.done                 THEN 'crawled_no_parcels'
             WHEN j.failed               THEN 'crawl_failed'
             ELSE 'no_source'
           END AS reason,
           count(*)::int                                   AS sales,
           coalesce(sum(a.announced_parcel_count), 0)::int  AS parcels_announced,
           coalesce(sum(a.lot_count), 0)::int               AS parcels_held
    FROM announced a
    LEFT JOIN job j ON j.county_fips = a.county_fips
    GROUP BY 1
    ORDER BY 2 DESC
  `)) as unknown as {
    reason: CoverageReason;
    sales: number;
    parcels_announced: number;
    parcels_held: number;
  }[];

  return rows.map((r) => ({
    reason: r.reason,
    sales: r.sales,
    parcelsAnnounced: r.parcels_announced,
    parcelsHeld: r.parcels_held,
  }));
}
