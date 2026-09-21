/*
 * No `server-only` guard — this shells out to ffmpeg from `scripts/cape-produce.ts`
 * and from the render cron.
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RenderedSlide } from "./slides";
import { bundledFfmpegPath, ffmpegPath, probeMedia, runFfmpeg } from "./ffmpeg";

/**
 * The encode: slides plus narration into one MP4.
 *
 * ## Why ffmpeg and not a JavaScript renderer
 *
 * Remotion is the obvious modern answer and it carries a commercial licence
 * that this product would have to buy, plus a headless browser to drive it.
 * ffmpeg ships with the app (`ffmpeg.ts`), is unencumbered, and the job here is genuinely
 * simple: hold each still for a known number of seconds and lay one audio track
 * underneath. That is a concat demuxer and a single encode.
 *
 * ## Why the concat demuxer rather than a filter graph
 *
 * A filter graph with per-image `loop` filters is the other way, and it builds
 * a command line that grows with the number of slides until it becomes
 * unreadable and, past a few dozen inputs, unreliable. The concat demuxer takes
 * a text file listing each frame and how long to hold it. The list is
 * inspectable, diffable, and identical in shape whether there are four slides
 * or forty.
 *
 * ## Why the last frame is repeated
 *
 * The concat demuxer ignores the duration of the final entry — a documented
 * quirk, not a bug — so the last slide would flash past in one frame time. The
 * fix is to list it twice, which is why `buildConcatList` appends it again.
 * Losing the closing slide is exactly the kind of defect that survives review
 * because nobody watches to the end of every render.
 */

export interface EncodeResult {
  mp4Path: string;
  durationSec: number;
  bytes: number;
}

export class EncoderMissingError extends Error {}

/** Fail early and by name, rather than with an ENOENT from a child process. */
export async function assertEncoderAvailable(): Promise<void> {
  const bin = await ffmpegPath().catch(() => "ffmpeg");
  try {
    await runFfmpeg(["-hide_banner", "-version"]);
  } catch (e) {
    throw new EncoderMissingError(
      `ffmpeg is not usable (tried ${bin}; bundled path ${bundledFfmpegPath()}): ` +
        `${e instanceof Error ? e.message : String(e)}. Run \`npm install\` so ffmpeg-static ` +
        `downloads its binary, set FFMPEG_PATH, or install ffmpeg on PATH. ` +
        `CAPE Component Seven cannot encode without it.`,
    );
  }
}

/**
 * The concat demuxer's playlist.
 *
 * Paths are quoted and single quotes escaped: a slide directory under a path
 * containing an apostrophe would otherwise produce a playlist ffmpeg parses
 * into nonsense.
 */
export function buildConcatList(slides: RenderedSlide[]): string {
  const line = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;
  const parts: string[] = [];

  for (const s of slides) {
    parts.push(line(s.pngPath));
    parts.push(`duration ${Math.max(0.5, s.durationSec).toFixed(3)}`);
  }

  // See the module note: the final entry's duration is ignored, so it is
  // repeated to give the closing slide its full time on screen.
  const last = slides[slides.length - 1];
  if (last) parts.push(line(last.pngPath));

  return parts.join("\n") + "\n";
}

/** Pixel dimensions of a rendered slide, so the clips match it exactly. */
async function probeSize(file: string): Promise<{ width: number; height: number }> {
  if (!file) return { width: 1920, height: 1080 };
  const { width, height } = await probeMedia(file);
  return width && height ? { width, height } : { width: 1920, height: 1080 };
}

/** Duration of a media file, from ffmpeg's banner. See `ffmpeg.ts` on why not ffprobe. */
async function probeDuration(file: string): Promise<number> {
  const { durationSec } = await probeMedia(file);
  return durationSec > 0 ? durationSec : 0;
}

/**
 * Silence, to sit under the slides that have nothing spoken over them.
 *
 * Without this the audio began at the first narrated word while the picture
 * began at the title card, so every slide ran behind its own narration by the
 * length of the lead-in — three seconds, on every video ever produced here —
 * and the encode, being cut at the narration's length, took those three
 * seconds off the closing slide instead. The opening of section one was spoken
 * over the title.
 *
 * Generating the gap rather than shortening the lead-in keeps the title card
 * on screen for as long as it was designed to be.
 */
async function silenceFile(seconds: number, outPath: string): Promise<string> {
  await runFfmpeg([
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", seconds.toFixed(3),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    outPath,
  ]);
  return outPath;
}

/** Concatenate the per-section narration into one continuous track. */
async function concatAudio(mp3Paths: string[], outPath: string): Promise<void> {
  const listPath = `${outPath}.txt`;
  await writeFile(
    listPath,
    mp3Paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    "utf8",
  );
  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    // Re-encoded rather than stream-copied: the cached section files can differ
    // in bitrate, and copying mismatched streams produces an audio track whose
    // timestamps drift away from the slides over the length of the video.
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    outPath,
  ]);
}

/**
 * One slide, as a clip that moves.
 *
 * ## Why each slide is encoded separately
 *
 * The module note above explains why the concat demuxer beat a filter graph
 * for stills, and that reasoning holds harder here: `zoompan` per input would
 * put eleven of these in one command line. Encoding each clip on its own and
 * concatenating the results keeps the command the same shape whether there are
 * four slides or forty, and a failure names the slide it happened on.
 *
 * ## Why the source is upscaled first
 *
 * `zoompan` computes an integer crop per frame, so zooming a 1920-wide still
 * directly steps a whole pixel at a time and reads as judder rather than as a
 * camera move. Scaling up first makes each step a fraction of an output pixel.
 * 2x is the point where it looks smooth without the frame buffer getting
 * expensive.
 *
 * ## Why the direction alternates
 *
 * A deck where every shot pushes in the same way reads as a slideshow with an
 * effect applied. Alternating in and out, keyed to the slide index so it is
 * deterministic, is what the reference briefings do.
 */
async function renderSlideClip(
  pngPath: string,
  seconds: number,
  outPath: string,
  opts: { fps: number; width: number; height: number; index: number; move: boolean },
): Promise<string> {
  const { fps, width, height, index, move } = opts;
  const frames = Math.max(1, Math.round(seconds * fps));
  const zoomIn = index % 2 === 0;
  /* Slow: about 8% across the whole slide, whatever its length. */
  const span = 0.08;
  const z = zoomIn
    ? `min(1+${span}*on/${frames},${1 + span})`
    : `max(${1 + span}-${span}*on/${frames},1)`;

  /*
   * A held slide is still encoded as a clip, so every segment the demuxer
   * joins has the same encoder, rate and pixel format and the final mux can
   * stream-copy. It costs almost nothing: a static clip is a keyframe and a
   * few hundred near-empty frames.
   */
  const vf = move
    ? `scale=${width * 2}:${height * 2},` +
      `zoompan=z='${z}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`
    : `scale=${width}:${height},setsar=1,format=yuv420p,fps=${fps}`;

  /*
   * A held slide is read once a second, not once a frame.
   *
   * `-loop 1` re-decodes the PNG for every input frame, and at the image
   * demuxer's default 25 a second that was over half the CPU of a held clip —
   * decoding and scaling the same 1080p still 800 times. At `-framerate 1` the
   * `fps` filter duplicates the frame instead. Measured on a 33-second slide,
   * single-threaded: 17.4 s of CPU down to 9.7 s, and the output is the same
   * file byte for byte. It matters because the render cron has one vCPU.
   */
  const input = move ? ["-loop", "1"] : ["-loop", "1", "-framerate", "1"];

  await runFfmpeg(
    [
      "-y",
      ...input,
      "-i", pngPath,
      "-vf", vf,
      "-frames:v", String(frames),
      "-c:v", "libx264",
      "-preset", x264Preset(),
      "-crf", "20",
      "-r", String(fps),
      outPath,
    ],
    { maxBuffer: 1024 * 1024 * 32 },
  );
  return outPath;
}

/**
 * The x264 preset for every clip — one value, so the clips stay stream-
 * copyable into one file.
 *
 * `medium` is the cut that was reviewed. `CAPE_X264_PRESET=veryfast` is the
 * lever if a render ever nears the function ceiling: measured on a held slide
 * it is five times faster and 20% smaller, at 52.5 dB PSNR against medium's
 * 55 — both far past visible on a still.
 */
function x264Preset(): string {
  const p = process.env.CAPE_X264_PRESET?.trim();
  return p && /^(ultrafast|superfast|veryfast|faster|fast|medium|slow)$/.test(p) ? p : "medium";
}

export interface EncodeOptions {
  slides: RenderedSlide[];
  /** Per-section narration, in order. Empty produces a silent slide deck. */
  audioPaths: string[];
  outDir: string;
  /** Base filename without extension. */
  name: string;
  fps?: number;
  /**
   * Seconds of slide shown before the narration starts — the title card, and
   * anything else held silently in front of it. Padded onto the audio so
   * picture and voice stay in step.
   */
  leadInSec?: number;
  /**
   * How much of the deck moves. Defaults to `opening`.
   *
   * The move costs roughly five times the file — 103 MB against 22 for the
   * same briefing — and that is bandwidth on every view, which is what
   * suspended this account once already. `opening` is the default after review:
   * the title card moves, which is where a viewer decides whether this is a
   * video or a slideshow, and the sections that follow hold. It lands within
   * half a megabyte of a fully still cut — 22.3 MB against 21.8 — where moving
   * the whole deck costs 102.5.
   */
  motion?: "all" | "opening" | "none";
}

/**
 * Encode the final MP4.
 *
 * Produces a silent video when there is no audio, rather than refusing. A deck
 * with correct slides and no narration is a usable review artifact and is what
 * a run without an ElevenLabs key should leave behind; refusing would throw
 * away the script and slide work that already succeeded.
 */
export async function encodeVideo(opts: EncodeOptions): Promise<EncodeResult> {
  await assertEncoderAvailable();
  await mkdir(opts.outDir, { recursive: true });

  const fps = opts.fps ?? 24;
  const concatPath = path.join(opts.outDir, `${opts.name}.concat.txt`);
  const mp4Path = path.join(opts.outDir, `${opts.name}.mp4`);

  /*
   * Each slide becomes its own moving clip, and the demuxer concatenates those
   * instead of stills. The playlist is still written — it is the inspectable
   * record of what was held for how long, and the first thing to read when a
   * cut looks wrong.
   */
  await writeFile(concatPath, buildConcatList(opts.slides), "utf8");

  const motion = opts.motion ?? "opening";

  const clipDir = path.join(opts.outDir, "clips");
  await mkdir(clipDir, { recursive: true });
  let videoInput = concatPath;

  if (motion !== "none") {
    const { width, height } = await probeSize(opts.slides[0]?.pngPath ?? "");
    const clips: string[] = [];
    for (const [i, slide] of opts.slides.entries()) {
      clips.push(
        await renderSlideClip(
          slide.pngPath,
          Math.max(0.5, slide.durationSec),
          path.join(clipDir, `clip-${String(i).padStart(3, "0")}.mp4`),
          { fps, width, height, index: i, move: motion === "all" || i === 0 },
        ),
      );
    }
    videoInput = path.join(opts.outDir, `${opts.name}.clips.txt`);
    await writeFile(
      videoInput,
      clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
      "utf8",
    );
  }

  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", videoInput,
  ];

  let audioPath: string | null = null;
  if (opts.audioPaths.length > 0) {
    audioPath = path.join(opts.outDir, `${opts.name}.narration.mp3`);
    const leadIn = opts.leadInSec ?? 0;
    const paths =
      leadIn > 0
        ? [await silenceFile(leadIn, path.join(opts.outDir, `${opts.name}.leadin.mp3`)), ...opts.audioPaths]
        : opts.audioPaths;
    await concatAudio(paths, audioPath);
    args.push("-i", audioPath);
  }

  /*
   * Stream-copied. Every clip was written by `renderSlideClip` with the same
   * encoder, rate and pixel format — `yuv420p` among them, which is not
   * optional: without it ffmpeg picks a format from the PNG source that
   * QuickTime, Safari and most social platforms refuse to play, and the file
   * encodes cleanly then will not open. Re-encoding here would cost a second
   * generation of loss for nothing.
   */
  if (motion !== "none") {
    args.push("-c:v", "copy");
  } else {
    /*
     * Stills go through the encoder, since there is nothing to copy — and
     * `yuv420p` is not optional here: without it ffmpeg picks a format from the
     * PNG source that QuickTime, Safari and most social platforms refuse to
     * play, and the file encodes cleanly then will not open.
     */
    args.push(
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      // Even dimensions, or libx264 rejects the stream outright.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-preset", "medium",
      "-crf", "20",
    );
  }

  if (audioPath) {
    args.push("-c:a", "aac", "-b:a", "192k");
    /*
     * An explicit duration, not `-shortest`.
     *
     * `-shortest` is the documented way to end an output with its shortest
     * input and it does not constrain a concat-demuxer image stream, whose
     * length is not known until it ends. Measured: a narration of 193.6s
     * produced a 223.5s file — thirty seconds of a frozen final slide over
     * silence, on every narrated video.
     *
     * The extra time is the last-frame repeat above, which the demuxer plays
     * for an unspecified stretch. Both problems disappear if the output is cut
     * at a length we actually know, and after concatenation the narration's own
     * duration is exactly that.
     */
    const narrationSec = await probeDuration(audioPath);
    if (narrationSec > 0) args.push("-t", narrationSec.toFixed(3));
    else args.push("-shortest");
  } else {
    /*
     * Silent decks have no audio to cut against, so they are bounded by the
     * slide plan — otherwise the repeated final frame runs on past the end.
     */
    const planned = opts.slides.reduce((n, s) => n + Math.max(0.5, s.durationSec), 0);
    if (planned > 0) args.push("-t", planned.toFixed(3));
  }

  args.push(mp4Path);

  await runFfmpeg(args, { maxBuffer: 1024 * 1024 * 32 });

  const s = await stat(mp4Path);
  return {
    mp4Path,
    durationSec: await probeDuration(mp4Path),
    bytes: s.size,
  };
}
