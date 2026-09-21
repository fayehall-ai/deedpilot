/**
 * CAPE briefing videos, carried on the job queue as `cape-video:<auctionId>`.
 *
 * ## What gets a video
 *
 * Not every script. Each video buys speech and several minutes of encode, and
 * the owner's call was: every weekly batch, the N largest sales by parcel count
 * get one, N set on the console (`videoTopN`, default 16).
 *
 * A "weekly batch" is Component Eight's production week — the packages whose
 * deadline (`productionDeadline`: the Monday or Tuesday of the sale's week)
 * falls in the same week. Ranking inside each week rather than across the whole
 * calendar is the point: ranked globally, the top sixteen would be the largest
 * sales months out, and the batch actually due this week would get nothing.
 *
 * Only batches whose production week starts within `VIDEO_HORIZON_DAYS` are
 * considered. Rendering further ahead buys videos of facts that will move —
 * lists get crawled closer to the sale, the inputs hash changes, the script is
 * rewritten and the video with it. Fourteen days always covers the next two
 * batches in full, so a batch is being worked on a week before it is due.
 *
 * Parcels are `greatest(lot_count, announced_parcel_count)` — the same "best
 * figure available" `MIN_PARCELS` measures, so a county that announced 1,800
 * parcels ranks by its sale rather than by how much of it we have crawled.
 *
 * ## When one is rendered
 *
 * Eligible when the script stored for the sale was written from the facts now
 * in force, passed the automatic checks (no unsupported figure, right county),
 * and no Drive delivery is recorded for it. `produceCapePackage` clears the
 * video fields whenever it writes a new script, so a Drive link on the row is
 * always a reading of the current script.
 *
 * ## Why this module has no `server-only` guard
 *
 * The render proof and the CLI evaluate the same selection from tsx, where that
 * guard throws on import. It is server-side by nature — it needs the database.
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { capeProductions, runJobs } from "@/lib/db/schema";
import { capePackageInputs } from "@/lib/cape/inputs";
import { capeInputsHash } from "@/lib/cape/components";
import { productionDeadline } from "@/lib/cape/deadline";
import { heldReason } from "@/lib/cape/produce";
import { isDriveLink } from "@/lib/delivery/drive";
import { enqueue, liveJob } from "./queue";

export const VIDEO_PREFIX = "cape-video:";

export const isVideoJob = (adapter: string): boolean => adapter.startsWith(VIDEO_PREFIX);
export const videoAuctionId = (adapter: string): string => adapter.slice(VIDEO_PREFIX.length);
export const videoAdapter = (auctionId: string): string => `${VIDEO_PREFIX}${auctionId}`;

/** Only `/api/cron/render` claims these (`LANES.render`), so this orders them among themselves. */
export const VIDEO_PRIORITY = -3;

/** Batches whose production week starts within this many days. See the module note. */
export const VIDEO_HORIZON_DAYS = 14;

/**
 * Queued-but-unclaimed ceiling. A tick renders one; the queue is a buffer, so a
 * change to the facts or to N reaches the work within a tick or two.
 */
const QUEUE_CAP = 4;

/**
 * A sale whose render job failed every attempt is left alone this long.
 *
 * Without it a deterministic failure loops: three attempts, `failed`, and the
 * next tick queues a fresh job for the same sale because nothing was delivered.
 * A day keeps the retry but stops it eating every tick.
 */
const FAILURE_COOLDOWN_HOURS = 24;

type Input = Awaited<ReturnType<typeof capePackageInputs>>[number];

export const parcelsFor = (i: { lotCount: number; announcedParcelCount: number | null }): number =>
  Math.max(i.lotCount ?? 0, i.announcedParcelCount ?? 0);

const DAY_MS = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday of the week a deadline falls in — the batch's name. */
export function batchWeekOf(dueDate: string): string {
  const d = new Date(utc(dueDate));
  const back = (d.getUTCDay() + 6) % 7;
  return iso(d.getTime() - back * DAY_MS);
}

export interface VideoCandidate<T> {
  input: T;
  parcels: number;
  dueDate: string;
  /** `YYYY-MM-DD` Monday of the production week. */
  batch: string;
  /** 1-based rank by parcels within the batch. */
  rank: number;
}

/**
 * The top N sales by parcels in each weekly batch due within the horizon.
 *
 * Pure, so the selection can be tested and printed without a database. Ties
 * break on the earlier sale, then the auction id, so the same facts always pick
 * the same sales. Returned most urgent batch first, largest sale first.
 */
export function selectVideoCandidates<
  T extends { auctionId: string; saleDate: string; platform: string | null; lotCount: number; announcedParcelCount: number | null },
>(inputs: T[], opts: { topN: number; today: string; horizonDays?: number }): VideoCandidate<T>[] {
  if (opts.topN <= 0) return [];
  const horizonEnd = iso(utc(opts.today) + (opts.horizonDays ?? VIDEO_HORIZON_DAYS) * DAY_MS);

  const byBatch = new Map<string, Omit<VideoCandidate<T>, "rank">[]>();
  for (const input of inputs) {
    const { dueDate, salePassed } = productionDeadline({ saleDate: input.saleDate, platform: input.platform, today: opts.today });
    const batch = batchWeekOf(dueDate);
    /*
     * Cut on the batch's week, not the deadline itself, so a week is never
     * split — its Monday live deadlines in and its Tuesday online ones out.
     */
    if (salePassed || batch > horizonEnd) continue;
    const list = byBatch.get(batch) ?? [];
    list.push({ input, parcels: parcelsFor(input), dueDate, batch });
    byBatch.set(batch, list);
  }

  const out: VideoCandidate<T>[] = [];
  for (const batch of [...byBatch.keys()].sort()) {
    const ranked = byBatch
      .get(batch)!
      .sort(
        (a, b) =>
          b.parcels - a.parcels ||
          a.input.saleDate.localeCompare(b.input.saleDate) ||
          a.input.auctionId.localeCompare(b.input.auctionId),
      )
      .slice(0, opts.topN);
    ranked.forEach((c, i) => out.push({ ...c, rank: i + 1 }));
  }
  return out;
}

export type VideoEligibility =
  | { ok: true }
  | { ok: false; reason: "no-script" | "stale-script" | "held" | "delivered"; detail?: string };

/** The slice of a production row the decision reads. */
export interface ProductionForVideo {
  inputsHash: string;
  hasScript: boolean;
  unsupportedFigures: string[] | null;
  error: string | null;
  videoUrl: string | null;
}

/**
 * Whether a sale's production row is ready for a video, and if not, why.
 *
 * Pure. `currentHash` is `capeInputsHash` of the sale as it stands now.
 */
export function videoEligibility(row: ProductionForVideo | undefined, currentHash: string): VideoEligibility {
  if (!row || !row.hasScript) return { ok: false, reason: "no-script" };
  if (row.inputsHash !== currentHash) return { ok: false, reason: "stale-script" };
  const held = heldReason(row);
  if (held) return { ok: false, reason: "held", detail: held };
  if (isDriveLink(row.videoUrl)) return { ok: false, reason: "delivered" };
  return { ok: true };
}

/** The production rows eligibility is judged on, keyed by auction. */
export async function productionRowsFor(auctionIds: string[]): Promise<Map<string, ProductionForVideo>> {
  if (auctionIds.length === 0) return new Map();
  const rows = await db
    .select({
      auctionId: capeProductions.auctionId,
      inputsHash: capeProductions.inputsHash,
      hasScript: sql<boolean>`${capeProductions.script} is not null`,
      unsupportedFigures: capeProductions.unsupportedFigures,
      error: capeProductions.error,
      videoUrl: capeProductions.videoUrl,
    })
    .from(capeProductions)
    .where(inArray(capeProductions.auctionId, auctionIds));
  return new Map(rows.map((r) => [r.auctionId, { ...r, hasScript: Boolean(r.hasScript) }]));
}

export interface VideoEnqueueResult {
  topN: number;
  /** Weekly batches inside the horizon. */
  batches: string[];
  /** Top-N sales across those batches. */
  candidates: number;
  /** Ready to render and not yet delivered. */
  eligible: number;
  delivered: number;
  held: number;
  /** No script yet, or one written from facts that have since moved. */
  awaitingScript: number;
  coolingDown: number;
  inFlight: number;
  queued: number;
}

/**
 * Queue a render for each top-N sale that is ready and not yet delivered.
 *
 * Idempotent: a sale already queued, leased, delivered, held, or recently
 * failed is not queued again, so a tick every ten minutes converges instead of
 * piling up. `inputs` lets the render route pass the list it already read.
 */
export async function enqueueCapeVideos(opts: {
  topN: number;
  inputs?: Input[];
  today?: string;
  cap?: number;
}): Promise<VideoEnqueueResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const inputs = opts.inputs ?? (await capePackageInputs({ today }));
  const candidates = selectVideoCandidates(inputs, { topN: opts.topN, today });
  const rows = await productionRowsFor(candidates.map((c) => c.input.auctionId));

  const counts = { eligible: 0, delivered: 0, held: 0, awaitingScript: 0 };
  const ready: string[] = [];
  for (const c of candidates) {
    const verdict = videoEligibility(rows.get(c.input.auctionId), capeInputsHash(c.input));
    if (verdict.ok) {
      counts.eligible++;
      ready.push(c.input.auctionId);
    } else if (verdict.reason === "delivered") counts.delivered++;
    else if (verdict.reason === "held") counts.held++;
    else counts.awaitingScript++;
  }

  const live = await db
    .select({ adapter: runJobs.adapter })
    .from(runJobs)
    .where(and(sql`${runJobs.adapter} LIKE ${VIDEO_PREFIX + "%"}`, liveJob));
  const busy = new Set(live.map((r) => videoAuctionId(r.adapter)));

  const since = new Date(Date.now() - FAILURE_COOLDOWN_HOURS * 3_600_000);
  const failedRecently = await db
    .select({ adapter: runJobs.adapter })
    .from(runJobs)
    .where(
      and(
        sql`${runJobs.adapter} LIKE ${VIDEO_PREFIX + "%"}`,
        eq(runJobs.status, "failed"),
        gt(runJobs.finishedAt, since),
      ),
    );
  const cooling = new Set(failedRecently.map((r) => videoAuctionId(r.adapter)));

  const room = Math.max(0, (opts.cap ?? QUEUE_CAP) - busy.size);
  const toQueue = ready.filter((id) => !busy.has(id) && !cooling.has(id)).slice(0, room);
  for (const auctionId of toQueue) {
    await enqueue({ adapter: videoAdapter(auctionId), priority: VIDEO_PRIORITY, requestedBy: "render-cron" });
  }

  return {
    topN: opts.topN,
    batches: [...new Set(candidates.map((c) => c.batch))],
    candidates: candidates.length,
    ...counts,
    coolingDown: ready.filter((id) => cooling.has(id) && !busy.has(id)).length,
    inFlight: busy.size,
    queued: toQueue.length,
  };
}

/** Render jobs currently held by a live worker. The render cron runs one at a time. */
export async function renderInFlight(): Promise<number> {
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runJobs)
    .where(
      and(
        sql`${runJobs.adapter} LIKE ${VIDEO_PREFIX + "%"}`,
        eq(runJobs.status, "leased"),
        sql`${runJobs.leaseExpiresAt} > now()`,
      ),
    )) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}
