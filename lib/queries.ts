import "server-only";
import { and, asc, desc, eq, gte, sql, count } from "drizzle-orm";
import { db } from "./db";
import { auctions, counties, lots, ingestRuns, dealAnalyses, lotValuations } from "./db/schema";

/** Today in UTC as YYYY-MM-DD — sale dates are stored as plain dates. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Inventory a bidder can act on: parcels from a county's published sale list.
 *
 * A delinquent roll parses identically to a sale list and is 10-50x larger, so
 * without this filter the honest counts are swamped by parcels that are not for
 * sale. Applied to every headline number and every default listing view; ops
 * surfaces opt out explicitly.
 */
const isConfirmedInventory = () =>
  and(eq(auctions.listingKind, "sale_list"), eq(auctions.saleDateConfirmed, true));

export interface AuctionListRow {
  id: string;
  saleDate: string;
  saleType: string;
  status: string;
  title: string | null;
  platform: string;
  sourceUrl: string;
  lotCount: number;
  countyFips: string;
  countyName: string;
  state: string;
  /** Which document these parcels came from. Only `sale_list` is inventory. */
  listingKind: string;
  /** False when the date is projected from the state's typical schedule. */
  saleDateConfirmed: boolean;
  /** Sum of opening bids where known — an incomplete floor, labelled as such. */
  totalOpeningBids: string | null;
}

export async function getUpcomingAuctions(
  opts: {
    state?: string;
    limit?: number;
    /** Include 0-lot calendar shells. Default false. */
    includeSkeletons?: boolean;
    /**
     * Include delinquent rolls and projected sale dates. Default false —
     * these are research leads, not auctions, and must be labelled wherever
     * they are shown.
     */
    includeUnconfirmed?: boolean;
  } = {},
) {
  // Skeletons (lot_count = 0) are not inventory — they inflate "coverage" and
  // look like real sales on the auctions page. Opt in only for ops views.
  const where = [
    gte(auctions.saleDate, todayIso()),
    ...(opts.includeSkeletons ? [] : [sql`${auctions.lotCount} > 0`]),
    ...(opts.includeUnconfirmed ? [] : [isConfirmedInventory()]),
  ];
  if (opts.state) where.push(eq(counties.state, opts.state));

  return db
    .select({
      id: auctions.id,
      saleDate: auctions.saleDate,
      saleType: auctions.saleType,
      status: auctions.status,
      title: auctions.title,
      platform: auctions.platform,
      sourceUrl: auctions.sourceUrl,
      lotCount: auctions.lotCount,
      countyFips: auctions.countyFips,
      countyName: counties.name,
      state: counties.state,
      listingKind: auctions.listingKind,
      saleDateConfirmed: auctions.saleDateConfirmed,
      totalOpeningBids: sql<string | null>`(
        SELECT sum(${lots.openingBid}) FROM ${lots} WHERE ${lots.auctionId} = ${auctions.id}
      )`,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(and(...where))
    .orderBy(asc(auctions.saleDate), asc(counties.state), asc(counties.name))
    .limit(opts.limit ?? 200);
}

export async function getAuction(id: string) {
  const [row] = await db
    .select({
      auction: auctions,
      county: counties,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(eq(auctions.id, id))
    .limit(1);
  return row ?? null;
}

export async function getAuctionLots(auctionId: string) {
  return db
    .select()
    .from(lots)
    .where(eq(lots.auctionId, auctionId))
    // Biggest apparent spread first — that is what people are scanning for.
    .orderBy(desc(sql`coalesce(${lots.assessedValue}, 0) - coalesce(${lots.openingBid}, 0)`))
    .limit(1000);
}

export async function getLot(id: string) {
  const [row] = await db
    .select({ lot: lots, auction: auctions, county: counties })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(eq(lots.id, id))
    .limit(1);
  return row ?? null;
}

/** Latest enrichment rows for a lot (ATTOM / RentCast / assessor). */
export async function getLotValuations(lotId: string) {
  return db
    .select()
    .from(lotValuations)
    .where(eq(lotValuations.lotId, lotId))
    .orderBy(desc(lotValuations.fetchedAt));
}

/**
 * A previously generated brief for this lot and exact input set.
 *
 * Read on page render so a cached brief appears immediately instead of the
 * component resetting to "Generate brief" and making the user pay 35 seconds
 * again for something already bought and stored.
 */
export async function getCachedBrief(lotId: string, inputsHash: string) {
  const [row] = await db
    .select({ brief: dealAnalyses.brief, model: dealAnalyses.model })
    .from(dealAnalyses)
    .where(and(eq(dealAnalyses.lotId, lotId), eq(dealAnalyses.inputsHash, inputsHash)))
    .limit(1);

  if (!row?.brief) return null;
  try {
    return { brief: JSON.parse(row.brief), model: row.model };
  } catch {
    return null;
  }
}

/**
 * Headline counts for the landing page and the coverage report.
 *
 * Every number here counts *confirmed sale inventory only* — a published sale
 * list on a published date. Delinquent rolls and projected dates are counted
 * separately as `leads`, because presenting them together is the difference
 * between "9,598 lots" and the ~3,300 a subscriber can actually bid on.
 */
export async function getPlatformStats() {
  const upcoming = gte(auctions.saleDate, todayIso());
  const hasLots = sql`${auctions.lotCount} > 0`;
  const confirmed = isConfirmedInventory();

  const [totals] = await db
    .select({
      auctions: count(auctions.id),
    })
    .from(auctions)
    .where(and(upcoming, hasLots, confirmed));

  const [skeletonTotals] = await db
    .select({ auctions: count(auctions.id) })
    .from(auctions)
    .where(and(upcoming, eq(auctions.lotCount, 0)));

  // Lots on upcoming non-skeleton auctions only (not historical junk).
  const [lotTotals] = await db
    .select({ lots: count(lots.id) })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .where(and(upcoming, hasLots, confirmed));

  const [lotsWithAssessed] = await db
    .select({ n: count(lots.id) })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .where(and(upcoming, hasLots, confirmed, sql`${lots.assessedValue} is not null`));

  // Parcels we hold that are *not* bidding inventory: delinquent rolls, lands
  // available, and lists sitting under a projected date. Real research value,
  // reported under its own name so it can never pad the inventory figure.
  const [leadTotals] = await db
    .select({
      auctions: sql<number>`count(DISTINCT ${auctions.id})::int`,
      lots: count(lots.id),
    })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .where(and(upcoming, hasLots, sql`NOT (${confirmed})`));

  const byState = await db
    .select({
      state: counties.state,
      counties: sql<number>`count(DISTINCT ${counties.fips})::int`,
      auctions: sql<number>`count(DISTINCT ${auctions.id})::int`,
      lots: sql<number>`count(${lots.id})::int`,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .innerJoin(lots, eq(lots.auctionId, auctions.id))
    .where(and(upcoming, hasLots, confirmed))
    .groupBy(counties.state)
    .orderBy(desc(sql`count(${lots.id})`));

  return {
    upcomingAuctions: totals?.auctions ?? 0,
    skeletonAuctions: skeletonTotals?.auctions ?? 0,
    totalLots: lotTotals?.lots ?? 0,
    lotsWithAssessed: lotsWithAssessed?.n ?? 0,
    /** Parcels held that are not confirmed bidding inventory. */
    leadAuctions: leadTotals?.auctions ?? 0,
    leadLots: leadTotals?.lots ?? 0,
    byState,
  };
}

/**
 * Most recent ingest outcome per county — the honesty surface. A county that
 * silently stopped returning lots shows up here as a stale or failed run
 * rather than as an empty auction list.
 */
export async function getIngestHealth() {
  return db
    .select({
      adapter: ingestRuns.adapter,
      countyFips: ingestRuns.countyFips,
      countyName: counties.name,
      state: counties.state,
      status: ingestRuns.status,
      auctionsFound: ingestRuns.auctionsFound,
      lotsFound: ingestRuns.lotsFound,
      rejected: ingestRuns.rejected,
      repaired: ingestRuns.repaired,
      error: ingestRuns.error,
      finishedAt: ingestRuns.finishedAt,
    })
    .from(ingestRuns)
    .leftJoin(counties, eq(counties.fips, ingestRuns.countyFips))
    .orderBy(desc(ingestRuns.startedAt))
    .limit(200);
}
