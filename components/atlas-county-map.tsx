/**
 * One state's counties, as a map.
 *
 * The drill-down thetaxdeed.vercel.app does with client state — national map,
 * click a state, see its counties — is done here with routes instead. Same
 * journey, but each step is a URL: `/atlas` shows the states, `/atlas/texas`
 * shows Texas's 254 counties, `/atlas/texas/harris` is the county. That
 * matters because those 1,010 county pages are the reason the atlas lives in
 * code at all; a click that only changes client state is not something a
 * search engine can index or a person can send to someone else.
 *
 * Rendered on the server as static SVG, same as the national map. The topology
 * is pre-projected to Albers USA, so a single state is drawn by taking the
 * bounding box of its counties and using that as the viewBox — no reprojection,
 * no client JavaScript.
 *
 * Counties are shaded by *how much we know about them*, not by sale type. On
 * the national map the whole point is that sale type varies by state; within a
 * state it rarely varies at all, so colouring by it would produce one flat
 * wash. What does vary — and what a reader actually needs before trusting a
 * page — is whether a county was researched individually or is showing its
 * state's defaults. The atlas says that in words on every county page; this
 * says it for the whole state at once.
 */
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import countiesTopo from "@/public/geo/counties-albers-10m.json";
import { COUNTY_DATA } from "@/lib/atlas/county-rules";
import { countyLabel, countySlug, stateSlug } from "@/lib/atlas";
import { num } from "@/lib/format";

/** Padding around the state's bounding box, in projected units. */
const PAD = 12;

interface CountyShape {
  fips: string;
  name: string;
  d: string;
  researched: boolean;
}

/**
 * Every county path, grouped by state FIPS, computed once per process.
 *
 * 3,142 paths is a lot to build per request and none of it ever changes. The
 * per-state grouping is what keeps a single state page from touching the other
 * 3,100 shapes.
 */
const BY_STATE: Map<string, Feature<Geometry, { name: string }>[]> = (() => {
  const fc = feature(
    countiesTopo as never,
    (countiesTopo as unknown as { objects: { counties: unknown } }).objects.counties as never,
  ) as unknown as FeatureCollection<Geometry, { name: string }>;

  const grouped = new Map<string, Feature<Geometry, { name: string }>[]>();
  for (const f of fc.features) {
    const fips = String(f.id).padStart(5, "0");
    const state = fips.slice(0, 2);
    const list = grouped.get(state);
    if (list) list.push(f);
    else grouped.set(state, [f]);
  }
  return grouped;
})();

export function AtlasCountyMap({
  stateAbbr,
  stateFips,
  stateName,
}: {
  stateAbbr: string;
  stateFips: string;
  stateName: string;
}) {
  const features = BY_STATE.get(stateFips);
  // Alaska's boroughs and a handful of territories are absent from the 10m
  // topology. No map is better than a broken one — the county list below it on
  // the page is the fallback, and it is complete.
  if (!features?.length) return null;

  const toPath = geoPath();
  const shapes: CountyShape[] = [];
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
    shapes.push({
      fips,
      name: f.properties?.name ?? fips,
      d,
      researched: fips in COUNTY_DATA,
    });
  }
  if (!shapes.length) return null;

  const vb = [minX - PAD, minY - PAD, maxX - minX + PAD * 2, maxY - minY + PAD * 2].join(" ");
  const researched = shapes.filter((s) => s.researched).length;

  return (
    <figure className="m-0">
      <svg
        viewBox={vb}
        className="h-auto max-h-[26rem] w-full"
        role="img"
        aria-label={`Map of ${stateName}'s ${num(shapes.length)} counties`}
      >
        {shapes.map((c) => (
          <a
            key={c.fips}
            href={`/atlas/${stateSlug(stateAbbr)}/${countySlug(c.name)}`}
            className="group/county outline-none"
          >
            <title>
              {`${countyLabel(stateAbbr, c.name)} — ${
                c.researched ? "researched individually" : "showing state defaults"
              }`}
            </title>
            <path
              d={c.d}
              /*
               * Researched counties carry the accent; the rest sit in the
               * surface tone. The contrast is the message: a pale county is
               * one whose page will tell you it inherited its state's rules.
               */
              fill={c.researched ? "var(--accent)" : "var(--surface-2)"}
              fillOpacity={c.researched ? 0.85 : 1}
              stroke="var(--border)"
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
              className="cursor-pointer transition-opacity hover:fill-accent hover:opacity-100 group-focus-visible/county:opacity-100"
            />
          </a>
        ))}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent opacity-85" />
          Researched individually ({num(researched)})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm border border-border bg-surface-2"
          />
          Showing state defaults ({num(shapes.length - researched)})
        </span>
        <span className="ml-auto">Select a county for its rules, contacts and auction logistics.</span>
      </figcaption>
    </figure>
  );
}
