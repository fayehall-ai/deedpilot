/**
 * The dispatcher.
 *
 * Replaces the shell-out in `/api/cron/ingest`, which cannot work here: that
 * route runs `npm run ingest` through `exec`, and a Vercel function has no
 * `tsx`, no devDependencies and a read-only filesystem. The evidence is in the
 * data — `vercel.json` had declared a daily ingest for weeks and
 * `ingest_runs` contains **zero** rows at that hour. Every run on record came
 * from someone's terminal.
 *
 * This calls `runAdapter` in-process instead, one leased job at a time, and
 * stops before the function's own ceiling rather than being killed at it. A
 * job that outlives its slot simply loses its lease and is picked up by the
 * next tick, which is why the queue leases rather than assigns.
 *
 * ## Tick frequency
 *
 * `vercel.json` schedules this daily, because a Hobby account rejects any cron
 * that would run more than once a day — an every-ten-minutes expression fails the *build*,
 * not the run, so an over-frequent schedule takes the whole deployment down.
 *
 * One tick a day drains one function budget's worth of queue, which is enough
 * for the nightly sweep and not enough for anything interactive. The endpoint
 * is therefore also callable directly with the admin token, so a queued run
 * can be drained on demand from anywhere — an external scheduler, a terminal,
 * or a laptop — without waiting for 02:00. Raising the cadence properly means
 * a Pro plan.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAdapter } from "@/lib/ingest/adapters";
import { runAdapter } from "@/lib/ingest/runner";
import {
  claimNext,
  completeJob,
  enqueueDueSchedules,
  failJob,
  reapStuckRuns,
} from "@/lib/admin/queue";
import { tokenMatches } from "@/lib/admin/token";
import { loadPolicyOverrides } from "@/lib/admin/policy-load";
import { enqueueWeeklyResearch, isScoutJob, scoutState } from "@/lib/admin/scout-jobs";
import { enqueuePlan, planGaps } from "@/lib/admin/plan-jobs";
import { enqueueIntel, intelLotId, intelSource, isIntelJob } from "@/lib/admin/intel-jobs";
import { configuredSignalSources, enrichLotIntel } from "@/lib/property/signals";
import { getPipelineConfig } from "@/lib/admin/pipeline-settings";

/** Thrown to skip planning without logging it as a fault. */
class SkipPlanning extends Error {}
import { getScoutPrompt } from "@/lib/admin/scout-prompt";
import { scoutState as researchState } from "@/lib/ai/scout-report";

/*
 * Fluid Compute allows far longer than the old 60s ceiling. The budget below
 * stops well short of it so the handler returns a real summary instead of
 * being terminated mid-job.
 */
export const maxDuration = 300;

/** Stop claiming new work with this much of the budget left. */
const RESERVE_MS = 45_000;
const BUDGET_MS = 240_000;

function authorised(req: NextRequest): boolean {
  // Vercel's own scheduler identifies itself; anything else needs the token.
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return (
    tokenMatches(bearer) ||
    tokenMatches(req.nextUrl.searchParams.get("token")) ||
    // Legacy cron secret, so an existing schedule keeps working after deploy.
    (!!process.env.VERCEL_CRON_SECRET && bearer === process.env.VERCEL_CRON_SECRET)
  );
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const log: string[] = [];
  const done: unknown[] = [];

  /*
   * Housekeeping first and cheaply: resolve runs abandoned by dead processes,
   * then promote any schedules that have come due. Both are idempotent.
   */
  /* Operator policy overrides must be in memory before anything fetches. */
  const overrides = await loadPolicyOverrides();
  if (overrides > 0) log.push(`loaded ${overrides} policy override(s)`);

  const reaped = await reapStuckRuns(60);
  if (reaped > 0) log.push(`reaped ${reaped} abandoned ingest_runs`);
  const promoted = await enqueueDueSchedules();
  if (promoted > 0) log.push(`enqueued ${promoted} due schedule(s)`);

  /*
   * The calendar decides the day's crawl work.
   *
   * `run_schedules` sweeps an adapter's whole binding list regardless of when
   * its counties actually sell, and a `limit` on a large adapter permanently
   * starves its tail because `runAdapter` slices the first N bindings every
   * time. `enqueuePlan` instead asks which counties are inside a crawl window
   * today, and queues one job per county carrying the planner's own priority —
   * so a listing crawl three days from a sale (near 115) drains ahead of a
   * routine sweep (0) and ahead of research (5).
   *
   * Failure here must not take the tick down: draining whatever is already
   * queued is more valuable than planning, and a planner fault would otherwise
   * stop the pipeline entirely.
   */
  try {
    /*
     * Capped to what one tick can actually drain.
     *
     * Today's plan has 446 runnable counties. At a measured 3.0s median (p90
     * 8.1s) that is ~1,340 seconds of work against a 195-second daily claiming
     * budget, so enqueuing all of it would grow the queue by ~380 jobs a day
     * forever — `enqueue` does not dedupe across days.
     *
     * Tasks are priority-sorted, so a cap takes the most perishable work and
     * genuinely leaves the rest for tomorrow: a county crawled today falls out
     * of the next plan under its re-crawl interval (7d / 3d / 1d), so the queue
     * rotates rather than starving a fixed tail the way an adapter `limit` does.
     *
     * Raise this the moment the dispatcher ticks hourly.
     */
    const config = await getPipelineConfig();
    if (!config.crawlEnabled) {
      log.push("calendar crawling is switched off in pipeline settings");
      throw new SkipPlanning();
    }
    const planned = await enqueuePlan({ maxTasks: config.crawlMaxTasks });
    if (planned.enqueued > 0) {
      log.push(
        `planned ${planned.enqueued} county crawl(s) from the calendar` +
          (planned.alreadyQueued > 0 ? `, ${planned.alreadyQueued} already in flight` : ""),
      );
    }
    const gaps = planGaps(planned.plan);
    if (gaps.no_source) log.push(`${gaps.no_source} county/counties due with no verified source`);

    /*
     * The weekly research pass, on the Sunday tick.
     *
     * Queued after the plan and at priority 5, so it can only ever consume
     * budget the day's county crawls did not want. Research that outranked a
     * near-sale listing crawl is the exact inversion that made two searched
     * calls eat an entire tick.
     */
    const weekly = await enqueueWeeklyResearch();
    if (weekly.ran) log.push(`weekly research queued: ${weekly.states.join(", ")}`);

    /*
     * Site intel last and at the lowest priority in the queue, so it can only
     * ever consume budget the day's crawls and research did not want. A daily
     * tick enriches a handful of parcels against thousands; the long-running
     * worker in `scripts/intel-worker.ts` is what actually drains the backlog.
     */
    const intel = await enqueueIntel();
    if (intel.enqueued > 0) log.push(`queued ${intel.enqueued} site-intel fetch(es)`);
  } catch (e) {
    // A deliberate skip is not a failure; anything else is, and either way the
    // queue keeps draining because that is worth more than planning.
    if (!(e instanceof SkipPlanning)) {
      log.push(`plan failed (queue still draining): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  while (Date.now() - started < BUDGET_MS - RESERVE_MS) {
    const job = await claimNext();
    if (!job) break;

    /*
     * Auction Scout research runs, which are not adapters and have no county
     * to crawl — the state is carried in the job name. Handled before the
     * adapter lookup because `getAdapter` would reject them as unknown and
     * fail a job that is perfectly well formed.
     *
     * Errors are NOT swallowed into an empty report. A searched call that
     * cannot reach a browsing provider must fail the job loudly, because the
     * alternative is a report that looks complete and is simply blank for
     * that state — the one outcome nobody would think to question.
     */
    if (isScoutJob(job.adapter)) {
      const state = scoutState(job.adapter);
      try {
        // The edited brief, read per job rather than per tick, so a prompt
        // saved while the queue is draining takes effect on the next state.
        const { template } = await getScoutPrompt();
        const result = await researchState(state, { template });
        await completeJob(job.id, result as unknown as Record<string, unknown>);
        log.push(
          `${job.adapter}: ${result.report.rows.length} rows from ${result.searchCount} searches ` +
            `across ${result.report.countiesChecked} counties`,
        );
        done.push({ job: job.id, adapter: job.adapter, rows: result.report.rows.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await failJob(job.id, msg);
        log.push(`${job.adapter}: ${msg}`);
        done.push({ job: job.id, adapter: job.adapter, error: msg });
      }
      continue;
    }

    /*
     * Site-intel fetches, which are not adapters and have no county to crawl.
     * Handled before the adapter lookup for the same reason scout jobs are:
     * `getAdapter` would reject a perfectly well-formed job as unknown.
     */
    if (isIntelJob(job.adapter)) {
      const lotId = intelLotId(job.requestedBy);
      const source = intelSource(job.adapter);
      if (!lotId) {
        await failJob(job.id, `intel job carries no lot id: ${job.requestedBy}`);
        continue;
      }
      try {
        const sources = configuredSignalSources().filter((s) => s.name === source);
        const result = await enrichLotIntel(lotId, { sources });
        await completeJob(job.id, result as unknown as Record<string, unknown>);
        log.push(`${job.adapter}: ${result.totalSignals} signal(s) for ${lotId.slice(0, 8)}`);
        done.push({ job: job.id, adapter: job.adapter, signals: result.totalSignals });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await failJob(job.id, msg);
        log.push(`${job.adapter}: ${msg}`);
        done.push({ job: job.id, adapter: job.adapter, error: msg });
      }
      continue;
    }

    const adapter = getAdapter(job.adapter);
    if (!adapter) {
      await failJob(job.id, `unknown adapter: ${job.adapter}`);
      log.push(`${job.adapter}: unknown adapter`);
      continue;
    }

    try {
      const summary = await runAdapter(adapter, {
        countyFips: job.countyFips ?? undefined,
        limit: job.limit ?? undefined,
        dryRun: job.dryRun,
        onProgress: (m) => log.push(m),
      });
      await completeJob(job.id, {
        counties: summary.counties.length,
        ...summary.totals,
      });
      done.push({ job: job.id, adapter: job.adapter, lots: summary.totals.lots });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failJob(job.id, msg);
      log.push(`${job.adapter}: ${msg}`);
      done.push({ job: job.id, adapter: job.adapter, error: msg });
    }
  }

  return NextResponse.json({
    ok: true,
    reaped,
    promoted,
    processed: done.length,
    elapsedMs: Date.now() - started,
    done,
    log: log.slice(-60),
  });
}
