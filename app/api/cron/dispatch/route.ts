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
import {
  claimNext,
  enqueueDueSchedules,
  LANES,
  reapDeadJobs,
  reapStuckRuns,
} from "@/lib/admin/queue";
import { runQueuedJob } from "@/lib/admin/run-job";
import { cronAuthorised } from "@/lib/admin/cron-auth";
import { loadPolicyOverrides } from "@/lib/admin/policy-load";
import { enqueueWeeklyResearch } from "@/lib/admin/scout-jobs";
import { enqueuePlan, planGaps } from "@/lib/admin/plan-jobs";
import { enqueueIntel } from "@/lib/admin/intel-jobs";
import { getPipelineConfig } from "@/lib/admin/pipeline-settings";
import { primeCountySources } from "@/lib/ingest/county-sources";
import { foldSupersededImports } from "@/lib/import/reconcile";

/** Thrown to skip planning without logging it as a fault. */
class SkipPlanning extends Error {}

/*
 * The claiming budget below is what paces the dispatcher; this ceiling is only
 * how long the last job it claimed may run. At 300 seconds a county claimed at
 * 190 had under two minutes, and a large list — a PDF of 800 parcels through
 * the model — was killed partway and left as "abandoned": Vigo and Greene,
 * Indiana, a thousand parcels between them, never landed. 800 is the same
 * ceiling the CAPE worker runs under; the claiming budget is unchanged, so
 * ticks do not pile up.
 */
export const maxDuration = 800;

/** Stop claiming new work with this much of the budget left. */
const RESERVE_MS = 45_000;
const BUDGET_MS = 240_000;

function authorised(req: NextRequest): boolean {
  if (cronAuthorised(req)) return true;
  // Legacy cron secret, so an existing schedule keeps working after deploy.
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  return !!process.env.VERCEL_CRON_SECRET && bearer === process.env.VERCEL_CRON_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const log: string[] = [];
  const done: unknown[] = [];
  /*
   * `?drain=1`: the Sunday CAPE run. Plan nothing — no due schedules, no
   * calendar crawl, no research, no site intel — and claim only county crawls,
   * so the tick reads the lists the Auction Scout workbook just queued and
   * nothing else.
   */
  const drainOnly = req.nextUrl.searchParams.get("drain") === "1";

  /*
   * Housekeeping first and cheaply: resolve runs abandoned by dead processes,
   * then promote any schedules that have come due. Both are idempotent.
   */
  /* Operator policy overrides must be in memory before anything fetches. */
  const overrides = await loadPolicyOverrides();
  if (overrides > 0) log.push(`loaded ${overrides} policy override(s)`);

  const reaped = await reapStuckRuns(60);
  if (reaped > 0) log.push(`reaped ${reaped} abandoned ingest_runs`);
  const dead = await reapDeadJobs();
  if (dead > 0) log.push(`retired ${dead} job(s) whose worker died on every attempt`);
  /* List pages the Auction Scout found, laid over the committed registry. */
  await primeCountySources();
  const promoted = drainOnly ? 0 : await enqueueDueSchedules();
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
    if (drainOnly) throw new SkipPlanning();
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
    const job = await claimNext(new Date(), drainOnly ? LANES.crawl : LANES.dispatch);
    if (!job) break;
    const outcome = await runQueuedJob(job, { onProgress: (m) => log.push(m) });
    log.push(outcome.line);
    done.push({ job: outcome.job, adapter: outcome.adapter, ...outcome.detail });
  }

  /*
   * Merge announcements into the crawls that superseded them — an imported or
   * Scout sale and the crawl that found its parcels, same county, same day.
   * Cheap, idempotent, and it used to run only at the end of the terminal
   * drain, so in production the two rows sat side by side indefinitely.
   */
  try {
    const fold = await foldSupersededImports();
    if (fold.folded) log.push(`folded ${fold.folded} announcement(s) into their crawls`);
  } catch (e) {
    log.push(`fold failed: ${e instanceof Error ? e.message : String(e)}`);
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
