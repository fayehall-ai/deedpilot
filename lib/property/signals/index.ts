/**
 * Running every intel source against one parcel.
 *
 * The registry and the per-parcel runner. Scheduling — which parcel next, and
 * when — is `scheduler.ts`; this file only knows how to enrich the parcel it
 * is handed, and how to record honestly what happened.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { counties, lots } from "@/lib/db/schema";
import { osmSource } from "./osm";
import { floodSource } from "./flood";
import { terrainSource } from "./terrain";
import { neighborhoodSource } from "./neighborhood";
import { recordIntelRun, writeSignals, type IntelStatus } from "./store";
import {
  SignalSourceUnavailableError,
  type ParcelLocation,
  type SignalInput,
  type SignalSource,
} from "./types";

/**
 * Ordered cheapest and most reliable first.
 *
 * FEMA answered in 80-255ms during development and OSM took tens of seconds
 * with retries, so a parcel that only ever gets one source enriched should get
 * the flood zone. That is not hypothetical — a queue drained under a time
 * budget stops partway through by design.
 */
export const SIGNAL_SOURCES: SignalSource[] = [
  floodSource,
  terrainSource,
  neighborhoodSource,
  osmSource,
];

export function configuredSignalSources(): SignalSource[] {
  return SIGNAL_SOURCES.filter((s) => s.configured());
}

export interface EnrichIntelResult {
  lotId: string;
  bySource: { source: string; status: IntelStatus; signals: number; error?: string; ms: number }[];
  totalSignals: number;
  skipped?: string;
}

/**
 * Everything we can learn about where one parcel sits.
 *
 * Sources are independent: one that fails does not stop the others, because a
 * flood zone is still worth having when Overpass is rate-limited. Each records
 * its own ledger row, so the scheduler retries exactly the source that failed
 * rather than the whole parcel.
 */
export async function enrichLotIntel(
  lotId: string,
  opts: { sources?: SignalSource[]; force?: boolean; onProgress?: (m: string) => void } = {},
): Promise<EnrichIntelResult> {
  const log = opts.onProgress ?? (() => {});
  const result: EnrichIntelResult = { lotId, bySource: [], totalSignals: 0 };

  const [row] = await db
    .select({
      id: lots.id,
      latitude: lots.latitude,
      longitude: lots.longitude,
      state: counties.state,
      fips: counties.fips,
    })
    .from(lots)
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(eq(lots.id, lotId))
    .limit(1);

  if (!row) return { ...result, skipped: "lot not found" };

  /*
   * No coordinates, nothing to ask. Recorded as `skipped` against every source
   * rather than left absent, so the scheduler can see at a glance how much of
   * the backlog is waiting on geocoding rather than on fetching — which, at
   * 4,002 of 25,702 lots located, is most of it.
   */
  if (!row.latitude || !row.longitude) {
    for (const s of opts.sources ?? configuredSignalSources()) {
      await recordIntelRun(lotId, s.name, "skipped", { error: "no coordinates" });
    }
    return { ...result, skipped: "no coordinates" };
  }

  const location: ParcelLocation = {
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    // Lots carry a point, not a polygon. A boundary arrives only when the
    // caller has one from the cadastre and passes it in.
    basis: "centroid",
  };

  const input: SignalInput = { lotId, location, state: row.state, fips: row.fips };

  for (const source of opts.sources ?? configuredSignalSources()) {
    const started = Date.now();
    try {
      const signals = await source.fetch(input);
      const written = await writeSignals(lotId, source.name, signals);
      const status: IntelStatus = written > 0 ? "ok" : "empty";
      const ms = Date.now() - started;
      await recordIntelRun(lotId, source.name, status, { signalCount: written, durationMs: ms });
      result.bySource.push({ source: source.name, status, signals: written, ms });
      result.totalSignals += written;
      log(`  ${source.name}: ${written} signal(s) in ${ms}ms`);
    } catch (e) {
      const ms = Date.now() - started;
      const msg = e instanceof Error ? e.message : String(e);
      /*
       * Failure is recorded and never written as an empty result. An Overpass
       * 504 that landed in the table as "nothing near this parcel" would be a
       * permanent wrong answer that nothing downstream could detect — the same
       * failure mode that turned an exhausted ATTOM key into 799 phantom misses.
       */
      await recordIntelRun(lotId, source.name, "failed", { error: msg, durationMs: ms });
      result.bySource.push({ source: source.name, status: "failed", signals: 0, error: msg, ms });
      log(`  ${source.name}: FAILED ${msg}`);

      if (e instanceof SignalSourceUnavailableError) continue;
    }
  }

  return result;
}

export { osmSource, floodSource, terrainSource, neighborhoodSource };
export * from "./types";
export { signalsForLot, signalsForLots } from "./store";
