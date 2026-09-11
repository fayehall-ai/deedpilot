import "server-only";
import { and, desc, gte, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { runJobs, type RunJob } from "@/lib/db/schema";
import { enqueue } from "./queue";
import { cooldownSince, deskWeekday, isResearchDay } from "./research-day";
import { getPipelineConfig } from "./pipeline-settings";
import { scanStateCodes } from "@/lib/ai/scan-states";
import {
  dedupe,
  scanWindow,
  urgentRows,
  type ScoutRow,
  type StateReportResult,
} from "@/lib/ai/scout-report";

/**
 * Auction Scout report runs, carried on the existing job queue.
 *
 * One job per state, and the state is encoded in the `adapter` column as
 * `auction-scout:GA`. That column is free text with no foreign key, so this
 * needs no migration — and `inFlightFor` then guards each state separately,
 * which is the behaviour you want: pressing the button again while Georgia is
 * mid-flight should not start Georgia twice, but should not block Texas either.
 *
 * One job per state rather than one per report because a searched call runs
 * one to two minutes and the dispatcher leases for ten, with a 240-second
 * budget per tick. A whole nation in one job would lose its lease, be retried,
 * and spend the search budget three times over without ever finishing.
 */
export const SCOUT_PREFIX = "auction-scout:";

export const isScoutJob = (adapter: string): boolean => adapter.startsWith(SCOUT_PREFIX);
export const scoutState = (adapter: string): string => adapter.slice(SCOUT_PREFIX.length);
export const scoutAdapter = (state: string): string => `${SCOUT_PREFIX}${state.toUpperCase()}`;

/**
 * Priority for a research job — deliberately *below* every crawl.
 *
 * This was 20, above a hand-pressed adapter run (10), on the reasoning that
 * somebody is watching the console. That reasoning holds for one press and
 * fails as a standing policy: `claimNext` claims by priority, a searched call
 * runs one to two minutes, and the dispatcher's whole claiming budget is 195
 * seconds. Two research jobs therefore consumed an entire daily tick, and every
 * county crawl due that day got nothing.
 *
 * The ordering that matters is perishability. A listing crawl two days before a
 * sale cannot be done later — the auction happens without us. Discovery of a
 * county we have never crawled can always wait a day. So:
 *
 *     planScout tasks     0-115  (priorityOf: listing +50, +30-daysToSale, …)
 *     hand-pressed crawl     10
 *     research               5
 *     nightly sweep          0
 */
export const SCOUT_RESEARCH_PRIORITY = 5;

/**
 * Queue a full scan.
 */
export async function enqueueScoutReport(
  /** Omit to scan whatever the calendar currently justifies. */
  states?: readonly string[],
  requestedBy = "admin",
): Promise<{ queued: number; states: string[] }> {
  const wanted = (states ?? (await scanStateCodes())).map((s) => s.toUpperCase());
  const queued: string[] = [];
  for (const state of wanted) {
    await enqueue({ adapter: scoutAdapter(state), priority: SCOUT_RESEARCH_PRIORITY, requestedBy });
    queued.push(state);
  }
  return { queued: queued.length, states: queued };
}

export interface ScoutReportView {
  window: { start: string; end: string | null } | null;
  rows: ScoutRow[];
  urgent: ScoutRow[];
  states: {
    state: string;
    /** `not run` is not a job status — it is the absence of one, shown as its own thing. */
    status: RunJob["status"] | "not run";
    rows: number;
    countiesChecked: number;
    manualVerification: string[];
    noSaleFound: string[];
    searchCount: number;
    summary: string | null;
    error: string | null;
    finishedAt: Date | null;
  }[];
  citations: { url: string; title: string | null }[];
  totals: {
    rows: number;
    statesCovered: number;
    urgent: number;
    manualVerification: number;
    countiesChecked: number;
    pending: number;
    failed: number;
    /** Scannable states that have never been queued — coverage nobody has asked for yet. */
    notRun: number;
  };
}

/**
 * The most recent run of each state, assembled into one report.
 *
 * Latest-per-state rather than latest-batch on purpose: states finish across
 * different dispatcher ticks, and a strict batch view would show an empty
 * report for hours while the queue drained. This shows Georgia the moment
 * Georgia lands, with the rest still marked queued.
 */
export async function getScoutReport(): Promise<ScoutReportView> {
  /*
   * The scan set is resolved from the calendar, so it moves. A state that has
   * dropped out still has its last report in `run_jobs`; it simply stops being
   * listed as outstanding, which is correct — it is no longer work we intend
   * to do.
   */
  const scanStates = await scanStateCodes();
  const adapters = scanStates.map(scoutAdapter);
  const jobs = await db
    .select()
    .from(runJobs)
    .where(inArray(runJobs.adapter, adapters))
    .orderBy(desc(runJobs.createdAt))
    .limit(200);

  const latest = new Map<string, RunJob>();
  for (const job of jobs) if (!latest.has(job.adapter)) latest.set(job.adapter, job);

  const rows: ScoutRow[] = [];
  const citations = new Map<string, string | null>();
  const states: ScoutReportView["states"] = [];
  let window: { start: string; end: string | null } | null = null;
  let countiesChecked = 0;
  let pending = 0;
  let failed = 0;
  let notRun = 0;

  /*
   * Every scannable state appears, whether or not it has ever been queued.
   *
   * Building this list from the jobs that exist made the console read
   * "States covered 1 / 1" after a single Connecticut run — a national scan,
   * apparently complete, that had never looked at Georgia. A state nobody has
   * run is the most important row on the table, because it is the one holding
   * a gap nobody can see.
   */
  for (const state of scanStates.filter((s) => !latest.has(scoutAdapter(s)))) {
    states.push({
      state,
      status: "not run",
      rows: 0,
      countiesChecked: 0,
      manualVerification: [],
      noSaleFound: [],
      searchCount: 0,
      summary: null,
      error: null,
      finishedAt: null,
    });
    notRun += 1;
  }

  for (const [adapter, job] of latest) {
    const result = job.result as StateReportResult | null;
    const report = result?.report;
    if (result?.window) window ??= result.window;
    if (report?.rows) rows.push(...report.rows);
    for (const c of result?.citations ?? []) if (!citations.has(c.url)) citations.set(c.url, c.title);
    countiesChecked += report?.countiesChecked ?? 0;
    if (job.status === "queued" || job.status === "leased") pending += 1;
    if (job.status === "failed") failed += 1;

    states.push({
      state: scoutState(adapter),
      status: job.status,
      rows: report?.rows.length ?? 0,
      countiesChecked: report?.countiesChecked ?? 0,
      manualVerification: report?.manualVerification ?? [],
      noSaleFound: report?.noSaleFound ?? [],
      searchCount: result?.searchCount ?? 0,
      summary: report?.summary ?? null,
      error: job.lastError,
      finishedAt: job.finishedAt,
    });
  }

  // Deduped across states too: a sale posted by both a county and a statewide
  // list would otherwise be counted twice in the headline number.
  const deduped = dedupe(rows);
  states.sort((a, b) => a.state.localeCompare(b.state));

  return {
    window: window ?? scanWindow(),
    rows: deduped,
    urgent: urgentRows(deduped),
    states,
    citations: [...citations].map(([url, title]) => ({ url, title })),
    totals: {
      rows: deduped.length,
      statesCovered: new Set(deduped.map((r) => r.state)).size,
      urgent: urgentRows(deduped).length,
      /*
       * Rows that need checking PLUS counties a state flagged as unresolved.
       * Counting only rows reported "0 manual verification items" for a
       * Connecticut run that had named seven towns it could not confirm —
       * the finding was in the data and absent from the headline, which is
       * the one place it would have been read.
       */
      manualVerification:
        deduped.filter((r) => r.verification === "manual").length +
        states.reduce((n, s) => n + s.manualVerification.length, 0),
      countiesChecked,
      pending,
      failed,
      notRun,
    },
  };
}

/**
 * The standing weekly research pass.
 *
 * ## Why the day is checked at the desk, not in UTC
 *
 * The dispatcher tick is scheduled in UTC and the desk is Pacific. The cron now
 * fires at 09:00 UTC — 01:00-02:00 Pacific on the *same* calendar day — so the
 * two agree and Sunday means Sunday. That was not free: at the previous 02:00
 * UTC hour the tick landed at 18:00-19:00 Pacific the day before, and a UTC
 * day-of-week check would have queued the week's research every Saturday
 * evening. The check reads the desk zone regardless, so moving the cron hour
 * again cannot silently reintroduce it.
 *
 * ## Why four states and not sixteen
 *
 * A searched call runs one to two minutes and the dispatcher claims for 195
 * seconds a day. Sixteen states is roughly half an hour of model time — around
 * ten days of budget on the current plan, so a "weekly" full sweep would still
 * be draining when the next one queued. Four is what a week of leftover budget
 * actually absorbs, given research sits below every crawl at priority 5.
 *
 * They are the four with the most urgent gap rather than the next four
 * alphabetically: `backlogStates` ranks by soonest *upcoming* sale among
 * counties that have a crawl window open and no source, so the spend goes where
 * an auction is about to happen without us.
 *
 * Idempotent by construction — if any research job was created in the last six
 * days, this does nothing. The dispatcher may tick more than once a day, and
 * `enqueue` does not dedupe.
 */
export const WEEKLY_RESEARCH_STATES = 4;

export async function enqueueWeeklyResearch(now = new Date()): Promise<{
  ran: boolean;
  reason: string;
  states: string[];
}> {
  const config = await getPipelineConfig();
  if (!config.researchEnabled) {
    return { ran: false, reason: "research is switched off in pipeline settings", states: [] };
  }

  // Predicate lives in `./research-day`, which is pure and tested. The
  // UTC-versus-desk distinction is a whole day wide at the wrong cron hour.
  if (!isResearchDay(now, config.researchWeekday)) {
    return {
      ran: false,
      reason: `not ${config.researchWeekday} at the desk (${deskWeekday(now)})`,
      states: [],
    };
  }

  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runJobs)
    .where(
      and(
        like(runJobs.adapter, `${SCOUT_PREFIX}%`),
        gte(runJobs.createdAt, cooldownSince(now, config.researchCooldownDays)),
      ),
    );
  if ((recent?.n ?? 0) > 0) {
    return {
      ran: false,
      reason: `research already queued within the last ${config.researchCooldownDays} days`,
      states: [],
    };
  }

  const { backlogStates, buildPlan } = await import("./plan-jobs");
  const ranked = backlogStates(await buildPlan());
  if (ranked.length === 0) {
    return { ran: false, reason: "no state has an upcoming sale without a source", states: [] };
  }

  const states = ranked.slice(0, config.researchStates).map((s) => s.state);
  await enqueueScoutReport(states, "weekly");
  return { ran: true, reason: `queued ${states.length} state(s) by backlog urgency`, states };
}
