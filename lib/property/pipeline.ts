/**
 * The order in which a county gets valuations, and how to tell where it is stuck.
 *
 * Coverage went from 18% to 86% of pending inventory in a day, and almost all of
 * the wasted effort came from doing these steps out of order — paying a searched
 * call for a parcel a free county layer answers in 110ms, or hunting a layer for
 * a county whose identifiers could never have matched one.
 *
 * The stages below are ordered by cost and by evidential strength, which happen
 * to agree. `nextAction` reads a county's shape and says which stage it is on.
 *
 * ## The stages
 *
 * 1. **Published in the listing.** Some sources carry a value already — Michigan's
 *    `tax-sale.info` publishes SEV. Free, no lookup, and the source of record.
 *    Nothing to do but parse it.
 *
 * 2. **Cadastre.** The county's or state's own ArcGIS parcel layer, keyed on
 *    parcel number. Free, keyless, ~110ms, and it is the data ATTOM aggregates
 *    rather than a copy of it. Needs a verified registry entry.
 *
 * 3. **Geocode.** Not a valuation — an enabler. The Census geocoder returns the
 *    locality and ZIP with the point, and those are what address-keyed providers
 *    need. Louisiana's lots had a street address and no city, which is the only
 *    reason RentCast had been refusing 1,638 of them.
 *
 * 4. **Address providers.** RentCast, metered. Only worth calling once a lot has
 *    a city; without one the call is spend with no chance of an answer.
 *
 * 5. **Web search.** Last, ~20s and a paid call each. Barred from writing
 *    `assessedValue` — it may only report a market figure, because a searched
 *    estimate divided by an assessment ratio becomes a bid on a number nobody
 *    published.
 *
 * ## What decides between them
 *
 * Whether the lots carry a parcel number, a street address, or neither — and
 * whether a verified layer exists for that county. Not which is nicest.
 */

import { CADASTRE_SOURCES } from "./providers/cadastre";

export type Stage =
  | "already-valued"
  | "cadastre"
  | "needs-layer"
  | "geocode"
  | "address-provider"
  | "search-or-nothing";

export interface CountyShape {
  fips: string;
  state: string;
  name: string;
  lots: number;
  valued: number;
  withParcel: number;
  /** Street addresses carrying a house number — a street name alone is not one. */
  withNumberedAddress: number;
  withCity: number;
}

export interface Recommendation {
  stage: Stage;
  /** What to run, verbatim. */
  command: string | null;
  why: string;
  /** Lots this would put in reach. */
  reachable: number;
}

/** Whether a county or its state has a verified parcel layer. */
export function hasCadastre(fips: string, state: string): boolean {
  return Boolean(CADASTRE_SOURCES[fips] ?? CADASTRE_SOURCES[state.toUpperCase()]);
}

/**
 * The one thing to do next for this county.
 *
 * Deliberately returns a single action rather than a list. A list invites
 * picking the interesting one, and the whole lesson of today is that the order
 * is the point: a searched call for a parcel the county publishes for free is
 * not a slower route to the same answer, it is a worse answer that costs money.
 */
export function nextAction(c: CountyShape): Recommendation {
  const missing = c.lots - c.valued;

  if (missing <= 0) {
    return { stage: "already-valued", command: null, why: "every lot has a valuation", reachable: 0 };
  }

  // 2. A verified layer is the cheapest real answer, so it goes first whenever
  //    one exists and the lots carry the identifier it keys on.
  if (hasCadastre(c.fips, c.state) && c.withParcel > 0) {
    /*
     * A statewide entry gets a statewide command, so forty-five Arkansas
     * counties collapse into one action instead of forty-five rows saying the
     * same thing. A county-keyed entry stays county-scoped, because that is all
     * it covers.
     */
    const statewide = Boolean(CADASTRE_SOURCES[c.state.toUpperCase()]);
    return {
      stage: "cadastre",
      command: statewide
        ? `npx tsx scripts/bulk-cadastre.ts --state ${c.state}`
        : `npx tsx scripts/bulk-cadastre.ts --fips ${c.fips}`,
      why: "a verified parcel layer covers this county and the lots carry parcel numbers",
      reachable: Math.min(missing, c.withParcel),
    };
  }

  // No layer, but parcel numbers to match one with — worth hunting for.
  if (!hasCadastre(c.fips, c.state) && c.withParcel > 0 && c.withNumberedAddress === 0) {
    return {
      stage: "needs-layer",
      command: `npx tsx scripts/discover-parcel-layers.ts --state ${c.state}`,
      why:
        "parcel numbers but no address and no registry entry — only a parcel layer can answer, " +
        "and discovery verifies a candidate against these very parcels before reporting it",
      reachable: Math.min(missing, c.withParcel),
    };
  }

  // 3. Addresses without a city cannot reach an address provider. Geocoding is
  //    free and supplies the locality, so it comes before spending anything.
  if (c.withNumberedAddress > c.withCity) {
    return {
      stage: "geocode",
      command: `npx tsx scripts/geocode-lots.ts --state ${c.state}`,
      why: `${c.withNumberedAddress - c.withCity} lots have a street address and no city; ` +
        "the geocoder supplies the city and ZIP that address providers key on",
      reachable: Math.min(missing, c.withNumberedAddress - c.withCity),
    };
  }

  // 4. Metered, and only where it can actually answer.
  if (c.withCity > 0) {
    return {
      stage: "address-provider",
      command: `npx tsx scripts/bulk-rentcast.ts --state ${c.state}`,
      why: "lots have a full address; RentCast is metered, so this is real spend",
      reachable: Math.min(missing, c.withCity),
    };
  }

  return {
    stage: "search-or-nothing",
    command: null,
    why:
      "no parcel layer resolves these identifiers and there are no addresses to geocode — " +
      "a searched lookup is the only route left, at ~20s and a paid call per lot, and it may " +
      "only report a market value",
    reachable: 0,
  };
}

/** Human-readable order, for anything that needs to explain itself. */
export const STAGE_ORDER: { stage: Stage; label: string; cost: string }[] = [
  { stage: "already-valued", label: "Published in the listing or already filled", cost: "free" },
  { stage: "cadastre", label: "County or state parcel layer", cost: "free" },
  { stage: "needs-layer", label: "Find and verify a parcel layer", cost: "free" },
  { stage: "geocode", label: "Geocode for city and ZIP", cost: "free" },
  { stage: "address-provider", label: "Address provider (RentCast)", cost: "metered" },
  { stage: "search-or-nothing", label: "Web search, or leave null", cost: "~20s + a paid call each" },
];
