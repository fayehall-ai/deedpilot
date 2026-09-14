/*
 * No `server-only` guard — this is the CLI's entry point and shells out to
 * ffmpeg. See `lib/cape/script.ts` for the same reasoning.
 */
import { eq } from "drizzle-orm";
import path from "node:path";
import { db } from "@/lib/db";
import { capeProductions } from "@/lib/db/schema";
import { buildPackage, capeInputsHash, type PackageInput } from "./components";
import { generateCapeScript, estimateDurationSec, type CapeScript } from "./script";
import { leadInSec, renderSlides, TITLE_HOLD_SEC } from "./slides";
import {
  characterCount,
  estimateUsd,
  narrate,
  voiceConfigured,
  voiceProvider,
  VoiceUnavailableError,
} from "./voice";
import { encodeVideo, EncoderMissingError } from "./video";
import { countyPhotos } from "./photo";
import { readFile as readFileAsync } from "node:fs/promises";
import { blobConfigured, publishVideo } from "./publish";

/**
 * Component Seven, end to end: script, slides, narration, video.
 *
 * ## Why it advances in stages and records each one
 *
 * The four steps have wildly different costs and failure modes. A script is a
 * cheap model call; narration is metered speech; an encode is CPU and disk.
 * Recording the stage reached after each step means a run interrupted at the
 * encoder does not throw away the audio it already paid for, and a rerun
 * resumes rather than restarts.
 *
 * `stage` is therefore written as the work completes, not planned in advance.
 *
 * ## Why a failure still writes a row
 *
 * A package that failed at narration and a package nobody has attempted look
 * identical if failure writes nothing — the same distinction `lot_intel_runs`
 * exists to preserve one system over. The row carries the error so the next
 * operator sees why, rather than re-running into the same wall.
 */

export type ProduceStage = "pending" | "script" | "audio" | "video" | "failed";

export interface ProduceOptions {
  /** Root for artifacts. Slides, audio cache and MP4 land underneath. */
  outRoot: string;
  /** Stop after the script and slide plan — no speech, no encode, no spend. */
  scriptOnly?: boolean;
  /** Produce slides and video but skip narration. */
  silent?: boolean;
  /** Re-run even when the stored hash matches the current facts. */
  force?: boolean;
  /** Upload the finished video to Vercel Blob and record its public URL. */
  publish?: boolean;
  /** Hold every slide still instead of moving the camera. See `video.ts`. */
  still?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ProduceResult {
  auctionId: string;
  stage: ProduceStage;
  skipped?: string;
  inputsHash: string;
  script?: CapeScript;
  unsupportedFigures: string[];
  slideCount: number;
  audioSeconds?: number;
  characters?: number;
  estimatedUsd?: number;
  cachedSections?: number;
  videoPath?: string;
  videoSeconds?: number;
  videoUrl?: string;
  error?: string;
}

/** Filesystem-safe stem for this auction's artifacts. */
function slug(input: PackageInput): string {
  const county = (input.countyName ?? "county").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const state = (input.state ?? "xx").toLowerCase();
  return `${state}-${county}-${input.saleDate}`.replace(/-+/g, "-");
}

async function upsert(
  auctionId: string,
  patch: Partial<typeof capeProductions.$inferInsert>,
): Promise<void> {
  await db
    .insert(capeProductions)
    .values({ auctionId, inputsHash: patch.inputsHash ?? "", ...patch })
    .onConflictDoUpdate({
      target: capeProductions.auctionId,
      set: { ...patch, updatedAt: new Date() },
    });
}

/**
 * Produce one county package.
 *
 * Returns rather than throws for the ordinary refusals — nothing to do, no
 * speech provider — because a batch run over 152 packages must keep going.
 * A genuinely broken environment (no ffmpeg) still throws, since every
 * subsequent package would fail the same way.
 */
export async function produceCapePackage(
  input: PackageInput,
  opts: ProduceOptions,
): Promise<ProduceResult> {
  const log = opts.onProgress ?? (() => {});
  const inputsHash = capeInputsHash(input);
  const pkg = buildPackage(input);

  const base: ProduceResult = {
    auctionId: input.auctionId,
    stage: "pending",
    inputsHash,
    unsupportedFigures: [],
    slideCount: 0,
  };

  // Already produced from these exact facts.
  const [existing] = await db
    .select()
    .from(capeProductions)
    .where(eq(capeProductions.auctionId, input.auctionId))
    .limit(1);

  if (!opts.force && existing?.inputsHash === inputsHash && existing.videoPath) {
    return { ...base, stage: "video", skipped: "already produced from these facts" };
  }

  const outDir = path.join(opts.outRoot, slug(input));

  try {
    // --- 1. Script and slide plan -------------------------------------------
    log("  writing script…");
    const generated = await generateCapeScript(pkg, {
      countyName: input.countyName,
      state: input.state,
      saleDate: input.saleDate,
      saleDateConfirmed: input.saleDateConfirmed,
      saleType: input.saleType,
      platform: input.platform,
    });

    const script = generated.script;
    base.script = script;
    base.unsupportedFigures = generated.unsupportedFigures;
    base.slideCount = script.sections.length + 1; // + the title card

    await upsert(input.auctionId, {
      inputsHash,
      script: script as unknown as Record<string, unknown>,
      scriptModel: generated.model,
      unsupportedFigures: generated.unsupportedFigures,
      slidePlanCount: base.slideCount,
      stage: "script",
      error: null,
    });

    log(
      `  script: ${script.sections.length} section(s), ~${estimateDurationSec(script)}s, ` +
        `${generated.model}${generated.usedFallback ? " (fallback)" : ""}`,
    );

    /*
     * A script that spoke an uncomputed number stops here.
     *
     * Narrating it would spend money turning a wrong figure into audio, and
     * encoding it would put that figure in front of an audience. The row is
     * written so the checklist shows exactly which number, and a human decides.
     */
    if (generated.unsupportedFigures.length > 0) {
      log(`  HELD — unsupported figure(s): ${generated.unsupportedFigures.join(", ")}`);
      return { ...base, stage: "script", skipped: "narration contains unsupported figures" };
    }

    if (opts.scriptOnly) return { ...base, stage: "script" };

    // --- 2. Narration -------------------------------------------------------
    const characters = characterCount(script);
    base.characters = characters;

    let audioPaths: string[] = [];
    let sectionDurations = script.sections.map(() => 6);

    if (!opts.silent && voiceConfigured()) {
      const provider = voiceProvider()!;
      base.estimatedUsd = estimateUsd(characters, provider.name);
      log(
        `  narrating ${characters.toLocaleString()} chars via ${provider.name} ` +
          `(~$${base.estimatedUsd.toFixed(3)} if uncached)…`,
      );

      const sections = await narrate(script, { cacheDir: path.join(opts.outRoot, "_audio-cache") });
      audioPaths = sections.map((s) => s.mp3Path);
      sectionDurations = sections.map((s) => s.durationSec);
      base.audioSeconds = sections.reduce((n, s) => n + s.durationSec, 0);
      base.cachedSections = sections.filter((s) => s.cached).length;

      await upsert(input.auctionId, {
        inputsHash,
        audioPath: path.join(outDir, `${slug(input)}.narration.mp3`),
        audioDurationSec: String(base.audioSeconds.toFixed(2)),
        audioCharacters: characters,
        stage: "audio",
      });

      log(
        `  audio: ${Math.round(base.audioSeconds)}s, ` +
          `${base.cachedSections}/${sections.length} section(s) served from cache`,
      );
    } else {
      log(opts.silent ? "  silent run — skipping narration" : "  no speech provider — silent video");
    }

    // --- 3. Slides ----------------------------------------------------------
    const subtitle = `${input.countyName ?? ""}, ${input.state ?? ""} — sale ${input.saleDate}`.trim();
    /*
     * Decoration, and treated as such: a county with no safely-licensed
     * photograph simply does not get the slides. See `photo.ts`.
     */
    const photos = await countyPhotos(input.countyFips, input.countyName, input.state);

    /*
     * The brand artwork, read from disk and inlined as a data URI because the
     * SVG is rasterised without a base URL to resolve a relative path against.
     * Missing artwork falls back to the wordmark rather than failing the run.
     */
    const logo = await readFileAsync(path.join(process.cwd(), "public", "brand", "tdc-logo.png"))
      .then((b) => `data:image/png;base64,${b.toString("base64")}`)
      .catch(() => null);
    if (!logo) log("  brand logo not found at public/brand/tdc-logo.png — wordmark only");
    log(
      photos.length
        ? `  county photos: ${photos.length} (${photos.map((p) => p.credit.split(" — ")[1] ?? "?").join(", ")})`
        : "  no safely-licensed county photo — none inserted",
    );

    const slides = await renderSlides(
      script,
      subtitle,
      path.join(outDir, "slides"),
      sectionDurations,
      undefined,
      photos,
      logo,
    );
    log(`  slides: ${slides.length} rendered (title held ${TITLE_HOLD_SEC}s)`);

    // --- 4. Encode ----------------------------------------------------------
    log("  encoding…");
    const video = await encodeVideo({
      slides,
      audioPaths,
      outDir,
      name: slug(input),
      // Silence under the title and the photograph, so the voice does not run
      // ahead of the picture. See `silenceFile` in `video.ts`.
      leadInSec: leadInSec(),
      motion: !opts.still,
    });

    await upsert(input.auctionId, {
      inputsHash,
      videoPath: video.mp4Path,
      videoDurationSec: String(video.durationSec.toFixed(2)),
      videoBytes: video.bytes,
      stage: "video",
      error: null,
    });

    log(
      `  video: ${Math.round(video.durationSec)}s, ` +
        `${(video.bytes / 1_048_576).toFixed(1)} MB → ${video.mp4Path}`,
    );

    // --- 5. Publish ---------------------------------------------------------
    /*
     * Opt-in, because producing and distributing are different commitments —
     * see `publish.ts`. Encoding a batch for review must not put a batch of
     * videos on a public URL as a side effect.
     */
    let videoUrl: string | undefined;
    if (opts.publish) {
      if (!blobConfigured()) {
        log("  publish requested but BLOB_READ_WRITE_TOKEN is not set — kept local");
      } else {
        const published = await publishVideo(video.mp4Path, { slug: slug(input) });
        videoUrl = published.url;
        await upsert(input.auctionId, { inputsHash, videoUrl: published.url });
        log(
          `  published${published.alreadyPublished ? " (already up, not re-uploaded)" : ""}: ${published.url}`,
        );
      }
    }

    return {
      ...base,
      stage: "video",
      videoPath: video.mp4Path,
      videoSeconds: video.durationSec,
      videoUrl,
    };
  } catch (e) {
    // A missing encoder is an environment fault, not this package's — every
    // other package would fail identically, so it stops the run.
    if (e instanceof EncoderMissingError) throw e;

    const message = e instanceof Error ? e.message : String(e);
    await upsert(input.auctionId, { inputsHash, stage: "failed", error: message });

    /*
     * A dead speech key or an exhausted quota is a fact about the account, so
     * it aborts rather than grinding through the remaining packages recording
     * the same failure — the lesson `ProviderUnavailableError` already carries
     * one system over.
     */
    if (e instanceof VoiceUnavailableError && (e.status === 401 || e.status === 429)) throw e;

    log(`  FAILED: ${message}`);
    return { ...base, stage: "failed", error: message };
  }
}

/** The production row, in the shape the checklist reads. */
export async function productionStateFor(auctionId: string) {
  const [row] = await db
    .select()
    .from(capeProductions)
    .where(eq(capeProductions.auctionId, auctionId))
    .limit(1);
  if (!row) return null;
  return {
    inputsHash: row.inputsHash,
    hasScript: Boolean(row.script),
    slidePlanCount: row.slidePlanCount,
    hasAudio: Boolean(row.audioPath),
    hasVideo: Boolean(row.videoPath),
    unsupportedFigures: row.unsupportedFigures ?? [],
  };
}
