/*
 * No `server-only` guard — `scripts/cape-render-one.ts` runs this under tsx, so
 * the proof exercises exactly the code the render cron does.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { capeProductions } from "@/lib/db/schema";
import { capePackageInputs } from "./inputs";
import { capeInputsHash } from "./components";
import { produceCapePackage } from "./produce";
import { deliverVideo } from "./deliver";
import { productionRowsFor, videoEligibility } from "@/lib/admin/video-jobs";

/**
 * Render one briefing video and deliver it — the unit of work behind a
 * `cape-video:<auctionId>` job.
 *
 * Shared by `/api/cron/render` and the local proof script so there is one code
 * path to trust: the stored script (never a fresh one), narration through the
 * Blob-backed cache, slides drawn from bundled outlines, the bundled ffmpeg,
 * then Drive.
 *
 * Returns an outcome rather than throwing for everything a job should simply
 * record — a sale that left the calendar, a script that is held or stale, a
 * video already delivered. What does throw is what should fail the job and be
 * retried: a broken encoder, a dead speech key.
 */

type Input = Awaited<ReturnType<typeof capePackageInputs>>[number];

export interface RenderOneOptions {
  /** The upcoming set, if the caller already read it. Read fresh otherwise. */
  inputs?: Input[];
  /** Scratch root. The function's disk is `/tmp`; nothing here outlives the call. */
  outRoot?: string;
  /** Narration cache. Defaults under `outRoot`; the Blob layer sits behind it either way. */
  audioCacheDir?: string;
  /** Upload to Drive and record the link. Default true; the proof turns it off. */
  deliver?: boolean;
  /** Render even when a delivery is already recorded for these facts. */
  force?: boolean;
  motion?: "all" | "opening" | "none";
  onProgress?: (msg: string) => void;
}

export interface RenderOneResult {
  auctionId: string;
  outcome: "delivered" | "rendered" | "skipped" | "held" | "failed";
  reason?: string;
  /** "Fulton, GA — sale 2026-10-06", for logs and job results. */
  label?: string;
  fileName?: string;
  driveLink?: string;
  videoPath?: string;
  videoBytes?: number;
  videoSeconds?: number;
  audioSeconds?: number;
  cachedSections?: number;
  billedCharacters?: number;
  wallMs: number;
}

export async function renderOne(auctionId: string, opts: RenderOneOptions = {}): Promise<RenderOneResult> {
  const started = Date.now();
  const done = (r: Omit<RenderOneResult, "auctionId" | "wallMs">): RenderOneResult => ({
    auctionId,
    ...r,
    wallMs: Date.now() - started,
  });
  const log = opts.onProgress ?? (() => {});
  const deliver = opts.deliver ?? true;

  const inputs = opts.inputs ?? (await capePackageInputs());
  const input = inputs.find((i) => i.auctionId === auctionId);
  /* The sale passed its lead-time floor, or dropped off its county's calendar. */
  if (!input) return done({ outcome: "skipped", reason: "no longer an upcoming package" });

  const label = `${input.countyName}, ${input.state} — sale ${input.saleDate}`;
  const inputsHash = capeInputsHash(input);

  const verdict = videoEligibility((await productionRowsFor([auctionId])).get(auctionId), inputsHash);
  if (!verdict.ok && !(opts.force && verdict.reason === "delivered")) {
    return done({
      outcome: verdict.reason === "held" ? "held" : "skipped",
      reason: verdict.detail ?? verdict.reason,
      label,
    });
  }

  /*
   * Always a fresh render, never a video found on disk. Rows written before
   * `produceCapePackage` began clearing media on a script rewrite can carry a
   * `video_path` at the current hash that is a reading of an older script, and
   * nothing on the row can tell the two apart. Narration is cached, so a
   * re-render costs encode time, not speech.
   */
  const result = await produceCapePackage(input, {
    outRoot: opts.outRoot ?? "/tmp/cape",
    audioCacheDir: opts.audioCacheDir,
    remoteAudioCache: true,
    reuseScript: true,
    /* Eligibility was decided above; don't let a stale `video_path` skip the render. */
    force: true,
    motion: opts.motion ?? "opening",
    onProgress: log,
  });

  if (result.stage === "failed") return done({ outcome: "failed", reason: result.error, label });
  if (result.stage !== "video" || !result.videoPath) {
    return done({
      outcome: result.stage === "script" ? "held" : "skipped",
      reason: result.skipped ?? `stopped at ${result.stage}`,
      label,
    });
  }
  const videoPath = result.videoPath;
  const render: Partial<RenderOneResult> = {
    videoBytes: result.videoBytes,
    videoSeconds: result.videoSeconds,
    audioSeconds: result.audioSeconds,
    cachedSections: result.cachedSections,
    billedCharacters: result.billedCharacters,
  };

  if (!deliver) return done({ outcome: "rendered", label, videoPath, ...render });

  try {
    const delivered = await deliverVideo({
      auctionId,
      inputsHash,
      mp4Path: videoPath,
      countyName: input.countyName,
      state: input.state,
      saleDate: input.saleDate,
    });
    log(`  delivered: ${delivered.fileName} → ${delivered.webViewLink}`);
    return done({
      outcome: "delivered",
      label,
      videoPath,
      fileName: delivered.fileName,
      driveLink: delivered.webViewLink,
      reason: delivered.recorded ? undefined : "uploaded, but the facts moved during the upload — not recorded",
      ...render,
    });
  } catch (e) {
    /*
     * The video is good and stays recorded; only the hand-off failed. The error
     * goes on the row so the console says why nothing arrived, and the job is
     * failed by the caller so it is retried.
     */
    const message = `Drive delivery failed — ${e instanceof Error ? e.message : String(e)}`;
    await db
      .update(capeProductions)
      .set({ error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(capeProductions.auctionId, auctionId));
    return done({ outcome: "failed", reason: message, label, videoPath, ...render });
  }
}
