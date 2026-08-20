import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, lots } from "../db/schema";

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
 * definition of the rows this touches — and everything it did carry is in the
 * source file, in the crawl that replaced it, and in the count moved across
 * first.
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
  const result: FoldResult = { folded: 0, countsMoved: 0, ambiguous: [] };

  /*
   * County/date groups holding both kinds of row, for sales that have not
   * happened yet. Past sales are left alone — a duplicate on a date nobody can
   * bid at is not worth a delete, and the history is more useful intact.
   */
  const groups = (await db.execute(sql`
    SELECT county_fips,
           sale_date::text AS sale_date,
           count(*) FILTER (WHERE external_id LIKE 'ustla:%' AND lot_count = 0)::int AS imported,
           count(*) FILTER (WHERE external_id NOT LIKE 'ustla:%')::int AS crawled
    FROM auctions
    WHERE sale_date >= current_date
    GROUP BY 1, 2
    HAVING count(*) FILTER (WHERE external_id LIKE 'ustla:%' AND lot_count = 0) > 0
       AND count(*) FILTER (WHERE external_id NOT LIKE 'ustla:%') > 0
  `)) as unknown as { county_fips: string; sale_date: string; imported: number; crawled: number }[];

  for (const g of groups) {
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

    const [announcement] = await db
      .select({ id: auctions.id, announced: auctions.announcedParcelCount })
      .from(auctions)
      .where(and(where, sql`${auctions.externalId} LIKE 'ustla:%'`, eq(auctions.lotCount, 0)))
      .limit(1);
    const [crawl] = await db
      .select({ id: auctions.id, announced: auctions.announcedParcelCount })
      .from(auctions)
      .where(and(where, sql`${auctions.externalId} NOT LIKE 'ustla:%'`))
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

    // Move the count first, so a failure between the two statements leaves the
    // announcement standing rather than losing the number entirely.
    if (announcement.announced !== null && crawl.announced === null) {
      await db
        .update(auctions)
        .set({ announcedParcelCount: announcement.announced })
        .where(eq(auctions.id, crawl.id));
      result.countsMoved++;
    }

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
