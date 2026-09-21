/**
 * The render cron's unit of work, from a terminal.
 *
 *   npm run cape:render -- --plan                   # this week's top-N per batch, and what each is waiting on
 *   npm run cape:render -- --next                   # render + deliver the first ready one, as the cron would
 *   npm run cape:render -- --auction <uuid>         # render + deliver that sale
 *   npm run cape:render -- --auction <uuid> --no-deliver --out /tmp/x --audio-cache <dir>
 *
 * Calls `renderOne` — the function `/api/cron/render` calls — so a run here is
 * the same code path: the stored script, the Blob-backed narration cache, the
 * outline-drawn slides, the bundled ffmpeg, then Drive. It is how the cron was
 * proven before it was deployed, and how to push one video through by hand.
 *
 * `--top N` overrides the console's `videoTopN` for `--plan` / `--next`.
 * `--force` renders even when a delivery is already recorded.
 */
import "../lib/env";
import { capePackageInputs } from "../lib/cape/inputs";
import { capeInputsHash } from "../lib/cape/components";
import { renderOne } from "../lib/cape/render";
import { getPipelineConfig, DEFAULT_CONFIG } from "../lib/admin/pipeline-settings";
import { productionRowsFor, selectVideoCandidates, videoEligibility } from "../lib/admin/video-jobs";
import { ffmpegPath } from "../lib/cape/ffmpeg";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function topN(): Promise<number> {
  if (arg("top")) return Number(arg("top"));
  try {
    return (await getPipelineConfig()).videoTopN;
  } catch (e) {
    console.warn(`(could not read videoTopN — ${e instanceof Error ? e.message.split("\n")[0] : e}; using ${DEFAULT_CONFIG.videoTopN})`);
    return DEFAULT_CONFIG.videoTopN;
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const inputs = await capePackageInputs({ today });

  let auctionId = arg("auction");

  if (flag("plan") || flag("next")) {
    const n = await topN();
    const candidates = selectVideoCandidates(inputs, { topN: n, today });
    const rows = await productionRowsFor(candidates.map((c) => c.input.auctionId));
    const verdicts = candidates.map((c) => ({ c, v: videoEligibility(rows.get(c.input.auctionId), capeInputsHash(c.input)) }));

    if (flag("plan")) {
      console.log(`\nTop ${n} per weekly batch, batches due within the horizon (${inputs.length} upcoming packages)\n`);
      let batch = "";
      for (const { c, v } of verdicts) {
        if (c.batch !== batch) {
          batch = c.batch;
          console.log(`  week of ${batch}`);
        }
        const status = v.ok ? "READY" : v.reason + (v.detail ? ` (${v.detail.slice(0, 60)})` : "");
        console.log(
          `    ${String(c.rank).padStart(2)}. ${String(c.parcels).padStart(6)} parcels  ` +
            `${(c.input.countyName ?? "?").padEnd(18)} ${c.input.state}  sale ${c.input.saleDate}  ` +
            `due ${c.dueDate}  ${status}  ${c.input.auctionId}`,
        );
      }
      return;
    }

    auctionId = verdicts.find(({ v }) => v.ok)?.c.input.auctionId;
    if (!auctionId) {
      console.log("Nothing ready to render — see --plan.");
      return;
    }
  }

  if (!auctionId) {
    console.error("Pass --auction <uuid>, --next or --plan.");
    process.exit(1);
  }

  console.log(`ffmpeg: ${await ffmpegPath()}`);
  const result = await renderOne(auctionId, {
    inputs,
    outRoot: arg("out") ?? "/tmp/cape",
    audioCacheDir: arg("audio-cache"),
    deliver: !flag("no-deliver"),
    force: flag("force"),
    onProgress: (m) => console.log(m),
  });

  console.log(`\n=== ${result.outcome}${result.label ? ` — ${result.label}` : ""} ===`);
  if (result.reason) console.log(`reason:     ${result.reason}`);
  if (result.videoPath) console.log(`video:      ${result.videoPath}`);
  if (result.videoBytes) console.log(`size:       ${(result.videoBytes / 1_048_576).toFixed(1)} MB`);
  if (result.videoSeconds) console.log(`duration:   ${result.videoSeconds.toFixed(1)}s`);
  if (result.cachedSections !== undefined) console.log(`cached:     ${result.cachedSections} section(s)`);
  console.log(`billed:     ${result.billedCharacters ?? 0} characters of speech`);
  if (result.driveLink) console.log(`drive:      ${result.fileName} → ${result.driveLink}`);
  console.log(`wall time:  ${(result.wallMs / 1000).toFixed(1)}s`);
  if (result.outcome === "failed") process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
