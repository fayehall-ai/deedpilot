/*
 * No `server-only` guard — the producer CLI runs this under plain tsx, and the
 * render cron runs it inside a Vercel function.
 */
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Which ffmpeg, and how to ask it about a file.
 *
 * ## Why the binary ships with the app
 *
 * The encode used to shell out to whatever `ffmpeg` was on PATH, which meant a
 * laptop with Homebrew. A Vercel function has no ffmpeg and no package manager,
 * so the render cron could not exist until the binary travelled with the code.
 * `ffmpeg-static` downloads a static build for the install platform into
 * `node_modules/ffmpeg-static/ffmpeg`; `next.config.ts` traces that one file
 * into the render route's bundle.
 *
 * The path is resolved from the working directory rather than by requiring the
 * package. A bundled `require("ffmpeg-static")` answers relative to the chunk
 * it was bundled into, not to `node_modules`, and would point at a file that is
 * not there. `process.cwd()` is the project root both under tsx and in the
 * function (`/var/task`), which is the same assumption the ingest registry
 * already relies on.
 *
 * ## Why there is no ffprobe
 *
 * Every probe this pipeline makes — a duration, a frame size — is in the header
 * ffmpeg prints when handed an input and no output. The only static ffprobe on
 * npm ships every platform's binary in one 350 MB package, and a Vercel
 * function's whole bundle is capped at 250 MB. Reading ffmpeg's banner costs
 * precision to the hundredth of a second, which is a quarter of a frame at 24
 * fps and invisible in a slide held for thirty seconds.
 *
 * ## Resolution order
 *
 *  1. `FFMPEG_PATH`, for anyone who needs a particular build.
 *  2. The bundled binary — copied to the temp directory and made executable if
 *     the bundle lost its mode bit, since `/var/task` is read-only.
 *  3. `ffmpeg` on PATH, so a checkout without the optional download still works.
 */

let resolved: Promise<string> | null = null;

async function executable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** The bundled binary's location, whether or not it is there. */
export function bundledFfmpegPath(): string {
  return path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
}

async function resolveFfmpeg(): Promise<string> {
  const forced = process.env.FFMPEG_PATH?.trim();
  if (forced) return forced;

  const bundled = bundledFfmpegPath();
  if (await exists(bundled)) {
    if (await executable(bundled)) return bundled;
    /*
     * Present but not executable: a deployment that dropped the mode bit. The
     * bundle's filesystem is read-only, so the copy goes to the temp dir.
     */
    const dir = path.join(os.tmpdir(), "cape-bin");
    await mkdir(dir, { recursive: true });
    const copy = path.join(dir, "ffmpeg");
    if (!(await executable(copy))) {
      await copyFile(bundled, copy);
      await chmod(copy, 0o755);
    }
    return copy;
  }

  return "ffmpeg";
}

/** Absolute path to the ffmpeg this process will use, or `ffmpeg` for PATH. */
export function ffmpegPath(): Promise<string> {
  resolved ??= resolveFfmpeg().catch((e) => {
    resolved = null;
    throw e;
  });
  return resolved;
}

/** Run ffmpeg with the resolved binary. Rejects on a non-zero exit. */
export async function runFfmpeg(
  args: string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = await ffmpegPath();
  return exec(bin, args, { maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 32 });
}

export interface MediaInfo {
  /** Seconds, or 0 when the container states none (a still image). */
  durationSec: number;
  width: number | null;
  height: number | null;
}

/**
 * Parse the input banner ffmpeg prints for `-i <file>`.
 *
 * Exported for the test. The two lines it reads look like:
 *
 *     Duration: 00:03:13.62, start: 0.025057, bitrate: 128 kb/s
 *     Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 1920x1080, 25 fps
 */
export function parseMediaBanner(stderr: string): MediaInfo {
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = /Stream #[^\n]*?Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: v ? Number(v[1]) : null,
    height: v ? Number(v[2]) : null,
  };
}

/**
 * Duration and frame size of a media file, from ffmpeg's banner.
 *
 * `ffmpeg -i file` with no output exits non-zero by design ("At least one
 * output file must be specified") after printing everything wanted here, so the
 * failure is the normal path and its stderr is the answer. A file ffmpeg cannot
 * open at all has no `Input #0` line, and that is the error thrown.
 */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const bin = await ffmpegPath();
  let stderr = "";
  try {
    const out = await exec(bin, ["-hide_banner", "-nostdin", "-i", file], { maxBuffer: 1024 * 1024 * 4 });
    stderr = out.stderr;
  } catch (e) {
    const err = e as { stderr?: string; code?: string };
    if (err.code === "ENOENT") throw e;
    stderr = err.stderr ?? "";
  }
  if (!/Input #0/.test(stderr)) {
    throw new Error(`ffmpeg could not read ${file}: ${stderr.trim().split("\n").slice(-1)[0] ?? "no output"}`);
  }
  return parseMediaBanner(stderr);
}
