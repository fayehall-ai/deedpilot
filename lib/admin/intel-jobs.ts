/**
 * Site-intel enrichment, carried on the existing job queue.
 *
 * ## Why it rides the queue rather than owning a schedule
 *
 * `run_jobs` already has leasing, retry limits, priority ordering and a
 * dispatcher that drains it — everything an enrichment loop needs, built and
 * debugged for ingest. Encoding the work in the `adapter` column as
 * `site-intel:<source>` needs no migration, because that column is free text,
 * and it gets `inFlightFor` deduplication per source for free.
 *
 * ## Why the priority is the lowest thing in the queue
 *
 * Intel is the least perishable work the pipeline does. A listing crawl two
 * days before a sale cannot be done later — the auction happens without us. A
 * flood zone can be fetched tomorrow and will be the same flood zone. Placing
 * this below research (5) and every crawl means enrichment consumes only the
 * budget nothing else wanted, which is the correct standing policy even though
 * the intel is the more interesting output.
 *
 *     planScout tasks     0-115
 *     hand-pressed crawl     10
 *     research                5
 *     nightly sweep           0
 *     site intel             -5
 *
 * ## Why the daily tick is not the real engine
 *
 * A Vercel Hobby cron runs once a day and the dispatcher reserves 45 seconds
 * of its 240-second budget, so one tick can enrich a handful of parcels
 * against an inventory of 9,742. This exists so that a deployed instance makes
 * progress unattended and so the work is visible in the same console as
 * everything else — not because it is sufficient. `scripts/intel-worker.ts` is
 * what actually drains the backlog; see `docs/intel-loop.md`.
 */

import "server-only";
import { and, sql } from "drizzle-orm";
import { db } from "../db";
import { runJobs } from "../db/schema";
import { enqueue, liveJob } from "./queue";
import { planIntelWork } from "@/lib/property/signals/scheduler";

export const INTEL_PREFIX = "site-intel:";

export const isIntelJob = (adapter: string): boolean => adapter.startsWith(INTEL_PREFIX);
export const intelSource = (adapter: string): string => adapter.slice(INTEL_PREFIX.length);
export const intelAdapter = (source: string): string => `${INTEL_PREFIX}${source}`;

/** Below everything. See the ordering note above. */
export const INTEL_PRIORITY = -5;

/**
 * Queue the most valuable enrichment fetches available right now.
 *
 * The cap is small on purpose, and a fetch already waiting is not queued again.
 * The dispatcher ticks every five minutes; before this check each tick added
 * another ten jobs for the same top-ranked parcels, because a queued fetch has
 * not run yet and so the planner still ranks its parcel first. Tasks come back
 * priority-sorted, so the cap takes the most perishable work and leaves the
 * rest: a parcel enriched today drops out of the plan under its source TTL, and
 * the queue rotates rather than starving a fixed tail.
 */
export async function enqueueIntel(opts: { maxTasks?: number } = {}): Promise<{
  enqueued: number;
  planned: number;
}> {
  const maxTasks = opts.maxTasks ?? 10;
  /* Plan past the cap, so parcels already waiting do not use up the whole of it. */
  const tasks = await planIntelWork({ limit: maxTasks * 4 });

  const waiting = await db
    .select({ adapter: runJobs.adapter, requestedBy: runJobs.requestedBy })
    .from(runJobs)
    .where(and(sql`${runJobs.adapter} LIKE ${INTEL_PREFIX + "%"}`, liveJob));
  const busy = new Set(waiting.map((w) => `${w.adapter}|${w.requestedBy}`));

  let enqueued = 0;
  for (const task of tasks) {
    if (enqueued >= maxTasks) break;
    const adapter = intelAdapter(task.source);
    const requestedBy = `intel:${task.lotId}`;
    if (busy.has(`${adapter}|${requestedBy}`)) continue;
    await enqueue({
      adapter,
      /*
       * The lot id rides in `requestedBy` rather than `countyFips`, which has a
       * foreign key to `counties` and would reject it. Not elegant, and the
       * alternative is a migration to add a nullable `lot_id` to a table that
       * is otherwise entirely about county-scoped crawls.
       */
      requestedBy,
      priority: INTEL_PRIORITY,
    });
    enqueued++;
  }

  return { enqueued, planned: tasks.length };
}

/** The lot id an intel job carries, or null when the row is malformed. */
export function intelLotId(requestedBy: string): string | null {
  return requestedBy.startsWith("intel:") ? requestedBy.slice("intel:".length) : null;
}
