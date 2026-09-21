"use server";

/**
 * The Auction Scout workbook upload, and decisions on the Scout's findings.
 *
 * The workbook runs through the same ingest as `npm run scout:ingest`
 * (`lib/import/scout-ingest.ts`), so what Ed sees here is what the terminal
 * would have printed. Preview plans without writing; the report comes back as
 * a return value for the same reason the CSV import's does — which sales were
 * added, filled, or left for a person is the point of the operation.
 */

import { revalidatePath } from "next/cache";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/queue";
import { describePlan, ingestWorkbook } from "@/lib/import/scout-ingest";
import { approveFinding, dismissFinding } from "@/lib/import/scout-research";

export interface WorkbookOutcome {
  ok: boolean;
  error?: string;
  applied?: boolean;
  tabs?: { tab: string; lines: string[]; wrote: string | null }[];
}

/** Matches `serverActions.bodySizeLimit` in next.config.ts. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function uploadScoutWorkbook(
  _prev: WorkbookOutcome | null,
  formData: FormData,
): Promise<WorkbookOutcome> {
  if (!(await isAdmin())) return { ok: false, error: "Not authorised." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the workbook to upload." };
  if (!/\.xlsx$/i.test(file.name)) return { ok: false, error: "That is not an .xlsx workbook." };
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 8 MB.` };
  }

  const preview = String(formData.get("preview") ?? "") === "on";
  const actor = await currentActor();

  let results;
  try {
    results = await ingestWorkbook(new Uint8Array(await file.arrayBuffer()), file.name, {
      apply: !preview,
      via: "console",
      actor,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  await audit(
    preview ? "scout.workbook_previewed" : "scout.workbook_applied",
    file.name,
    Object.fromEntries(
      results.map((r) => [r.tab, { sales: r.plan.sales.length, filled: r.result?.filled ?? 0, inserted: r.result?.inserted ?? 0 }]),
    ),
    actor,
  );

  if (!preview) {
    revalidatePath("/calendar");
    revalidatePath("/auctions");
    revalidatePath("/admin");
    revalidatePath("/");
  }

  return {
    ok: true,
    applied: !preview,
    tabs: results.map((r) => ({
      tab: r.tab,
      lines: describePlan(r.plan),
      wrote: r.result
        ? `Wrote ${r.result.filled} fill(s) and ${r.result.inserted} new sale(s); queued ` +
          `${r.result.enrichment.queued} county crawl(s); recorded ${r.sourcesAdded} new list link(s).`
        : null,
    })),
  };
}

export async function approveScoutFinding(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const id = String(formData.get("id") ?? "");
  const actor = await currentActor();
  const outcome = await approveFinding(id, actor);
  await audit("scout.finding_approved", id, { outcome }, actor);
  revalidatePath("/admin");
  revalidatePath("/calendar");
}

export async function dismissScoutFinding(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const id = String(formData.get("id") ?? "");
  const actor = await currentActor();
  await dismissFinding(id, actor);
  await audit("scout.finding_dismissed", id, {}, actor);
  revalidatePath("/admin");
}
