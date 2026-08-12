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
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { runSchedules, sourceOverrides, policyOverrides } from "@/lib/db/schema";
import { isAdmin } from "@/lib/admin/auth";
import { audit, cancelJob, enqueue, inFlightFor } from "@/lib/admin/queue";
import { getAdapter } from "@/lib/ingest/adapters";

class NotAuthorised extends Error {
  constructor() {
    super("Not authorised");
  }
}

async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new NotAuthorised();
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
    await audit("run_now.rejected", adapter, { reason: "already in flight", inFlight });
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
  await audit("run_now", adapter, { jobId: job.id, countyFips, limit, dryRun });
  revalidatePath("/admin");
}

export async function cancelRun(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = str(formData, "jobId");
  await cancelJob(id);
  await audit("run.cancel", id, {});
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

  await audit("schedule.save", adapter, { intervalMinutes, limit, enabled });
  revalidatePath("/admin");
}

export async function deleteSchedule(formData: FormData): Promise<void> {
  await requireAdmin();
  const adapter = str(formData, "adapter");
  await db.delete(runSchedules).where(eq(runSchedules.adapter, adapter));
  await audit("schedule.delete", adapter, {});
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

  await audit("source.save", `${adapter}/${countyFips}`, { url, enabled });
  revalidatePath("/admin");
}

export async function deleteSource(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = str(formData, "id");
  await db.delete(sourceOverrides).where(eq(sourceOverrides.id, id));
  await audit("source.delete", id, {});
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
 * crawling USTLA or the Georgia Press Association, and neither is blocked by
 * robots — both are blocked by terms that a crawler cannot read. Loosening one
 * from a dropdown is a decision with legal weight.
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

  await audit("policy.save", host, { decision, minDelayMs, reason });
  revalidatePath("/admin");
}

export async function deletePolicy(formData: FormData): Promise<void> {
  await requireAdmin();
  const host = str(formData, "host");
  await db.delete(policyOverrides).where(eq(policyOverrides.host, host));
  await audit("policy.delete", host, { note: "reverted to the decision in code" });
  revalidatePath("/admin");
}
