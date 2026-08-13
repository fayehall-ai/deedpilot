/*
 * No `server-only` guard, matching `lib/admin/queue.ts` and `lib/ingest/runner.ts`
 * rather than the console-facing modules. The planner is genuinely useful from a
 * terminal — inspecting today's queue before it runs is the main way to tell
 * whether the calendar is doing something sensible — and `server-only` throws
 * under plain tsx.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { runJobs } from "@/lib/db/schema";
import { ALL_COUNTIES } from "@/lib/atlas";
import { loadRegistry } from "@/lib/ingest/adapters/generic";
import { planScoutRun, type CountyHealth, type ScoutPlan } from "@/lib/scout";
import { enqueue } from "./queue";
import { asDeskDay, deskDate } from "../desk-time";

/**
 * Turn the crawl calendar into queued work.
 *
 * `lib/scout/` has held a tested, calendar-driven planner since it was written
 * and has been imported by exactly one CLI script. What actually runs in
 * production is `run_schedules` firing adapter-wide sweeps, which re-fetch
 * counties whose sale is eight months away — precisely the shape the planner
 * was built to replace, and precisely why a `limit` on a big adapter starves
 * its tail: `runAdapter` slices the *first* N bindings every time.
 *
 * This is the missing wire. Once a day the plan is built and its tasks become
 * `run_jobs` rows, one per county, carrying the planner's own priority. The
 * dispatcher then drains them highest-first, so a listing crawl three days from
 * a sale outranks a routine sweep instead of queuing behind it.
 *
 * ## Why per-county jobs rather than one job per adapter
 *
 * A county is the unit that fits inside a function invocation — measured median
 * 3.0s, p90 8.1s — and it is the unit `runAdapter` already accepts via
 * `countyFips`. One job per county means a slow county costs its own lease
 * rather than the whole adapter's, and the queue can be drained in any order.
 */

/** Recent health per county, so the planner can back off from failing sources. */
export async function countyHealth(): Promise<Record<string, CountyHealth>> {
  /*
   * Derived from `ingest_runs` rather than stored, so it cannot drift from what
   * actually happened. `blocked` is excluded from the failure count on purpose —
   * a policy block is permanent and expected, and backing off from it would only
   * delay the day someone notices the county needs an agreement.
   */
  const rows = (await db.execute(sql`
    WITH ordered AS (
      SELECT county_fips,
             status,
             started_at,
             row_number() OVER (PARTITION BY county_fips ORDER BY started_at DESC) AS rn
      FROM ingest_runs
      WHERE county_fips IS NOT NULL AND status <> 'running'
    )
    SELECT county_fips,
           max(started_at) FILTER (WHERE rn = 1) AS last_attempt,
           count(*) FILTER (
             WHERE status = 'failed'
               AND rn <= (
                 SELECT coalesce(min(rn), 999) FROM ordered o2
                 WHERE o2.county_fips = ordered.county_fips AND o2.status = 'ok'
               ) - 1
           )::int AS consecutive_failures
    FROM ordered
    GROUP BY county_fips
  `)) as unknown as { county_fips: string; last_attempt: Date | null; consecutive_failures: number }[];

  const out: Record<string, CountyHealth> = {};
  for (const r of rows) {
    out[r.county_fips] = {
      consecutiveFailures: r.consecutive_failures ?? 0,
      // Desk day, because `planScout` compares this to `plan.date`.
      lastAttempt: r.last_attempt ? deskDate(new Date(r.last_attempt)) : null,
    };
  }
  return out;
}

/**
 * Build today's plan without writing anything.
 *
 * "Today" is the desk's calendar day, not the server's. `crawlsDueOn` derives
 * its day from `toISOString()`, so an unshifted `new Date()` run by hand at 6pm
 * Pacific would plan against *tomorrow* — comparing a US sale date to a UTC day
 * that has already rolled over, and skipping a county whose window closes today.
 */
export async function buildPlan(opts: { maxTasks?: number; on?: Date } = {}): Promise<ScoutPlan> {
  return planScoutRun({
    fipsList: ALL_COUNTIES.map((c) => c.fips),
    registry: loadRegistry() ?? undefined,
    healthByCounty: await countyHealth(),
    on: asDeskDay(opts.on),
    maxTasks: opts.maxTasks,
  });
}

export interface PlanEnqueueResult {
  planned: number;
  enqueued: number;
  alreadyQueued: number;
  plan: ScoutPlan;
}

/**
 * Enqueue today's plan.
 *
 * Idempotent within a day. `enqueueDueSchedules` has no such guard and would
 * happily queue the same adapter every tick — with an hourly dispatcher that
 * becomes unbounded growth, so this checks for live work per county before
 * adding any. A county already queued or leased is skipped, not duplicated.
 */
export async function enqueuePlan(opts: { maxTasks?: number; on?: Date } = {}): Promise<PlanEnqueueResult> {
  const plan = await buildPlan(opts);
  if (plan.tasks.length === 0) {
    return { planned: 0, enqueued: 0, alreadyQueued: 0, plan };
  }

  const fipsList = plan.tasks.map((t) => t.fips);
  const live = await db
    .select({ countyFips: runJobs.countyFips })
    .from(runJobs)
    .where(
      and(
        inArray(runJobs.status, ["queued", "leased"]),
        inArray(runJobs.countyFips, fipsList),
      ),
    );
  const busy = new Set(live.map((r) => r.countyFips).filter(Boolean) as string[]);

  let enqueued = 0;
  for (const task of plan.tasks) {
    if (busy.has(task.fips)) continue;
    await enqueue({
      adapter: task.adapter!,
      countyFips: task.fips,
      // The planner's own score. Listing +50, plus up to 30 for closeness to the
      // sale, plus 20 statutory / 10 typical, plus 15 for having a parser — so a
      // sale three days out lands near 115 and a distant results crawl near 0.
      priority: task.priority,
      requestedBy: "plan",
    });
    enqueued++;
  }

  return { planned: plan.tasks.length, enqueued, alreadyQueued: plan.tasks.length - enqueued, plan };
}

/** Counties the plan wanted and could not run, grouped for the console. */
export function planGaps(plan: ScoutPlan): Record<string, number> {
  return plan.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] ?? 0) + 1;
    return acc;
  }, {});
}

/** Clear plan-created jobs that are still queued, for a clean re-plan. */
export async function clearPlanQueue(): Promise<number> {
  const cleared = await db
    .update(runJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(runJobs.requestedBy, "plan"), eq(runJobs.status, "queued")))
    .returning({ id: runJobs.id });
  return cleared.length;
}

export interface BacklogState {
  state: string;
  /** Counties due for a crawl today with no verified source. */
  counties: number;
  /** Soonest sale date among them — how perishable this state's gap is. */
  soonestSale: string;
}

/**
 * Which states the research pass should look at, ranked by their real gap.
 *
 * The Auction Scout currently sweeps sixteen states blind on every press, which
 * pays to rediscover the Arkansas COSL catalog each time and spends nothing on
 * the states where a sale is coming and no source exists. The planner already
 * emits exactly the right queue — `no_source` skips carry a state and a sale
 * date — so research can be pointed at the gap instead of at a fixed list.
 *
 * Ranked by soonest sale first, then by how many counties are affected: a state
 * with one county selling next week is more urgent than one with forty selling
 * in November, because only the first is about to happen without us.
 */
export function backlogStates(plan: ScoutPlan): BacklogState[] {
  const byState = new Map<string, { counties: Set<string>; soonest: string }>();

  for (const skip of plan.skipped) {
    if (skip.reason !== "no_source") continue;
    /*
     * Upcoming listing windows only.
     *
     * `crawlsDueOn` looks back 120 days so a sale that just happened is still
     * visible for its results crawl, which means `skipped` carries results
     * windows for sales already held. Ranking by "soonest sale" across all of
     * them put Kansas at the top for a sale on 3 July — six weeks in the past.
     * Research is about finding a source before a sale, so a finished one
     * carries no urgency at all.
     */
    if (skip.kind !== "listing" || skip.saleDate < plan.date) continue;
    const held = byState.get(skip.state);
    if (held) {
      held.counties.add(skip.fips);
      if (skip.saleDate < held.soonest) held.soonest = skip.saleDate;
    } else {
      byState.set(skip.state, { counties: new Set([skip.fips]), soonest: skip.saleDate });
    }
  }

  return [...byState]
    .map(([state, v]) => ({ state, counties: v.counties.size, soonestSale: v.soonest }))
    .sort((a, b) => a.soonestSale.localeCompare(b.soonestSale) || b.counties - a.counties);
}
