/*
 * No `server-only` guard — this is the CLI's entry point and shells out to
 * ffmpeg. See `lib/cape/script.ts` for the same reasoning.
 */
import { and, eq, sql } from "drizzle-orm";
import path from "node:path";
import { db } from "@/lib/db";
import { capeCountyScripts, capeProductions } from "@/lib/db/schema";
import {
  buildPackage,
  capeCountyInputsHash,
  capeInputsHash,
  type PackageInput,
} from "./components";
import {
  generateCapeScript,
  estimateDurationSec,
  type CapeScript,
  type CountyHalf,
} from "./script";
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
import { deliverVideo, VIDEO_SUBFOLDER } from "./deliver";
import { recordUsage } from "@/lib/ai/usage";

const VIDEO_DELIVERY_PATH = `CAPE/${VIDEO_SUBFOLDER}`;

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
  /** Per-provider deadline, for a caller running under a function ceiling. */
  scriptTimeoutMs?: number;
  /** Per-provider retry count for the script calls. */
  scriptAttempts?: number;
  /** Upload the finished video to Vercel Blob and record its public URL. */
  publish?: boolean;
  /**
   * Deliver the finished video to the CAPE folder on Google Drive and record
   * its link in `video_url`. See `deliver.ts`.
   */
  drive?: boolean;
  /**
   * Narrate the script already stored for these facts instead of writing a new
   * one.
   *
   * The render cron's mode. The script it renders is the one the script worker
   * wrote and the automatic checks passed; re-rolling it here would put an
   * unreviewed sample on video and spend a model call doing it. With no stored
   * script at the current hash this returns without doing anything, and a held
   * script stays held.
   */
  reuseScript?: boolean;
  /** Where narration is cached. Defaults to `<outRoot>/_audio-cache`. */
  audioCacheDir?: string;
  /** Also cache narration in Vercel Blob. See `VoiceOptions.remoteCache`. */
  remoteAudioCache?: boolean;
  /** How much of the deck moves: `all`, `opening`, or `none`. See `video.ts`. */
  motion?: "all" | "opening" | "none";
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
  /** Characters actually sent to the speech provider — cache hits excluded. */
  billedCharacters?: number;
  estimatedUsd?: number;
  cachedSections?: number;
  videoPath?: string;
  videoSeconds?: number;
  videoBytes?: number;
  videoUrl?: string;
  /** The Drive file name, when delivered. */
  deliveredAs?: string;
  error?: string;
}

/**
 * Why a stored script must not be narrated, or null when it may.
 *
 * The two holds `produceCapePackage` writes: a spoken figure the facts do not
 * support, and a script about the wrong county. Both are recorded on the row
 * rather than thrown, so anything deciding whether to render reads them here.
 */
export function heldReason(row: {
  unsupportedFigures: string[] | null;
  error: string | null;
}): string | null {
  if ((row.unsupportedFigures ?? []).length > 0) {
    return `unsupported figure(s): ${(row.unsupportedFigures ?? []).join(", ")}`;
  }
  if (row.error?.startsWith("wrong county")) return row.error;
  return null;
}

/**
 * Media fields, emptied whenever a new script is written.
 *
 * A video is a reading of one particular script. The row used to keep
 * `video_path` and `video_url` across a rewrite, so a package whose facts had
 * moved still reported a video "produced from these facts" — the old one — and
 * the checklist, the CLI's skip test and the render cron all believed it. With
 * these cleared, `inputs_hash` plus a video field means what it says.
 */
const NO_MEDIA = {
  audioPath: null,
  audioDurationSec: null,
  audioCharacters: null,
  videoPath: null,
  videoUrl: null,
  videoDurationSec: null,
  videoBytes: null,
} as const;

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

  /*
   * The same skip, measured against what this run is actually asked to make.
   *
   * The check above demands a `videoPath`, which a `--script-only` run never
   * writes — so every script-only run regenerated every script it had already
   * written. That is invisible on `--limit 1` and expensive across 476: a batch
   * that dies at package 300 and is restarted buys those 300 model calls a
   * second time, for identical output from identical facts.
   *
   * `stage` is not consulted on purpose. A package held at `script` for an
   * unsupported figure still has the script that was held, written from these
   * same facts, and re-rolling it is a fresh sample of the same distribution
   * rather than a fix. `--force` is how you ask for a new one.
   */
  if (!opts.force && opts.scriptOnly && existing?.inputsHash === inputsHash && existing.script) {
    return { ...base, stage: "script", skipped: "script already written from these facts" };
  }

  const outDir = path.join(opts.outRoot, slug(input));

  /*
   * Write a fresh script, or return the held result that stops the package.
   * Called inside the `try` below, so a failure here is recorded like any other.
   */
  const writeScript = async (): Promise<CapeScript | ProduceResult> => {
    log("  writing script…");

    /*
     * The county half, looked up before anything is written.
     *
     * Keyed on (county, sale type) and validated by hash, so the row is reused
     * only while the statute entry, the county rule and the submarket research
     * behind it are unchanged. `usedCount` is incremented on every reuse purely
     * so the saving is measurable after the fact — 815 sales across 523
     * counties is the estimate; this is the count.
     */
    const countyHash = capeCountyInputsHash(input);
    const countyKey = { fips: input.countyFips ?? "", saleType: input.saleType ?? "unknown" };

    const loadCountyHalf = async (): Promise<CountyHalf | null> => {
      if (!countyKey.fips || opts.force) return null;
      const [row] = await db
        .select()
        .from(capeCountyScripts)
        .where(
          and(
            eq(capeCountyScripts.countyFips, countyKey.fips),
            eq(capeCountyScripts.saleType, countyKey.saleType),
          ),
        )
        .limit(1);
      if (!row || row.inputsHash !== countyHash) return null;
      await db
        .update(capeCountyScripts)
        .set({ usedCount: sql`${capeCountyScripts.usedCount} + 1`, updatedAt: new Date() })
        .where(eq(capeCountyScripts.id, row.id));
      log(`  county half reused (written ${row.createdAt.toISOString().slice(0, 10)}, ${row.usedCount + 1} sales)`);
      return row.sections as unknown as CountyHalf;
    };

    const saveCountyHalf = async (half: CountyHalf, model: string) => {
      if (!countyKey.fips) return;
      await db
        .insert(capeCountyScripts)
        .values({
          countyFips: countyKey.fips,
          saleType: countyKey.saleType,
          inputsHash: countyHash,
          sections: half as unknown as Record<string, unknown>[],
          scriptModel: model,
          usedCount: 1,
        })
        .onConflictDoUpdate({
          target: [capeCountyScripts.countyFips, capeCountyScripts.saleType],
          set: {
            inputsHash: countyHash,
            sections: half as unknown as Record<string, unknown>[],
            scriptModel: model,
            usedCount: 1,
            updatedAt: new Date(),
          },
        });
    };

    const generated = await generateCapeScript(pkg, {
      countyName: input.countyName,
      state: input.state,
      saleDate: input.saleDate,
      saleDateConfirmed: input.saleDateConfirmed,
      saleType: input.saleType,
      platform: input.platform,
      population: input.population,
      countyFips: input.countyFips,
    }, {
      loadCountyHalf,
      saveCountyHalf,
      timeoutMs: opts.scriptTimeoutMs,
      attempts: opts.scriptAttempts,
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
      // The old audio and video read the old script. See `NO_MEDIA`.
      ...NO_MEDIA,
    });

    log(
      `  script: ${script.sections.length} section(s), ~${estimateDurationSec(script)}s, ` +
        `${generated.model}${generated.usedFallback ? " (fallback)" : ""}`,
    );
    /*
     * A script about the wrong county is held, not shipped.
     *
     * Treated exactly like an unsupported figure, and for the same reason: it
     * is a confident false statement that a viewer has no way to check, and the
     * next steps would spend money turning it into audio and then put it in
     * front of an audience. Held rather than retried, because a second roll of
     * the same dice is not a fix and a person should see that this happened.
     */
    if (generated.countyMismatch) {
      log(`  HELD — wrong county: ${generated.countyMismatch}`);
      await upsert(input.auctionId, {
        inputsHash,
        stage: "script",
        error: `wrong county — ${generated.countyMismatch}`,
      });
      return { ...base, stage: "script", skipped: "script names the wrong county" };
    }

    if (generated.countyLeak) {
      log(`  county half NOT cached — it names an occasion: ${generated.countyLeak.slice(0, 90)}`);
    }

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

    return script;
  };

  try {
    // --- 1. Script and slide plan -------------------------------------------
    let script: CapeScript;

    if (opts.reuseScript) {
      /*
       * The stored script, only if it was written from the facts now in force
       * and nothing held it. A held script is not narrated here any more than
       * it would have been when it was written — that is a person's call.
       */
      const stored = existing?.inputsHash === inputsHash ? existing.script : null;
      if (!existing || !stored) return { ...base, skipped: "no script written from these facts" };
      const held = heldReason(existing);
      if (held) {
        base.unsupportedFigures = existing.unsupportedFigures ?? [];
        return { ...base, stage: "script", skipped: `script held — ${held}` };
      }
      script = stored as unknown as CapeScript;
      base.script = script;
      base.slideCount = script.sections.length + 1; // + the title card
      log(
        `  script: reusing the stored one — ${script.sections.length} section(s), ` +
          `~${estimateDurationSec(script)}s, ${existing.scriptModel ?? "model unknown"}`,
      );
    } else {
      const written = await writeScript();
      if ("stage" in written) return written;
      script = written;
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

      const sections = await narrate(script, {
        cacheDir: opts.audioCacheDir ?? path.join(opts.outRoot, "_audio-cache"),
        remoteCache: opts.remoteAudioCache,
      });
      audioPaths = sections.map((s) => s.mp3Path);
      sectionDurations = sections.map((s) => s.durationSec);
      base.audioSeconds = sections.reduce((n, s) => n + s.durationSec, 0);
      base.cachedSections = sections.filter((s) => s.cached).length;

      /* The bill: characters actually synthesised, never cache hits. */
      const billed = sections.filter((s) => !s.cached);
      base.billedCharacters = billed.reduce((n, s) => n + s.characters, 0);
      if (base.billedCharacters > 0) {
        await recordUsage({
          provider: provider.name === "google" ? "google-tts" : provider.name,
          operation: "cape-narration",
          inputTokens: base.billedCharacters,
          requests: billed.length,
          countyFips: input.countyFips ?? null,
          note: `characters, not tokens — ${billed.length} section(s) for auction ${input.auctionId}`,
        });
      }

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
      motion: opts.motion ?? "opening",
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

    /*
     * Drive delivery, the team's destination. Also opt-in, for the same reason
     * as Blob: a review encode must not land in a shared folder by accident.
     */
    let deliveredAs: string | undefined;
    if (opts.drive) {
      log("  delivering to Drive…");
      const delivered = await deliverVideo({
        auctionId: input.auctionId,
        inputsHash,
        mp4Path: video.mp4Path,
        countyName: input.countyName,
        state: input.state,
        saleDate: input.saleDate,
      });
      videoUrl = delivered.webViewLink;
      deliveredAs = delivered.fileName;
      log(
        `  delivered to Drive (${delivered.created ? "new file" : "replaced in place"}): ` +
          `${VIDEO_DELIVERY_PATH}/${delivered.fileName} → ${delivered.webViewLink}` +
          (delivered.recorded ? "" : " — NOT recorded: the facts moved during the upload"),
      );
    }

    return {
      ...base,
      stage: "video",
      videoPath: video.mp4Path,
      videoSeconds: video.durationSec,
      videoBytes: video.bytes,
      videoUrl,
      deliveredAs,
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
