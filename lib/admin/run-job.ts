/**
 * Run one claimed job from the dispatch lane, whatever kind it is.
 *
 * The dispatcher, the console's "work the queue now" and anything else that
 * drains `LANES.dispatch` go through here, so a kind of job is run the same way
 * wherever it is picked up. The console button used to know only county
 * crawls, and failed every research and intel job it claimed as "unknown
 * adapter" — three strikes and a perfectly good job was retired.
 *
 * Completes or fails the job itself, and returns one line for the caller's log.
 */
import "server-only";
import type { RunJob } from "../db/schema";
import { completeJob, failJob } from "./queue";
import { getAdapter } from "../ingest/adapters";
import { runAdapter } from "../ingest/runner";
import { isScoutJob, scoutState } from "./scout-jobs";
import { getScoutPrompt } from "./scout-prompt";
import { scoutState as researchState } from "../ai/scout-report";
import { intelLotId, intelSource, isIntelJob } from "./intel-jobs";
import { configuredSignalSources, enrichLotIntel } from "../property/signals";
import { primeCountySources } from "../ingest/county-sources";
import { ingestResearch } from "../import/scout-research";

export interface JobOutcome {
  job: string;
  adapter: string;
  ok: boolean;
  line: string;
  /** Kind-specific tallies for the caller's JSON: rows, signals, lots. */
  detail: Record<string, unknown>;
}

export async function runQueuedJob(
  job: RunJob,
  opts: { onProgress?: (m: string) => void } = {},
): Promise<JobOutcome> {
  const outcome = (ok: boolean, line: string, detail: Record<string, unknown> = {}): JobOutcome => ({
    job: job.id,
    adapter: job.adapter,
    ok,
    line: `${job.adapter}: ${line}`,
    detail,
  });
  const fail = async (msg: string) => {
    await failJob(job.id, msg);
    return outcome(false, msg, { error: msg });
  };

  try {
    /*
     * Auction Scout research. Errors fail the job loudly: a searched call that
     * cannot reach a browsing provider must not complete as an empty report,
     * because a state that is simply blank is the one outcome nobody questions.
     * The brief is read per job, so a prompt saved mid-drain applies to the
     * next state.
     */
    if (isScoutJob(job.adapter)) {
      const { template } = await getScoutPrompt();
      const result = await researchState(scoutState(job.adapter), { template });
      await completeJob(job.id, result as unknown as Record<string, unknown>);

      /*
       * Into the calendar: confirmed official rows straight in, the rest onto
       * Ed's review list. A failure here does not fail the research — the report
       * is complete and stored, and the next run will try the ingest again.
       */
      let ingested = "";
      try {
        const i = await ingestResearch(result, job.id);
        ingested =
          `; calendar: ${i.applied.inserted} new, ${i.applied.filled} filled, ` +
          `${i.heldForReview} held for review, ${i.sourcesAdded} list link(s) added`;
      } catch (e) {
        ingested = `; calendar ingest failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      return outcome(
        true,
        `${result.report.rows.length} rows from ${result.searchCount} searches across ` +
          `${result.report.countiesChecked} counties${ingested}`,
        { rows: result.report.rows.length },
      );
    }

    /* Site intel. The lot id rides in `requestedBy`; see `intel-jobs.ts`. */
    if (isIntelJob(job.adapter)) {
      const lotId = intelLotId(job.requestedBy);
      if (!lotId) return fail(`intel job carries no lot id: ${job.requestedBy}`);
      const source = intelSource(job.adapter);
      const sources = configuredSignalSources().filter((s) => s.name === source);
      const result = await enrichLotIntel(lotId, { sources });
      await completeJob(job.id, result as unknown as Record<string, unknown>);
      return outcome(true, `${result.totalSignals} signal(s) for ${lotId.slice(0, 8)}`, {
        signals: result.totalSignals,
      });
    }

    const adapter = getAdapter(job.adapter);
    if (!adapter) return fail(`unknown adapter: ${job.adapter}`);
    await primeCountySources();
    const summary = await runAdapter(adapter, {
      countyFips: job.countyFips ?? undefined,
      limit: job.limit ?? undefined,
      dryRun: job.dryRun,
      onProgress: opts.onProgress,
    });
    await completeJob(job.id, { counties: summary.counties.length, ...summary.totals });
    return outcome(true, `${summary.totals.lots} lot(s) across ${summary.counties.length} county(ies)`, {
      lots: summary.totals.lots,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
