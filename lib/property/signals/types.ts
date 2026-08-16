/**
 * What a signal is, and how a raw feature becomes one.
 *
 * A *signal* is one checkable statement about a parcel's surroundings: what it
 * is, how far away, which way it cuts, and where the claim came from. Not an
 * opinion, not a score, and never a dollar amount — see `severity` below.
 */

import type { LatLon } from "./geo";

export type Direction = "negative" | "positive" | "neutral";
export type Severity = "high" | "medium" | "low";

export interface Signal {
  /** Dotted taxonomy: `rail.mainline`, `flood.sfha`, `neighborhood.vacancy`. */
  kind: string;
  source: string;
  /** Stable within its source, so a re-run updates rather than duplicates. */
  featureKey: string;
  direction: Direction;
  severity: Severity;
  label: string;
  note?: string;
  distanceM?: number;
  distanceBasis?: "centroid" | "boundary";
  value?: number;
  valueText?: string;
  raw?: Record<string, unknown>;
}

/**
 * Where a parcel is, and how well we know it.
 *
 * `basis` is carried through every distance computed from this point, because
 * a distance from an assessor's centroid and a distance from a parcel boundary
 * are different measurements wearing the same unit. On a forty-acre tract they
 * differ by a quarter of a mile.
 */
export interface ParcelLocation extends LatLon {
  basis: "centroid" | "boundary";
  /** The parcel boundary, where the cadastre published one. */
  ring?: { lat: number; lon: number }[];
}

/** Enough about the parcel for a fetcher to do its job. */
export interface SignalInput {
  lotId: string;
  location: ParcelLocation;
  state: string;
  fips: string;
}

export interface SignalSource {
  /** Matches `lot_signals.source` and `lot_intel_runs.source`. */
  name: string;
  /** False when a key is missing; the run is recorded `skipped`, not `failed`. */
  configured(): boolean;
  /**
   * How long an answer stays good.
   *
   * Set per source because the underlying facts move at wildly different
   * speeds. A rail alignment is effectively permanent and a FEMA map is
   * revised on a multi-year cycle, while tract demographics land annually. A
   * uniform TTL would either re-fetch railways monthly for nothing or let a
   * flood map remap go unnoticed for a decade.
   */
  ttlDays: number;
  fetch(input: SignalInput): Promise<Signal[]>;
}

/**
 * The source could not be asked — down, rate limited, timed out.
 *
 * The same distinction `ProviderUnavailableError` draws for valuations, for the
 * same reason: a parcel with no rail line near it and a parcel whose rail query
 * timed out look identical in the results table and are opposite states. Only
 * one is a fact about the property, and only the other should be retried.
 */
export class SignalSourceUnavailableError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source} unavailable: ${message}`);
    this.name = "SignalSourceUnavailableError";
  }
}
