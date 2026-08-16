/**
 * The census tract a parcel sits in, and what lives there.
 *
 * ## Why tract-level and not "neighborhood"
 *
 * A tax deed buyer's real question about a rural or semi-urban parcel is
 * whether anyone lives around it and whether they own or rent. Listing sites
 * answer this with a school rating and a walk score, both of which are
 * proprietary composites of things you cannot check. A census tract is a
 * published boundary with published counts, and the counts are the answer:
 * owner-occupancy, vacancy, median value, median income.
 *
 * Vacancy is the number that matters most and is the one nobody shows. A tract
 * at 40% vacancy is not a market with soft prices — it is a market where the
 * exit is uncertain at any price, which is precisely the risk a tax sale
 * concentrates. The parcel is at a tax sale because somebody stopped paying,
 * and the tract tells you whether that is one owner's story or the area's.
 *
 * ## The key
 *
 * The ACS endpoint began requiring an API key — an unkeyed request returns an
 * HTML "Missing Key" page with status 200, which is the worst possible failure
 * shape and the reason this parses defensively rather than trusting the status
 * code. The key is free and instant from
 * `https://api.census.gov/data/key_signup.html`; without it this source reports
 * itself unconfigured and the scheduler records `skipped` rather than burning
 * retries on a fetch that cannot succeed.
 */

import {
  SignalSourceUnavailableError,
  type Signal,
  type SignalInput,
  type SignalSource,
} from "./types";

const TRACT_LOOKUP = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
const ACS = "https://api.census.gov/data/2023/acs/acs5";

/** ACS variables, with what each one is for. */
const VARS = {
  B19013_001E: "median household income",
  B25077_001E: "median owner-occupied home value",
  B25003_002E: "owner-occupied units",
  B25003_001E: "occupied units",
  B25002_003E: "vacant units",
  B25002_001E: "total housing units",
  /*
   * Vacancy by reason, and specifically the seasonal share.
   *
   * Without this the vacancy signal is actively misleading in exactly the
   * places tax deed inventory is cheapest. Keweenaw County, Michigan measures
   * 51% vacant — flagged `high`, described as an exit-risk market — and 982 of
   * those 1,146 empty units are seasonal cabins. Real distress vacancy there is
   * 7%, below the national tract average, in a county whose whole economy is
   * second homes.
   *
   * Mississippi County, Arkansas measures 25% vacant with *zero* seasonal
   * units. Same headline band, opposite fact. The seasonal split is what tells
   * them apart.
   */
  B25004_006E: "vacant for seasonal, recreational or occasional use",
  B01003_001E: "population",
} as const;

/** ACS jams sentinels like -666666666 into suppressed cells. */
const clean = (v: string | null): number | undefined => {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > -1e6 ? n : undefined;
};

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

async function tractFor(lat: number, lon: number): Promise<{ geoid: string; name: string } | null> {
  const params = new URLSearchParams({
    x: String(lon),
    y: String(lat),
    benchmark: "Public_AR_Current",
    vintage: "Current_Current",
    layers: "Census Tracts",
    format: "json",
  });
  const res = await fetch(`${TRACT_LOOKUP}?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new SignalSourceUnavailableError("census", `geocoder HTTP ${res.status}`);
  const j = (await res.json()) as {
    result?: { geographies?: { "Census Tracts"?: { GEOID?: string; NAME?: string }[] } };
  };
  const t = j.result?.geographies?.["Census Tracts"]?.[0];
  // Offshore or unmapped coordinates land here legitimately.
  return t?.GEOID ? { geoid: t.GEOID, name: t.NAME ?? t.GEOID } : null;
}

export const neighborhoodSource: SignalSource = {
  name: "census",
  configured: () => Boolean(process.env.CENSUS_API_KEY),
  /* ACS 5-year estimates are published annually; nothing moves faster. */
  ttlDays: 365,

  async fetch(input: SignalInput): Promise<Signal[]> {
    const key = process.env.CENSUS_API_KEY;
    if (!key) return [];

    const tract = await tractFor(input.location.latitude, input.location.longitude);
    if (!tract) return [];

    const state = tract.geoid.slice(0, 2);
    const county = tract.geoid.slice(2, 5);
    const tractCode = tract.geoid.slice(5);

    const url =
      `${ACS}?get=NAME,${Object.keys(VARS).join(",")}` +
      `&for=tract:${tractCode}&in=state:${state}%20county:${county}&key=${key}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const text = await res.text();

    /*
     * Parsed rather than trusted. A missing or rejected key comes back as an
     * HTML page under a 200, so `res.ok` proves nothing here — the only real
     * evidence of success is that the body is the two-row array the API
     * documents.
     */
    let rows: string[][];
    try {
      rows = JSON.parse(text) as string[][];
    } catch {
      const hint = /Missing Key|Invalid Key/i.test(text)
        ? "ACS rejected the key (set CENSUS_API_KEY — free at api.census.gov/data/key_signup.html)"
        : `ACS returned a non-JSON body (HTTP ${res.status})`;
      throw new SignalSourceUnavailableError("census", hint);
    }
    if (!Array.isArray(rows) || rows.length < 2) return [];

    const header = rows[0];
    const row = rows[1];
    const at = (name: string) => clean(row[header.indexOf(name)] ?? null);

    const income = at("B19013_001E");
    const medianValue = at("B25077_001E");
    const ownerOccupied = at("B25003_002E");
    const occupied = at("B25003_001E");
    const vacant = at("B25002_003E");
    const totalUnits = at("B25002_001E");
    const population = at("B01003_001E");

    const signals: Signal[] = [];
    const base = { source: "census", distanceBasis: input.location.basis } as const;

    if (vacant !== undefined && totalUnits && totalUnits > 0) {
      /*
       * Seasonal units are removed before anything is judged.
       *
       * A cabin that is empty in February because its owner lives in Chicago is
       * not a distressed unit, and counting it as one inverts the signal in
       * every resort county — see the note on `B25004_006E` above.
       */
      const seasonal = at("B25004_006E") ?? 0;
      const distressVacant = Math.max(0, vacant - seasonal);
      const rate = distressVacant / totalUnits;
      const seasonalShare = vacant > 0 ? seasonal / vacant : 0;

      /*
       * Thresholds, not a curve. The national tract vacancy rate runs around
       * 10%; a fifth of homes empty is a visibly distressed area and a third is
       * one where resale, not price, is the problem.
       */
      const severity = rate >= 0.3 ? "high" : rate >= 0.2 ? "medium" : "low";

      // Worth saying out loud once it is a third of the empty stock, because
      // the headline vacancy figure a reader finds elsewhere will disagree
      // with this one and they deserve to know why.
      const seasonalNote =
        seasonalShare >= 0.33
          ? ` A further ${seasonal.toLocaleString()} unit(s) are vacant seasonally — second homes ` +
            `rather than distress — so a headline vacancy rate quoted elsewhere for this tract ` +
            `will read ${pct(vacant / totalUnits)}.`
          : "";

      signals.push({
        ...base,
        kind: "neighborhood.vacancy",
        featureKey: `vacancy:${tract.geoid}`,
        direction: rate >= 0.2 ? "negative" : "neutral",
        severity,
        label: `${pct(rate)} of homes vacant year-round in ${tract.name}`,
        note:
          (rate >= 0.2
            ? `${distressVacant.toLocaleString()} of ${totalUnits.toLocaleString()} units sit empty ` +
              `outside seasonal use. High vacancy is an exit-risk signal rather than a price signal — ` +
              `the question is whether there is a buyer at any price, not what the price is.`
            : `${distressVacant.toLocaleString()} of ${totalUnits.toLocaleString()} units vacant ` +
              `year-round, around or below the national tract average.`) + seasonalNote,
        value: Math.round(rate * 10000) / 100,
        valueText: pct(rate),
        raw: { vacant, seasonal, distressVacant, totalUnits, geoid: tract.geoid },
      });
    }

    if (ownerOccupied !== undefined && occupied && occupied > 0) {
      const rate = ownerOccupied / occupied;
      signals.push({
        ...base,
        kind: "neighborhood.ownership",
        featureKey: `ownership:${tract.geoid}`,
        direction: rate >= 0.6 ? "positive" : rate <= 0.35 ? "negative" : "neutral",
        severity: "low",
        label: `${pct(rate)} owner-occupied`,
        /*
         * Three bands, because two produced a sentence that contradicted the
         * number beside it. Anything above 35% fell through to "owner-occupied
         * majority", so a tract measured at 42% — a renter-leaning tract with
         * no majority either way — rendered as "42% owner-occupied /
         * Owner-occupied majority" on the same line. The note has to survive
         * being read next to the figure it describes.
         */
        note:
          rate <= 0.35
            ? `Predominantly renter-occupied tract — the resale pool leans investor, which caps price ` +
              `at what the rent supports.`
            : rate < 0.5
              ? `Renters are the majority here. A retail resale is possible but the investor bid is ` +
                `what sets the floor.`
              : `Owner-occupied majority, which usually means a retail resale is possible.`,
        value: Math.round(rate * 10000) / 100,
        valueText: pct(rate),
        raw: { ownerOccupied, occupied },
      });
    }

    if (medianValue !== undefined) {
      signals.push({
        ...base,
        kind: "neighborhood.median_value",
        featureKey: `median_value:${tract.geoid}`,
        direction: "neutral",
        severity: "low",
        label: `Tract median home value ${money(medianValue)}`,
        /*
         * Explicitly not a comp and explicitly not a valuation input. It is a
         * self-reported owner estimate across a whole tract, and a bid derived
         * from it would be a bid on a survey response.
         */
        note:
          `Self-reported median across the whole tract — context for whether a number is plausible, ` +
          `not a comparable and never a bid input.`,
        value: medianValue,
        valueText: money(medianValue),
        raw: { medianValue },
      });
    }

    if (income !== undefined) {
      signals.push({
        ...base,
        kind: "neighborhood.income",
        featureKey: `income:${tract.geoid}`,
        direction: "neutral",
        severity: "low",
        label: `Median household income ${money(income)}`,
        note: `Tract median household income. Sets what a local buyer can finance.`,
        value: income,
        valueText: money(income),
        raw: { income, population },
      });
    }

    return signals;
  },
};
