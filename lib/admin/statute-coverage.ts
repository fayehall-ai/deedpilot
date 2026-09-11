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

import { gte, sql } from "drizzle-orm";
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
  sales: number;
  parcels: number;
  soonest: string | null;
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
  /** States holding upcoming inventory with no entry, worst gap first. */
  uncovered: UncoveredState[];
  /** Parcels we hold that no statute can price. */
  unpriceableParcels: number;
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

  const rows = await db
    .select({
      state: counties.state,
      sales: sql<number>`count(*)::int`,
      parcels: sql<number>`coalesce(sum(${auctions.announcedParcelCount}), 0)::int`,
      soonest: sql<string>`min(${auctions.saleDate})`,
    })
    .from(auctions)
    .innerJoin(counties, sql`${counties.fips} = ${auctions.countyFips}`)
    .where(gte(auctions.saleDate, today))
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
        b.parcels - a.parcels ||
        b.sales - a.sales ||
        a.state.localeCompare(b.state),
    );

  return {
    covered,
    uncovered,
    unpriceableParcels: uncovered.reduce((n, s) => n + s.parcels, 0),
  };
}
