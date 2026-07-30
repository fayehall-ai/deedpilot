/**
 * Scout scheduling — decide which counties to crawl today, and in what order.
 *
 * The existing runner takes an adapter and sweeps every county that adapter
 * serves. That is the right shape for debugging one source and the wrong shape
 * for national coverage: it re-fetches counties whose sale is eight months away
 * and ignores whether anything is actually happening.
 *
 * This module inverts the loop. The calendar says which counties are inside a
 * crawl window today; the registry says where their source of record is; the
 * adapter index says whether we can parse it. What comes out is a ranked work
 * queue plus an explicit account of everything skipped and why — because the
 * skipped list is the coverage backlog, and it is only useful if it is visible.
 *
 * Planning is pure. Every input is passed in, so the plan can be inspected and
 * tested without a database, a network, or a clock.
 */

import { crawlsDueOn, type CrawlKind, type ScheduleConfidence } from "../atlas/calendar";
import type { SourceRegistry } from "../prospector/types";

/** A county the Scout can actually crawl right now. */
export interface ScoutTask {
  fips: string;
  state: string;
  kind: CrawlKind;
  saleDate: string;
  confidence: ScheduleConfidence;
  /** Adapter that serves this county, or null when none does. */
  adapter: string | null;
  /** Verified source URL from the registry, when known. */
  sourceUrl: string | null;
  /** Higher runs first. */
  priority: number;
  reason: string;
}

export type SkipReason =
  | "no_adapter"
  | "no_source"
  | "backed_off"
  | "recently_crawled";

export interface SkippedCounty {
  fips: string;
  state: string;
  kind: CrawlKind;
  saleDate: string;
  reason: SkipReason;
  detail: string;
}

export interface ScoutPlan {
  /** YYYY-MM-DD the plan was built for. */
  date: string;
  tasks: ScoutTask[];
  skipped: SkippedCounty[];
  coverage: {
    dueToday: number;
    runnable: number;
    noAdapter: number;
    noSource: number;
    backedOff: number;
    recentlyCrawled: number;
  };
}

/** Operational health per county, derived from recent ingest runs. */
export interface CountyHealth {
  consecutiveFailures: number;
  /** YYYY-MM-DD of the last attempt, successful or not. */
  lastAttempt: string | null;
}

/**
 * Days to wait after N consecutive failures.
 *
 * A county source that has moved or died should not be re-fetched every cycle
 * forever — that is rude to a government server and buries real failures in
 * noise. Doubling, capped at 30 days so a fixed source recovers within a month
 * without anyone intervening.
 */
export function backoffDays(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(30, 2 ** (consecutiveFailures - 1));
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/** Is this county still inside its backoff window on `date`? */
export function isBackedOff(health: CountyHealth | undefined, date: string): boolean {
  if (!health?.lastAttempt || health.consecutiveFailures <= 0) return false;
  return daysBetween(health.lastAttempt, date) < backoffDays(health.consecutiveFailures);
}

/**
 * How long to wait before re-crawling a county inside an open window.
 *
 * Being *in* a crawl window is not a reason to fetch daily. A Texas listing
 * posts 21 days before the sale and then barely changes until bidders start
 * withdrawing parcels near the end, so re-fetching it every morning is 21
 * requests to learn what 3 would have told us. This is where the real saving
 * lives — window membership alone only buys 2-3x over blind polling.
 *
 * Tightens as the sale approaches, because that is when parcels actually get
 * pulled for late payment and the list stops being stable.
 */
export function recrawlIntervalDays(daysToSale: number, kind: CrawlKind): number {
  if (kind === "results") return 7;
  if (daysToSale <= 3) return 1;
  if (daysToSale <= 10) return 3;
  return 7;
}

/**
 * Rank a task.
 *
 * A listing crawl close to the sale is the most perishable thing the system
 * does — miss that window and the auction happens without us. Everything else
 * is recoverable later, so it ranks below.
 */
export function priorityOf(t: {
  kind: CrawlKind;
  confidence: ScheduleConfidence;
  saleDate: string;
  date: string;
  hasAdapter: boolean;
}): number {
  let p = 0;
  if (t.kind === "listing") p += 50;
  const daysToSale = daysBetween(t.date, t.saleDate);
  // Closer to the sale is more urgent, but only for listings — a results crawl
  // gets better with a little age, not worse.
  if (t.kind === "listing" && daysToSale >= 0) p += Math.max(0, 30 - daysToSale);
  if (t.confidence === "statutory") p += 20;
  else if (t.confidence === "typical") p += 10;
  if (t.hasAdapter) p += 15;
  return p;
}

export interface PlanInputs {
  /** Counties the Scout is responsible for. */
  fipsList: readonly string[];
  /** county FIPS → adapter name. Counties absent from this map have no parser. */
  adapterByCounty: Record<string, string>;
  /** county FIPS → verified source URL, from the Prospector registry. */
  sourceByCounty: Record<string, string>;
  /** county FIPS → recent run health. */
  healthByCounty?: Record<string, CountyHealth>;
  on?: Date;
  /** Cap the queue; the remainder stays due tomorrow. */
  maxTasks?: number;
}

/**
 * Build today's work queue.
 *
 * A county with no adapter is *not* dropped silently: it is skipped with its
 * source URL attached, which turns the coverage gap into an actionable list of
 * "here is a live source we cannot yet parse".
 */
export function planScout(inputs: PlanInputs): ScoutPlan {
  const on = inputs.on ?? new Date();
  const date = on.toISOString().slice(0, 10);
  const health = inputs.healthByCounty ?? {};

  const due = crawlsDueOn(inputs.fipsList, on);
  const tasks: ScoutTask[] = [];
  const skipped: SkippedCounty[] = [];

  for (const d of due) {
    const adapter = inputs.adapterByCounty[d.fips] ?? null;
    const sourceUrl = inputs.sourceByCounty[d.fips] ?? null;
    const h = health[d.fips];
    const base = { fips: d.fips, state: d.state, kind: d.kind, saleDate: d.saleDate };

    // Backoff is checked before the re-crawl interval on purpose. Both would
    // suppress the fetch, but "this source has failed five times" is the signal
    // someone needs to act on, and reporting it as a routine re-crawl skip would
    // bury a broken county in ordinary scheduling noise.
    if (isBackedOff(h, date)) {
      skipped.push({
        ...base,
        reason: "backed_off",
        detail: `${h!.consecutiveFailures} consecutive failures; waiting ${backoffDays(
          h!.consecutiveFailures,
        )}d from ${h!.lastAttempt}`,
      });
      continue;
    }
    const daysToSale = daysBetween(date, d.saleDate);
    const interval = recrawlIntervalDays(daysToSale, d.kind);
    if (h?.lastAttempt && daysBetween(h.lastAttempt, date) < interval) {
      skipped.push({
        ...base,
        reason: "recently_crawled",
        detail: `crawled ${h.lastAttempt}; re-crawl interval ${interval}d at ${daysToSale}d from sale`,
      });
      continue;
    }
    if (!adapter && !sourceUrl) {
      skipped.push({
        ...base,
        reason: "no_source",
        detail: "no adapter and no verified source — run the Prospector for this county",
      });
      continue;
    }
    if (!adapter) {
      skipped.push({
        ...base,
        reason: "no_adapter",
        detail: `source known but unparsed: ${sourceUrl}`,
      });
      continue;
    }

    tasks.push({
      ...base,
      confidence: d.confidence,
      adapter,
      sourceUrl,
      priority: priorityOf({
        kind: d.kind,
        confidence: d.confidence,
        saleDate: d.saleDate,
        date,
        hasAdapter: true,
      }),
      reason:
        d.kind === "listing"
          ? `listing window, sale ${d.saleDate}`
          : `results window, sale ${d.saleDate}`,
    });
  }

  tasks.sort((a, b) => b.priority - a.priority || a.fips.localeCompare(b.fips));
  const capped = inputs.maxTasks ? tasks.slice(0, inputs.maxTasks) : tasks;

  const count = (r: SkipReason) => skipped.filter((s) => s.reason === r).length;
  return {
    date,
    tasks: capped,
    skipped,
    coverage: {
      dueToday: due.length,
      runnable: capped.length,
      noAdapter: count("no_adapter"),
      noSource: count("no_source"),
      backedOff: count("backed_off"),
      recentlyCrawled: count("recently_crawled"),
    },
  };
}

/**
 * Counties with a live verified source and no adapter to parse it.
 *
 * This is the adapter backlog, ordered by how often it costs a missed sale.
 * The Georgia adapter — a per-county registry with HTML parsing and LLM PDF
 * transcription — is the template for clearing it, and the pieces it would need
 * per state now exist: `resolveCountyRule` supplies sale type and redemption,
 * `resolveSaleSchedule` supplies the timing.
 */
export function adapterBacklog(plan: ScoutPlan): { fips: string; state: string; url: string }[] {
  const seen = new Set<string>();
  const out: { fips: string; state: string; url: string }[] = [];
  for (const s of plan.skipped) {
    if (s.reason !== "no_adapter" || seen.has(s.fips)) continue;
    seen.add(s.fips);
    const url = s.detail.replace("source known but unparsed: ", "");
    out.push({ fips: s.fips, state: s.state, url });
  }
  return out;
}

/**
 * Flatten a Prospector registry into county → best source URL.
 *
 * Prefers a government listing page, then any government page, then whatever is
 * left — the same source-of-record precedence the Prospector ranks by, so the
 * Scout cannot end up crawling a vendor the Prospector deliberately outranked.
 */
export function sourceIndexFromRegistry(registry: SourceRegistry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [fips, entry] of Object.entries(registry.counties)) {
    const preferred =
      entry.sources.find((s) => s.isGovernment && s.kind === "listing") ??
      entry.sources.find((s) => s.isGovernment) ??
      entry.sources[0];
    if (preferred) out[fips] = preferred.url;
  }
  return out;
}

/** Minimal shape `healthFromResults` needs — avoids depending on the runner. */
export interface RunOutcome {
  countyFips: string;
  status: "ok" | "partial" | "failed" | "blocked";
}

/**
 * Fold run outcomes into the health map the next plan backs off from.
 *
 * A blocked county is not a failure. Policy blocks are permanent and expected,
 * and backing off from them would only delay the day someone notices the county
 * needs a data agreement or a government alternative.
 */
export function healthFromResults(
  prior: Record<string, CountyHealth>,
  results: readonly RunOutcome[],
  date: string,
): Record<string, CountyHealth> {
  const next: Record<string, CountyHealth> = { ...prior };
  for (const r of results) {
    if (r.status === "blocked") continue;
    const failed = r.status === "failed";
    next[r.countyFips] = {
      consecutiveFailures: failed ? (prior[r.countyFips]?.consecutiveFailures ?? 0) + 1 : 0,
      lastAttempt: date,
    };
  }
  return next;
}
