/**
 * Which states the deal maths can price, which cannot, and what it would be
 * worth to fix.
 *
 * ## Why this had to exist
 *
 * `STATUTE_PARAMS` is read by fifteen modules — the CAPE pipeline, the coverage
 * funnel, the cartographer's verifier — and rendered by none of them. Every
 * citation in it, every `asOf`, every source URL, existed only in the source
 * file. The console could say "seventeen states have inventory and no
 * statutory parameters" and could not say which nine were done, when they were
 * last checked, or what they cited.
 *
 * ## Why it ranks the gap by parcels rather than by sales
 *
 * The question this answers is "which state do I research next", and the honest
 * measure of that is exposure, not activity. Pennsylvania carried 83 upcoming
 * sales and 40,530 announced parcels against Georgia's 51 sales and 421
 * parcels; on a sale count those look comparable and on parcels they are two
 * orders of magnitude apart. Ranking on sales would have pointed at the wrong
 * state.
 *
 * ## Why it no longer filters the gap to upcoming sales
 *
 * Because tax sales are seasonal and this query was blind to it. It asked only
 * for sales dated today or later, so a state between seasons looked exactly
 * like a state that does not hold tax sales at all.
 *
 * Mississippi is the case. Its annual sale is the last Monday in August — 74
 * sales carrying 123,409 announced parcels, more than every upcoming sale in
 * every other state put together. Eleven days after it closed the console
 * showed Mississippi nowhere, because every row we hold for it is in the past.
 * The research queue called the gap empty while the largest gap in the product
 * sat just outside the window.
 *
 * So the gap is ranked on everything we have ever seen, and `parcels` — what is
 * unpriceable right now — is reported separately from `seenParcels`, which is
 * what researching the state is worth. Our whole corpus spans July to November,
 * so even `seenParcels` understates any state selling in the other seven
 * months. It is a floor on the gap, not a measure of it.
 *
 * ## Why staleness is a first-class field
 *
 * `statute.ts` opens by warning that its figures "move with legislation" and to
 * "re-verify against the cited statute before trusting a computed max bid in a
 * state whose `asOf` has gone stale." Nothing enforced or displayed that, so a
 * date going stale was invisible until somebody re-read the file. Pennsylvania
 * makes it concrete: its assessment ratios come from a table the State Tax
 * Equalization Board republishes every July, so that entry is wrong on a
 * schedule whether or not anyone notices.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, counties } from "../db/schema";
import { NOT_ENCODED, STATUTE_PARAMS, type StatuteParams } from "../deal/statute";
import { STATE_NAMES } from "../atlas/state-names";

/**
 * Months after which an entry is treated as due for re-verification.
 *
 * Twelve, because statutes move with legislative sessions and most states run
 * one a year. It is a prompt to re-read, not an assertion that the entry is
 * now wrong.
 */
export const STALE_AFTER_MONTHS = 12;

export interface CoveredState {
  state: string;
  name: string;
  saleType: string;
  /** Plain-language summary of the redemption model, or "none". */
  redemption: string;
  asOf: string;
  monthsOld: number;
  stale: boolean;
  sources: string[];
  caveats: number;
  /** County-level assessment overrides, when the state needs them. */
  countyRatios: number;
  /** Upcoming sales and announced parcels we hold for this state. */
  sales: number;
  parcels: number;
}

export interface UncoveredState {
  state: string;
  name: string;
  /** Upcoming sales and announced parcels — the gap right now. */
  sales: number;
  parcels: number;
  soonest: string | null;
  /** Everything we have ever held for this state — what researching it is worth. */
  seenSales: number;
  seenParcels: number;
  /** Most recent sale date on record, upcoming or past. */
  lastSale: string | null;
  /**
   * We hold sales for this state but none upcoming, so a forward-looking query
   * cannot see it. Seasonality, not absence.
   */
  betweenSeasons: boolean;
  /**
   * Set when the state was researched and deliberately left uncovered.
   *
   * Without this the console cannot tell a closed question from a queue item,
   * and since the list ranks by parcels, the closed ones sit at the top of the
   * research queue permanently — New Jersey's 7,427 parcels above every state
   * anyone could actually act on.
   */
  deliberate?: { summary: string; blocker: string; unblockedBy: string };
}

export interface StatuteCoverage {
  covered: CoveredState[];
  /** States we have ever seen sales for with no entry, worst gap first. */
  uncovered: UncoveredState[];
  /** Upcoming parcels we hold that no statute can price. */
  unpriceableParcels: number;
  /**
   * States with no statutory parameters AND no auction we have ever recorded.
   *
   * The uncovered list is built from the auctions table, so it can only rank
   * what discovery has found. A state nobody has crawled is not at the bottom
   * of that list, it is absent from it — and absent looks identical to "has no
   * tax sales". Alabama, Iowa and Oklahoma all run substantial tax sales and
   * all have zero rows here.
   *
   * This is a discovery gap rather than a statute gap, which is why it is a
   * separate field: researching the statute for a state we cannot see any sales
   * in would price nothing.
   */
  neverSeen: string[];
}

/** How long ago a YYYY-MM stamp was, in whole months. */
function monthsSince(asOf: string): number {
  const [y, m] = asOf.split("-").map(Number);
  if (!y || !m) return Number.POSITIVE_INFINITY;
  const now = new Date();
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
}

/**
 * One line describing what an investor earns while waiting, or that they earn
 * nothing. Deliberately not a number — the tiers are a shape, and flattening
 * them to "18%" is how a bid-down state gets mispriced.
 */
function describeRedemption(p: StatuteParams): string {
  if (!p.redemption) return "none — deed conveys without a post-sale window";
  const { tiers, maxDays, bidDown, extendedFor } = p.redemption;
  const top = tiers.length ? `${Math.round(tiers[0].penalty * 100)}%` : "—";
  const months = Math.round(maxDays / 30);
  const base = bidDown
    ? `${Math.round(bidDown.statutoryMax * 100)}% cap, ${Math.round(bidDown.observedMedian * 100)}% observed median`
    : `${top} first tier`;
  return `${base} · up to ${months} month${months === 1 ? "" : "s"}${extendedFor ? ` (longer for ${extendedFor})` : ""}`;
}

export async function getStatuteCoverage(): Promise<StatuteCoverage> {
  const today = new Date().toISOString().slice(0, 10);

  /*
   * Deliberately unfiltered by date, taking the upcoming figures as conditional
   * aggregates instead. A WHERE clause here is what hid Mississippi.
   */
  const rows = await db
    .select({
      state: counties.state,
      sales: sql<number>`count(*) filter (where ${auctions.saleDate} >= ${today})::int`,
      parcels: sql<number>`coalesce(sum(${auctions.announcedParcelCount}) filter (where ${auctions.saleDate} >= ${today}), 0)::int`,
      soonest: sql<string | null>`min(${auctions.saleDate}) filter (where ${auctions.saleDate} >= ${today})`,
      seenSales: sql<number>`count(*)::int`,
      seenParcels: sql<number>`coalesce(sum(${auctions.announcedParcelCount}), 0)::int`,
      lastSale: sql<string | null>`max(${auctions.saleDate})`,
    })
    .from(auctions)
    .innerJoin(counties, sql`${counties.fips} = ${auctions.countyFips}`)
    .groupBy(counties.state);

  const held = new Map(rows.map((r) => [r.state, r]));

  const covered: CoveredState[] = Object.values(STATUTE_PARAMS)
    .map((p) => {
      const h = held.get(p.state);
      const monthsOld = monthsSince(p.asOf);
      return {
        state: p.state,
        name: STATE_NAMES[p.state] ?? p.state,
        saleType: p.saleType,
        redemption: describeRedemption(p),
        asOf: p.asOf,
        monthsOld,
        stale: monthsOld >= STALE_AFTER_MONTHS,
        sources: p.sources,
        caveats: p.caveats.length,
        countyRatios: Object.keys(p.countyAssessmentRatios ?? {}).length,
        sales: h?.sales ?? 0,
        parcels: h?.parcels ?? 0,
      };
    })
    /* Biggest exposure first, then alphabetically so the order is stable. */
    .sort((a, b) => b.parcels - a.parcels || a.state.localeCompare(b.state));

  const uncovered: UncoveredState[] = rows
    .filter((r) => !(r.state in STATUTE_PARAMS))
    .map((r) => {
      const closed = NOT_ENCODED[r.state];
      return {
        state: r.state,
        name: STATE_NAMES[r.state] ?? r.state,
        sales: r.sales,
        parcels: r.parcels,
        soonest: r.soonest ?? null,
        seenSales: r.seenSales,
        seenParcels: r.seenParcels,
        lastSale: r.lastSale ?? null,
        betweenSeasons: r.sales === 0 && r.seenSales > 0,
        deliberate: closed
          ? { summary: closed.summary, blocker: closed.blocker, unblockedBy: closed.unblockedBy }
          : undefined,
      };
    })
    /*
     * Researchable states first, then the closed ones — within each group, by
     * exposure. Ranking purely on parcels would answer "where is the most
     * money" when the question the list is actually asked is "what should I do
     * next", and those differ exactly where a state has been ruled out.
     */
    .sort(
      (a, b) =>
        Number(Boolean(a.deliberate)) - Number(Boolean(b.deliberate)) ||
        /* Everything seen, not only what is upcoming — see the header. */
        b.seenParcels - a.seenParcels ||
        b.seenSales - a.seenSales ||
        a.state.localeCompare(b.state),
    );

  const seen = new Set(rows.map((r) => r.state));
  const neverSeen = Object.keys(STATE_NAMES)
    .filter((st) => st.length === 2 && !(st in STATUTE_PARAMS) && !(st in NOT_ENCODED) && !seen.has(st))
    .sort();

  return {
    covered,
    uncovered,
    unpriceableParcels: uncovered.reduce((n, s) => n + s.parcels, 0),
    neverSeen,
  };
}
