/*
 * No `server-only` guard — the producer CLI delivers with `--drive` as well as
 * the render cron.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { capeProductions } from "@/lib/db/schema";
import { upsertFile, type UpsertResult } from "@/lib/delivery/drive";

/**
 * Handing a finished briefing to the team: an MP4 in the CAPE folder's `Video`
 * subfolder on Google Drive, and its link on the production row.
 *
 * This replaces `scripts/collect-videos.sh` piped into `scripts/push-to-drive.sh`
 * — rclone, from a laptop, by someone who remembered to run it.
 */

/** The Drive subfolder briefings go into. Matched case-insensitively, plural too. */
export const VIDEO_SUBFOLDER = "Video";

/**
 * `<County>_County_<ST>_<date>.mp4`, exactly as `collect-videos.sh` named them.
 *
 * Identical on purpose, down to its quirks — the county is slugged first and
 * each piece capitalised, so "St. Lucie" is `St_Lucie` and "DeKalb" is `Dekalb`
 * — because `upsertFile` replaces by name. A file the old script uploaded is
 * the same file the cron updates, instead of a near-duplicate beside it.
 */
export function deliveryFileName(input: {
  countyName: string | null;
  state: string | null;
  saleDate: string;
}): string {
  const slug = (input.countyName ?? "county").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  const county = slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("_");
  const state = (input.state ?? "xx").toUpperCase();
  return `${county}_County_${state}_${input.saleDate}.mp4`;
}

/**
 * Upload a produced video and record where it went.
 *
 * The link is written to `video_url` only if the row still describes the facts
 * the video was rendered from. A script rewritten mid-upload (the facts moved)
 * clears the video fields; writing the link back over that would mark a stale
 * cut as delivered for the new facts, and the cron would never render the
 * current one.
 */
export async function deliverVideo(opts: {
  auctionId: string;
  inputsHash: string;
  mp4Path: string;
  countyName: string | null;
  state: string | null;
  saleDate: string;
}): Promise<UpsertResult & { fileName: string; recorded: boolean }> {
  const fileName = deliveryFileName(opts);
  const uploaded = await upsertFile(VIDEO_SUBFOLDER, fileName, { path: opts.mp4Path }, "video/mp4");

  const [row] = await db
    .select({ inputsHash: capeProductions.inputsHash })
    .from(capeProductions)
    .where(eq(capeProductions.auctionId, opts.auctionId))
    .limit(1);
  const recorded = row?.inputsHash === opts.inputsHash;
  if (recorded) {
    await db
      .update(capeProductions)
      .set({ videoUrl: uploaded.webViewLink, stage: "video", error: null, updatedAt: new Date() })
      .where(eq(capeProductions.auctionId, opts.auctionId));
  }
  return { ...uploaded, fileName, recorded };
}
