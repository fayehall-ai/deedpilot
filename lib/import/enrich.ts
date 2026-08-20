import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, runJobs } from "../db/schema";
import { buildAdapterIndex, sourceIndexFromRegistry } from "../scout";
import { loadRegistry } from "../ingest/adapters/generic";
import { enqueue } from "../admin/queue";

/**
 * Filling in what an imported sale calendar does not contain.
 *
 * An import produces auctions that are real, dated and correctly located, and
 * that know almost nothing: a parcel *count* but no parcels, a venue but no
 * registration deadline, a collector's phone number but no opening bids. Every
 * one of those blanks is filled by the same thing — fetching what the county
 * itself publishes — so "enrichment" here is not a separate kind of work. It is
 * the ordinary crawl, aimed at the counties the upload just told us about.
 *
 * That ordering matters and is the reason this exists as its own entry point.
 * The nightly planner is calendar-driven: it crawls a county when the *atlas*
 * says a sale is near, and the atlas is built from state-level schedules. A
 * county that has just been imported with a confirmed sale date eleven days out
 * is not necessarily due under that model, so without this the newly imported
 * rows would sit as bare announcements until their state's typical window came
 * round. The upload is new information about the world, and it should cause a
 * fetch.
 *
 * ## Lot-level enrichment is deliberately not queued here
 *
 * Cadastre, RentCast and geocoding all iterate over `lots`, and an imported
 * auction has none. Queuing them now would run 30 states' worth of paid API
 * calls against an empty set. They become worth running once these crawls have
 * produced parcels, which is a later and separate decision.
 */

export interface ImportEnrichment {
  /** Counties queued for a crawl by this pass. */
  queued: number;
  /** Counties skipped because they already had queued or leased work. */
  alreadyBusy: number;
  /** Counties whose source is known but which no adapter can parse. */
  noAdapter: string[];
  /** Counties where nothing knows where the sale list is published. */
  noSource: string[];
  /** Imported auctions still holding a count with no parcels behind it. */
  awaitingParcels: number;
}

/**
 * Priority for an import-triggered crawl.
 *
 * The planner scores a listing crawl at roughly 50 plus up to 30 for closeness
 * to the sale; a hand-pressed `runNow` sits at 10. These land in the same band
 * as the planner rather than above everything, because an import is a bulk
 * action and letting 600 counties outrank every scheduled crawl would starve
 * the sales that are actually imminent. Closeness still dominates within the
 * batch, so a sale next week is fetched before one in October.
 */
function priorityFor(saleDate: string, today: string): number {
  const days = Math.round(
    (Date.parse(`${saleDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 7) return 75;
  if (days <= 14) return 65;
  if (days <= 30) return 55;
  return 45;
}

/**
 * Queue crawls for counties an upload just populated.
 *
 * Scoped to auctions that actually need it — an announced count with no parcels
 * behind it — rather than to every county in the file, so re-uploading a
 * calendar whose counties have already been crawled queues nothing.
 */
export async function enqueueImportEnrichment(
  countyFips: string[],
  actor: string,
): Promise<ImportEnrichment> {
  const result: ImportEnrichment = {
    queued: 0,
    alreadyBusy: 0,
    noAdapter: [],
    noSource: [],
    awaitingParcels: 0,
  };
  if (countyFips.length === 0) return result;

  const today = new Date().toISOString().slice(0, 10);

  /*
   * The worklist, straight from the gap the schema keeps open: a sale with an
   * announced count and no parcel rows. Past sales are excluded — crawling a
   * list for a sale that already happened fills in history nobody asked for and
   * costs the same as a useful fetch.
   */
  const pending = await db
    .select({
      countyFips: auctions.countyFips,
      soonest: sql<string>`min(${auctions.saleDate})`,
      n: sql<number>`count(*)::int`,
    })
    .from(auctions)
    .where(
      and(
        inArray(auctions.countyFips, countyFips),
        gte(auctions.saleDate, today),
        isNotNull(auctions.announcedParcelCount),
        sql`${auctions.announcedParcelCount} > ${auctions.lotCount}`,
      ),
    )
    .groupBy(auctions.countyFips);

  result.awaitingParcels = pending.reduce((n, p) => n + p.n, 0);
  if (pending.length === 0) return result;

  /*
   * Counties already queued or leased are skipped rather than queued again.
   * `enqueue` deliberately does not deduplicate — an operator pressing "run
   * now" twice means it — but a bulk import is not that, and 600 duplicate
   * jobs would take hours to drain past the work that matters.
   */
  const live = await db
    .select({ countyFips: runJobs.countyFips })
    .from(runJobs)
    .where(
      and(
        inArray(runJobs.status, ["queued", "leased"]),
        inArray(
          runJobs.countyFips,
          pending.map((p) => p.countyFips),
        ),
      ),
    );
  const busy = new Set(live.map((r) => r.countyFips).filter(Boolean) as string[]);

  const adapterByCounty = await buildAdapterIndex();
  const registry = loadRegistry();
  const sourceByCounty = registry ? sourceIndexFromRegistry(registry) : {};

  for (const county of pending) {
    if (busy.has(county.countyFips)) {
      result.alreadyBusy++;
      continue;
    }
    const adapter = adapterByCounty[county.countyFips];
    if (!adapter) {
      /*
       * Reported, not queued. A county with a known source and no parser is
       * adapter backlog; a county with neither needs the Prospector to go and
       * find where it publishes. Both are real work and neither is a crawl, so
       * inventing a job for them would only fail three times and give up.
       */
      if (sourceByCounty[county.countyFips]) result.noAdapter.push(county.countyFips);
      else result.noSource.push(county.countyFips);
      continue;
    }

    await enqueue({
      adapter,
      countyFips: county.countyFips,
      priority: priorityFor(county.soonest, today),
      requestedBy: `import:${actor}`,
    });
    result.queued++;
  }

  return result;
}
