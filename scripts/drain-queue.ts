/**
 * Drain the crawl queue, here rather than on a cron tick.
 *
 *   npm run queue:drain                 # until the queue is empty, then stop
 *   npm run queue:drain -- --queue      # queue newly crawlable counties first
 *   npm run queue:drain -- --follow     # keep running, waiting for new work
 *   npm run queue:drain -- --max 20     # stop after N jobs
 *   npm run queue:status                # what is queued, running and done
 *
 * After a prospecting run the loop closes with `--queue`: counties that just
 * acquired a source become crawlable, and this is what goes back for them.
 *
 * ## Why this exists alongside the dispatcher
 *
 * `app/api/cron/dispatch/route.ts` does exactly this work and is the right
 * thing in production, but it is bounded twice over: a Vercel Hobby account
 * refuses any cron more frequent than daily — an over-frequent expression
 * fails the *build*, so it cannot simply be turned up — and each tick stops
 * before its function budget, draining perhaps a few dozen jobs.
 *
 * An import that queues several hundred counties at once is not a nightly
 * sweep. Waiting for it to trickle out over a week is the wrong shape for
 * "these sales are in eleven days and we have no parcels for them", so this
 * runs the same loop in a process that can stay up: claim, crawl, complete.
 * It shares the queue's lease, so it is safe to run while the cron also ticks
 * — whoever claims a job owns it, and a process that dies loses the lease and
 * the job returns.
 *
 * ## Why it is serial and paced
 *
 * Every fetch here lands on a county's own web server, most of them small
 * government sites that are not being paid to answer us. `lib/ingest/policy.ts`
 * already treats politeness as architecture; this holds the same line. The
 * delay between jobs is deliberate and is not a tuning knob to be turned to
 * zero. Concurrency is available for a hurry, capped low, and off by default.
 */

import "../lib/env";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { runJobs } from "../lib/db/schema";
import { claimNext, completeJob, failJob, LANES, reapDeadJobs, reapStuckRuns } from "../lib/admin/queue";
import { getAdapter } from "../lib/ingest/adapters";
import { runAdapter } from "../lib/ingest/runner";
import { loadPolicyOverrides } from "../lib/admin/policy-load";
import { primeCountySources } from "../lib/ingest/county-sources";
import {
  coverageBreakdown,
  foldSupersededImports,
  parcelListCoverage,
} from "../lib/import/reconcile";
import { enqueueImportEnrichment } from "../lib/import/enrich";
import { auctions } from "../lib/db/schema";

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Between jobs. See the note on pacing. */
const JOB_DELAY_MS = 1_500;
/** While following an empty queue. */
const IDLE_DELAY_MS = 20_000;

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig} — finishing the job in flight, then stopping.`);
  });
}

/** Queue depth and what the crawls have actually produced. */
async function status(): Promise<void> {
  const q = await db
    .select({ status: runJobs.status, n: sql<number>`count(*)::int` })
    .from(runJobs)
    .groupBy(runJobs.status);
  console.log("queue:", q.map((r) => `${r.status} ${r.n}`).join(" · ") || "empty");

  /*
   * The headline and the breakdown below it read the same function, so they
   * cannot drift. They did: a local copy of this query counted announcements
   * with a count of zero and the breakdown did not, and the two lines
   * disagreed by 23 sales with no way to tell which was right.
   */
  const cov = await parcelListCoverage();
  const pct = cov.announced ? Math.round((cov.withList / cov.announced) * 100) : 0;
  console.log(
    `parcel-list coverage: ${cov.withList}/${cov.announced} announced sales have a list (${pct}%) — ` +
      `${cov.parcelsHeld.toLocaleString()} of ${cov.parcelsAnnounced.toLocaleString()} announced parcels held`,
  );

  const LABEL: Record<string, string> = {
    has_list: "parcel list held",
    crawl_pending: "crawl queued, not run yet",
    crawled_no_parcels: "crawled, county published no parsable list",
    crawl_failed: "crawl failed",
    no_source: "no located source — needs the Prospector",
  };
  for (const b of await coverageBreakdown()) {
    console.log(
      `  ${String(b.sales).padStart(4)} sales  ${b.parcelsHeld.toLocaleString().padStart(8)}/` +
        `${b.parcelsAnnounced.toLocaleString().padEnd(8)} parcels  ${LABEL[b.reason] ?? b.reason}`,
    );
  }

  const recent = await db
    .select({ adapter: runJobs.adapter, err: runJobs.lastError })
    .from(runJobs)
    .where(eq(runJobs.status, "failed"))
    .orderBy(desc(runJobs.finishedAt))
    .limit(5);
  if (recent.length) {
    console.log("recent failures:");
    for (const r of recent) console.log(`  ${r.adapter}: ${(r.err ?? "").slice(0, 110)}`);
  }
}

async function main(): Promise<void> {
  if (flag("status")) {
    await status();
    process.exit(0);
  }

  // The same access decisions the dispatcher loads before it crawls anything.
  await loadPolicyOverrides();
  await primeCountySources();

  const max = Number(arg("max") ?? Infinity);
  const follow = flag("follow");

  /*
   * `--queue` first, for the step after a prospecting run.
   *
   * A county with no located source has no adapter, so the import's enrichment
   * could not queue anything for it and it sat in the "no source" bucket. Once
   * the Prospector finds its sale page, the registry entry makes
   * `genericAdapter` serve it and it becomes crawlable — but nothing goes back
   * to look. This does, in a fresh process, which matters: both the registry
   * and the adapter index are cached per-process, so newly located counties are
   * only visible to a run that started after they were written.
   */
  if (flag("queue")) {
    const counties = (
      await db
        .selectDistinct({ fips: auctions.countyFips })
        .from(auctions)
        .where(
          sql`${auctions.announcedParcelCount} > 0 AND ${auctions.lotCount} = 0
              AND ${auctions.saleDate} >= current_date AND ${auctions.delistedAt} IS NULL`,
        )
    ).map((r) => r.fips);
    const e = await enqueueImportEnrichment(counties, "queue-flag");
    console.log(
      `queued ${e.queued} county crawl(s) (${e.alreadyBusy} already in flight, ` +
        `${e.noSource.length} still have no located source)\n`,
    );
  }
  const reaped = await reapStuckRuns();
  if (reaped) console.log(`reaped ${reaped} stuck run(s)`);
  const dead = await reapDeadJobs();
  if (dead) console.log(`retired ${dead} job(s) whose worker died on every attempt`);

  const [{ n: queued }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runJobs)
    .where(inArray(runJobs.status, ["queued", "leased"]));
  console.log(`${queued} job(s) waiting\n`);

  let done = 0;
  let lots = 0;
  let failed = 0;
  const started = Date.now();

  while (!stopping && done < max) {
    const job = await claimNext(new Date(), LANES.crawl);

    if (!job) {
      if (!follow) break;
      await sleep(IDLE_DELAY_MS);
      continue;
    }

    const adapter = getAdapter(job.adapter);
    if (!adapter) {
      await failJob(job.id, `unknown adapter: ${job.adapter}`);
      console.log(`✗ ${job.adapter} — unknown adapter`);
      failed++;
      continue;
    }

    const label = `${job.adapter}${job.countyFips ? ` ${job.countyFips}` : ""}`;
    const t0 = Date.now();
    try {
      const summary = await runAdapter(adapter, {
        countyFips: job.countyFips ?? undefined,
        limit: job.limit ?? undefined,
        dryRun: job.dryRun,
      });
      /* As in `runQueuedJob`: one county that failed is a failed job. */
      const [only] = summary.counties;
      if (job.countyFips && summary.counties.length === 1 && only.status === "failed") {
        throw new Error(only.error ?? "the crawl failed");
      }
      await completeJob(job.id, { counties: summary.counties.length, ...summary.totals });
      lots += summary.totals.lots;
      done++;
      console.log(
        `✓ ${label} — ${summary.totals.lots} lot(s), ${summary.totals.auctions} auction(s) ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s   [${done} done, ${lots} lots]`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failJob(job.id, msg);
      failed++;
      done++;
      console.log(`✗ ${label} — ${msg.slice(0, 120)}`);
    }

    await sleep(JOB_DELAY_MS);
  }

  console.log(
    `\n${done} job(s), ${lots} lot(s) written, ${failed} failed, ` +
      `${((Date.now() - started) / 60000).toFixed(1)} min`,
  );

  /*
   * A crawl that finds a county's real sale list writes its own auction row,
   * which now sits beside the announcement that caused it to be queued — the
   * same sale, twice, on the calendar. Folding runs after the drain rather than
   * inside the loop because the pairing is only unambiguous once a county's
   * jobs have all finished.
   */
  const fold = await foldSupersededImports();
  if (fold.folded || fold.ambiguous.length) {
    console.log(
      `folded ${fold.folded} superseded announcement(s) into their crawl` +
        (fold.countsMoved ? `, carrying ${fold.countsMoved} parcel count(s) across` : "") +
        (fold.ambiguous.length ? `; ${fold.ambiguous.length} left for a person` : ""),
    );
  }

  await status();
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
