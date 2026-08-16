/**
 * Writing signals down, and remembering what was asked.
 *
 * Two writes per source per parcel: the signals themselves, and a ledger row
 * saying the source was asked and what came back. The ledger is what makes the
 * loop terminate — see `lot_intel_runs` in the schema for why an empty answer
 * has to be recorded as loudly as a full one.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { lotIntelRuns, lotSignals, lots } from "@/lib/db/schema";
import type { Signal } from "./types";

export type IntelStatus = "ok" | "empty" | "failed" | "skipped";

/**
 * Replace one source's view of a parcel.
 *
 * Scoped to the source on purpose: a FEMA refresh must not delete the OSM rows,
 * and an OSM refresh that finds the substation was demolished must delete it
 * rather than leave it standing in the database forever.
 *
 * Rows are upserted and then survivors deleted, rather than deleted and
 * reinserted, so `observed_at` on an unchanged feature keeps saying when it was
 * first seen — and so a reader refreshing the page mid-write never sees a
 * parcel with no signals at all.
 */
export async function writeSignals(lotId: string, source: string, signals: Signal[]): Promise<number> {
  if (signals.length > 0) {
    await db
      .insert(lotSignals)
      .values(
        signals.map((s) => ({
          lotId,
          kind: s.kind,
          source: s.source,
          featureKey: s.featureKey,
          direction: s.direction,
          severity: s.severity,
          label: s.label,
          note: s.note ?? null,
          distanceM: s.distanceM ?? null,
          distanceBasis: s.distanceBasis ?? null,
          value: s.value !== undefined ? String(s.value) : null,
          valueText: s.valueText ?? null,
          raw: s.raw ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [lotSignals.lotId, lotSignals.source, lotSignals.featureKey],
        set: {
          kind: sql`excluded.kind`,
          direction: sql`excluded.direction`,
          severity: sql`excluded.severity`,
          label: sql`excluded.label`,
          note: sql`excluded.note`,
          distanceM: sql`excluded.distance_m`,
          distanceBasis: sql`excluded.distance_basis`,
          value: sql`excluded.value`,
          valueText: sql`excluded.value_text`,
          raw: sql`excluded.raw`,
          observedAt: sql`now()`,
        },
      });
  }

  const keep = signals.map((s) => s.featureKey);
  await db
    .delete(lotSignals)
    .where(
      keep.length
        ? and(
            eq(lotSignals.lotId, lotId),
            eq(lotSignals.source, source),
            notInArray(lotSignals.featureKey, keep),
          )
        : and(eq(lotSignals.lotId, lotId), eq(lotSignals.source, source)),
    );

  return signals.length;
}

/** Record that a source was asked, whatever the answer was. */
export async function recordIntelRun(
  lotId: string,
  source: string,
  status: IntelStatus,
  opts: { signalCount?: number; error?: string; durationMs?: number } = {},
): Promise<void> {
  await db
    .insert(lotIntelRuns)
    .values({
      lotId,
      source,
      status,
      signalCount: opts.signalCount ?? 0,
      error: opts.error ?? null,
      durationMs: opts.durationMs ?? null,
    })
    .onConflictDoUpdate({
      target: [lotIntelRuns.lotId, lotIntelRuns.source],
      set: {
        status: sql`excluded.status`,
        signalCount: sql`excluded.signal_count`,
        error: sql`excluded.error`,
        durationMs: sql`excluded.duration_ms`,
        fetchedAt: sql`now()`,
      },
    });
}

/** Everything known about a parcel's surroundings, worst and nearest first. */
export async function signalsForLot(lotId: string) {
  const rows = await db.select().from(lotSignals).where(eq(lotSignals.lotId, lotId));

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return rows.sort((a, b) => {
    /*
     * Negatives first, then by severity, then by distance. A bidder opens this
     * to find out what is wrong; the park is worth showing and is not the
     * reason they came.
     */
    const dirA = a.direction === "negative" ? 0 : a.direction === "neutral" ? 1 : 2;
    const dirB = b.direction === "negative" ? 0 : b.direction === "neutral" ? 1 : 2;
    if (dirA !== dirB) return dirA - dirB;
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return (a.distanceM ?? 99_999) - (b.distanceM ?? 99_999);
  });
}

/** Signals for many lots at once, for list surfaces. */
export async function signalsForLots(lotIds: string[]) {
  if (lotIds.length === 0) return new Map<string, Awaited<ReturnType<typeof signalsForLot>>>();
  const rows = await db.select().from(lotSignals).where(inArray(lotSignals.lotId, lotIds));
  const out = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = out.get(r.lotId) ?? [];
    list.push(r);
    out.set(r.lotId, list);
  }
  return out;
}

/**
 * Which sources have actually looked at this parcel.
 *
 * Lets a surface tell "we checked and there is nothing near it" from "nobody
 * has looked yet". Those render as different sentences because they are
 * different facts, and only the first one is reassuring.
 */
export async function intelSourcesChecked(lotId: string): Promise<string[]> {
  const rows = await db
    .select({ source: lotIntelRuns.source, status: lotIntelRuns.status })
    .from(lotIntelRuns)
    .where(eq(lotIntelRuns.lotId, lotId));
  // A failed or skipped run is not a look — it is a look that did not happen.
  return rows.filter((r) => r.status === "ok" || r.status === "empty").map((r) => r.source);
}

/** The parcel's location, as the signal fetchers need it. */
export async function lotLocation(lotId: string) {
  const [row] = await db
    .select({
      id: lots.id,
      latitude: lots.latitude,
      longitude: lots.longitude,
      countyFips: lots.countyFips,
    })
    .from(lots)
    .where(eq(lots.id, lotId))
    .limit(1);
  return row ?? null;
}
