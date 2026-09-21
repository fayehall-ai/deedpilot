/**
 * The ingest work queue.
 *
 * Two facts force this design. A Vercel function is capped at 300 seconds and
 * a full adapter pass takes ten minutes or more, so no request can run one to
 * completion. And a worker can die at any moment — 51 rows currently sit in
 * `ingest_runs` at status `running`, the oldest from 31 July, every one of
 * them a process that stopped without reconciling its own state.
 *
 * So work is claimed rather than assigned, and a claim expires. A dispatcher
 * takes a lease on a job, does one county's worth of work, and either finishes
 * it or dies. If it dies the lease lapses and the job is claimable again — no
 * reconciliation pass required, and no job can be silently owned by a process
 * that no longer exists.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes concurrent dispatchers safe: two
 * ticks overlapping is normal on a cron, and without it both would claim the
 * same row and run the same county twice.
 */
/*
 * Deliberately not marked `server-only`, for the same reason `lib/ai/providers`
 * is not: the ingest CLI runs under plain tsx, outside any React server
 * context, where that guard throws on import. The queue is server-side by
 * nature — it needs a database connection — but it is not React-server-only.
 */
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { runJobs, runSchedules, adminAudit, type RunJob } from "../db/schema";

/**
 * How long a claim is good for.
 *
 * Comfortably longer than the function's own ceiling, so a job cannot be
 * stolen from a worker that is still legitimately running, and short enough
 * that a dead worker's job is retried within one dispatcher cycle.
 */
export const LEASE_MS = 10 * 60 * 1000;

/** Give up after this many failed attempts rather than retrying forever. */
export const MAX_ATTEMPTS = 3;

/**
 * Which kinds of job a worker may claim, by `adapter` prefix.
 *
 * One table, several workers, and each can only run some of what is in it. A
 * worker used to claim the head of the queue whatever it was and then decide:
 * the CAPE worker let a crawl's lease lapse (burning one of its three attempts
 * and parking it for ten minutes), the dispatcher failed CAPE jobs as "unknown
 * adapter", and the terminal drain failed research and intel jobs the same way.
 * A lane is decided in the claim itself, so a worker never holds a job it
 * cannot run.
 */
export interface Lane {
  /** Claim only jobs whose adapter starts with one of these. */
  only?: readonly string[];
  /** Never claim jobs whose adapter starts with one of these. */
  except?: readonly string[];
}

/* The job kinds with a worker of their own. Everything else is a county crawl. */
const CAPE_SCRIPT = "cape-script:";
const CAPE_VIDEO = "cape-video:";
const RESEARCH = "auction-scout:";
const INTEL = "site-intel:";

export const LANES = {
  /** `/api/cron/cape`: script writing, six at a time. */
  cape: { only: [CAPE_SCRIPT] },
  /** `/api/cron/render`: narration, slides and encode, one at a time. */
  render: { only: [CAPE_VIDEO] },
  /** `/api/cron/dispatch` and the console: crawls, research and site intel. */
  dispatch: { except: [CAPE_SCRIPT, CAPE_VIDEO] },
  /** The terminal drain, which can run a county crawl and nothing else. */
  crawl: { except: [CAPE_SCRIPT, CAPE_VIDEO, RESEARCH, INTEL] },
} as const satisfies Record<string, Lane>;

function laneFilter(lane: Lane) {
  const like = (prefixes: readonly string[]) =>
    sql.join(prefixes.map((p) => sql`adapter LIKE ${p + "%"}`), sql` OR `);
  return sql`${lane.only?.length ? sql`AND (${like(lane.only)})` : sql``}
             ${lane.except?.length ? sql`AND NOT (${like(lane.except)})` : sql``}`;
}

/**
 * Work that is still going to happen: queued, or leased and either within its
 * lease or with a retry left.
 *
 * The "already queued?" checks used to read any `queued` or `leased` row as
 * busy. A job killed by the platform on its third attempt stays `leased`
 * forever — `claimNext` will not take it and nothing marks it failed — so its
 * county was busy forever and never crawled again. `reapDeadJobs` now retires
 * those rows; this predicate stops them blocking anything in the meantime.
 */
export const liveJob = sql`(${runJobs.status} = 'queued'
  OR (${runJobs.status} = 'leased'
      AND (${runJobs.leaseExpiresAt} > now() OR ${runJobs.attempts} < ${MAX_ATTEMPTS})))`;

export interface EnqueueInput {
  adapter: string;
  countyFips?: string | null;
  limit?: number | null;
  dryRun?: boolean;
  priority?: number;
  requestedBy?: string;
  scheduleId?: string | null;
}

/**
 * Add work to the queue.
 *
 * Deliberately does not deduplicate against queued work: an operator who
 * presses "run now" twice means it, and the dispatcher's per-adapter
 * concurrency guard is the right place to stop a pile-up, not the enqueue.
 */
export async function enqueue(input: EnqueueInput): Promise<RunJob> {
  const [job] = await db
    .insert(runJobs)
    .values({
      adapter: input.adapter,
      countyFips: input.countyFips ?? null,
      limit: input.limit ?? null,
      dryRun: input.dryRun ?? false,
      priority: input.priority ?? 0,
      requestedBy: input.requestedBy ?? "system",
      scheduleId: input.scheduleId ?? null,
    })
    .returning();
  return job;
}

/**
 * Claim the next job, atomically.
 *
 * A job is claimable when it is `queued`, or when it is `leased` but its lease
 * has expired — the second case is a worker that died. Both are folded into
 * one statement so there is no window between deciding and claiming.
 */
export async function claimNext(now = new Date(), lane: Lane = {}): Promise<RunJob | null> {
  /*
   * Timestamps are bound as ISO strings with an explicit cast: the postgres
   * driver will not bind a JS Date inside a raw template and fails at encode
   * time with a type error rather than anything that names the column.
   */
  const nowIso = now.toISOString();
  const leaseIso = new Date(now.getTime() + LEASE_MS).toISOString();

  const rows = (await db.execute(sql`
    WITH next AS (
      SELECT id FROM run_jobs
      WHERE (status = 'queued'
             OR (status = 'leased' AND lease_expires_at IS NOT NULL
                 AND lease_expires_at < ${nowIso}::timestamptz))
        AND attempts < ${MAX_ATTEMPTS}
        ${laneFilter(lane)}
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE run_jobs j
       SET status = 'leased',
           lease_expires_at = ${leaseIso}::timestamptz,
           attempts = j.attempts + 1,
           started_at = COALESCE(j.started_at, ${nowIso}::timestamptz)
      FROM next
     WHERE j.id = next.id
     RETURNING j.*
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * Map a raw result row onto the typed shape.
 *
 * `db.execute` returns the database's own column names — `county_fips`, not
 * `countyFips` — and casting the result to `RunJob` only silences the type
 * checker while every camelCase field reads `undefined`. That is invisible
 * until something acts on it: the dispatcher would have taken `limit` and
 * `countyFips` as undefined and run a full unbounded pass for every job,
 * including ones queued as a single-county smoke test.
 */
function hydrate(r: Record<string, unknown>): RunJob {
  return {
    id: String(r.id),
    adapter: String(r.adapter),
    countyFips: (r.county_fips as string | null) ?? null,
    limit: r.limit == null ? null : Number(r.limit),
    dryRun: Boolean(r.dry_run),
    status: r.status as RunJob["status"],
    priority: Number(r.priority ?? 0),
    requestedBy: String(r.requested_by ?? "system"),
    scheduleId: (r.schedule_id as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at as string) : null,
    attempts: Number(r.attempts ?? 0),
    lastError: (r.last_error as string | null) ?? null,
    result: (r.result as RunJob["result"]) ?? null,
    createdAt: new Date(r.created_at as string),
    startedAt: r.started_at ? new Date(r.started_at as string) : null,
    finishedAt: r.finished_at ? new Date(r.finished_at as string) : null,
  };
}

export async function completeJob(
  id: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db
    .update(runJobs)
    .set({ status: "done", finishedAt: new Date(), leaseExpiresAt: null, result })
    .where(eq(runJobs.id, id));
}

/**
 * Record a failure.
 *
 * Left claimable while attempts remain — the lease is cleared so the next
 * dispatcher picks it straight up rather than waiting for expiry — and marked
 * `failed` once the budget is spent, so a permanently broken adapter stops
 * consuming every cycle.
 */
export async function failJob(id: string, error: string): Promise<void> {
  const [job] = await db.select().from(runJobs).where(eq(runJobs.id, id)).limit(1);
  const exhausted = (job?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
  await db
    .update(runJobs)
    .set({
      status: exhausted ? "failed" : "queued",
      lastError: error.slice(0, 2000),
      leaseExpiresAt: null,
      finishedAt: exhausted ? new Date() : null,
    })
    .where(eq(runJobs.id, id));
}

export async function cancelJob(id: string): Promise<void> {
  await db
    .update(runJobs)
    .set({ status: "cancelled", finishedAt: new Date(), leaseExpiresAt: null })
    .where(and(eq(runJobs.id, id), or(eq(runJobs.status, "queued"), eq(runJobs.status, "leased"))));
}

/**
 * Turn due schedules into queued jobs.
 *
 * Advances `nextDueAt` from now rather than from the previous due time on
 * purpose: catch-up semantics would have a schedule that was paused for a week
 * enqueue seven runs the moment it resumes.
 */
export async function enqueueDueSchedules(now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(runSchedules)
    .where(and(eq(runSchedules.enabled, true), lt(runSchedules.nextDueAt, now)));

  for (const s of due) {
    await enqueue({
      adapter: s.adapter,
      limit: s.limit,
      priority: 0,
      requestedBy: `schedule:${s.id}`,
      scheduleId: s.id,
    });
    await db
      .update(runSchedules)
      .set({
        lastEnqueuedAt: now,
        nextDueAt: new Date(now.getTime() + s.intervalMinutes * 60_000),
      })
      .where(eq(runSchedules.id, s.id));
  }
  return due.length;
}

export interface QueueView {
  queued: number;
  leased: number;
  failed: number;
  recent: RunJob[];
}

export async function getQueue(limit = 25): Promise<QueueView> {
  const [counts] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status='queued')::int AS queued,
      count(*) FILTER (WHERE status='leased')::int AS leased,
      count(*) FILTER (WHERE status='failed')::int AS failed
    FROM run_jobs
  `)) as unknown as { queued: number; leased: number; failed: number }[];

  const recent = await db
    .select()
    .from(runJobs)
    .orderBy(desc(runJobs.createdAt))
    .limit(limit);

  return {
    queued: Number(counts?.queued ?? 0),
    leased: Number(counts?.leased ?? 0),
    failed: Number(counts?.failed ?? 0),
    recent,
  };
}

export async function getSchedules() {
  return db.select().from(runSchedules).orderBy(asc(runSchedules.adapter));
}

/**
 * Retire jobs whose worker died on every attempt.
 *
 * A job the platform kills never reaches `failJob`: it stays `leased`, and once
 * its third lease lapses `claimNext` will not take it again. Without this it
 * sits there for good, unclaimable and unfailed, invisible on the console's
 * failed count and — until `liveJob` — blocking its county from ever being
 * queued again.
 */
export async function reapDeadJobs(): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE run_jobs
       SET status = 'failed',
           finished_at = now(),
           last_error = COALESCE(last_error || ' — ', '') || 'worker died on every attempt'
     WHERE status = 'leased'
       AND attempts >= ${MAX_ATTEMPTS}
       AND lease_expires_at < now()
     RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length;
}

/**
 * Resolve `ingest_runs` rows abandoned by a dead process.
 *
 * The runner writes `running` before the work and only resolves it after, so a
 * killed process leaves the row forever. These are not failures anybody can
 * act on — they are bookkeeping — so they are marked `failed` with a note
 * saying exactly that, rather than left to inflate the run counts on the
 * console and mask real breakage.
 */
export async function reapStuckRuns(olderThanMinutes = 60): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE ingest_runs
       SET status = 'failed',
           finished_at = now(),
           error = COALESCE(error, 'abandoned: process ended before the run was resolved')
     WHERE status = 'running'
       AND started_at < now() - make_interval(mins => ${olderThanMinutes})
     RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length;
}

export async function audit(
  action: string,
  target: string | null,
  detail: Record<string, unknown>,
  actor = "admin",
): Promise<void> {
  await db.insert(adminAudit).values({ action, target, detail, actor });
}

/** Whether an adapter already has work in flight — the pile-up guard. */
export async function inFlightFor(adapter: string): Promise<number> {
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runJobs)
    .where(
      and(
        eq(runJobs.adapter, adapter),
        or(eq(runJobs.status, "queued"), eq(runJobs.status, "leased")),
        or(isNull(runJobs.leaseExpiresAt), sql`${runJobs.leaseExpiresAt} > now()`),
      ),
    )) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}
