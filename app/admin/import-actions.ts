"use server";

/**
 * Uploading a sale calendar.
 *
 * Like every other write on this console, the cookie is re-checked here rather
 * than trusted from the render: a Server Function is a public endpoint whose id
 * is discoverable, and this one inserts auctions.
 *
 * The result comes back as a return value instead of a redirect. An import
 * report is the point of the operation — which rows were rejected, which
 * counties did not resolve, which sales the pipeline already had — and none of
 * that survives a round trip through search params. `revalidatePath` still runs
 * so the calendar and the console reflect the new rows immediately.
 */

import { revalidatePath } from "next/cache";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/queue";
import { importAuctionCsv, UnreadableFile } from "@/lib/import/run";
import { enqueueImportEnrichment } from "@/lib/import/enrich";
import type { ImportReport } from "@/lib/import/apply";
import type { ImportEnrichment } from "@/lib/import/enrich";

/** What the panel renders after an upload. */
export interface ImportOutcome {
  ok: boolean;
  /** Set when the file could not be read at all. Nothing was written. */
  error?: string;
  report?: ImportReport;
  /** What the enrichment pass queued, when it was asked for. */
  enrichment?: ImportEnrichment;
}

/**
 * The upload cap.
 *
 * A year of national sale dates is roughly 4 MB, so 8 MB is generous headroom
 * for the file this is meant to take while still refusing something that is not
 * a calendar at all. Server Actions cap bodies at 1 MB by default; the matching
 * `serverActions.bodySizeLimit` in `next.config.ts` has to move with this
 * number or the request is rejected by the framework before reaching us.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export async function uploadAuctionCsv(
  _prev: ImportOutcome | null,
  formData: FormData,
): Promise<ImportOutcome> {
  if (!(await isAdmin())) return { ok: false, error: "Not authorised." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a CSV file to upload." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`,
    };
  }

  const actor = await currentActor();
  const alsoEnrich = String(formData.get("enrich") ?? "") === "on";

  /*
   * Both the applied and the refused cases are written by `importAuctionCsv`
   * itself now, from the provenance handed to it here. The audit used to live
   * in this function, which meant the terminal path recorded nothing — see
   * `lib/import/history.ts`. Anything added to the record belongs there, below
   * both callers, rather than here where only the browser would benefit.
   */
  let report: ImportReport;
  try {
    report = await importAuctionCsv(await file.text(), {
      source: file.name,
      via: "console",
      bytes: file.size,
      actor,
    });
  } catch (e) {
    // A file in the wrong format is an operator mistake, not a fault.
    if (!(e instanceof UnreadableFile)) throw e;
    return { ok: false, error: e.message };
  }

  let enrichment: ImportEnrichment | undefined;
  if (alsoEnrich && report.countiesTouched.length > 0) {
    enrichment = await enqueueImportEnrichment(report.countiesTouched, actor);
    await audit("import.enrichment_queued", file.name, { ...enrichment }, actor);
  }

  /*
   * The calendar and the auctions list are cached with `cacheLife("minutes")`,
   * so without this the operator uploads a file, sees the report, clicks
   * through to the calendar and finds it unchanged — which reads as the import
   * having failed.
   */
  revalidatePath("/calendar");
  revalidatePath("/auctions");
  revalidatePath("/admin");
  revalidatePath("/");

  return { ok: true, report, enrichment };
}
