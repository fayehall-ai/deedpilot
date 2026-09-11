/**
 * Which states the Auction Scout scans, decided from the calendar rather than
 * from a list somebody maintained.
 *
 * ## Why this stopped being a constant
 *
 * `SCAN_STATES` was eighteen states written by hand, and it drifted. After the
 * national calendar import the database held upcoming sales in thirty-two
 * states, sixteen of which were never scanned — Kentucky alone carried 28,864
 * announced parcels across 27 sales, more than most states on the list — while
 * Connecticut and Oklahoma were still scanned every sweep holding nothing
 * upcoming at all. Nobody had done anything wrong; the list was right when it
 * was written and there was no mechanism for it to stop being right.
 *
 * So the set is now derived: the priority states are pinned, and the remaining
 * slots go to the states actually holding upcoming inventory, ranked by what is
 * at stake. An import changes the scan set the same day, which is the property
 * the constant could not have.
 *
 * ## Why a state with no hub is still allowed in
 *
 * `STATE_HUBS` is hand-researched — the Arkansas COSL catalog, the Michigan
 * tax-sale.info group — and a hub is what makes a state cheap to scan. A
 * derived set will pick states nobody has researched, so the obvious worry is
 * that those runs are wasted.
 *
 * They are not. `scoutState` falls back to a generic "find the statewide
 * catalog, the multi-county law-firm page, or the platform calendar"
 * instruction, which is precisely the research a hub-less state needs — and its
 * citations are what `promote:sources` turns into sources. A hub-less state is
 * more expensive per call and lower yield, and that is a reason to rank it
 * below a hub state, not to refuse it. `hasHub` travels with every candidate so
 * the console can show which is which instead of hiding the distinction.
 *
 * ## Why this module is not `server-only`
 *
 * `scout-report.ts` is, because it talks to the model. This is geography and a
 * database query, and the scripts and the dispatcher both need it.
 */

import { gte, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, counties } from "../db/schema";

/**
 * Scanned county by county rather than by exception, always, whatever the
 * calendar says. These are where the volume is and where a missed sale costs
 * most, and a quiet month is not evidence that Georgia stopped mattering.
 */
export const PRIORITY_STATES = ["GA", "TX", "CA", "FL", "OH"] as const;

/**
 * How many states one sweep may cover.
 *
 * Each state is a paid searched call of one to two minutes against a dispatcher
 * that drains 195 seconds a day, so the ceiling is a real constraint rather
 * than a preference. Above the old eighteen because the calendar now justifies
 * more, and bounded because it must be.
 */
export const MAX_SCAN_STATES = 24;

/**
 * Where a state's sales are published in bulk.
 *
 * This is the difference between a report worth sending and a thin one, and it
 * was learned by taking the previous edition apart: its 79 rows rest on about
 * twenty sources, and the volume is almost all hubs. Forty-six Arkansas rows
 * came from ONE page — the Commissioner of State Lands catalog. Michigan's came
 * from a single site covering seventy-plus counties. Texas from a law firm that
 * posts every county's monthly sale on one page.
 *
 * A county-at-a-time crawl cannot compete with that. A Connecticut run spent
 * thirty-seven searches to find six sales, because it went looking for counties
 * instead of looking for the list. So the model is pointed at the hub first and
 * told to enumerate it, and only then to fill gaps county by county.
 *
 * Deliberately entry points, not answers: the model still has to open them and
 * read what is posted today. A hub that has gone stale should produce nothing,
 * not a remembered row.
 */
export const STATE_HUBS: Record<string, string> = {
  AR: "Arkansas Commissioner of State Lands (cosl.org) publishes the statewide catalog of tax-delinquent land auctions county by county, with sale dates, venues and redemption cut-offs. Start there and enumerate every county sale it lists in the window.",
  MI: "tax-sale.info runs the land auctions for most Michigan counties and lists dates by county group.",
  NY: "aarauctions.com and nysauctions.com carry county tax-foreclosure auctions with closing dates across many counties.",
  TX: "Texas sales are on the first Tuesday monthly. mvbalaw.com, lgbs.com (Linebarger) and pbfcm.com (Perdue Brandon) each post many counties' sale notices on one page; county sheriff and tax-assessor pages carry the rest.",
  GA: "Georgia sales are on the first Tuesday monthly, run by county tax commissioners and sheriffs (levy sales). County tax commissioner sites and consolidated Georgia tax-sale listing pages carry many counties at once.",
  FL: "Florida tax deed sales run on county clerk RealTaxDeed / RealAuction sites — commonly <county>.realtaxdeed.com or the clerk's own calendar. Each carries its county's full upcoming schedule.",
  CA: "California county treasurer-tax collectors sell through Bid4Assets and GrantStreet DeedAuction; both list several counties' upcoming sales together.",
  OH: "Ohio county sheriff sales run largely on RealAuction (sheriffsaleauction.ohio.gov subdomains) and county sheriff sites, each with a full upcoming calendar.",
  PA: "Pennsylvania county Tax Claim Bureaus run upset and judicial sales; several counties sell through Bid4Assets.",
  CT: "Connecticut sales are MUNICIPAL, not county — town and city tax collectors under CGS 12-157. Work the town tax collector pages.",
  NC: "North Carolina tax foreclosures are run by county tax offices and their law firms — zacchaeuslegal.com and kaniaLaw.com post many counties' upcoming sales together.",
  CO: "Colorado county treasurers run annual tax lien sales, many through zeusauction.com and realauction.",
  MN: "Minnesota county auditor-treasurers publish tax-forfeited land sales.",
  MO: "Missouri county collectors hold annual August tax sales; collector pages carry the lists.",
  OK: "Oklahoma county treasurers hold June resales and publish lists on treasurer pages.",
  AK: "Alaska boroughs and municipalities publish tax foreclosure land sales.",
  KS: "Kansas county treasurers and county counselors publish tax foreclosure sale notices.",
  WI: "Wisconsin counties sell tax-deeded land through county treasurer and land records pages.",
};

/** True when this state has a hand-researched entry point. */
export const hasHub = (state: string): boolean => state in STATE_HUBS;

export interface ScanCandidate {
  state: string;
  /** Upcoming sales held for this state. */
  sales: number;
  /** Announced parcels across those sales — what is at stake if we lose sight. */
  parcels: number;
  /** Soonest upcoming sale date, ISO. */
  soonest: string | null;
  hasHub: boolean;
  /** Why it is in the set. Rendered on the console so the set explains itself. */
  reason: "priority" | "inventory" | "researched";
}

/**
 * The states worth scanning right now, best first.
 *
 * Priority states lead, always. The rest are ranked by announced parcels and
 * then by sale count — two different kinds of exposure, and both belong in the
 * order: Kentucky's 27 sales carry 28,864 parcels while New Jersey's 179 carry
 * 7,631, and a ranking on either number alone would drop one of them.
 *
 * Ties broken by hub, so when two states are equally exposed the cheap one goes
 * first.
 */
export async function resolveScanStates(opts: { limit?: number } = {}): Promise<ScanCandidate[]> {
  const limit = Math.max(
    PRIORITY_STATES.length,
    Math.min(opts.limit ?? MAX_SCAN_STATES, MAX_SCAN_STATES),
  );
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
  const candidate = (state: string, reason: ScanCandidate["reason"]): ScanCandidate => {
    const r = held.get(state);
    return {
      state,
      sales: r?.sales ?? 0,
      parcels: r?.parcels ?? 0,
      soonest: r?.soonest ?? null,
      hasHub: hasHub(state),
      reason,
    };
  };

  const taken = new Set<string>(PRIORITY_STATES);
  const pinned = PRIORITY_STATES.map((s) => candidate(s, "priority"));

  const byExposure = rows
    .filter((r) => !taken.has(r.state))
    .sort(
      (a, b) =>
        b.parcels - a.parcels ||
        b.sales - a.sales ||
        Number(hasHub(b.state)) - Number(hasHub(a.state)) ||
        a.state.localeCompare(b.state),
    )
    .map((r) => {
      taken.add(r.state);
      return candidate(r.state, "inventory");
    });

  /*
   * Researched states stay eligible even holding nothing.
   *
   * Ranking purely on inventory we already hold is circular for a tool whose
   * job is finding sales we cannot see: a state drops out of the sweep because
   * our calendar is empty for it, and the calendar stays empty because nothing
   * scans it. Connecticut, Colorado, Missouri, Oklahoma and Alaska all fell out
   * on the first derived run for exactly that reason.
   *
   * A hub is hand-researched — somebody established where that state publishes
   * — so it is evidence about the state, not about our coverage. Those states
   * therefore keep a place, below everything with live exposure, and are cut
   * only when the ceiling actually bites.
   */
  const researched = Object.keys(STATE_HUBS)
    .filter((s) => !taken.has(s))
    .sort()
    .map((s) => candidate(s, "researched"));

  return [...pinned, ...byExposure, ...researched].slice(0, limit);
}

/** Just the codes, for callers that only need the list. */
export async function scanStateCodes(opts: { limit?: number } = {}): Promise<string[]> {
  return (await resolveScanStates(opts)).map((c) => c.state);
}
