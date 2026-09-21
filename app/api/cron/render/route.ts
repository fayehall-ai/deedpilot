/**
 * The CAPE render worker: one briefing video per tick, delivered to Drive.
 *
 * ## What a tick does
 *
 *  1. Tops up the queue — `enqueueCapeVideos` finds the top-N sales in each
 *     weekly batch whose current script passed the automatic checks and has no
 *     delivery recorded, and queues a `cape-video:` job for each (bounded).
 *  2. Claims one job from `LANES.render` and runs `renderOne`: narrate the
 *     stored script, draw the slides, encode with the bundled ffmpeg, upload to
 *     `CAPE/Video/<County>_County_<ST>_<date>.mp4`, write the link to
 *     `cape_productions.video_url`.
 *
 * ## Why one at a time
 *
 * An encode is CPU for minutes on a one-vCPU function, and Fluid compute may
 * put two overlapping invocations on the same instance — where two encodes
 * would each run at half speed and both miss the ceiling. So a tick that finds
 * a render already leased returns without claiming. Sixteen videos at one per
 * ten-minute tick is under three hours, against a batch due a week later.
 *
 * ## Why it refuses to start rather than failing jobs
 *
 * Missing Drive credentials, a missing speech key or a broken ffmpeg would fail
 * every job identically, and a failed job is retried — so each of those is
 * checked before anything is claimed, and the tick says which one is missing.
 * A render with no speech key would otherwise deliver a silent video to the
 * team's folder, which is worse than none.
 *
 * `CAPE_RENDER_DISABLED=1` stops it without a deploy; `videoTopN = 0` on the
 * console stops new work being queued.
 */
import { NextResponse, type NextRequest } from "next/server";
import { rm } from "node:fs/promises";
import path from "node:path";
import { claimNext, completeJob, extendLease, failJob, LANES, reapDeadJobs } from "@/lib/admin/queue";
import { enqueueCapeVideos, renderInFlight, videoAuctionId } from "@/lib/admin/video-jobs";
import { getPipelineConfig } from "@/lib/admin/pipeline-settings";
import { cronAuthorised } from "@/lib/admin/cron-auth";
import { capePackageInputs } from "@/lib/cape/inputs";
import { renderOne } from "@/lib/cape/render";
import { assertEncoderAvailable } from "@/lib/cape/video";
import { voiceConfigured } from "@/lib/cape/voice";
import { driveConfigured } from "@/lib/delivery/drive";

/*
 * The Pro ceiling. A measured render of a 3-minute briefing is well inside it
 * (see the commit that added this route); the headroom is for a long script on
 * a cold instance.
 */
export const maxDuration = 800;

/**
 * The claimed job's lease, past the function's own ceiling.
 *
 * `claimNext` leases for ten minutes and a render may run for thirteen. A lease
 * that lapsed mid-render would let the next tick claim the same sale and buy
 * its narration twice; fifteen minutes cannot lapse while this invocation lives.
 */
const RENDER_LEASE_MS = 15 * 60 * 1000;

const OUT_ROOT = "/tmp/cape";

/** Same contract as `/api/cron/cape`: the cron's bearer secret, Vercel's header, or the operator token. */
const authorised = cronAuthorised;

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();

  if (/^(1|true|yes)$/i.test(process.env.CAPE_RENDER_DISABLED ?? "")) {
    return NextResponse.json({ ok: true, stopped: "CAPE_RENDER_DISABLED" });
  }

  const missing = [
    driveConfigured() ? null : "Drive delivery not configured — set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_CAPE_FOLDER_ID",
    voiceConfigured() ? null : "no speech provider — set GOOGLE_TTS_API_KEY or ELEVENLABS_API_KEY",
  ].filter((m): m is string => Boolean(m));
  if (missing.length) {
    return NextResponse.json({ ok: false, error: missing.join("; ") }, { status: 503 });
  }

  await reapDeadJobs();

  const [config, inputs] = await Promise.all([getPipelineConfig(), capePackageInputs()]);
  const fill = await enqueueCapeVideos({ topN: config.videoTopN, inputs });

  if ((await renderInFlight()) > 0) {
    return NextResponse.json({ ok: true, busy: "a render is already running", fill, elapsedMs: Date.now() - started });
  }

  try {
    await assertEncoderAvailable();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), fill },
      { status: 500 },
    );
  }

  const job = await claimNext(new Date(), LANES.render);
  if (!job) {
    return NextResponse.json({ ok: true, idle: "nothing to render", fill, elapsedMs: Date.now() - started });
  }
  await extendLease(job.id, RENDER_LEASE_MS);

  const auctionId = videoAuctionId(job.adapter);
  const lines: string[] = [];
  try {
    const result = await renderOne(auctionId, {
      inputs,
      outRoot: OUT_ROOT,
      onProgress: (m) => {
        lines.push(m);
        console.log(`[render] ${m}`);
      },
    });

    const summary = {
      outcome: result.outcome,
      label: result.label ?? null,
      reason: result.reason ?? null,
      file: result.fileName ?? null,
      link: result.driveLink ?? null,
      bytes: result.videoBytes ?? null,
      seconds: result.videoSeconds ?? null,
      billedCharacters: result.billedCharacters ?? 0,
      cachedSections: result.cachedSections ?? null,
      wallMs: result.wallMs,
    };

    if (result.outcome === "failed") {
      await failJob(job.id, result.reason ?? "render failed");
    } else {
      await completeJob(job.id, summary);
    }

    /* `/tmp` is 512 MB and a warm instance keeps it; a delivered render's frames are dead weight. */
    if (result.outcome === "delivered" && result.videoPath?.startsWith(OUT_ROOT + "/")) {
      await rm(path.dirname(result.videoPath), { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json({ ok: result.outcome !== "failed", job: job.id, ...summary, fill, log: lines });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failJob(job.id, message);
    console.error(`[render] ${auctionId} failed: ${message}`);
    return NextResponse.json({ ok: false, job: job.id, error: message, fill, log: lines }, { status: 500 });
  }
}
