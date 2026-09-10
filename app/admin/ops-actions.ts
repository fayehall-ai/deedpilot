"use server";

/**
 * Running a pipeline operation from the console.
 *
 * These were terminal commands. Each one now has a bounded, importable runner
 * in `lib/ops/tasks.ts`; this is the half that checks the cookie, holds the
 * clock, audits, and carries the outcome back to the page.
 *
 * ## Why the result travels in the URL
 *
 * The same reason `runCrawlPlanNow` does it: the interesting outcome is the
 * quiet one. "Nothing due — every in-scope parcel already has current intel" is
 * a correct and useful answer, and with no message it is indistinguishable from
 * a button that does nothing. That exact confusion is on the record here — four
 * presses, four audited successes, no visible change.
 *
 * ## Why there is a deadline rather than a spend prompt
 *
 * A Server Function has a hard ceiling and several of these operations are
 * national in scope, so none of them can be allowed to run to completion inside
 * a request. The budget below is what makes the work possible at all; the
 * `limit` on the form is the operator's own dial on top of it. A task stops at
 * whichever comes first and says what it did not reach.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/queue";
import { opsTask } from "@/lib/ops/tasks";

/**
 * Wall clock for one press.
 *
 * `drainQueueNow` uses 25s against the same ceiling and that has proven safe,
 * so this matches it rather than inventing a second number. Tasks re-check the
 * deadline between units of work instead of assuming a unit is quick.
 */
const BUDGET_MS = 25_000;

/** Nothing here may run unbounded, whatever the form says. */
const MAX_LIMIT = 500;

export async function runOpsTask(formData: FormData): Promise<void> {
  if (!(await isAdmin())) throw new Error("Not authorised");

  const key = String(formData.get("key") ?? "").trim();
  const task = opsTask(key);
  if (!task) throw new Error(`Unknown operation ${key}`);

  const rawLimit = Number.parseInt(String(formData.get("limit") ?? ""), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, rawLimit))
    : task.defaultLimit;
  const state = String(formData.get("state") ?? "").trim().toUpperCase() || undefined;

  const started = Date.now();
  let summary: string;
  let ok = true;
  let detail: Record<string, unknown> = {};

  try {
    const result = await task.run({
      limit,
      state: task.stateful ? state : undefined,
      deadline: started + BUDGET_MS,
    });
    summary = result.summary;
    detail = result.detail;
  } catch (e) {
    /*
     * Reported rather than thrown. A failed operation is information — a
     * missing API key, a provider timing out — and an error page loses both the
     * message and the console the operator was working in.
     */
    ok = false;
    summary = e instanceof Error ? e.message : String(e);
  }

  await audit(
    ok ? "ops.ran" : "ops.failed",
    task.key,
    { ...detail, limit, state: state ?? null, ms: Date.now() - started, summary },
    await currentActor(),
  );

  revalidatePath("/admin");
  redirect(
    `/admin?op=${encodeURIComponent(task.key)}&ok=${ok ? 1 : 0}` +
      `&msg=${encodeURIComponent(summary.slice(0, 300))}#ops`,
  );
}
