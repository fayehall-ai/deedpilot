"use server";

/**
 * Auction Scout report controls.
 *
 * Separate from `run-actions.ts` because this queues research rather than a
 * crawl, but it obeys the same rule: the Server Function re-checks the admin
 * cookie itself. Rendering a button is not an authorisation check when the
 * action endpoint is reachable on its own — and this one spends money on every
 * press, so the check matters more here than anywhere else in the console.
 */
import { revalidatePath } from "next/cache";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit, inFlightFor } from "@/lib/admin/queue";
import { enqueueScoutReport, scoutAdapter } from "@/lib/admin/scout-jobs";
import { scanStateCodes } from "@/lib/ai/scan-states";
import { backlogStates, buildPlan } from "@/lib/admin/plan-jobs";
import { SCOUT_PROMPT_ID, resetScoutPrompt, saveScoutPrompt } from "@/lib/admin/scout-prompt";

export async function generateScoutReport(formData: FormData): Promise<void> {
  if (!(await isAdmin())) throw new Error("Not authorised");

  const only = String(formData.get("state") ?? "").trim().toUpperCase();

  /*
   * BACKLOG points research at the gap instead of a fixed list.
   *
   * A blind sixteen-state sweep pays to rediscover the Arkansas COSL catalog
   * every press and spends nothing on states where a sale is coming and no
   * source exists. `backlogStates` ranks by soonest *upcoming* sale, so the
   * money goes where an auction is about to happen without us. Capped at six
   * states because each is a paid searched call of one to two minutes and the
   * dispatcher drains 195 seconds a day.
   */
  let wanted: string[];
  if (only === "BACKLOG") {
    const ranked = backlogStates(await buildPlan());
    wanted = ranked.slice(0, 6).map((s) => s.state);
  } else if (only && only !== "ALL") {
    wanted = [only];
  } else {
    /*
     * Resolved from the calendar rather than a constant, so an import that adds
     * a state adds it to the next sweep. See `resolveScanStates`.
     */
    wanted = await scanStateCodes();
  }

  /*
   * Skip states already in flight rather than refusing the whole press.
   *
   * Each state is a paid searched call. Pressing the button twice is the most
   * natural thing in the world when a queue takes minutes to drain, and
   * queueing Georgia a second time would buy a second Georgia report at full
   * price. Skipping quietly is wrong too, so the count of what was skipped
   * goes into the audit row.
   */
  const fresh: string[] = [];
  const skipped: string[] = [];
  for (const state of wanted) {
    if ((await inFlightFor(scoutAdapter(state))) > 0) skipped.push(state);
    else fresh.push(state);
  }

  const { queued, states } = fresh.length
    ? await enqueueScoutReport(fresh, await currentActor())
    : { queued: 0, states: [] as string[] };

  await audit("scout.report.enqueue", only || "ALL", { queued, states, skipped }, await currentActor());
  revalidatePath("/admin");
}

/**
 * Save an edited research brief.
 *
 * Validation lives in `saveScoutPrompt` rather than here so the CLI and any
 * future caller get the same refusals — a prompt that has lost {{STATE}} is
 * wrong however it arrives.
 */
export async function saveScoutPromptAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) throw new Error("Not authorised");

  const template = String(formData.get("template") ?? "");
  if (String(formData.get("intent") ?? "") === "reset") {
    await resetScoutPrompt();
    await audit("scout.prompt.reset", SCOUT_PROMPT_ID, {}, await currentActor());
  } else {
    await saveScoutPrompt(template, await currentActor());
    await audit("scout.prompt.save", SCOUT_PROMPT_ID, { chars: template.trim().length }, await currentActor());
  }
  revalidatePath("/admin");
}
