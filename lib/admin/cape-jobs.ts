/**
 * CAPE script production, carried on the existing job queue.
 *
 * ## Why this exists
 *
 * Writing the briefing scripts for every upcoming sale is 477 model calls of
 * roughly two minutes each. Run in series that is most of a day; run at
 * concurrency four on a laptop it is five hours of a machine that cannot be
 * closed, and the run dies with the lid. Neither is somewhere this work should
 * live.
 *
 * `run_jobs` already has leasing, retry limits, priority ordering and a
 * dispatcher — built and debugged for ingest, reused by scout and site-intel on
 * exactly this argument. Encoding the auction id in the `adapter` column as
 * `cape-script:<uuid>` needs no migration, because that column is free text.
 *
 * ## Why only the script
 *
 * Narration is metered speech and an encode is ffmpeg against a writable disk;
 * a Vercel function has neither the binary nor the filesystem. `scriptOnly`
 * stops before both, and — checked rather than assumed — it never touches the
 * filesystem: `outDir` is computed and not created until after the early
 * return. The audio and the video stay where the ffmpeg is.
 *
 * ## Why the queue tops itself up rather than being filled once
 *
 * A single enqueue of 477 rows is a queue that cannot be corrected: change the
 * fact sheet halfway through and the tail is already committed to the old one.
 * `enqueueCapeScripts` instead asks, each tick, which packages are not written
 * from the facts currently in force, and queues a bounded slice of them. When
 * every script is current it queues nothing and the cron becomes a no-op that
 * costs one query — which is the correct resting state for a schedule that
 * runs every two minutes forever.
 */

import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { capeProductions, runJobs } from "@/lib/db/schema";
import { capePackageInputs } from "@/lib/cape/inputs";
import { capeInputsHash } from "@/lib/cape/components";
import { enqueue } from "./queue";

export const CAPE_PREFIX = "cape-script:";

export const isCapeJob = (adapter: string): boolean => adapter.startsWith(CAPE_PREFIX);
export const capeAuctionId = (adapter: string): string => adapter.slice(CAPE_PREFIX.length);
export const capeAdapter = (auctionId: string): string => `${CAPE_PREFIX}${auctionId}`;

/**
 * Above site-intel, below anything perishable.
 *
 * A crawl two days before a sale cannot be done later — the auction happens
 * without us. A script can be written tomorrow and will describe the same sale.
 * It sits above intel only because a briefing with no script blocks a video and
 * an unenriched parcel blocks nothing.
 *
 *     planScout tasks     0-115
 *     hand-pressed crawl     10
 *     research                5
 *     nightly sweep           0
 *     cape scripts           -3
 *     site intel             -5
 */
export const CAPE_PRIORITY = -3;

/**
 * How many CAPE jobs may sit unclaimed at once.
 *
 * Small, because the queue is a buffer and not a plan. A tick drains a handful;
 * holding forty means a change to the facts reaches the work within minutes
 * rather than after the whole backlog has run on the old ones.
 */
const QUEUE_CAP = 40;

export interface CapeEnqueueResult {
  /** Packages whose stored script was not written from the facts now in force. */
  outstanding: number;
  /** Already queued or leased when we looked. */
  inFlight: number;
  queued: number;
}

/**
 * Queue script work for packages that need it, up to the cap.
 *
 * Idempotent by construction: a package already queued, already leased, or
 * already written from the current facts is not queued again, so calling this
 * every two minutes forever converges rather than accumulating.
 */
export async function enqueueCapeScripts(
  opts: { cap?: number } = {},
): Promise<CapeEnqueueResult> {
  const cap = opts.cap ?? QUEUE_CAP;

  const inputs = await capePackageInputs();

  /* What each package's script would have to hash to in order to be current. */
  const wanted = new Map(inputs.map((i) => [i.auctionId, capeInputsHash(i)]));

  const produced = await db
    .select({ auctionId: capeProductions.auctionId, hash: capeProductions.inputsHash,
              script: capeProductions.script })
    .from(capeProductions)
    .where(inArray(capeProductions.auctionId, [...wanted.keys()]));

  const currentFor = new Map(
    produced.filter((p) => p.script).map((p) => [p.auctionId, p.hash]),
  );

  const outstandingIds = inputs
    .filter((i) => currentFor.get(i.auctionId) !== wanted.get(i.auctionId))
    .map((i) => i.auctionId);

  /*
   * Live rows, so a job mid-flight is not queued a second time. `attempts` is
   * checked too: a job that has exhausted its retries is finished with, and
   * leaving it out of this set lets a later tick queue a fresh one rather than
   * the package being stuck behind a dead row forever.
   */
  const live = await db
    .select({ adapter: runJobs.adapter })
    .from(runJobs)
    .where(
      and(
        sql`${runJobs.adapter} LIKE ${CAPE_PREFIX + "%"}`,
        inArray(runJobs.status, ["queued", "leased"]),
        sql`${runJobs.attempts} < 3`,
      ),
    );
  const busy = new Set(live.map((r) => capeAuctionId(r.adapter)));

  const room = Math.max(0, cap - busy.size);
  const toQueue = outstandingIds.filter((id) => !busy.has(id)).slice(0, room);

  for (const auctionId of toQueue) {
    await enqueue({
      adapter: capeAdapter(auctionId),
      priority: CAPE_PRIORITY,
      requestedBy: "cape-cron",
    });
  }

  return { outstanding: outstandingIds.length, inFlight: busy.size, queued: toQueue.length };
}

/** Drop every queued CAPE job. The stop button for a run in progress. */
export async function clearCapeQueue(): Promise<number> {
  const rows = await db
    .update(runJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(sql`${runJobs.adapter} LIKE ${CAPE_PREFIX + "%"}`, eq(runJobs.status, "queued")))
    .returning({ id: runJobs.id });
  return rows.length;
}
