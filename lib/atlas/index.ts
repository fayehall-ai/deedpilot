/**
 * The national tax-sale rules atlas.
 *
 * Resolution model: a county's rules are its own researched entry
 * (COUNTY_DATA, 152 counties) layered over its state's defaults (STATE_DATA,
 * all 51). Anything the county research doesn't cover falls through to the
 * state — and we track exactly which fields fell through, so the UI can say
 * "state default, not verified for this county" instead of implying research
 * that hasn't happened.
 */

import { STATE_DATA, TYPE_COLORS, TYPE_DESCRIPTIONS } from "./states";
import { COUNTY_DATA } from "./county-rules";
import { COUNTY_NAMES } from "./county-names";
import { COUNTY_POPULATION } from "./population";
import { FIPS_TO_STATE } from "./fips";
import { STATE_NAMES, stateSlug, stateFromSlug } from "./state-names";
import type { County, ResolvedCountyRule, SaleType, StateRule } from "./types";

export * from "./types";
export { STATE_DATA, TYPE_COLORS, TYPE_DESCRIPTIONS, COUNTY_DATA };
export { STATE_NAMES, stateSlug, stateFromSlug };

/** Fields that can be inherited from the state when a county doesn't set them. */
const STATE_INHERITED_FIELDS = ["type", "redemption", "returns", "statute", "notes"] as const;

/**
 * Map any sale-type label onto one of the four canonical buckets.
 *
 * Counties describe their systems more precisely than the national taxonomy
 * does ("Tax Lien Assignment", "Hybrid (Lien Assignment / Judicial
 * Foreclosure)"). Those labels are worth showing verbatim, but the map legend
 * and deal maths need a fixed set, so we bucket by the leading keyword.
 */
export function toSaleType(label: string): SaleType {
  if (label.startsWith("Hybrid")) return "Hybrid";
  if (label.startsWith("Redeemable")) return "Redeemable Deed";
  if (label.startsWith("Tax Lien")) return "Tax Lien";
  if (label.startsWith("Tax Deed")) return "Tax Deed";
  return "Tax Deed";
}

/** URL-safe slug for a county name, e.g. "st-louis". */
export function countySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildCounty(fips: string, name: string): County {
  const state = FIPS_TO_STATE[fips.slice(0, 2)] ?? "";
  return {
    fips,
    name,
    state,
    stateName: STATE_NAMES[state] ?? state,
    population: COUNTY_POPULATION[fips] ?? null,
  };
}

/** Every county and county-equivalent, ordered by FIPS. */
export const ALL_COUNTIES: readonly County[] = COUNTY_NAMES.map(([fips, name]) =>
  buildCounty(fips, name),
).filter((c) => c.state !== "");

const BY_FIPS = new Map(ALL_COUNTIES.map((c) => [c.fips, c]));

const BY_STATE = ALL_COUNTIES.reduce<Record<string, County[]>>((acc, c) => {
  (acc[c.state] ??= []).push(c);
  return acc;
}, {});
for (const list of Object.values(BY_STATE)) {
  list.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCounty(fips: string): County | null {
  return BY_FIPS.get(fips) ?? null;
}

/** Counties in a state, alphabetical by name. */
export function countiesInState(stateAbbr: string): readonly County[] {
  return BY_STATE[stateAbbr] ?? [];
}

/**
 * Normalise a county name for matching across sources.
 *
 * Sources are wildly inconsistent: "POLK COUNTY", "Polk", "St. Louis City",
 * "DeWitt", "De Witt", "LaSalle Parish". Strip the jurisdiction suffix,
 * punctuation, and spacing, then compare what's left.
 */
function normalizeCountyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(county|parish|borough|census area|city and borough|municipality)\b/g, "")
    // "Saint Clair" (Title Check) vs "St. Clair" (Census) — the same county.
    // Also covers Sainte/Ste. (Ste. Genevieve, MO).
    .replace(/\bsainte\b/g, "ste")
    .replace(/\bsaint\b/g, "st")
    .replace(/[^a-z0-9]/g, "");
}

const BY_NORMALIZED_NAME = new Map<string, County>();
for (const c of ALL_COUNTIES) {
  BY_NORMALIZED_NAME.set(`${c.state}:${normalizeCountyName(c.name)}`, c);
}

/**
 * Resolve a source's county name to a canonical county. Returns null rather
 * than guessing — an unmatched name is a data-quality signal worth logging,
 * not something to paper over with a fuzzy best-effort match that silently
 * files Texas parcels under the wrong FIPS.
 */
/**
 * The word a state uses for its county-equivalent, for display.
 *
 * County names are stored bare ("Jefferson"), so anything rendering a title
 * has to add the noun — and Louisiana does not have counties. Calling a
 * Louisiana parish a county in a product whose whole value is legal precision
 * is the kind of error a subscriber notices first.
 *
 * Alaska returns an empty string on purpose: its subdivisions are a mix of
 * boroughs, census areas and one municipality, so there is no single correct
 * noun to append and the bare name is the honest rendering.
 */
export function countyNoun(stateAbbr: string): string {
  if (stateAbbr === "LA") return "Parish";
  if (stateAbbr === "AK") return "";
  return "County";
}

/** "Jefferson Parish", "Bastrop County", "Anchorage". */
export function countyLabel(stateAbbr: string, name: string): string {
  const noun = countyNoun(stateAbbr);
  return noun ? `${name} ${noun}` : name;
}

export function findCountyByName(stateAbbr: string, name: string): County | null {
  return BY_NORMALIZED_NAME.get(`${stateAbbr}:${normalizeCountyName(name)}`) ?? null;
}

export function getStateRule(stateAbbr: string): StateRule | null {
  return STATE_DATA[stateAbbr] ?? null;
}

/** States that have at least one county with individual research. */
export function statesWithResearch(): Set<string> {
  const out = new Set<string>();
  for (const fips of Object.keys(COUNTY_DATA)) {
    const abbr = FIPS_TO_STATE[fips.slice(0, 2)];
    if (abbr) out.add(abbr);
  }
  return out;
}

/** How many counties in a state have been individually researched. */
export function researchedCountCount(stateAbbr: string): number {
  let n = 0;
  for (const fips of Object.keys(COUNTY_DATA)) {
    if (FIPS_TO_STATE[fips.slice(0, 2)] === stateAbbr) n++;
  }
  return n;
}

/**
 * Resolve a county's full rule set, layering county research over state
 * defaults and recording which fields were inherited.
 *
 * Returns null only for a FIPS that isn't a real county.
 */
export function resolveCountyRule(fips: string): ResolvedCountyRule | null {
  const county = getCounty(fips);
  if (!county) return null;

  const stateRule = STATE_DATA[county.state];
  if (!stateRule) return null;

  const countyRule = COUNTY_DATA[fips];
  const inherited: string[] = [];

  // A county entry may override the sale type; everything else in the
  // state-level block (redemption/returns/statute/notes) is state-wide law and
  // is always inherited, except `notes`, which a county entry may replace with
  // county-specific commentary.
  const type: string = countyRule?.type ?? stateRule.type;
  if (!countyRule?.type) inherited.push("type");

  for (const f of STATE_INHERITED_FIELDS) {
    if (f === "type") continue;
    if (f === "notes" && countyRule?.notes) continue;
    inherited.push(f);
  }

  return {
    ...countyRule,
    county,
    type,
    saleType: toSaleType(type),
    redemption: stateRule.redemption,
    returns: stateRule.returns,
    statute: stateRule.statute,
    notes: countyRule?.notes ?? stateRule.notes,
    isStateDefault: !countyRule,
    inherited,
  };
}

/** Look up a county by state slug + county slug, for /atlas/[state]/[county]. */
export function resolveBySlug(
  stateSlugOrAbbr: string,
  county: string,
): ResolvedCountyRule | null {
  const abbr = stateFromSlug(stateSlugOrAbbr);
  if (!abbr) return null;
  const slug = county.toLowerCase();
  const match = countiesInState(abbr).find((c) => countySlug(c.name) === slug);
  return match ? resolveCountyRule(match.fips) : null;
}

/**
 * The five states with parcel-level auction coverage. Everywhere else gets
 * the rules atlas only — surfaced in the UI rather than left ambiguous.
 */
export const COVERED_STATES = ["FL", "GA", "TX", "AZ", "MI"] as const;
export type CoveredState = (typeof COVERED_STATES)[number];

export function isCovered(stateAbbr: string): stateAbbr is CoveredState {
  return (COVERED_STATES as readonly string[]).includes(stateAbbr);
}
