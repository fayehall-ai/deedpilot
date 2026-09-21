/**
 * Render-cron decisions: which sales get a video, when, and under what name.
 * Run: npx tsx lib/cape/render.test.ts
 *
 * No network and no database — every function here is pure. `DATABASE_URL` is
 * set to a dummy only because the modules import the (lazy) client.
 */
process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";

/* A module, not a script: the imports below are dynamic so the env line runs first. */
export {};

let passed = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
}

async function main() {
  const { parseMediaBanner } = await import("./ffmpeg");
  const { deliveryFileName } = await import("./deliver");
  const { heldReason } = await import("./produce");
  const { batchWeekOf, parcelsFor, selectVideoCandidates, videoEligibility } = await import("@/lib/admin/video-jobs");

  // --- ffmpeg banner --------------------------------------------------------
  const mp3 = parseMediaBanner(
    "Input #0, mp3, from 'a.mp3':\n  Duration: 00:03:13.62, start: 0.025057, bitrate: 128 kb/s\n  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s\n",
  );
  assert(Math.abs(mp3.durationSec - 193.62) < 1e-9 && mp3.width === null, `mp3 duration (${mp3.durationSec})`);
  const png = parseMediaBanner(
    "Input #0, png_pipe, from 's.png':\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 1920x1080, 25 fps, 25 tbr\n",
  );
  assert(png.durationSec === 0 && png.width === 1920 && png.height === 1080, "png size, no duration");
  const mp4 = parseMediaBanner(
    "Input #0, mov,mp4:\n  Duration: 01:02:03.50, start: 0.000000\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 24 fps\n",
  );
  assert(mp4.durationSec === 3723.5 && mp4.width === 1920, "hours parse; hex stream ids do not read as a size");

  // --- the delivery name matches collect-videos.sh --------------------------
  assert(deliveryFileName({ countyName: "Fulton", state: "ga", saleDate: "2026-10-06" }) === "Fulton_County_GA_2026-10-06.mp4", "simple");
  assert(deliveryFileName({ countyName: "St. Lucie", state: "FL", saleDate: "2026-11-02" }) === "St_Lucie_County_FL_2026-11-02.mp4", "punctuation");
  assert(deliveryFileName({ countyName: "DeKalb", state: "GA", saleDate: "2026-10-06" }) === "Dekalb_County_GA_2026-10-06.mp4", "script lowercases then capitalises");
  assert(
    deliveryFileName({ countyName: "Prince George's", state: "MD", saleDate: "2026-12-01" }) === "Prince_George_S_County_MD_2026-12-01.mp4",
    "apostrophe, as the shell script produced it",
  );

  // --- holds ---------------------------------------------------------------
  assert(heldReason({ unsupportedFigures: ["$4,200"], error: null })?.includes("$4,200"), "unsupported figure holds");
  assert(heldReason({ unsupportedFigures: [], error: "wrong county — names Cobb" })?.startsWith("wrong county"), "wrong county holds");
  assert(heldReason({ unsupportedFigures: null, error: "Drive delivery failed — 403" }) === null, "a delivery error is not a hold");

  // --- eligibility ---------------------------------------------------------
  const row = { inputsHash: "h1", hasScript: true, unsupportedFigures: [] as string[], error: null, videoUrl: null };
  assert(videoEligibility(undefined, "h1").ok === false, "no row");
  assert(videoEligibility({ ...row, hasScript: false }, "h1").ok === false, "no script");
  const stale = videoEligibility(row, "h2");
  assert(!stale.ok && stale.reason === "stale-script", "script from older facts waits for the script worker");
  const held = videoEligibility({ ...row, unsupportedFigures: ["12%"] }, "h1");
  assert(!held.ok && held.reason === "held", "held script is not rendered");
  const done = videoEligibility({ ...row, videoUrl: "https://drive.google.com/file/d/abc/view" }, "h1");
  assert(!done.ok && done.reason === "delivered", "delivered for these facts is skipped");
  assert(videoEligibility({ ...row, videoUrl: "https://x.public.blob.vercel-storage.com/a.mp4" }, "h1").ok, "a Blob URL is not a Drive delivery");
  assert(videoEligibility(row, "h1").ok, "current, unheld, undelivered is eligible");

  // --- weekly batches, top N by parcels -------------------------------------
  assert(batchWeekOf("2026-09-29") === "2026-09-28", "Tuesday deadline belongs to Monday's week");
  assert(batchWeekOf("2026-09-28") === "2026-09-28", "Monday is its own week");
  assert(parcelsFor({ lotCount: 12, announcedParcelCount: 1800 }) === 1800, "announced count counts");
  assert(parcelsFor({ lotCount: 50, announcedParcelCount: null }) === 50, "crawled count when none announced");

  const sale = (id: string, saleDate: string, lotCount: number, announced: number | null = null, platform = "govease") => ({
    auctionId: id,
    saleDate,
    platform,
    lotCount,
    announcedParcelCount: announced,
  });
  // Today Monday 21 Sep 2026. Online deadline = Tuesday of the sale week.
  const inputs = [
    sale("a", "2026-09-30", 100), //   due Tue 29 Sep → week of 28 Sep
    sale("b", "2026-10-01", 20, 900), // due 29 Sep, announced 900
    sale("c", "2026-10-02", 300), //   due 29 Sep
    sale("d", "2026-10-08", 5000), //  due Tue 6 Oct → week of 5 Oct, which starts 14 days out: inside
    sale("e", "2026-10-15", 9000), //  due Tue 13 Oct → week of 12 Oct, 21 days out: outside
    sale("f", "2026-10-02", 300), //   ties with c on parcels and date → id breaks it
  ];
  const picked = selectVideoCandidates(inputs, { topN: 2, today: "2026-09-21" });
  assert(
    picked.map((p) => p.input.auctionId).join() === "b,c,d",
    `top 2 per week, horizon applied (got ${picked.map((p) => `${p.input.auctionId}@${p.batch}#${p.rank}`).join()})`,
  );
  assert(picked[0].batch === "2026-09-28" && picked[0].rank === 1 && picked[1].rank === 2, "ranked within the batch");
  assert(picked[2].batch === "2026-10-05" && picked[2].rank === 1, "each week ranked separately");
  assert(selectVideoCandidates(inputs, { topN: 0, today: "2026-09-21" }).length === 0, "N = 0 pauses");
  assert(
    selectVideoCandidates(inputs, { topN: 16, today: "2026-09-21", horizonDays: 30 }).length === 6,
    "a wider horizon takes the later week too",
  );

  console.log(`render.test: ${passed} assertions passed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
