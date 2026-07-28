import "server-only";
import { and, asc, desc, eq, gte, sql, count } from "drizzle-orm";
import { db } from "./db";
import { auctions, counties, lots, ingestRuns } from "./db/schema";

/** Today in UTC as YYYY-MM-DD — sale dates are stored as plain dates. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  /** Sum of opening bids where known — an incomplete floor, labelled as such. */
  totalOpeningBids: string | null;
}

export async function getUpcomingAuctions(opts: { state?: string; limit?: number } = {}) {
  const where = [gte(auctions.saleDate, todayIso())];
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

/** Headline counts for the landing page and the coverage report. */
export async function getPlatformStats() {
  const [totals] = await db
    .select({
      auctions: count(auctions.id),
    })
    .from(auctions)
    .where(gte(auctions.saleDate, todayIso()));

  const [lotTotals] = await db.select({ lots: count(lots.id) }).from(lots);

  const byState = await db
    .select({
      state: counties.state,
      counties: sql<number>`count(DISTINCT ${counties.fips})::int`,
      auctions: sql<number>`count(DISTINCT ${auctions.id})::int`,
      lots: sql<number>`count(${lots.id})::int`,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .leftJoin(lots, eq(lots.auctionId, auctions.id))
    .groupBy(counties.state)
    .orderBy(desc(sql`count(${lots.id})`));

  return {
    upcomingAuctions: totals?.auctions ?? 0,
    totalLots: lotTotals?.lots ?? 0,
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
