/**
 * CAPE Component Seven — produce the county briefing videos.
 *
 *   npm run cape:plan                        # what would be produced, and what it costs
 *   npm run cape:produce -- --limit 1        # produce the most urgent package
 *   npm run cape:produce -- --auction <uuid>
 *   npm run cape:produce -- --script-only    # no speech, no encode, no spend
 *   npm run cape:produce -- --silent         # slides and video, no narration
 *   npm run cape:produce -- --still          # hold every slide, no camera move
 *   npm run cape:produce -- --motion all     # move every slide (5x the file)
 *   npm run cape:produce -- --limit 20 --force
 *   npm run cape:produce -- --script-only --concurrency 6
 *   npm run cape:produce -- --limit 1 --publish   # upload and print the URL
 *   npm run cape:produce -- --auction <uuid> --reuse-script --drive
 *                                            # narrate the stored script, deliver to Drive
 *
 * `--drive` puts the finished MP4 in the CAPE folder's Video subfolder on Google
 * Drive (needs GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_CAPE_FOLDER_ID) —
 * the same delivery the render cron makes. `--reuse-script` narrates the script
 * already stored for the current facts instead of writing a new one, as the
 * cron does; packages without one are skipped.
 *
 * ## Order of work
 *
 * By production deadline, soonest first — Component Eight's own ordering, not a
 * separate opinion about urgency. A package due Monday night for a live auction
 * outranks one due a fortnight out, and that is the whole point of having a
 * production calendar.
 *
 * ## What this spends
 *
 * One model call per package for the script, and metered speech synthesis per
 * character of narration. `--script-only` does the first and not the second;
 * `npm run cape:plan` does neither and prints the estimate. The estimate is
 * printed before any speech is bought, and `--yes` is required to spend beyond
 * a threshold, because a mistyped `--limit` should not be able to buy 152
 * narrations.
 */

import "../lib/env";
import { capePackageInputs } from "../lib/cape/inputs";
import { buildPackage, capeInputsHash } from "../lib/cape/components";
import { produceCapePackage } from "../lib/cape/produce";
import { voiceConfigured, voiceProvider, estimateUsd } from "../lib/cape/voice";
import { assertEncoderAvailable, EncoderMissingError } from "../lib/cape/video";
import { configuredProviders } from "../lib/ai/providers";
import { driveConfigured, DriveNotConfiguredError } from "../lib/delivery/drive";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Spend above this needs `--yes`. Roughly a full run at Google Neural2 rates. */
const CONFIRM_USD = 5;

/** Characters per package, measured across generated scripts. Planning only. */
const TYPICAL_CHARS = 2000;

const OUT_ROOT = arg("out") ?? path.join(process.cwd(), "artifacts", "cape");

async function main() {
  const auctionId = arg("auction");
  /*
   * A named auction is fetched by id, not filtered out of the default
   * selection. `capePackageInputs` already honours the distinction; the CLI
   * did not pass it through, so `--auction` silently did nothing for any sale
   * the inventory rule excludes — a delinquent list, an unconfirmed date. Those
   * are exactly the packages someone names explicitly, usually to correct a
   * script that is already wrong.
   */
  const inputs = await capePackageInputs(auctionId ? { auctionId } : {});

  // Deadline order — Component Eight's, not a second opinion about urgency.
  const ranked = inputs
    .map((i) => ({ input: i, pkg: buildPackage(i) }))
    .sort((a, b) => a.pkg.deadline.dueDate.localeCompare(b.pkg.deadline.dueDate));

  const selected = auctionId
    ? ranked.filter((r) => r.input.auctionId === auctionId)
    : ranked.filter((r) => {
        if (flag("force")) return true;
        // Already produced from exactly these facts.
        const p = r.input.production;
        return !(p && p.hasVideo && p.inputsHash === capeInputsHash(r.input));
      });

  const limit = arg("limit") ? Number(arg("limit")) : selected.length;
  const work = selected.slice(0, limit);

  const provider = (() => {
    try {
      return voiceProvider();
    } catch {
      return null;
    }
  })();

  // --- planning ------------------------------------------------------------
  if (flag("plan")) {
    const chars = work.length * TYPICAL_CHARS;
    console.log(`\nCAPE Component Seven — production plan\n`);
    console.log(`Upcoming packages:        ${inputs.length}`);
    console.log(`Already produced:         ${inputs.length - selected.length}`);
    console.log(`Would produce now:        ${work.length}`);
    console.log(`Script provider:          ${configuredProviders().join(", ") || "NONE — set XAI_API_KEY or ANTHROPIC_API_KEY"}`);
    console.log(`Speech provider:          ${provider?.name ?? "none — video would be silent"}`);
    if (provider) {
      console.log(
        `Estimated speech:         ~${chars.toLocaleString()} chars, ` +
          `~$${estimateUsd(chars, provider.name).toFixed(2)} if nothing is cached`,
      );
    }
    console.log(`Artifacts:                ${OUT_ROOT}`);
    console.log(`\nNext ${Math.min(10, work.length)} by production deadline:\n`);
    for (const { input, pkg } of work.slice(0, 10)) {
      console.log(
        `  ${pkg.deadline.dueDate}  ${(input.countyName ?? "?").padEnd(18)} ` +
          `${input.state}  sale ${input.saleDate}  ${input.lotCount} lots`,
      );
    }
    return;
  }

  if (work.length === 0) {
    console.log("Nothing to produce — every upcoming package is current.");
    return;
  }

  // --- guards --------------------------------------------------------------
  /* A reused script needs no model; everything else writes one. */
  if (configuredProviders().length === 0 && !flag("reuse-script")) {
    console.error("No model provider configured. Set XAI_API_KEY or ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  /*
   * Checked before anything is spent: a run that narrates and encodes a batch
   * and then cannot hand any of it over has bought speech for nothing.
   */
  if (flag("drive")) {
    if (flag("script-only")) {
      console.error("--drive delivers a video; it cannot be combined with --script-only.");
      process.exit(1);
    }
    if (!driveConfigured()) {
      console.error(
        new DriveNotConfiguredError(["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_DRIVE_CAPE_FOLDER_ID"]).message,
      );
      process.exit(1);
    }
  }

  if (!flag("script-only")) {
    try {
      await assertEncoderAvailable();
    } catch (e) {
      if (e instanceof EncoderMissingError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  }

  const willNarrate = !flag("script-only") && !flag("silent") && voiceConfigured();
  if (willNarrate && provider) {
    const estimate = estimateUsd(work.length * TYPICAL_CHARS, provider.name);
    console.log(
      `Speech: ${provider.name}, ~${(work.length * TYPICAL_CHARS).toLocaleString()} chars, ` +
        `~$${estimate.toFixed(2)} if nothing is cached.`,
    );
    /*
     * The confirmation is on estimated spend rather than on package count,
     * because the number that matters is the money. A hundred packages already
     * narrated cost nothing to re-run; ten fresh ones cost real money.
     */
    if (estimate > CONFIRM_USD && !flag("yes")) {
      console.error(
        `\nThat is over $${CONFIRM_USD}. Re-run with --yes to confirm, ` +
          `or --script-only / --silent to spend nothing.`,
      );
      process.exit(1);
    }
  } else if (!flag("script-only")) {
    console.log("No speech provider configured — videos will be silent.");
    console.log("  Cheapest: GOOGLE_TTS_API_KEY (~$16/M chars). Premium: ELEVENLABS_API_KEY.");
  }

  // --- produce -------------------------------------------------------------
  console.log(`\nProducing ${work.length} package(s) into ${OUT_ROOT}\n`);

  let produced = 0;
  let held = 0;
  let failed = 0;
  let spentChars = 0;
  const urls: string[] = [];

  /*
   * One at a time by default, and that default is not timidity.
   *
   * A full run encodes video, and ffmpeg already saturates the machine on a
   * single clip — running four of those at once makes each of them slower and
   * the batch no faster. A `--script-only` run is the opposite: every package
   * is one HTTPS request spending minutes waiting on a model, and 476 of them
   * in series is roughly twenty hours of a laptop doing nothing. So the lever
   * exists, and the person who knows which kind of run this is sets it.
   *
   * Progress prints on completion rather than on start, because interleaved
   * "writing script…" lines from six packages at once are unreadable — each
   * package's output is buffered and flushed as one block.
   */
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 1) || 1);

  let next = 0;
  let done = 0;
  const startedAt = Date.now();

  async function worker() {
    for (;;) {
      const n = next++;
      if (n >= work.length) return;
      const { input, pkg } = work[n];
      const lines: string[] = [];

      const result = await produceCapePackage(input, {
        outRoot: OUT_ROOT,
        scriptOnly: flag("script-only"),
        silent: flag("silent"),
        motion: flag("still") ? "none" : (arg("motion") as "all" | "opening" | "none" | undefined) ?? "opening",
        force: flag("force"),
        publish: flag("publish"),
        drive: flag("drive"),
        reuseScript: flag("reuse-script"),
        onProgress: (m) => lines.push(m),
      });

      done++;
      /*
       * Elapsed and remaining, because a run this long is abandoned or babysat
       * on the strength of whether anyone can tell how far through it is.
       */
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = done > 0 ? Math.round((elapsed / done) * (work.length - done)) : 0;
      console.log(
        `[${done}/${work.length}] ${input.countyName}, ${input.state} — sale ${input.saleDate} ` +
          `(due ${pkg.deadline.dueDate})  ~${Math.round(eta / 60)}m left`,
      );
      for (const l of lines) console.log(l);
      /* A skip is silent inside `produceCapePackage`; in a batch that reads as a hang. */
      if (result.skipped && lines.length === 0) console.log(`  skipped — ${result.skipped}`);

      spentChars += result.characters ?? 0;
      if (result.videoUrl) urls.push(result.videoUrl);
      if (result.stage === "video") produced++;
      else if (result.stage === "failed") failed++;
      else if (result.skipped) held++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));

  console.log(`\n=== summary ===`);
  console.log(`produced: ${produced}   held: ${held}   failed: ${failed}`);
  if (spentChars > 0 && provider) {
    console.log(
      `narration: ${spentChars.toLocaleString()} chars ` +
        `(~$${estimateUsd(spentChars, provider.name).toFixed(2)} at ${provider.name} rates, ` +
        `less whatever was cached)`,
    );
  }
  console.log(`artifacts: ${OUT_ROOT}`);
  if (urls.length > 0) {
    console.log(`\n${flag("drive") ? "delivered" : "published"}:`);
    for (const u of urls) console.log(`  ${u}`);
  } else if (!flag("publish") && !flag("drive") && produced > 0) {
    console.log(`(local only — pass --drive to deliver to the CAPE Drive folder, or --publish for Vercel Blob)`);
  }
}

/*
 * Explicit exit, matching the other CLI scripts — `lib/db` holds a long-lived
 * pool with no close on it, which keeps a finished process alive indefinitely.
 */
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
