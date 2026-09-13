import "server-only";
import { cacheLife } from "next/cache";
import { and, asc, desc, eq, gte, inArray, lte, or, sql, count } from "drizzle-orm";
import { db } from "./db";
import { auctions, counties, lots, ingestRuns, dealAnalyses, lotValuations } from "./db/schema";

/** Today in UTC as YYYY-MM-DD — sale dates are stored as plain dates. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A sale whose county has stated a parcel count without publishing the parcels.
 *
 * Written by the CSV import. The count is the county's claim, not a number of
 * rows this database holds — see `announced_parcel_count` in the schema.
 */
const hasAnnouncedCount = () => sql`coalesce(${auctions.announcedParcelCount}, 0) > 0`;

/**
 * Not an empty calendar shell.
 *
 * Was `lot_count > 0` alone. An announced sale has no lots yet and is still
 * not a skeleton: a skeleton is a date with nothing known about it, whereas an
 * announced sale carries a published parcel count and a venue. Hiding those
 * would mean importing a calendar and then not seeing it.
 */
const hasParcels = () => or(sql`${auctions.lotCount} > 0`, hasAnnouncedCount());

/**
 * Inventory a bidder can act on: parcels from a county's published sale list,
 * or a sale the county has announced with a count.
 *
 * A delinquent roll parses identically to a sale list and is 10-50x larger, so
 * without this filter the honest counts are swamped by parcels that are not for
 * sale. Applied to every headline number and every default listing view; ops
 * surfaces opt out explicitly.
 *
 * The `listing_kind` half is now a disjunction because an imported sale's
 * `listing_kind` is `unknown` and must stay that way — nothing has read a
 * document for it, so claiming `sale_list` would be a lie about provenance.
 * What admits it instead is the announced count, which no delinquent roll has.
 * A projected date is still excluded by `sale_date_confirmed`, which is the
 * half that was actually keeping research leads off the calendar.
 */
const isConfirmedInventory = () =>
  and(
    or(eq(auctions.listingKind, "sale_list"), hasAnnouncedCount()),
    eq(auctions.saleDateConfirmed, true),
  );

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
  /**
   * Parcels the county says it is offering, when nothing has crawled the list.
   * Null for a crawled sale; with `lotCount` 0 it marks an announced sale, which
   * the UI must label rather than show as though the parcels were in hand.
   */
  announcedParcelCount: number | null;
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
  /*
   * Cached for the same two reasons as the aggregates: it reads the clock
   * before its first query, which Cache Components only permits inside a cache
   * scope, and the underlying rows only move on the nightly ingest.
   */
  "use cache";
  cacheLife("minutes");
  // Skeletons — no lots and no announced count — are not inventory: they
  // inflate "coverage" and look like real sales. Opt in only for ops views.
  const where = [
    gte(auctions.saleDate, todayIso()),
    ...(opts.includeSkeletons ? [] : [hasParcels()]),
    ...(opts.includeUnconfirmed ? [] : [isConfirmedInventory()]),
  ];
  if (opts.state) where.push(eq(counties.state, opts.state));

  return await db
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
      announcedParcelCount: auctions.announcedParcelCount,
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

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarAuctionRow {
  id: string;
  saleDate: string;
  saleType: string;
  status: string;
  platform: string;
  lotCount: number;
  countyFips: string;
  countyName: string;
  state: string;
  listingKind: string;
  saleDateConfirmed: boolean;
  /** See `AuctionListRow.announcedParcelCount`. */
  announcedParcelCount: number | null;
  /**
   * The county's own name for this sale. Load-bearing when one county holds
   * several sales the same day — "HARRIS COUNTY tax sale — precinct 3" is the
   * only thing separating eight otherwise identical rows.
   */
  title: string | null;
  /**
   * Sum of opening bids where known — an incomplete floor, labelled as such.
   *
   * Null when no lot in the sale carries an opening bid, which is a different
   * statement from "$0" and is rendered differently. Lot count answers how much
   * there is to work through; this answers whether it is worth the drive.
   */
  totalOpeningBids: string | null;
}

export interface CalendarFilterOpts {
  /** State abbreviations. Empty/absent means all. */
  states?: string[];
  /** Sale-type labels, e.g. "Tax Deed". Empty/absent means all. */
  saleTypes?: string[];
  /** Platform enum values. Empty/absent means all. */
  platforms?: string[];
  /** Include delinquent rolls, lands-available, and projected dates. */
  includeUnconfirmed?: boolean;
}

/** The shared WHERE for every calendar query, so facets and cells agree. */
function calendarWhere(opts: CalendarFilterOpts) {
  const where = [
    hasParcels(),
    ...(opts.includeUnconfirmed ? [] : [isConfirmedInventory()]),
  ];
  if (opts.states?.length) where.push(inArray(counties.state, opts.states));
  if (opts.saleTypes?.length) {
    where.push(inArray(auctions.saleType, opts.saleTypes as (typeof auctions.saleType.enumValues)[number][]));
  }
  if (opts.platforms?.length) {
    where.push(inArray(auctions.platform, opts.platforms as (typeof auctions.platform.enumValues)[number][]));
  }
  return where;
}

/**
 * Sales landing between two dates, for the calendar grid.
 *
 * Bounded by the visible grid range rather than "upcoming", because the grid
 * shows whole weeks: the last row of August contains September 1, which is the
 * single busiest sale day in the data. It also means past months are browsable
 * — a bidder checking what they missed in a county is a real motion.
 */
export async function getCalendarAuctions(
  opts: CalendarFilterOpts & { from: string; to: string },
): Promise<CalendarAuctionRow[]> {
  return db
    .select({
      id: auctions.id,
      saleDate: auctions.saleDate,
      saleType: auctions.saleType,
      status: auctions.status,
      platform: auctions.platform,
      lotCount: auctions.lotCount,
      countyFips: auctions.countyFips,
      countyName: counties.name,
      state: counties.state,
      listingKind: auctions.listingKind,
      saleDateConfirmed: auctions.saleDateConfirmed,
      announcedParcelCount: auctions.announcedParcelCount,
      title: auctions.title,
      // Correlated rather than joined-and-grouped: `lots_auction_idx` turns each
      // one into an index scan, and grouping would have to survive the county
      // join above without double-counting.
      totalOpeningBids: sql<string | null>`(
        SELECT sum(${lots.openingBid}) FROM ${lots} WHERE ${lots.auctionId} = ${auctions.id}
      )`,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(
      and(
        gte(auctions.saleDate, opts.from),
        lte(auctions.saleDate, opts.to),
        ...calendarWhere(opts),
      ),
    )
    // Biggest sales first within a day: a 400-lot county is worth more of a
    // bidder's attention than the 3-lot one that happens to sort before it.
    .orderBy(asc(auctions.saleDate), desc(auctions.lotCount), asc(counties.state), asc(counties.name))
    .limit(2000);
}

export interface CalendarFacet {
  value: string;
  count: number;
}

/**
 * Which states, sale types and platforms have upcoming sales at all.
 *
 * Deliberately *not* narrowed by the visible month or the active filters. A
 * filter chip that disappears when you page to a quiet month, or when another
 * chip is on, makes the control feel broken and hides where the inventory is —
 * the counts are the answer to "where should I be looking", which is the
 * question ahead of "what is on in September".
 */
export async function getCalendarFacets(
  opts: { includeUnconfirmed?: boolean } = {},
): Promise<{ states: CalendarFacet[]; saleTypes: CalendarFacet[]; platforms: CalendarFacet[] }> {
  /*
   * Cached for the same two reasons as the aggregates: it reads the clock
   * before its first query, which Cache Components only permits inside a cache
   * scope, and the underlying rows only move on the nightly ingest.
   */
  "use cache";
  cacheLife("minutes");
  const rows = await db
    .select({
      state: counties.state,
      saleType: auctions.saleType,
      platform: auctions.platform,
      n: sql<number>`count(*)::int`,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(and(gte(auctions.saleDate, todayIso()), ...calendarWhere(opts)))
    .groupBy(counties.state, auctions.saleType, auctions.platform);

  const tally = (key: "state" | "saleType" | "platform"): CalendarFacet[] => {
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r[key], (totals.get(r[key]) ?? 0) + r.n);
    return [...totals.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };

  return { states: tally("state"), saleTypes: tally("saleType"), platforms: tally("platform") };
}

/**
 * The next date on or after `after` that has a sale matching these filters.
 *
 * Turns an empty month into a jump link instead of a dead end — with sales
 * concentrated in a few months a year, paging blindly through empty grids is
 * the default experience otherwise.
 */
export async function getNextCalendarDate(
  opts: CalendarFilterOpts & { after: string },
): Promise<string | null> {
  const [row] = await db
    .select({ saleDate: auctions.saleDate })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(and(gte(auctions.saleDate, opts.after), ...calendarWhere(opts)))
    .orderBy(asc(auctions.saleDate))
    .limit(1);
  return row?.saleDate ?? null;
}

/**
 * The month the calendar opens on when the URL names none.
 *
 * This month whenever it still has a sale to come, and otherwise the month of
 * the next one. Sales cluster into a few months a year, so the literal current
 * month is empty for much of it — and a landing page whose main section says
 * "nothing scheduled in August" reads as no inventory rather than as a quiet
 * August.
 *
 * Deliberately blind to the reader's filter chips, for the same reason
 * `getCalendarFacets` is: a month that jumps when a chip is toggled makes the
 * control feel broken. The empty-state's "the next matching sale is …" link is
 * the filtered answer, and it is one the reader chooses rather than one that
 * happens to them.
 */
export async function getDefaultCalendarMonth(): Promise<string> {
  /*
   * Cached because it reads the clock — Cache Components only permits that
   * inside a cache scope — and because the answer moves at most once a day.
   */
  "use cache";
  cacheLife("hours");
  const today = todayIso();
  return (await getNextCalendarDate({ after: today }))?.slice(0, 7) ?? today.slice(0, 7);
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
export interface PlatformStats {
  upcomingAuctions: number;
  skeletonAuctions: number;
  totalLots: number;
  lotsWithAssessed: number;
  /** Parcels held that are not confirmed bidding inventory. */
  leadAuctions: number;
  leadLots: number;
  byState: { state: string; counties: number; auctions: number; lots: number }[];
}

/**
 * What the landing page and the coverage report show when Postgres cannot be
 * reached. Zeroes, not absence: every consumer already renders a count, and a
 * zero reads as "nothing to report" where an undefined reads as a crash.
 */
export const EMPTY_PLATFORM_STATS: PlatformStats = {
  upcomingAuctions: 0,
  skeletonAuctions: 0,
  totalLots: 0,
  lotsWithAssessed: 0,
  leadAuctions: 0,
  leadLots: 0,
  byState: [],
};

async function platformStats(): Promise<PlatformStats> {
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

export async function getPlatformStats(): Promise<PlatformStats> {
  /*
   * Cached, which under Cache Components is also what makes the clock read
   * inside it legal: a Server Component may not ask the time before it has
   * read uncached data, and `todayIso()` here runs before the first query.
   *
   * Minutes is the right window. Everything this aggregates moves on the
   * nightly ingest cron, so a request-fresh count buys nothing a subscriber
   * can perceive, and the page is one a person reloads repeatedly while
   * working — which is precisely when a cache earns its keep.
   */
  "use cache";
  cacheLife("minutes");

  /*
   * Guarded here rather than at the call site — see the note on
   * `buildCoverageScoreboard`. Both callers already wrap this in `.catch()`
   * with a zeroed fallback, and both of those are inert during a build,
   * because a throw inside a cached function aborts the prerender out of band.
   */
  try {
    return await platformStats();
  } catch {
    return EMPTY_PLATFORM_STATS;
  }
}

/**
 * Most recent ingest outcome per county — the honesty surface. A county that
 * silently stopped returning lots shows up here as a stale or failed run
 * rather than as an empty auction list.
 */
async function ingestHealthRows() {
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

/** One row of the ingest-health surface, inferred from the query itself. */
export type IngestHealthRow = Awaited<ReturnType<typeof ingestHealthRows>>[number];

export async function getIngestHealth(): Promise<IngestHealthRow[]> {
  /*
   * Cached, which under Cache Components is also what makes the clock read
   * inside it legal: a Server Component may not ask the time before it has
   * read uncached data, and `todayIso()` here runs before the first query.
   *
   * Minutes is the right window. Everything this aggregates moves on the
   * nightly ingest cron, so a request-fresh count buys nothing a subscriber
   * can perceive, and the page is one a person reloads repeatedly while
   * working — which is precisely when a cache earns its keep.
   */
  "use cache";
  cacheLife("minutes");

  /*
   * Guarded here rather than at the call site — see the note on
   * `buildCoverageScoreboard`. A throw inside a cached function aborts the
   * build-time prerender before any caller's `.catch()` can run, so an
   * unreachable database stops the deploy instead of degrading the page.
   *
   * An empty list reads, correctly, as "no ingest runs to report". The
   * honesty surface is briefly silent rather than wrong.
   */
  try {
    return await ingestHealthRows();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CAPE — auction intake and source verification
// ---------------------------------------------------------------------------

export interface CapeAuctionRow {
  id: string;
  countyFips: string;
  countyName: string;
  state: string;
  saleDate: string;
  saleDateConfirmed: boolean;
  saleType: string;
  sourceUrl: string;
  platform: string;
  listingKind: string;
  lotCount: number;
  registrationDeadline: Date | null;
  depositDeadline: Date | null;
}

/**
 * Upcoming sales with the fields CAPE Component One asks for.
 *
 * Unfiltered by `listingKind` on purpose. A delinquent roll under a projected
 * date is exactly the thing intake is supposed to flag, so excluding it here
 * would hide the cases the report exists to surface.
 */
export async function getCapeAuctions(): Promise<CapeAuctionRow[]> {
  "use cache";
  cacheLife("minutes");
  return await db
    .select({
      id: auctions.id,
      countyFips: auctions.countyFips,
      countyName: counties.name,
      state: counties.state,
      saleDate: auctions.saleDate,
      saleDateConfirmed: auctions.saleDateConfirmed,
      saleType: auctions.saleType,
      sourceUrl: auctions.sourceUrl,
      platform: auctions.platform,
      listingKind: auctions.listingKind,
      lotCount: auctions.lotCount,
      registrationDeadline: auctions.registrationDeadline,
      depositDeadline: auctions.depositDeadline,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(and(gte(auctions.saleDate, todayIso()), sql`${auctions.lotCount} >= 0`))
    .orderBy(asc(auctions.saleDate), asc(counties.state), asc(counties.name))
    .limit(1000);
}

/** Per-sale parcel coverage, for CAPE Component Four. */
export async function getCapeParcelCoverage(): Promise<
  Record<string, { total: number; withParcelNumber: number; withAssessed: number; withAddress: number; withZoning: number; withGeo: number }>
> {
  "use cache";
  cacheLife("minutes");
  const rows = await db
    .select({
      auctionId: lots.auctionId,
      total: sql<number>`count(*)::int`,
      withParcelNumber: sql<number>`count(${lots.parcelNumber})::int`,
      withAssessed: sql<number>`count(${lots.assessedValue})::int`,
      withAddress: sql<number>`count(${lots.addressLine})::int`,
      /* Zoning lives on the valuation row, not the lot — ATTOM returns it. */
      withZoning: sql<number>`count(distinct ${lots.id}) filter (where exists (
        select 1 from lot_valuations lv where lv.lot_id = ${lots.id} and lv.zoning is not null))::int`,
      withGeo: sql<number>`count(${lots.latitude})::int`,
    })
    .from(lots)
    .innerJoin(auctions, eq(auctions.id, lots.auctionId))
    .where(gte(auctions.saleDate, todayIso()))
    .groupBy(lots.auctionId);

  return Object.fromEntries(rows.map((r) => [r.auctionId, r]));
}
