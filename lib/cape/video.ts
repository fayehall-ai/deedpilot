/*
 * No `server-only` guard — this shells out to ffmpeg from `scripts/cape-produce.ts`.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RenderedSlide } from "./slides";

const run = promisify(execFile);

/**
 * The encode: slides plus narration into one MP4.
 *
 * ## Why ffmpeg and not a JavaScript renderer
 *
 * Remotion is the obvious modern answer and it carries a commercial licence
 * that this product would have to buy, plus a headless browser to drive it.
 * ffmpeg is already installed, is unencumbered, and the job here is genuinely
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
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      await run(bin, ["-version"]);
    } catch {
      throw new EncoderMissingError(
        `${bin} is not on PATH. Install it with \`brew install ffmpeg\` (macOS) or ` +
          `\`apt-get install ffmpeg\` (Debian). CAPE Component Seven cannot encode without it.`,
      );
    }
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

/** Concatenate the per-section narration into one continuous track. */
async function concatAudio(mp3Paths: string[], outPath: string): Promise<void> {
  const listPath = `${outPath}.txt`;
  await writeFile(
    listPath,
    mp3Paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    "utf8",
  );
  await run("ffmpeg", [
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

export interface EncodeOptions {
  slides: RenderedSlide[];
  /** Per-section narration, in order. Empty produces a silent slide deck. */
  audioPaths: string[];
  outDir: string;
  /** Base filename without extension. */
  name: string;
  fps?: number;
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

  await writeFile(concatPath, buildConcatList(opts.slides), "utf8");

  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
  ];

  let audioPath: string | null = null;
  if (opts.audioPaths.length > 0) {
    audioPath = path.join(opts.outDir, `${opts.name}.narration.mp3`);
    await concatAudio(opts.audioPaths, audioPath);
    args.push("-i", audioPath);
  }

  args.push(
    "-c:v", "libx264",
    /*
     * `yuv420p` is not optional. Without it ffmpeg picks a pixel format from
     * the PNG source that QuickTime, Safari and most social platforms refuse to
     * play — the video encodes cleanly and then will not open on the machines
     * the audience actually uses.
     */
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    // Even dimensions, or libx264 rejects the stream outright.
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-preset", "medium",
    "-crf", "20",
  );

  if (audioPath) {
    args.push("-c:a", "aac", "-b:a", "192k");
    // The slides are timed to the narration, so the two should end together;
    // `-shortest` stops a rounding difference leaving a frozen tail frame.
    args.push("-shortest");
  }

  args.push(mp4Path);

  await run("ffmpeg", args, { maxBuffer: 1024 * 1024 * 32 });

  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    mp4Path,
  ]);

  const s = await stat(mp4Path);
  return {
    mp4Path,
    durationSec: Number(stdout.trim()) || 0,
    bytes: s.size,
  };
}
