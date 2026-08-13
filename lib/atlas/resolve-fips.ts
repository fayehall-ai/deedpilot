/**
 * Resolve a county as a source writes it into a FIPS code.
 *
 * A Scout row names its county the way the county names itself — "Fulton",
 * "Fulton County", "Orleans Parish", "Richmond City", "Doña Ana". Everything
 * downstream joins on FIPS, so this is the gate between researched rows and the
 * registry, and a wrong answer here is worse than no answer: it attaches a
 * verified source URL to the wrong county, and the crawler then fetches the
 * wrong county's sale list forever.
 *
 * So this refuses more than it guesses. Three outcomes, and only the first is a
 * resolution:
 *
 * - **resolved** — exactly one county matched, or an explicit City/County
 *   marker picked between two that share a name.
 * - **ambiguous** — the state has two entities with this name and the source
 *   did not say which. Never silently picked.
 * - **not found** — including the case where the state does not sell by county
 *   at all, which is reported under its own name rather than as a failure.
 *
 * ## The ambiguity this exists for
 *
 * `findCountyByName` in the atlas index keys a Map by `state:normalizedName`,
 * so where a state has two entities with one name the second insert silently
 * overwrites the first. Three states do:
 *
 * | State | Name       | County | Independent city |
 * |-------|------------|--------|------------------|
 * | VA    | Richmond   | 51159  | 51760            |
 * | MD    | Baltimore  | 24005  | 24510            |
 * | MO    | St. Louis  | 29189  | 29510            |
 *
 * Baltimore County and Baltimore city are different governments holding
 * different sales. A bare "Baltimore" resolves to whichever the map happened to
 * keep, which is not a decision anyone made.
 */

import { ALL_COUNTIES, countiesInState } from "./index";
import type { County } from "./types";

/**
 * States with independent cities that carry their own FIPS entry.
 *
 * Restricted to these four on purpose. Within them, an independent city's
 * 3-digit county code is >= 500 — but that rule is only safe *here*: Texas has
 * 254 counties running to 48507 (Zavala), so applying it nationally would
 * reclassify real counties as cities.
 */
const INDEPENDENT_CITY_STATES = new Set(["VA", "MD", "MO", "NV"]);

/** Is this FIPS an independent city rather than a county? */
export function isIndependentCity(fips: string): boolean {
  const state = fips.slice(0, 2);
  const stateAbbr = ALL_COUNTIES.find((c) => c.fips.slice(0, 2) === state)?.state;
  if (!stateAbbr || !INDEPENDENT_CITY_STATES.has(stateAbbr)) return false;
  return Number(fips.slice(2)) >= 500;
}

/**
 * States where tax sales are run by municipalities, not counties.
 *
 * Connecticut is the live case: the Scout's own hub note says CT sales are
 * municipal under CGS 12-157, so its rows name towns — New Britain, Bridgeport
 * — which are not counties and never will resolve. Reporting that as
 * "not found" would file a correct row as a data-quality problem, so it gets
 * its own outcome and the town name is preserved for whoever works the state.
 */
const MUNICIPAL_STATES = new Set(["CT", "RI", "VT", "NH", "ME", "MA"]);

/**
 * Fold a county name to a comparison key.
 *
 * Beyond the atlas's own normaliser this strips diacritics, without which
 * New Mexico's Doña Ana never matches a source writing "Dona Ana" — the
 * atlas rule drops every non-`a-z0-9` character, so "doña" becomes "doa".
 */
export function foldCountyName(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // "City of Richmond" → "richmond". Handled before the noun strip, which
      // would otherwise leave a stranded "of".
      .replace(/\bcity of\b/g, "")
      /*
       * `city` is stripped like any other entity noun so that "Baltimore City"
       * and "Baltimore County" both fold to "baltimore" and reach the
       * disambiguation below. Leaving it in made "Baltimore City" match neither
       * candidate, so the City marker never got a chance to choose.
       *
       * `city and borough` must precede bare `city` in the alternation or
       * Alaska's "Juneau City and Borough" strands an " and borough".
       * Counties genuinely containing the word — Carson City NV, James City
       * and Charles City VA — are safe because both sides fold identically.
       */
      .replace(/\b(county|parish|census area|city and borough|borough|municipality|city)\b/g, "")
      .replace(/\bsainte\b/g, "ste")
      .replace(/\bsaint\b/g, "st")
      .replace(/[^a-z0-9]/g, "")
  );
}

/** Did the source explicitly say city, or explicitly say county? */
export function readEntityMarker(name: string): "city" | "county" | null {
  const n = name.toLowerCase();
  if (/\bcity\b/.test(n) && !/\bcity and borough\b/.test(n)) return "city";
  if (/\b(county|parish)\b/.test(n)) return "county";
  return null;
}

export type FipsResolution =
  | { ok: true; fips: string; county: County; matchedOn: "unique" | "city-marker" | "county-marker" }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "municipal_state" | "unknown_state";
      detail: string;
      candidates: County[];
    };

/**
 * Resolve one (name, state) pair.
 *
 * `state` is a two-letter USPS code — the shape a Scout row carries.
 */
export function resolveFips(name: string, state: string): FipsResolution {
  const stateAbbr = state.trim().toUpperCase();
  const raw = name.trim();

  const inState = countiesInState(stateAbbr);
  if (inState.length === 0) {
    return { ok: false, reason: "unknown_state", detail: `no counties on file for "${state}"`, candidates: [] };
  }

  const key = foldCountyName(raw);
  if (!key) {
    return { ok: false, reason: "not_found", detail: `"${raw}" folds to an empty name`, candidates: [] };
  }

  const matches = inState.filter((c) => foldCountyName(c.name) === key);

  if (matches.length === 1) {
    return { ok: true, fips: matches[0].fips, county: matches[0], matchedOn: "unique" };
  }

  if (matches.length === 0) {
    if (MUNICIPAL_STATES.has(stateAbbr)) {
      return {
        ok: false,
        reason: "municipal_state",
        detail: `${stateAbbr} sells by municipality, and "${raw}" is not one of its counties`,
        candidates: [],
      };
    }
    return { ok: false, reason: "not_found", detail: `no county in ${stateAbbr} named "${raw}"`, candidates: [] };
  }

  // More than one entity shares this name. The only honest way through is an
  // explicit marker in what the source wrote.
  const marker = readEntityMarker(raw);
  if (marker === "city") {
    const city = matches.find((c) => isIndependentCity(c.fips));
    if (city) return { ok: true, fips: city.fips, county: city, matchedOn: "city-marker" };
  }
  if (marker === "county") {
    const county = matches.find((c) => !isIndependentCity(c.fips));
    if (county) return { ok: true, fips: county.fips, county, matchedOn: "county-marker" };
  }

  return {
    ok: false,
    reason: "ambiguous",
    detail:
      `${stateAbbr} has ${matches.length} entities named "${raw}" ` +
      `(${matches.map((c) => c.fips).join(", ")}) and the source did not say which`,
    candidates: matches,
  };
}

export interface ResolveSummary {
  resolved: number;
  ambiguous: number;
  notFound: number;
  municipal: number;
}

/** Fold a batch into counts, for reporting what a promotion run could not place. */
export function summarise(results: readonly FipsResolution[]): ResolveSummary {
  return results.reduce<ResolveSummary>(
    (acc, r) => {
      if (r.ok) acc.resolved++;
      else if (r.reason === "ambiguous") acc.ambiguous++;
      else if (r.reason === "municipal_state") acc.municipal++;
      else acc.notFound++;
      return acc;
    },
    { resolved: 0, ambiguous: 0, notFound: 0, municipal: 0 },
  );
}
