/**
 * The dispatcher.
 *
 * Replaces the shell-out in `/api/cron/ingest`, which cannot work here: that
 * route runs `npm run ingest` through `exec`, and a Vercel function has no
 * `tsx`, no devDependencies and a read-only filesystem. The evidence is in the
 * data — `vercel.json` has declared a 02:00 UTC daily ingest for weeks and
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

  while (Date.now() - started < BUDGET_MS - RESERVE_MS) {
    const job = await claimNext();
    if (!job) break;

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
