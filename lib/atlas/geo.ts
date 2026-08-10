/**
 * Map geometry for the atlas — projected once, shared by every surface.
 *
 * The TopoJSON in `public/geo/` is *pre-projected* to Albers USA, so `geoPath()`
 * needs no projection: turning it into SVG path strings is a pure function of a
 * file that never changes. That is done here, at module load, so the server
 * components, the static pages and the API route that feeds the interactive
 * explorer all draw exactly the same shapes.
 *
 * Nothing in here is client code. The explorer receives finished path strings
 * rather than topology, which is what keeps d3 and 800KB of TopoJSON out of the
 * browser bundle — the national view ships 51 paths, and a state's counties are
 * fetched only when someone asks for that state.
 */
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import statesTopo from "@/public/geo/states-albers-10m.json";
import countiesTopo from "@/public/geo/counties-albers-10m.json";
import { COUNTY_DATA } from "./county-rules";
import { FIPS_TO_STATE } from "./fips";
import { STATE_DATA } from "./states";
import { STATE_NAMES, stateSlug } from "./state-names";
import { countiesInState, countyLabel, countySlug, isCovered, researchedCountCount, toSaleType } from "./index";
import type { CountyRule, SaleType } from "./types";

/** The viewBox the Albers-projected 10m topology is authored against. */
export const NATIONAL_VIEWBOX = { width: 975, height: 610 };

/** Padding around a state's bounding box, in projected units. */
const STATE_PAD = 12;

export interface StatePath {
  fips: string;
  abbr: string;
  name: string;
  slug: string;
  d: string;
  saleType: SaleType;
  counties: number;
  researched: number;
  covered: boolean;
}

export interface CountyPath {
  fips: string;
  name: string;
  /** "Harris County" / "Jefferson Parish" — the state's own noun. */
  label: string;
  slug: string;
  d: string;
  researched: boolean;
}

export interface StateCountyMap {
  abbr: string;
  name: string;
  slug: string;
  viewBox: string;
  counties: CountyPath[];
}

function toFeatureCollection(topo: unknown, objectName: string) {
  return feature(
    topo as never,
    (topo as { objects: Record<string, unknown> }).objects[objectName] as never,
  ) as unknown as FeatureCollection<Geometry, { name: string }>;
}

/** All 51 state shapes, coloured by how that state sells. */
export const STATE_PATHS: StatePath[] = (() => {
  const fc = toFeatureCollection(statesTopo, "states");
  const toPath = geoPath();

  return fc.features
    .map((f) => {
      const fips = String(f.id).padStart(2, "0");
      const abbr = FIPS_TO_STATE[fips];
      const rule = abbr ? STATE_DATA[abbr] : undefined;
      const d = toPath(f);
      if (!abbr || !rule || !d) return null;
      return {
        fips,
        abbr,
        name: STATE_NAMES[abbr] ?? f.properties?.name ?? abbr,
        slug: stateSlug(abbr),
        d,
        saleType: toSaleType(rule.type),
        counties: countiesInState(abbr).length,
        researched: researchedCountCount(abbr),
        covered: isCovered(abbr),
      };
    })
    .filter((s): s is StatePath => s !== null);
})();

/**
 * County features grouped by state FIPS, so one state never touches the other
 * 3,100 shapes.
 */
const COUNTIES_BY_STATE: Map<string, Feature<Geometry, { name: string }>[]> = (() => {
  const fc = toFeatureCollection(countiesTopo, "counties");
  const grouped = new Map<string, Feature<Geometry, { name: string }>[]>();
  for (const f of fc.features) {
    const fips = String(f.id).padStart(5, "0");
    const key = fips.slice(0, 2);
    const list = grouped.get(key);
    if (list) list.push(f);
    else grouped.set(key, [f]);
  }
  return grouped;
})();

/**
 * One state's counties, with a viewBox framing just that state.
 *
 * Returns null where the 10m topology has no shapes for the state — Alaska's
 * boroughs and a few territories. No map beats a broken one; callers fall back
 * to the county list, which is complete.
 */
export function countyMapFor(abbr: string): StateCountyMap | null {
  const stateFips = Object.entries(FIPS_TO_STATE).find(([, a]) => a === abbr)?.[0];
  const features = stateFips ? COUNTIES_BY_STATE.get(stateFips) : undefined;
  if (!features?.length) return null;

  const toPath = geoPath();
  const counties: CountyPath[] = [];
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];

  for (const f of features) {
    const d = toPath(f);
    if (!d) continue;
    const fips = String(f.id).padStart(5, "0");
    const [[x0, y0], [x1, y1]] = toPath.bounds(f);
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
    const name = f.properties?.name ?? fips;
    counties.push({
      fips,
      name,
      label: countyLabel(abbr, name),
      slug: countySlug(name),
      d,
      researched: fips in COUNTY_DATA,
    });
  }
  if (!counties.length) return null;

  counties.sort((a, b) => a.name.localeCompare(b.name));

  return {
    abbr,
    name: STATE_NAMES[abbr] ?? abbr,
    slug: stateSlug(abbr),
    viewBox: [
      minX - STATE_PAD,
      minY - STATE_PAD,
      maxX - minX + STATE_PAD * 2,
      maxY - minY + STATE_PAD * 2,
    ].join(" "),
    counties,
  };
}

/** What the explorer's detail panel shows for one county. */
export interface CountyDetail extends CountyPath {
  rule: CountyRule | null;
}

/** A state's map plus the researched rules for its counties. */
export interface StatePayload extends StateCountyMap {
  saleType: SaleType;
  stateNotes?: string;
  counties: CountyDetail[];
}

export function statePayload(abbr: string): StatePayload | null {
  const map = countyMapFor(abbr);
  const rule = STATE_DATA[abbr];
  if (!map || !rule) return null;
  return {
    ...map,
    saleType: toSaleType(rule.type),
    stateNotes: rule.notes,
    counties: map.counties.map((c) => ({
      ...c,
      rule: (COUNTY_DATA as Record<string, CountyRule>)[c.fips] ?? null,
    })),
  };
}
