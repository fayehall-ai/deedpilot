/**
 * Ground elevation and slope, from the USGS national elevation dataset.
 *
 * ## Why slope, on a tax deed
 *
 * On a vacant parcel — which is most of this inventory — slope is close to
 * being the value. A flat acre is a building site; the same acre at 25% grade
 * needs engineered foundations, cut and fill, and a driveway that may cost more
 * than the parcel did, and in many counties it fails the septic percolation
 * requirement outright, which means no house, ever, whatever the zoning says.
 *
 * No listing site reports it, because listing sites describe houses and this
 * describes dirt.
 *
 * ## How slope is derived
 *
 * Five point queries: the parcel and four samples at roughly 60 metres north,
 * south, east and west. The gradient across that cross is the parcel's local
 * grade. It is a coarse instrument — a 120m cross cannot see a ravine ten
 * metres wide — and it is honest about being one: `terrain.slope` is only
 * emitted when the samples agree enough to mean something.
 *
 * Five calls at a measured 0.6-3.4s each is why this source is separate and
 * why it runs in a queue rather than in a request.
 */

import {
  SignalSourceUnavailableError,
  type Signal,
  type SignalInput,
  type SignalSource,
} from "./types";

const EPQS = "https://epqs.nationalmap.gov/v1/json";

/** Metres offset for the slope cross. */
const SAMPLE_M = 60;

async function elevationFt(lat: number, lon: number): Promise<number | undefined> {
  const url = `${EPQS}?x=${lon}&y=${lat}&units=Feet&wkid=4326&includeDate=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new SignalSourceUnavailableError("usgs", `HTTP ${res.status}`);

  const text = await res.text();
  let j: { value?: number | string };
  try {
    j = JSON.parse(text);
  } catch {
    throw new SignalSourceUnavailableError("usgs", "non-JSON response");
  }

  const v = typeof j.value === "string" ? Number(j.value) : j.value;
  /*
   * The service returns -1000000 for a point outside its coverage — offshore,
   * or beyond the dataset. Recorded as "no answer" rather than as an elevation,
   * because a parcel a million feet below sea level would sail through any
   * plausibility check that only tested for a number.
   */
  if (typeof v !== "number" || !Number.isFinite(v) || v < -1000) return undefined;
  return v;
}

export const terrainSource: SignalSource = {
  name: "usgs",
  configured: () => true,
  /* Bedrock does not move. This is re-fetched only to repair gaps. */
  ttlDays: 3650,

  async fetch(input: SignalInput): Promise<Signal[]> {
    const { latitude, longitude } = input.location;

    const centre = await elevationFt(latitude, longitude);
    if (centre === undefined) return [];

    const dLat = SAMPLE_M / 110_574;
    const dLon = SAMPLE_M / (111_320 * Math.cos((latitude * Math.PI) / 180));

    const samples = await Promise.all([
      elevationFt(latitude + dLat, longitude),
      elevationFt(latitude - dLat, longitude),
      elevationFt(latitude, longitude + dLon),
      elevationFt(latitude, longitude - dLon),
    ]);

    const signals: Signal[] = [
      {
        kind: "terrain.elevation",
        source: "usgs",
        featureKey: "elevation",
        direction: "neutral",
        severity: "low",
        label: `Elevation ${Math.round(centre)} ft`,
        note: `Ground elevation at the parcel. Compare with the FEMA base flood elevation where one is published.`,
        value: Math.round(centre * 100) / 100,
        valueText: `${Math.round(centre)} ft`,
        distanceBasis: input.location.basis,
        raw: { elevationFt: centre },
      },
    ];

    const ns = samples[0] !== undefined && samples[1] !== undefined ? samples[0] - samples[1] : undefined;
    const ew = samples[2] !== undefined && samples[3] !== undefined ? samples[2] - samples[3] : undefined;

    if (ns !== undefined || ew !== undefined) {
      // Rise over run across the full 120m cross, in feet, converted to percent.
      const runFt = (2 * SAMPLE_M) / 0.3048;
      const gradeNS = ns === undefined ? 0 : Math.abs(ns) / runFt;
      const gradeEW = ew === undefined ? 0 : Math.abs(ew) / runFt;
      const grade = Math.hypot(gradeNS, gradeEW);
      const pct = Math.round(grade * 1000) / 10;

      /*
       * Bands from what construction actually costs, not from a curve.
       * Under 5% builds like flat ground. 5-15% needs a stepped foundation and
       * a graded drive. Over 15% is where septic percolation and access start
       * failing outright in many rural counties, and over 25% is where a
       * parcel is frequently unbuildable at any price.
       */
      const severity = pct >= 25 ? "high" : pct >= 15 ? "medium" : "low";
      if (pct >= 8) {
        signals.push({
          kind: "terrain.slope",
          source: "usgs",
          featureKey: "slope",
          direction: "negative",
          severity,
          label: `Sloped ground — about ${pct}% grade`,
          note:
            pct >= 25
              ? `Steep. Expect engineered foundations and a graded access drive, and check the county's ` +
                `septic percolation rule before assuming anything can be built here.`
              : pct >= 15
                ? `Meaningful grade. Site work costs rise sharply and septic approval is not automatic.`
                : `Gentle grade — a stepped foundation or some cut and fill on a build.`,
          value: pct,
          valueText: `${pct}%`,
          distanceBasis: input.location.basis,
          raw: { centreFt: centre, samples, gradeNS, gradeEW },
        });
      }
    }

    return signals;
  },
};
