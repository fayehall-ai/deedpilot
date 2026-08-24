"use server";

/**
 * Every write the console can make.
 *
 * All of them re-check the cookie rather than trusting that the page rendered
 * — a Server Function is a public endpoint whose id is discoverable, so
 * "the form was only shown to an admin" is not an authorisation check. All of
 * them also write to `admin_audit` before returning, so a change survives the
 * person who made it.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { runSchedules, sourceOverrides, policyOverrides } from "@/lib/db/schema";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit, cancelJob, claimNext, completeJob, enqueue, failJob, inFlightFor } from "@/lib/admin/queue";
import { runAdapter } from "@/lib/ingest/runner";
import { getAdapter } from "@/lib/ingest/adapters";
import { clearOverrides, isOverridable, setOverrides } from "@/lib/admin/auction-overrides";
import { backlogStates, buildPlan, enqueuePlan } from "@/lib/admin/plan-jobs";
import { getPipelineConfig, resetPipelineConfig, savePipelineConfig } from "@/lib/admin/pipeline-settings";
import { enqueueScoutReport, scoutAdapter } from "@/lib/admin/scout-jobs";

class NotAuthorised extends Error {
  constructor() {
    super("Not authorised");
  }
}

async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new NotAuthorised();
}

/**
 * Audit a change against the person who made it.
 *
 * `audit()` defaults its actor to the literal "admin", which is what every row
 * in the table said until named tokens existed. Resolving the actor here rather
 * than at each call site means a new action cannot forget to attribute itself.
 */
async function auditAs(
  action: string,
  target: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await audit(action, target, detail, await currentActor());
}

const str = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();
const int = (f: FormData, k: string): number | null => {
  const v = str(f, k);
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Queue a run immediately.
 *
 * Enqueues rather than executing: a full adapter pass takes ten minutes and a
 * Server Function cannot hold the request that long. Priority 10 puts a
 * hand-pressed run ahead of the nightly sweep.
 *
 * Refuses when the adapter already has live work. Pressing the button twice is
 * the most natural thing in the world when nothing appears to happen, and two
 * dispatchers running the same county concurrently would have them fighting
 * over the same upsert.
 */
export async function runNow(formData: FormData): Promise<void> {
  await requireAdmin();
  const adapter = str(formData, "adapter");
  if (!getAdapter(adapter)) throw new Error(`Unknown adapter: ${adapter}`);

  const inFlight = await inFlightFor(adapter);
  if (inFlight > 0) {
    await auditAs("run_now.rejected", adapter, { reason: "already in flight", inFlight });
    revalidatePath("/admin");
    return;
  }

  const countyFips = str(formData, "countyFips") || null;
  const limit = int(formData, "limit");
  const dryRun = str(formData, "dryRun") === "on";

  const job = await enqueue({
    adapter,
    countyFips,
    limit,
    dryRun,
    priority: 10,
    requestedBy: "admin",
  });
  await auditAs("run_now", adapter, { jobId: job.id, countyFips, limit, dryRun });
  revalidatePath("/admin");
}

export async function cancelRun(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = str(formData, "jobId");
  await cancelJob(id);
  await auditAs("run.cancel", id, {});
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * Create or update an adapter's schedule.
 *
 * An interval and an anchor rather than a cron expression: enough for "sweep
 * this nightly", and incapable of expressing a schedule nobody can reason
 * about later. One schedule per adapter, enforced by a unique index.
 */
export async function saveSchedule(formData: FormData): Promise<void> {
  await requireAdmin();
  const adapter = str(formData, "adapter");
  if (!getAdapter(adapter)) throw new Error(`Unknown adapter: ${adapter}`);

  const intervalMinutes = Math.max(15, int(formData, "intervalMinutes") ?? 1440);
  const limit = int(formData, "limit");
  const enabled = str(formData, "enabled") === "on";
  const note = str(formData, "note") || null;

  await db
    .insert(runSchedules)
    .values({ adapter, intervalMinutes, limit, enabled, note, nextDueAt: new Date() })
    .onConflictDoUpdate({
      target: runSchedules.adapter,
      set: { intervalMinutes, limit, enabled, note, updatedAt: new Date() },
    });

  await auditAs("schedule.save", adapter, { intervalMinutes, limit, enabled });
  revalidatePath("/admin");
}

export async function deleteSchedule(formData: FormData): Promise<void> {
  await requireAdmin();
  const adapter = str(formData, "adapter");
  await db.delete(runSchedules).where(eq(runSchedules.adapter, adapter));
  await auditAs("schedule.delete", adapter, {});
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Override a county's source URL, or switch it off.
 *
 * An overlay on the code registry, never a replacement: the registry entry
 * keeps its verification history in the commit that added it, and this lets a
 * moved page be corrected without a deploy. Clearing the URL field reverts to
 * whatever the registry says.
 */
export async function saveSource(formData: FormData): Promise<void> {
  await requireAdmin();
  const adapter = str(formData, "adapter");
  const countyFips = str(formData, "countyFips");
  if (!getAdapter(adapter)) throw new Error(`Unknown adapter: ${adapter}`);
  if (!/^\d{5}$/.test(countyFips)) throw new Error(`Not a county FIPS: ${countyFips}`);

  const rawUrl = str(formData, "url");
  if (rawUrl) {
    // Reject anything that is not an absolute http(s) URL before it reaches
    // the fetcher, where a bad value would surface as an opaque run failure.
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Not a URL: ${rawUrl}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Unsupported scheme: ${parsed.protocol}`);
    }
  }

  const url = rawUrl || null;
  const enabled = str(formData, "enabled") === "on";
  const note = str(formData, "note") || null;

  await db
    .insert(sourceOverrides)
    .values({ adapter, countyFips, url, enabled, note })
    .onConflictDoUpdate({
      target: [sourceOverrides.adapter, sourceOverrides.countyFips],
      set: { url, enabled, note, updatedAt: new Date() },
    });

  await auditAs("source.save", `${adapter}/${countyFips}`, { url, enabled });
  revalidatePath("/admin");
}

export async function deleteSource(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = str(formData, "id");
  await db.delete(sourceOverrides).where(eq(sourceOverrides.id, id));
  await auditAs("source.delete", id, {});
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Access policy
// ---------------------------------------------------------------------------

const DECISIONS = new Set(["allow", "deny", "requires_agreement"]);

/**
 * Override an access decision for a host.
 *
 * This one is different in kind from the others and is treated that way. The
 * decisions in `lib/ingest/policy.ts` are the reason this project is not
 * crawling the Georgia Press Association, which is not blocked by robots — it is
 * blocked by terms that a crawler cannot read. Loosening one from a dropdown is
 * a decision with legal weight.
 *
 * So `reason` is required, and required to be substantive, whenever a host is
 * moved to `allow`. That does not make a bad decision impossible; it makes it
 * deliberate and attributable.
 */
export async function savePolicy(formData: FormData): Promise<void> {
  await requireAdmin();
  const host = str(formData, "host").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const decision = str(formData, "decision");
  const reason = str(formData, "reason");
  const minDelayMs = Math.max(0, int(formData, "minDelayMs") ?? 5000);

  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error(`Not a hostname: ${host}`);
  if (!DECISIONS.has(decision)) throw new Error(`Unknown decision: ${decision}`);
  if (decision === "allow" && reason.length < 20) {
    throw new Error(
      "Allowing a host requires a written reason of at least 20 characters — what was checked, and when.",
    );
  }
  if (!reason) throw new Error("A reason is required.");

  await db
    .insert(policyOverrides)
    .values({ host, decision, minDelayMs, reason })
    .onConflictDoUpdate({
      target: policyOverrides.host,
      set: { decision, minDelayMs, reason, updatedAt: new Date() },
    });

  await auditAs("policy.save", host, { decision, minDelayMs, reason });
  revalidatePath("/admin");
}

export async function deletePolicy(formData: FormData): Promise<void> {
  await requireAdmin();
  const host = str(formData, "host");
  await db.delete(policyOverrides).where(eq(policyOverrides.host, host));
  await auditAs("policy.delete", host, { note: "reverted to the decision in code" });
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Auction corrections
// ---------------------------------------------------------------------------

/**
 * Correct a field on one auction.
 *
 * The write goes to `auctions.operator_overrides`, never to the column itself.
 * Writing the column directly would look identical in the console and be
 * reverted by the next crawl, because `upsertAuction` sets these fields from
 * `excluded.*` — the failure this whole tier exists to prevent.
 *
 * An empty value clears that one correction, so reverting a single field never
 * means retyping the others.
 */
export async function saveAuctionOverride(formData: FormData): Promise<void> {
  await requireAdmin();
  const auctionId = str(formData, "auctionId");
  const field = str(formData, "field");
  const raw = str(formData, "value");

  if (!isOverridable(field)) {
    throw new Error(`${field} is not overridable`);
  }

  // Typed before validation, because the form gives everything back as a
  // string and `saleDateConfirmed` is the one field where "false" is a value
  // rather than an absence.
  let value: unknown = raw;
  if (raw === "") value = null;
  else if (field === "saleDateConfirmed") value = raw === "true";

  await setOverrides(auctionId, { [field]: value }, await currentActor());
  await auditAs("auction.override", `${auctionId}/${field}`, { value });
  revalidatePath("/admin");
}

/** Drop every correction on an auction, returning it wholly to the county. */
export async function clearAuctionOverrides(formData: FormData): Promise<void> {
  await requireAdmin();
  const auctionId = str(formData, "auctionId");
  await clearOverrides(auctionId);
  await auditAs("auction.override.clear", auctionId, {});
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Pipeline cadence
// ---------------------------------------------------------------------------

/**
 * Queue today's calendar plan, and say what happened.
 *
 * Enqueues rather than crawls: a full plan is hundreds of county fetches and a
 * Server Function cannot hold the request open for that.
 *
 * The outcome is carried back in the URL because the interesting case is the
 * quiet one. `enqueuePlan` skips any county already queued or leased, so a
 * second press correctly enqueues nothing — and with no message that is
 * indistinguishable from a broken button. It was reported as exactly that: four
 * presses, four audited successes, zero visible change.
 */
export async function runCrawlPlanNow(): Promise<void> {
  await requireAdmin();
  const config = await getPipelineConfig();
  const result = await enqueuePlan({ maxTasks: config.crawlMaxTasks });
  await auditAs("plan.run_now", null, {
    planned: result.planned,
    enqueued: result.enqueued,
    alreadyQueued: result.alreadyQueued,
  });
  revalidatePath("/admin");
  redirect(`/admin?ran=plan&enqueued=${result.enqueued}&skipped=${result.alreadyQueued}`);
}

/**
 * Work the queue here and now, within one request.
 *
 * Why this exists: "Run Crawl Scout now" only ever queued, and against a daily
 * dispatcher "now" meant "some time in the next twenty-four hours". The queue
 * sat at 50 jobs for an hour while the button was pressed four times, each press
 * doing exactly what it promised and nothing a person could see.
 *
 * Bounded hard. A Server Function is not the dispatcher and must not pretend to
 * be one: it claims a few jobs, runs them, and stops well inside the request
 * budget, leaving the rest to the overnight tick. A county is ~3s at the median
 * and 8s at p90, so the cap is small and the deadline is re-checked between jobs
 * rather than assumed.
 */
const DRAIN_BUDGET_MS = 25_000;
const DRAIN_MAX_JOBS = 5;

export async function drainQueueNow(): Promise<void> {
  await requireAdmin();
  const started = Date.now();
  let ran = 0;
  let failed = 0;

  while (ran + failed < DRAIN_MAX_JOBS && Date.now() - started < DRAIN_BUDGET_MS) {
    const job = await claimNext();
    if (!job) break;
    try {
      const adapter = getAdapter(job.adapter);
      if (!adapter) {
        await failJob(job.id, `unknown adapter ${job.adapter}`);
        failed++;
        continue;
      }
      const summary = await runAdapter(adapter, {
        countyFips: job.countyFips ?? undefined,
        limit: job.limit ?? undefined,
        dryRun: job.dryRun,
      });
      await completeJob(job.id, summary as unknown as Record<string, unknown>);
      ran++;
    } catch (e) {
      await failJob(job.id, e instanceof Error ? e.message : String(e));
      failed++;
    }
  }

  await auditAs("queue.drain_now", null, { ran, failed, ms: Date.now() - started });
  revalidatePath("/admin");
  redirect(`/admin?ran=drain&done=${ran}&failed=${failed}`);
}

/**
 * Queue the weekly research pass now, ignoring the day check.
 *
 * The cooldown still applies. That is the guard worth keeping under a manual
 * press: the day check exists to pick a slot, but the cooldown exists to stop
 * the same four states being researched twice in a week at full price.
 */
export async function runResearchNow(): Promise<void> {
  await requireAdmin();
  const config = await getPipelineConfig();
  const ranked = backlogStates(await buildPlan());
  const states = ranked.slice(0, config.researchStates).map((s) => s.state);

  const fresh: string[] = [];
  for (const state of states) {
    if ((await inFlightFor(scoutAdapter(state))) === 0) fresh.push(state);
  }
  if (fresh.length > 0) await enqueueScoutReport(fresh, await currentActor());

  await auditAs("research.run_now", null, { queued: fresh, skipped: states.length - fresh.length });
  revalidatePath("/admin");
  redirect(
    `/admin?ran=research&enqueued=${fresh.length}&skipped=${states.length - fresh.length}#cadence`,
  );
}

/** Change how hard the pipeline runs. */
export async function savePipelineSettings(formData: FormData): Promise<void> {
  await requireAdmin();

  if (str(formData, "intent") === "reset") {
    await resetPipelineConfig();
    await auditAs("pipeline.settings.reset", null, {});
    revalidatePath("/admin");
    return;
  }

  const patch = {
    // Checkboxes are absent from the payload when unticked, which is what makes
    // a bare `formData.get` the wrong read for a boolean.
    crawlEnabled: str(formData, "crawlEnabled") === "on",
    crawlMaxTasks: Number(str(formData, "crawlMaxTasks")),
    researchEnabled: str(formData, "researchEnabled") === "on",
    researchWeekday: str(formData, "researchWeekday"),
    researchStates: Number(str(formData, "researchStates")),
    researchCooldownDays: Number(str(formData, "researchCooldownDays")),
  };

  const next = await savePipelineConfig(patch, await currentActor());
  await auditAs("pipeline.settings.save", null, next as unknown as Record<string, unknown>);
  revalidatePath("/admin");
}
