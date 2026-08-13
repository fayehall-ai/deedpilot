import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctions, ingestRuns, lots } from "@/lib/db/schema";
import { getCounty, resolveCountyRule } from "@/lib/atlas";
import { resolveSaleSchedule, nextSaleWindows } from "@/lib/atlas/calendar";
import { loadRegistry } from "@/lib/ingest/adapters/generic";
import type { County } from "@/lib/atlas/types";
import type { VerifiedSource } from "@/lib/prospector/types";

/**
 * Everything about one county, assembled for the operations console.
 *
 * The unit of operational work here is a county, not a table. Answering "why is
 * Muskegon wrong" currently means joining the atlas, the registry, the calendar,
 * `ingest_runs`, `auctions` and `lots` by hand across six screens — and the
 * console offers none of them filtered to a county at all.
 *
 * Read-only and deliberately assembled from the same sources the pipeline uses,
 * rather than from a cache, so the page cannot disagree with what the crawler
 * will do next.
 */

export interface CountyAuctionRow {
  id: string;
  saleDate: string;
  saleType: string;
  listingKind: string;
  saleDateConfirmed: boolean;
  status: string;
  lotCount: number;
  sourceUrl: string;
  delistedAt: Date | null;
  overrides: Record<string, unknown> | null;
  editedBy: string | null;
  lastSeenAt: Date;
  /** Parcels currently listed, as distinct from every row ever recorded. */
  pendingLots: number;
  withdrawnLots: number;
}

export interface CountyDetail {
  county: County;
  rule: ReturnType<typeof resolveCountyRule>;
  schedule: ReturnType<typeof resolveSaleSchedule>;
  upcomingWindows: ReturnType<typeof nextSaleWindows>;
  sources: VerifiedSource[];
  auctionRows: CountyAuctionRow[];
  runs: {
    adapter: string;
    status: string;
    startedAt: Date | null;
    auctionsFound: number;
    lotsFound: number;
    durationMs: number | null;
    error: string | null;
  }[];
  totals: {
    auctions: number;
    pendingLots: number;
    withdrawnLots: number;
    observations: number;
  };
}

export async function getCountyDetail(fips: string): Promise<CountyDetail | null> {
  const county = getCounty(fips);
  if (!county) return null;

  const registry = loadRegistry();
  const sources = (registry?.counties[fips]?.sources ?? []) as VerifiedSource[];

  const [auctionRows, runs, obs] = await Promise.all([
    db
      .select({
        id: auctions.id,
        saleDate: auctions.saleDate,
        saleType: auctions.saleType,
        listingKind: auctions.listingKind,
        saleDateConfirmed: auctions.saleDateConfirmed,
        status: auctions.status,
        lotCount: auctions.lotCount,
        sourceUrl: auctions.sourceUrl,
        delistedAt: auctions.delistedAt,
        overrides: auctions.operatorOverrides,
        editedBy: auctions.editedBy,
        lastSeenAt: auctions.lastSeenAt,
        /*
         * Counted per status rather than trusting `lot_count`, which records
         * what the last crawl returned. After reconciliation those diverge by
         * exactly the withdrawn parcels, and seeing both is the point.
         */
        pendingLots: sql<number>`(select count(*)::int from ${lots} where ${lots.auctionId} = ${auctions.id} and ${lots.status} = 'pending')`,
        withdrawnLots: sql<number>`(select count(*)::int from ${lots} where ${lots.auctionId} = ${auctions.id} and ${lots.status} = 'withdrawn')`,
      })
      .from(auctions)
      .where(eq(auctions.countyFips, fips))
      .orderBy(desc(auctions.saleDate))
      .limit(25),
    db
      .select({
        adapter: ingestRuns.adapter,
        status: ingestRuns.status,
        startedAt: ingestRuns.startedAt,
        auctionsFound: ingestRuns.auctionsFound,
        lotsFound: ingestRuns.lotsFound,
        durationMs: ingestRuns.durationMs,
        error: ingestRuns.error,
      })
      .from(ingestRuns)
      .where(eq(ingestRuns.countyFips, fips))
      .orderBy(desc(ingestRuns.startedAt))
      .limit(12),
    db.execute(sql`SELECT count(*)::int n FROM lot_observations WHERE county_fips = ${fips}`),
  ]);

  const observations = (obs as unknown as { n: number }[])[0]?.n ?? 0;

  return {
    county,
    rule: resolveCountyRule(fips),
    schedule: resolveSaleSchedule(fips),
    upcomingWindows: nextSaleWindows(fips, { count: 3 }),
    sources,
    auctionRows,
    runs,
    totals: {
      auctions: auctionRows.length,
      pendingLots: auctionRows.reduce((n, a) => n + a.pendingLots, 0),
      withdrawnLots: auctionRows.reduce((n, a) => n + a.withdrawnLots, 0),
      observations,
    },
  };
}
