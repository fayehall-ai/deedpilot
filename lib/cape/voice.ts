/*
 * No `server-only` guard — this runs from `scripts/cape-produce.ts` under tsx.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CapeScript } from "./script";

/**
 * Narration audio, from whichever speech provider is configured.
 *
 * ## Why this is a chain and not a vendor
 *
 * The first version of this module was ElevenLabs and nothing else, which was
 * a pricing decision disguised as an implementation. Measured against the
 * actual workload — 152 packages at roughly two thousand characters each, so
 * about 304,000 characters for a full run — the spread between vendors is
 * larger than the whole rest of this system costs to operate:
 *
 *     Google Standard / WaveNet   $4 per million chars    ~$1.22 a run
 *     Google Neural2             $16 per million chars    ~$4.86 a run
 *     Google Chirp 3 HD          $30 per million chars    ~$9.12 a run
 *     ElevenLabs Flash v2.5      $50 per million chars   ~$15.20 a run
 *     ElevenLabs Scale/Business $120-165 per million    ~$36-50 a run
 *
 * Google's free tier is 4 million standard characters a month, which covers a
 * full CAPE run more than ten times over. So Google is the default and
 * ElevenLabs is the upgrade, rather than the other way round — and because
 * both sit behind one interface, that judgement can be revised by setting an
 * environment variable instead of by editing this file.
 *
 * ## This module spends money, and most of its design is about not spending it twice
 *
 * Every other source in this system is free. Speech is billed per character,
 * so the rule is that **identical text is never synthesised twice**. Each
 * section's audio is keyed by a hash of the exact text, the provider, the voice
 * and the model. A package regenerated because its sale date was confirmed
 * re-synthesises only the sections whose wording actually moved.
 *
 * ## Why per-section rather than one call
 *
 * The cache is only the first reason. Slides are held for exactly as long as
 * their own narration, which needs per-section durations that a single audio
 * file cannot give. And a failure halfway through costs one section rather than
 * the whole script.
 *
 * ## Unconfigured is not failed
 *
 * With no provider the module says so and the pipeline records the script and
 * slides as produced and the audio as absent — the same contract
 * `neighborhoodSource` uses for a missing Census key. A deployment state is not
 * an error, and half a package is worth more than none.
 */

export class VoiceUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} unavailable (${status}): ${message}`);
    this.name = "VoiceUnavailableError";
  }
}

interface VoiceProvider {
  name: string;
  configured(): boolean;
  /** Identity of this provider's current settings, for the cache key. */
  signature(): string;
  /** Returns MP3 bytes. */
  synthesise(text: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Google Cloud Text-to-Speech — the default
// ---------------------------------------------------------------------------

/**
 * Neural2 rather than Standard.
 *
 * Standard is a quarter of the price and sounds it — a flat, obviously
 * synthetic read that undercuts a briefing somebody is meant to trust. Neural2
 * at $16 per million is still a fraction of any ElevenLabs tier and is
 * comfortably good enough for narration over slides. Both are overridable.
 */
const GOOGLE_VOICE = process.env.CAPE_GOOGLE_VOICE ?? "en-US-Neural2-D";
const GOOGLE_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

/** Google rejects a request over 5,000 bytes of input. Sections are split below it. */
const GOOGLE_MAX_BYTES = 4800;

const googleProvider: VoiceProvider = {
  name: "google",
  configured: () => Boolean(process.env.GOOGLE_TTS_API_KEY),
  signature: () => `google|${GOOGLE_VOICE}`,

  async synthesise(text: string): Promise<Buffer> {
    const key = process.env.GOOGLE_TTS_API_KEY!;
    const chunks = splitForBytes(text, GOOGLE_MAX_BYTES);
    const parts: Buffer[] = [];

    for (const chunk of chunks) {
      const res = await fetch(`${GOOGLE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { text: chunk },
          voice: { languageCode: GOOGLE_VOICE.slice(0, 5), name: GOOGLE_VOICE },
          audioConfig: {
            audioEncoding: "MP3",
            // Slightly under natural pace. This is read to someone who may be
            // taking notes on a deadline and a redemption period.
            speakingRate: 0.96,
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new VoiceUnavailableError("google", res.status, body.slice(0, 300));
      }

      const json = (await res.json()) as { audioContent?: string };
      if (!json.audioContent) {
        throw new VoiceUnavailableError("google", res.status, "no audioContent in response");
      }
      parts.push(Buffer.from(json.audioContent, "base64"));
    }

    /*
     * Concatenated MP3 frames. Valid for playback and for ffmpeg, which
     * re-encodes the track anyway when it assembles the video, so no container
     * surgery is needed here.
     */
    return Buffer.concat(parts);
  },
};

// ---------------------------------------------------------------------------
// ElevenLabs — the upgrade
// ---------------------------------------------------------------------------

/** Rachel — a stable, widely-used default voice. */
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
/** Turbo is the cheapest ElevenLabs tier that suits long-form English narration. */
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5";

const elevenLabsProvider: VoiceProvider = {
  name: "elevenlabs",
  configured: () => Boolean(process.env.ELEVENLABS_API_KEY),
  signature: () => `elevenlabs|${ELEVEN_VOICE}|${ELEVEN_MODEL}`,

  async synthesise(text: string): Promise<Buffer> {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: {
          // Steady rather than expressive. This is a briefing read, and a voice
          // that performs the material undercuts it.
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new VoiceUnavailableError("elevenlabs", res.status, body.slice(0, 300));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new VoiceUnavailableError("elevenlabs", res.status, "empty body");
    return buf;
  },
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Cheapest adequate first. `CAPE_VOICE_PROVIDER` overrides the order. */
const PROVIDERS: VoiceProvider[] = [googleProvider, elevenLabsProvider];

export function voiceProvider(): VoiceProvider | null {
  const forced = process.env.CAPE_VOICE_PROVIDER?.toLowerCase();
  if (forced) {
    const p = PROVIDERS.find((x) => x.name === forced);
    /*
     * A named provider that is not configured is an error rather than a
     * fallback. Someone who set `CAPE_VOICE_PROVIDER=elevenlabs` and got Google
     * would be billed for the wrong thing and never told.
     */
    if (p && !p.configured()) {
      throw new VoiceUnavailableError(p.name, 0, `CAPE_VOICE_PROVIDER=${forced} but no key is set`);
    }
    if (p) return p;
  }
  return PROVIDERS.find((p) => p.configured()) ?? null;
}

export function voiceConfigured(): boolean {
  try {
    return voiceProvider() !== null;
  } catch {
    return false;
  }
}

/** Split on sentence boundaries so a chunk never breaks mid-word. */
function splitForBytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (Buffer.byteLength(current + s, "utf8") > maxBytes && current) {
      out.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface VoiceOptions {
  /** Where synthesised audio is cached, keyed by content hash. */
  cacheDir: string;
}

export interface SynthesisedSection {
  index: number;
  mp3Path: string;
  durationSec: number;
  characters: number;
  /** True when the file already existed and nothing was billed. */
  cached: boolean;
  provider: string;
}

/** Identity of a piece of audio: the text and the provider's settings. */
function audioKey(text: string, signature: string): string {
  return createHash("sha256").update(`${signature}|${text}`).digest("hex").slice(0, 24);
}

/**
 * How long an MP3 runs, read from the file rather than estimated.
 *
 * Slide timing is derived from this, so a guess shows up as picture drifting
 * out of step with the voice — the most visible defect a produced video can
 * have. `ffprobe` ships with ffmpeg, which the encoder already requires.
 */
async function durationOf(mp3Path: string): Promise<number> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    mp3Path,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no duration for ${mp3Path}`);
  }
  return seconds;
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** Narrate every section of a script. */
export async function narrate(
  script: CapeScript,
  opts: VoiceOptions,
): Promise<SynthesisedSection[]> {
  const provider = voiceProvider();
  if (!provider) {
    throw new VoiceUnavailableError(
      "none",
      0,
      "no speech provider configured — set GOOGLE_TTS_API_KEY (cheapest) or ELEVENLABS_API_KEY",
    );
  }

  await mkdir(opts.cacheDir, { recursive: true });
  const signature = provider.signature();
  const out: SynthesisedSection[] = [];

  for (const [index, section] of script.sections.entries()) {
    const text = section.narration.trim();
    if (!text) continue;

    const mp3Path = path.join(opts.cacheDir, `${audioKey(text, signature)}.mp3`);
    const cached = await exists(mp3Path);
    if (!cached) {
      await writeFile(mp3Path, await provider.synthesise(text));
    }

    out.push({
      index,
      mp3Path,
      durationSec: await durationOf(mp3Path),
      characters: text.length,
      cached,
      provider: provider.name,
    });
  }

  return out;
}

/**
 * What a script would cost to narrate, before narrating it.
 *
 * Exported so the CLI can print it and a caller can refuse. Characters are the
 * billed unit, and surfacing them matters because "152 packages" is an
 * abstraction while "304,000 characters, about a dollar twenty" is a number
 * somebody can weigh against a plan.
 */
export function characterCount(script: CapeScript): number {
  return script.sections.reduce((n, s) => n + s.narration.trim().length, 0);
}

/** Indicative USD per million characters, for the CLI's estimate. */
export const RATE_PER_MILLION: Record<string, number> = {
  google: 16,
  elevenlabs: 50,
};

export function estimateUsd(characters: number, provider: string): number {
  const rate = RATE_PER_MILLION[provider] ?? 0;
  return (characters / 1_000_000) * rate;
}
