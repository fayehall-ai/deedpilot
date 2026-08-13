import "server-only";
import { z } from "zod";
import { runSearched, type Citation } from "./providers";

/**
 * The Auction Scout report — one state's upcoming sales, read off the live web.
 *
 * This is a research pass, not a crawl. The ingest pipeline in `lib/ingest`
 * fetches sources we have already found and written a parser for; this looks
 * for the ones we have not, across every platform and county page a sale might
 * be posted on, and hands back rows a person can act on or hand to a parser.
 *
 * Two rules shape everything below, and both come from the same place — the
 * only thing that makes a report of this kind worth anything is that the dates
 * are real.
 *
 * 1. Every row must carry a URL the model actually fetched. A row without a
 *    source is not a lead, it is a sentence that looks like one.
 * 2. A county with no public list posted is reported AS a county with no public
 *    list posted. "Manual verification required" is a finding. An invented PDF
 *    link is a wasted morning at best and a missed sale at worst.
 *
 * Scoped one state per call because the dispatcher leases a job for minutes,
 * not hours, and a searched call runs one to two minutes on its own. A state
 * fits; a nation does not.
 */

/** Sale kinds worth reporting, in the words counties actually use. */
export const SALE_KINDS = [
  "tax deed",
  "redeemable tax deed",
  "tax foreclosure",
  "sheriff tax sale",
  "tax commissioner sale",
  "county tax auction",
] as const;

/**
 * States scanned by default, priority order.
 *
 * The first five are scanned county by county rather than by exception —
 * they are where the volume is, and a missed Georgia sale costs more than a
 * missed one anywhere else on this list.
 */
export const PRIORITY_STATES = ["GA", "TX", "CA", "FL", "OH"] as const;
export const SCAN_STATES = [
  ...PRIORITY_STATES,
  "PA", "CT", "NC", "AR", "CO", "MN", "MO", "OK", "AK", "KS", "WI",
  /*
   * MI and NY are here because their hubs were already written and were being
   * sent nowhere: `STATE_HUBS` had 18 keys against 16 scanned states, so the
   * tax-sale.info entry covering seventy-plus Michigan counties and the
   * AAR/NYSAuctions entry were dead weight. Both states publish upcoming county
   * auctions, which is the standing test for inclusion.
   */
  "MI", "NY",
] as const;

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
const STATE_HUBS: Record<string, string> = {
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

/**
 * Sources the report will not read.
 *
 * Social posts about tax sales are hearsay with a date attached. A live run
 * cited a Facebook group thread among its sources; nothing that reaches the
 * Source Log should be something a subscriber cannot verify.
 *
 * Paid aggregators are deliberately NOT on this list. They are read and cited
 * like any other source, and `officialSource` is what tells a subscriber which
 * kind of page a row came from — a label on the row rather than a hole in the
 * report. Note this governs only what the *report* reads: `lib/ingest/policy.ts`
 * separately keeps the crawler off hosts whose terms or robots.txt forbid it,
 * and that decision is unaffected by anything here.
 */
export const EXCLUDED_SOURCES = ["facebook.com", "reddit.com"] as const;

const RowSchema = z.object({
  county: z.string().describe("County or independent city, as the county itself writes it"),
  state: z.string().describe("Two-letter USPS code"),
  saleKind: z.string().describe(`One of: ${SALE_KINDS.join(", ")}`),
  saleDate: z.string().describe("YYYY-MM-DD. The date printed on the source page, never inferred"),
  saleTimeLocal: z.string().nullable().describe("Local start time as published, e.g. '10:00 AM ET'"),
  auctionFormat: z
    .string()
    .nullable()
    .describe("How it is run as published: 'Online', 'Live public auction', 'Sealed bid', 'In person at the courthouse'"),
  platform: z.string().nullable().describe("Bid4Assets, GovEase, RealAuction, Zeus, in person at the courthouse, etc."),
  platformLink: z.string().nullable().describe("The platform's own page for this sale, if it has one"),
  depositRules: z
    .string()
    .nullable()
    .describe("Deposit and payment terms as published — amount, form, and when it is due"),
  registrationDeadline: z.string().nullable().describe("YYYY-MM-DD if the page states one"),
  depositDeadline: z.string().nullable().describe("YYYY-MM-DD if the page states one"),
  countyListUrl: z
    .string()
    .nullable()
    .describe("Direct link to the county's own property list, catalog or PDF. Null if none is posted"),
  sourceUrl: z.string().describe("The page this row was actually read from"),
  officialSource: z
    .boolean()
    .describe("True only when sourceUrl is a .gov/county/sheriff/clerk page rather than a platform listing"),
  verification: z
    .enum(["confirmed", "manual"])
    .describe("'confirmed' only when sourceUrl states this county, this kind of sale, and this date"),
  notes: z.string().nullable().describe("Redemption cut-offs, registration rules, cancellations — what a bidder must know"),
});

export type ScoutRow = z.infer<typeof RowSchema>;

const StateReportSchema = z.object({
  rows: z.array(RowSchema),
  countiesChecked: z.number().describe("How many distinct counties were actually looked at"),
  noSaleFound: z
    .array(z.string())
    .describe("Counties checked whose official page states no sale, or posts none, in the window"),
  manualVerification: z
    .array(z.string())
    .describe("Counties where a sale is indicated but no public list or date could be confirmed"),
  summary: z.string().describe("Two or three sentences an operator can read in ten seconds"),
});

export type StateReport = z.infer<typeof StateReportSchema>;

const SYSTEM = `You are Auction Scout, a research analyst for a tax-deed investment desk.

You report only what you have READ on a page you fetched during this task. You
never answer from memory, never infer a sale date from a county's usual
schedule, and never construct a URL you did not visit. Your output is used to
plan travel and capital; a date that is wrong costs more than a date that is
missing.

When a county's official page says there is no sale, that is a finding worth
reporting. When you cannot confirm a sale, say so with 'manual' rather than
producing a plausible row. An empty result you can defend beats a full one you
cannot.`;

/**
 * The scan window: everything from today onward, with no end date.
 *
 * There used to be an 8-week ceiling here. It structurally hid the sales that
 * are hardest to find and easiest to plan for — Oklahoma's June resale,
 * Missouri's August collector sales, Colorado's annual lien auction, Arizona's
 * February — none of which enter an 8-week view until it is nearly too late to
 * raise capital for them. A sale announced in March for August is exactly the
 * lead this desk wants first, not last.
 *
 * `end` is kept as an optional bound rather than deleted so a caller can still
 * scope a run deliberately; the default is unbounded.
 *
 * The lower bound stays and is computed here rather than described to the
 * model, because "upcoming" is the kind of thing a model gets subtly wrong and
 * the failure is silent. A probe of this API, asked for an upcoming sale,
 * returned one from the previous March in a format that looked entirely
 * correct.
 */
export function scanWindow(from: Date = new Date()): { start: string; end: string | null } {
  return { start: new Date(from).toISOString().slice(0, 10), end: null };
}

/**
 * The standing brief, and the default the console loads into its editor.
 *
 * This is the desk's own Auction Scout instruction, kept in its own words
 * rather than paraphrased — it is what the report is graded against, so
 * rewriting it into something tidier would quietly change the product. The
 * placeholders are the only thing added: `{{STATE}}`, `{{START}}`, `{{END}}`,
 * `{{HUB}}` and `{{COUNTY_SCOPE}}` are filled per run.
 *
 * Editable at /admin, stored in `scout_prompts`. Change it there, not here.
 */
export const DEFAULT_SCOUT_PROMPT = `Search for all upcoming U.S. tax deed, redeemable tax deed, tax foreclosure, sheriff tax sale, tax commissioner sale, and county tax auction sales in {{STATE}} scheduled on or after {{START}}. {{END}}

TODAY IS {{START}}. A sale dated before today is not upcoming — leave it out even if the page presents it prominently. There is no upper limit: a sale eight months out is as reportable as one next week, and an annual sale posted far ahead is the most valuable thing you can find, because it is the one there is still time to prepare for.

Check public auction platforms, county tax collector/commissioner/treasurer pages, sheriff sale pages, clerk/legal notice pages, county PDFs, official auction catalogs, Bid4Assets, GovEase, RealAuction, RealTaxDeed, RealForeclose, ZeusAuction, Grant Street / DeedAuction / MyTaxSale, the Arkansas Commissioner of State Lands (COSL), Tax-Sale.info, AAR Auctions / NYSAuctions, AMSTax, and any other public county or state auction portal.

HOW TO WORK, IN THIS ORDER — this matters more than anything else here.

1. FIND THE LIST BEFORE YOU FIND THE COUNTIES. Most states publish their sales in bulk somewhere: a state agency catalog, a law firm handling many counties, or a platform carrying a whole state's calendar. One such page is worth thirty county-by-county searches.
   {{HUB}}

2. ENUMERATE IT COMPLETELY. When a hub lists twenty counties with dates from today onward, that is TWENTY ROWS, one per county — not one row for the hub and not a summary sentence. Read the whole list, including later pages of it. Under-reporting a list you already have open is the most expensive mistake available here.

3. THEN FILL THE GAPS county by county, prioritising populous counties and any the hub did not cover.

{{COUNTY_SCOPE}}

FOR EVERY ROW
- Include county-level public source links wherever possible. If a county has a public PDF, sale list, property catalog, or auction file, include the direct link in countyListUrl. An official statewide or multi-county catalog that covers this county counts as its list — link that. A county HOMEPAGE does not, and neither does a link you have constructed rather than opened. If no list is posted anywhere, set countyListUrl null and set verification 'manual' — that is the "Manual verification required" marking.
- saleDate must be printed on the page you cite. A page saying "first Tuesday monthly" without naming a date is verification 'manual', not a date you work out.
- Prefer the most official county-level source when one is available, and set officialSource accordingly.
- Remove duplicate entries: one row per county per sale date, keeping the most official source.

DEPTH PER ROW — a row with a date and nothing else is half a row. From the page you are already on, capture the auction format (online, live, sealed bid), the platform and its link, registration and deposit deadlines, deposit and payment terms, and anything a bidder would be caught out by: redemption cut-offs, registration closing early, deposits due days before, sales that were cancelled. Put that last kind in notes. Aim for 25 or more rows where the state has them.

Cite whatever source you actually read, including private aggregators — but prefer the county or state page when one carries the same sale, and set officialSource so the reader can tell which is which. Every row must be cited to a page a subscriber can open.

Return the rows, the counties you checked, the ones with no sale, the ones needing manual verification, and a short summary.`;

/**
 * Fill the per-run placeholders. Unknown placeholders are left alone.
 *
 * `{{END}}` is now a whole sentence rather than a date, because the default run
 * has no end date. A stored brief written against the old placeholder still
 * renders as prose that says so, instead of leaving a bare dangling "to".
 */
export function renderPrompt(
  template: string,
  vars: { state: string; start: string; end: string | null; hub: string; countyScope: string },
): string {
  const end = vars.end
    ? `Report only sales dated on or before ${vars.end}.`
    : "There is no end date — report every upcoming sale, however far out it is scheduled.";
  return template
    .replaceAll("{{STATE}}", vars.state)
    .replaceAll("{{START}}", vars.start)
    .replaceAll("{{END}}", end)
    .replaceAll("{{HUB}}", vars.hub)
    .replaceAll("{{COUNTY_SCOPE}}", vars.countyScope);
}

export interface StateReportResult {
  state: string;
  /** `end` is null on an unbounded run, which is the default. */
  window: { start: string; end: string | null };
  report: StateReport;
  citations: Citation[];
  searchCount: number;
  model: string;
  generatedAt: string;
}

/**
 * Research one state.
 *
 * Rows dated before today are dropped here rather than trusted, because "only
 * upcoming sales" is the instruction most likely to be quietly disobeyed — and
 * a stale date is indistinguishable from a fresh one once it is in a
 * spreadsheet. There is no upper bound unless a caller passes one.
 */
export async function scoutState(
  state: string,
  opts: {
    window?: { start: string; end: string | null };
    maxTokens?: number;
    /** The edited brief from the console. Falls back to the built-in one. */
    template?: string | null;
  } = {},
): Promise<StateReportResult> {
  const window = opts.window ?? scanWindow();
  const everyCounty = (PRIORITY_STATES as readonly string[]).includes(state);

  const countyScope = everyCounty
    ? `${state} is a priority state and is scanned county by county: after the hub, keep going until you have either a row or an explicit "no sale" for every county you can reach. Report how many you reached in countiesChecked and name the empty ones in noSaleFound, so "checked, nothing there" never looks like "never looked".`
    : `Report how many counties you reached in countiesChecked and name the empty ones in noSaleFound.`;

  const prompt = renderPrompt(opts.template?.trim() || DEFAULT_SCOUT_PROMPT, {
    state,
    start: window.start,
    end: window.end,
    hub:
      STATE_HUBS[state] ??
      "Look for a statewide agency catalog, a multi-county law-firm sale notice page, or a platform calendar covering this state.",
    countyScope,
  });

  const result = await runSearched({
    system: SYSTEM,
    prompt,
    schema: StateReportSchema,
    schemaName: "auction_scout_state_report",
    /*
     * Room for a full enumeration. A hub state answers with forty-odd rows and
     * every detail column filled; at the old ceiling that reply is truncated,
     * which surfaces as "no final message" rather than as a short report — so
     * the failure would look like an outage instead of a budget.
     */
    maxTokens: opts.maxTokens ?? 100_000,
    excludedDomains: [...EXCLUDED_SOURCES],
  });

  const inWindow = result.data.rows.filter((r) => {
    const d = String(r.saleDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < window.start) return false;
    return window.end === null || d <= window.end;
  });

  return {
    state,
    window,
    report: { ...result.data, rows: dedupe(inWindow) },
    citations: result.citations,
    searchCount: result.searchCount,
    model: result.model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * One row per county per sale date, official source winning ties.
 *
 * The same sale is commonly posted by the county, the sheriff and the platform,
 * and three rows for one auction is the fastest way to make a report look
 * bigger and be worth less.
 */
export function dedupe(rows: ScoutRow[]): ScoutRow[] {
  const best = new Map<string, ScoutRow>();
  for (const row of rows) {
    const key = `${row.state}|${row.county.trim().toLowerCase()}|${row.saleDate}`;
    const held = best.get(key);
    if (!held) {
      best.set(key, row);
      continue;
    }
    const better =
      (row.officialSource ? 2 : 0) + (row.countyListUrl ? 1 : 0) >
      (held.officialSource ? 2 : 0) + (held.countyListUrl ? 1 : 0);
    if (better) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => a.saleDate.localeCompare(b.saleDate) || a.county.localeCompare(b.county));
}

/**
 * How the workbook grades a row, and the thresholds are the workbook's own:
 * its Summary tab counts "Urgent Deadlines (<=7 days)". Derived in code rather
 * than asked of the model — same division of labour the rest of this codebase
 * keeps, where the model reports what is printed and code does the arithmetic.
 */
export const URGENT_DAYS = 7;
export const NEAR_TERM_DAYS = 21;

/** Whole days from `from` to the row's soonest deadline. Negative means passed. */
export function daysOut(row: ScoutRow, from: Date = new Date()): number {
  const today = from.toISOString().slice(0, 10);
  const dates = [row.registrationDeadline, row.depositDeadline, row.saleDate]
    .filter((d): d is string => d !== null && d >= today)
    .sort();
  const soonest = dates[0] ?? row.saleDate;
  const ms = Date.parse(`${soonest}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
}

export type Priority = "Urgent" | "Near-term" | "Watchlist";

export function priorityOf(row: ScoutRow, from: Date = new Date()): Priority {
  const d = daysOut(row, from);
  if (d <= URGENT_DAYS) return "Urgent";
  if (d <= NEAR_TERM_DAYS) return "Near-term";
  return "Watchlist";
}

/** The workbook's Status column, in its own words. */
export function statusOf(row: ScoutRow): string {
  if (row.verification !== "confirmed") return "Manual verification required";
  return row.officialSource ? "Verified public source" : "Verified — platform source";
}

/** Rows inside the urgent threshold — what an operator has to act on now. */
export function urgentRows(rows: ScoutRow[], from: Date = new Date()): ScoutRow[] {
  return rows.filter((r) => daysOut(r, from) <= URGENT_DAYS);
}
