/**
 * Framework documents into the CAPE Drive folder, for the sales that get a video.
 *
 * "Only the top ones": the same selection the briefing videos use — the N
 * largest sales by parcel count in each weekly production batch
 * (`selectVideoCandidates`) — so every delivered sale arrives as a pair, a
 * video in CAPE/Video and its framework in CAPE/Framework, under the names the
 * hand-made batches used.
 *
 * Re-uploaded daily rather than once. A framework's top rows are the sale's
 * venue, start time and date, which move as the county publishes; replacing
 * the file in place keeps its Drive link while its content catches up. A few
 * dozen small documents a day is nothing to Drive.
 */
import { capePackageInputs } from "../cape/inputs";
import { deliverableInputs, selectVideoCandidates } from "../admin/video-jobs";
import { getPipelineConfig } from "../admin/pipeline-settings";
import { upsertFile } from "../delivery/drive";
import { frameworkDocx } from "./docx";
import { frameworkSales } from "./select";

export const FRAMEWORK_SUBFOLDER = "Framework";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface FrameworkDelivery {
  delivered: { file: string; link: string | null }[];
  skipped: { sale: string; why: string }[];
}

export async function deliverFrameworks(opts: { today?: string; deadline?: number } = {}): Promise<FrameworkDelivery> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const { videoTopN } = await getPipelineConfig();
  const inputs = await deliverableInputs(await capePackageInputs({ today }));
  const candidates = selectVideoCandidates(inputs, { topN: videoTopN, today });

  const out: FrameworkDelivery = { delivered: [], skipped: [] };
  for (const c of candidates) {
    const where = `${c.input.countyName ?? c.input.countyFips}, ${c.input.state} ${c.input.saleDate}`;
    if (opts.deadline && Date.now() > opts.deadline) {
      out.skipped.push({ sale: where, why: "out of time this run" });
      continue;
    }
    /* A named date bypasses the framework window: a video is due, so is its framework. */
    const [sale] = await frameworkSales({ fips: c.input.countyFips, date: c.input.saleDate });
    if (!sale) {
      out.skipped.push({ sale: where, why: "no framework could be built for it" });
      continue;
    }
    const file = `${sale.fileBase}.docx`;
    const res = await upsertFile(FRAMEWORK_SUBFOLDER, file, await frameworkDocx(sale.framework), DOCX);
    out.delivered.push({ file, link: res.webViewLink ?? null });
  }
  return out;
}
