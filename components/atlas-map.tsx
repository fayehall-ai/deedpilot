/**
 * The national map — how tax-defaulted property is sold, state by state.
 *
 * Rendered entirely on the server as static SVG. The TopoJSON in `public/geo/`
 * is *pre-projected* to Albers USA, so `geoPath()` needs no projection and the
 * whole thing is a pure function of data that never changes. Nothing about
 * this ships to the browser as JavaScript: no map library, no hydration, no
 * client bundle — just paths and links, which is also why it works with the
 * page's prerendered shell.
 *
 * Colour carries the same meaning as everywhere else in the product. The four
 * hues are the sale-type tokens from `globals.css`, which exist so the map
 * legend and the badges on every county page cannot drift apart.
 *
 * States only. The county TopoJSON is ten times the size and 3,142 paths, and
 * the question this section answers — "how does this state sell, and where do
 * I start reading" — is a state-level question. County detail lives one click
 * away on the page a search engine can actually index.
 */
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import statesTopo from "@/public/geo/states-albers-10m.json";
import { FIPS_TO_STATE } from "@/lib/atlas/fips";
import {
  STATE_DATA,
  STATE_NAMES,
  TYPE_COLORS,
  countiesInState,
  isCovered,
  researchedCountCount,
  stateSlug,
  toSaleType,
} from "@/lib/atlas";
import { num, saleTypeColor } from "@/lib/format";
import type { SaleType } from "@/lib/atlas/types";

/** The viewBox the Albers-projected 10m topology is authored against. */
const WIDTH = 975;
const HEIGHT = 610;

interface StatePath {
  fips: string;
  abbr: string;
  name: string;
  d: string;
  saleType: SaleType;
  counties: number;
  researched: number;
  covered: boolean;
}

/**
 * Project once, at module load.
 *
 * This is a pure transform of a static file, so doing it per request would be
 * the same answer computed repeatedly. Module scope runs it once per server
 * process instead.
 */
const STATE_PATHS: StatePath[] = (() => {
  // The topology's own typings are loose; the shape is checked by what we read.
  const fc = feature(
    statesTopo as never,
    (statesTopo as unknown as { objects: { states: unknown } }).objects.states as never,
  ) as unknown as FeatureCollection<Geometry, { name: string }>;

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
        d,
        saleType: toSaleType(rule.type),
        counties: countiesInState(abbr).length,
        researched: researchedCountCount(abbr),
        covered: isCovered(abbr),
      };
    })
    .filter((s): s is StatePath => s !== null);
})();

export function AtlasMap() {
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label="United States map, each state shaded by how it sells tax-defaulted property"
      >
        {STATE_PATHS.map((s) => (
          <a
            key={s.fips}
            href={`/atlas/${stateSlug(s.abbr)}`}
            /*
             * A plain SVG anchor rather than next/link. These go to 51
             * different pages and prefetching all of them on sight would cost
             * far more than the navigation saves.
             */
            className="group/state outline-none"
          >
            <title>
              {`${s.name} — ${s.saleType}. ${num(s.counties)} counties`}
              {s.researched > 0 ? `, ${num(s.researched)} researched` : ""}
              {s.covered ? ", live auction inventory" : ""}
            </title>
            <path
              d={s.d}
              fill={saleTypeColor(s.saleType)}
              /*
               * The border colour is the page's own, so the map sits on the
               * surface rather than floating above it, and the hover state
               * lifts a state without changing its meaning-bearing fill.
               */
              stroke="var(--surface)"
              strokeWidth={0.75}
              className="cursor-pointer opacity-80 transition-opacity group-hover/state:opacity-100 group-focus-visible/state:opacity-100"
            />
          </a>
        ))}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
        {(Object.keys(TYPE_COLORS) as (keyof typeof TYPE_COLORS)[]).map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: saleTypeColor(t) }}
            />
            {t}
          </span>
        ))}
        <span className="ml-auto">Select a state for its counties, statutes and auction rules.</span>
      </figcaption>
    </figure>
  );
}
