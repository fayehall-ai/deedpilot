"use client";

/**
 * The interactive atlas: national map → a state's counties → county detail,
 * without leaving the page.
 *
 * Only the geometry moves. The 51 national paths arrive with the page; a
 * state's counties are fetched once, on the click that opens them, and kept
 * for the rest of the session. That keeps the initial payload to 51 path
 * strings instead of the 800KB county topology and 2.7MB of county rules the
 * whole country would cost.
 *
 * Every shape is still a real anchor with a real href. The click is
 * intercepted for the in-place drill-down, but cmd-click, middle-click, "open
 * in new tab" and a crawler following the link all reach `/atlas/<state>` and
 * `/atlas/<state>/<county>` — the pages that exist anyway. Interactivity is
 * added on top of working links rather than replacing them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CountyDetail, StatePath, StatePayload } from "@/lib/atlas/geo";
import { NATIONAL_VIEWBOX } from "@/lib/atlas/geo";
import { num } from "@/lib/format";
import { CountyAuctions, type AuctionRow } from "./county-auctions";

/** A modified click means the reader wants a new tab — never intercept it. */
function opensElsewhere(e: React.MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

/**
 * Minimum-population stops for the filter.
 *
 * A stepped ladder rather than a linear range: county populations span four
 * orders of magnitude, so a linear slider spends nine tenths of its travel
 * between "everything" and "everything except twelve counties".
 *
 * Index 0 is "All", and that is the default on purpose. The obvious default is
 * 50k+, and it is the wrong one here: Arkansas is 45 counties and 6,199 lots —
 * 55% of live inventory — and almost none of those counties clear 50,000
 * residents. `lib/coverage/scoreboard.ts` records the same mistake being made
 * once already, where a population ranking "hid Arkansas for months". A filter
 * that ships pre-set to hide the majority of your own inventory is a bug with a
 * default value.
 */
const POPULATION_STOPS: { min: number; label: string }[] = [
  { min: 0, label: "All" },
  { min: 1_000, label: "1k+" },
  { min: 2_500, label: "2.5k+" },
  { min: 5_000, label: "5k+" },
  { min: 10_000, label: "10k+" },
  { min: 25_000, label: "25k+" },
  { min: 50_000, label: "50k+" },
  { min: 100_000, label: "100k+" },
  { min: 250_000, label: "250k+" },
  { min: 500_000, label: "500k+" },
  { min: 1_000_000, label: "1M+" },
];

const TYPE_COLOR: Record<string, string> = {
  "Tax Lien": "var(--type-lien)",
  "Tax Deed": "var(--type-deed)",
  "Redeemable Deed": "var(--type-redeemable)",
  Hybrid: "var(--type-hybrid)",
};

export function AtlasExplorer({
  states,
  initialState = null,
  auctions = [],
}: {
  states: StatePath[];
  /**
   * Every upcoming sale, filtered in the browser as the selection changes.
   *
   * Passed whole rather than fetched per click: it is about a hundred and forty
   * rows, and a request on every county would make the map feel slower than the
   * question deserves. "Which counties sell what" and "when do they sell" are
   * one question, and this is the half that used to live behind a nav item.
   */
  auctions?: AuctionRow[];
  /**
   * Open on a state from the first paint. `/atlas/<state>` passes its own
   * payload so the page arrives already drilled in — the county map is in the
   * server-rendered HTML rather than appearing after a fetch, and a county
   * click there stays on the page like everywhere else.
   */
  initialState?: StatePayload | null;
}) {
  const [openState, setOpenState] = useState<StatePayload | null>(initialState);
  const [county, setCounty] = useState<CountyDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popIndex, setPopIndex] = useState(0);
  const minPopulation = POPULATION_STOPS[popIndex].min;

  /**
   * Counties clearing the population filter.
   *
   * A null population passes. The shapefile carries features the Census table
   * does not, and silently dropping a county because we lack a number for it
   * would be the filter quietly deleting data rather than narrowing it.
   */
  const passesPopulation = useCallback(
    (c: CountyDetail) => c.population === null || c.population >= minPopulation,
    [minPopulation],
  );
  const visibleCounties = openState?.counties.filter(passesPopulation) ?? [];
  /** Fetched states, kept so re-opening one is instant. */
  const cache = useRef(
    new Map<string, StatePayload>(initialState ? [[initialState.slug, initialState]] : []),
  );

  const openStateBySlug = useCallback(async (slug: string) => {
    setError(null);
    setCounty(null);
    const hit = cache.current.get(slug);
    if (hit) {
      setOpenState(hit);
      return;
    }
    setLoading(slug);
    try {
      const res = await fetch(`/api/atlas/${slug}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const payload = (await res.json()) as StatePayload;
      cache.current.set(slug, payload);
      setOpenState(payload);
    } catch {
      // A failed fetch must not strand the reader on a blank map. Say so, and
      // leave the link they clicked as the way through.
      setError(slug);
    } finally {
      setLoading(null);
    }
  }, []);

  // Escape steps back out, the way a dialog would.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (county) setCounty(null);
      else if (openState) setOpenState(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [county, openState]);

  /*
   * When a county is open the *copy* is the thing being read, and the map is
   * orientation. The old split was `1fr / 20rem`, so Mississippi sat in a
   * letterboxed white field while Jones County wrapped at 320px. Flip it:
   * map becomes a fitted column, the panel takes the rest. With no county
   * selected the map stays the lead — the national view needs the width.
   */
  const mapLeads = !county;

  return (
    <>
      <div
        className={`grid items-start gap-6 ${
          mapLeads
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]"
            : "lg:grid-cols-[minmax(16rem,28rem)_minmax(0,1fr)]"
        }`}
      >
      <div>
        {/*
          Controls above the map, driving the same state the map clicks do.
          Two ways into the same place: pointing at a shape is faster when you
          know where the county is, and a named list is the only way in when you
          do not — or when you are on a phone, where a 60-county map is a set of
          two-millimetre tap targets.
        */}
        <div
          className={`mb-4 grid gap-3 sm:grid-cols-2 ${
            mapLeads ? "lg:grid-cols-[1fr_1fr_14rem]" : "lg:grid-cols-1"
          }`}
        >
          <label className="block">
            <span className="mb-1 block text-sm font-medium uppercase tracking-[0.12em] text-muted">State</span>
            <select
              value={openState?.slug ?? ""}
              onChange={(e) => {
                const slug = e.target.value;
                if (!slug) {
                  setOpenState(null);
                  setCounty(null);
                  return;
                }
                void openStateBySlug(slug);
              }}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-base hover:border-accent focus:border-accent focus:outline-none"
            >
              <option value="">All states</option>
              {[...states]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((s) => (
                  <option key={s.fips} value={s.slug}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium uppercase tracking-[0.12em] text-muted">County</span>
            <select
              value={county?.fips ?? ""}
              disabled={!openState}
              onChange={(e) => {
                const fips = e.target.value;
                setCounty(openState?.counties.find((c) => c.fips === fips) ?? null);
              }}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-base hover:border-accent focus:border-accent focus:outline-none disabled:opacity-60 disabled:hover:border-border"
            >
              <option value="">
                {openState
                  ? `All ${visibleCounties.length} counties`
                  : "Select a state first…"}
              </option>
              {visibleCounties.map((c) => (
                <option key={c.fips} value={c.fips}>
                  {c.label}
                  {c.population === null ? "" : ` — ${num(c.population)}`}
                  {c.researched ? " ★" : ""}
                </option>
              ))}
            </select>
          </label>

          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Min. population</span>
              <span className="tnum text-sm font-medium">{POPULATION_STOPS[popIndex].label}</span>
            </div>
            <input
              type="range"
              min={0}
              max={POPULATION_STOPS.length - 1}
              step={1}
              value={popIndex}
              onChange={(e) => setPopIndex(Number(e.target.value))}
              aria-label="Minimum county population"
              aria-valuetext={POPULATION_STOPS[popIndex].label}
              className="mt-2 w-full accent-[var(--gold)]"
            />
            {/* Says what the filter is doing to the map, so a suddenly sparse
                state reads as a filter rather than as missing data. */}
            {openState && popIndex > 0 ? (
              <p className="mt-1 text-xs text-muted">
                {num(visibleCounties.length)} of {num(openState.counties.length)} shown
              </p>
            ) : null}
          </div>
        </div>

        {/* Breadcrumb + reset, mirroring where you are in the drill-down. */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-base">
          <button
            type="button"
            onClick={() => {
              setOpenState(null);
              setCounty(null);
            }}
            disabled={!openState}
            className="text-muted underline-offset-2 hover:text-foreground hover:underline disabled:no-underline disabled:opacity-60"
          >
            United States
          </button>
          {openState ? (
            <>
              <span aria-hidden className="text-muted">
                /
              </span>
              <button
                type="button"
                onClick={() => setCounty(null)}
                className="text-muted underline-offset-2 hover:text-foreground hover:underline"
              >
                {openState.name}
              </button>
            </>
          ) : null}
          {county ? (
            <>
              <span aria-hidden className="text-muted">
                /
              </span>
              <span className="text-foreground">{county.label}</span>
            </>
          ) : null}

          <span className="ml-auto text-xs text-muted">
            {openState
              ? "Select a county, or press Escape to go back"
              : "Select a state to see its counties"}
          </span>
        </div>

        {error ? (
          <p className="mb-3 rounded-lg border border-warn/40 bg-surface-2 px-3 py-2 text-xs text-muted">
            That state&apos;s map could not be loaded.{" "}
            <a href={`/atlas/${error}`} className="underline hover:text-foreground">
              Open its page instead
            </a>
            .
          </p>
        ) : null}

        <div className="relative flex min-h-[22rem] items-center justify-center rounded-3xl border border-border bg-surface p-4">
          {loading ? (
            <span
              role="status"
              className="absolute right-4 top-4 text-xs text-muted"
              aria-live="polite"
            >
              Loading {loading.replace(/-/g, " ")}…
            </span>
          ) : null}

          {openState ? (
            <svg
              viewBox={openState.viewBox}
              className="mx-auto h-auto max-h-[min(70vh,42rem)] w-full"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`Counties of ${openState.name}`}
            >
              {openState.counties.map((c) => {
                /*
                 * Filtered-out counties dim; they never disappear and never
                 * stop being clickable. Every county has a real page, and a
                 * slider is a way to emphasise part of the map — not a reason
                 * to make the rest of it unreachable. Someone who drags to
                 * 250k+ and then spots the small county they actually came for
                 * can still click it.
                 */
                const dimmed = !passesPopulation(c);
                const selected = county?.fips === c.fips;
                return (
                  <a
                    key={c.fips}
                    href={`/atlas/${openState.slug}/${c.slug}`}
                    onClick={(e) => {
                      if (opensElsewhere(e)) return;
                      e.preventDefault();
                      setCounty(c);
                    }}
                    className="outline-none"
                  >
                    {/* Single expression — see the note on the national map. */}
                    <title>
                      {`${c.label} — ${c.researched ? "researched individually" : "showing state defaults"}` +
                        (c.population === null ? "" : `, ${num(c.population)} residents`) +
                        (dimmed ? " (below the population filter)" : "")}
                    </title>
                    <path
                      d={c.d}
                      fill={
                        selected
                          ? "var(--accent)"
                          : c.researched
                            ? "var(--accent)"
                            : "var(--surface-2)"
                      }
                      fillOpacity={
                        dimmed && !selected ? 0.15 : selected ? 1 : c.researched ? 0.85 : 1
                      }
                      stroke={selected ? "var(--foreground)" : "var(--border)"}
                      strokeWidth={selected ? 1.2 : 0.4}
                      vectorEffect="non-scaling-stroke"
                      className="cursor-pointer transition-opacity hover:opacity-100"
                    />
                  </a>
                );
              })}
            </svg>
          ) : (
            <svg
              viewBox={`${NATIONAL_VIEWBOX.x} ${NATIONAL_VIEWBOX.y} ${NATIONAL_VIEWBOX.width} ${NATIONAL_VIEWBOX.height}`}
              className="h-auto w-full"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="United States map, each state shaded by how it sells tax-defaulted property"
            >
              {states.map((s) => (
                <a
                  key={s.fips}
                  href={`/atlas/${s.slug}`}
                  onClick={(e) => {
                    if (opensElsewhere(e)) return;
                    e.preventDefault();
                    void openStateBySlug(s.slug);
                  }}
                  className="outline-none"
                >
                  {/*
                    One expression, not three children. React separates
                    adjacent text children with comment markers in the
                    server-rendered HTML; inside `<title>` the browser
                    normalises those away, so the client tree no longer matches
                    and hydration fails on `/atlas` with "server rendered HTML
                    didn't match the client". React then throws away and
                    re-renders this subtree — which on a page whose whole point
                    is an interactive map is the difference between a map and a
                    blank panel. Concatenate before it reaches JSX.
                  */}
                  <title>
                    {`${s.name} — ${s.saleType}. ${s.counties} counties` +
                      (s.researched > 0 ? `, ${s.researched} researched` : "") +
                      (s.covered ? ", live auction inventory" : "")}
                  </title>
                  <path
                    d={s.d}
                    fill={TYPE_COLOR[s.saleType] ?? "var(--muted)"}
                    stroke="var(--surface)"
                    strokeWidth={0.75}
                    className="cursor-pointer opacity-80 transition-opacity hover:opacity-100"
                  />
                </a>
              ))}

              {/*
                Labels last, in one pass after every shape, so a neighbouring
                state can never paint over another's code. They are
                pointer-events:none so the letters do not swallow the click
                meant for the state under them.
              */}
              <g className="pointer-events-none">
                {states.map((s) =>
                  s.leader ? (
                    <line
                      key={`l${s.fips}`}
                      x1={s.leader.x1}
                      y1={s.leader.y1}
                      x2={s.leader.x2}
                      y2={s.leader.y2}
                      stroke="var(--muted)"
                      strokeWidth={0.6}
                    />
                  ) : null,
                )}
                {states.map((s) => (
                  <text
                    key={`t${s.fips}`}
                    x={s.label.x}
                    y={s.label.y}
                    textAnchor={s.label.external ? "start" : "middle"}
                    dominantBaseline="central"
                    fontSize={s.label.external ? 13 : 14}
                    fontWeight={600}
                    /*
                     * White on the sale-type fills, which are mid-tone enough
                     * to carry it in both themes; the gutter labels sit on the
                     * page background and take the page's own text colour.
                     */
                    fill={s.label.external ? "var(--foreground)" : "#fff"}
                    className="select-none"
                  >
                    {s.abbr}
                  </text>
                ))}
              </g>
            </svg>
          )}
        </div>

        {/* Legend swaps with the view, because the colours mean different things. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted">
          {openState ? (
            <>
              <Swatch color="var(--accent)" opacity={0.85} />
              Researched individually (
              {openState.counties.filter((c) => c.researched).length})
              <Swatch color="var(--surface-2)" bordered />
              Showing state defaults (
              {openState.counties.filter((c) => !c.researched).length})
            </>
          ) : (
            Object.entries(TYPE_COLOR).map(([label, color]) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <Swatch color={color} />
                {label}
              </span>
            ))
          )}
        </div>
      </div>

      <DetailPanel state={openState} county={county} />
      </div>

      {/*
        Sales sit under the map, not behind a nav item.
        
        Choosing a county and asking "does it have a sale coming up" used to mean
        leaving for /auctions and coming back — which made comparing two counties
        a round trip each. The answer now appears where the question was asked.
        
        Unfiltered it stays collapsed: a wall of dates answers a question nobody
        has asked yet. Once a county is chosen it opens, because at that point it
        is the answer rather than an aside.
      */}
      <CountyAuctions
        auctions={auctions}
        countyFips={county?.fips ?? null}
        countyLabel={county?.label ?? null}
        stateAbbr={openState?.abbr ?? null}
      />
    </>
  );
}

function Swatch({
  color,
  opacity = 1,
  bordered = false,
}: {
  color: string;
  opacity?: number;
  bordered?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`h-2.5 w-2.5 shrink-0 rounded-sm ${bordered ? "border border-border" : ""}`}
      style={{ background: color, opacity }}
    />
  );
}

/**
 * The panel beside the map.
 *
 * This used to describe itself as "deliberately a summary, not the county page",
 * and it is no longer true. The panel grew until it carried surviving liens,
 * quiet title, auction format, platform, frequency, deposit rules, offices,
 * notes, check dates and sources — everything on `/atlas/<state>/<county>`
 * except state-level deal maths, which belongs with the state anyway.
 *
 * The "Full county page →" link outlived that. It was pitched as "more detail"
 * while leading to a near-copy, and it cost the reader their place in the map to
 * get there. Removed, along with the equivalent state link, whose page adds only
 * a grid of county cards — and the map is a better county grid.
 *
 * Both pages still exist and are still worth having as shareable, indexable URLs
 * for someone arriving from search. The map simply should not be a funnel out of
 * itself.
 */
function DetailPanel({
  state,
  county,
}: {
  state: StatePayload | null;
  county: CountyDetail | null;
}) {
  if (!state) {
    return (
      <aside className="rounded-3xl border border-border/70 bg-surface p-6 shadow-[var(--shadow-sm)]">
        <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Select a state</p>
        <h3 className="font-display mt-1 text-2xl font-medium tracking-tight">Tax sale system</h3>
        <p className="mt-3 text-base leading-relaxed text-muted">
          Colour is how the state sells: a lien, a deed, a redeemable deed, or a hybrid. Select one
          to see its counties and which of them have been researched individually.
        </p>
      </aside>
    );
  }

  if (!county) {
    const researched = state.counties.filter((c) => c.researched).length;
    return (
      <aside className="rounded-3xl border border-border/70 bg-surface p-6 shadow-[var(--shadow-sm)]">
        <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted">{state.saleType}</p>
        <h3 className="font-display mt-1 text-2xl font-medium tracking-tight">{state.name}</h3>
        <p className="mt-3 text-base text-muted">
          {state.counties.length} counties · {researched} researched individually
        </p>
        {state.stateNotes ? (
          <p className="mt-3 text-base leading-relaxed text-muted">{state.stateNotes}</p>
        ) : null}
        {/*
          No "full state page" link.
          
          That page's only addition over this panel is a grid of county cards,
          and the map beside this is a better county grid — spatial, filterable,
          and already open. Sending someone there traded a good interface for a
          worse copy of it and cost them their place in the map.
          
          The page still exists and is still worth having as a shareable,
          indexable URL for someone arriving from search. The map simply should
          not be a funnel out of itself.
        */}
      </aside>
    );
  }

  const r = county.rule;
  const offices = r
    ? ([
        ["Tax collector", r.taxCollector],
        ["Clerk of court", r.clerkOfCourt],
        ["Property appraiser", r.propertyAppraiser],
        ["GIS / parcel map", r.gisMap],
      ] as const).filter(([, ref]) => ref?.label)
    : [];

  return (
    /*
     * Scrolls internally rather than growing the page. A researched county
     * carries enough prose — surviving liens, quiet title, deposit rules — to
     * run past the map beside it, and a panel taller than the thing it
     * describes pushes the map off screen mid-read.
     */
    <aside className="rounded-3xl border border-border/70 bg-surface p-7 shadow-[var(--shadow-md)]">
      <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted">{state.name}</p>
      <h3 className="font-display mt-1 text-3xl font-medium tracking-tight">{county.label}</h3>
      {/* The county's own label when it runs a finer-grained system than the
          four national buckets the map colour can express. */}
      {r?.type ? <p className="mt-1 text-base text-muted">{r.type}</p> : null}

      {r ? (
        <div className="mt-6 space-y-6 text-base">
          {/*
            Risk first, logistics second. These two are what a bid is wrong
            about when it is wrong expensively: a surviving municipal lien and
            a required quiet title action are both money the opening bid does
            not mention. Burying them under "Format: online" — as this panel
            did while it showed five fields and a link — puts the cheapest
            information at the top and the costliest behind a navigation.
          */}
          {r.survivingLiens || r.quietTitle ? (
            <dl className="space-y-4 rounded-2xl border border-warn/30 bg-warn/5 p-5">
              {r.survivingLiens ? (
                <Field label="Surviving liens">{r.survivingLiens}</Field>
              ) : null}
              {r.quietTitle ? <Field label="Quiet title">{r.quietTitle}</Field> : null}
            </dl>
          ) : null}

          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {r.auctionFormat ? <Field label="Format">{r.auctionFormat}</Field> : null}
            {r.auctionPlatform?.label ? (
              <Field label="Platform">
                <Ref link={r.auctionPlatform} />
              </Field>
            ) : null}
            {r.auctionFrequency ? <Field label="Frequency">{r.auctionFrequency}</Field> : null}
            {r.depositRules ? <Field label="Deposit">{r.depositRules}</Field> : null}
          </dl>

          {offices.length > 0 ? (
            <dl className="grid gap-x-8 gap-y-4 border-t border-border pt-5 sm:grid-cols-2">
              {offices.map(([label, ref]) => (
                <Field key={label} label={label}>
                  <Ref link={ref!} />
                </Field>
              ))}
            </dl>
          ) : null}

          {r.notes ? (
            <div className="border-t border-border pt-3">
              <Field label="Notes">{r.notes}</Field>
            </div>
          ) : null}

          {r.growthNeighborhoods?.length ? (
            <div className="border-t border-border pt-3">
              <p className="text-xs uppercase tracking-wide text-muted">Areas trending up</p>
              <ul className="mt-1.5 space-y-1.5">
                {r.growthNeighborhoods.map((g) => (
                  <li key={g.name} className="leading-relaxed">
                    <span className="font-medium">{g.name}</span>
                    <span className="text-muted"> — {g.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Dated and sourced, or it is just an assertion. Collapsed because
              the citations matter on challenge, not on every read. */}
          {r.asOf || r.sources?.length ? (
            <div className="border-t border-border pt-3">
              {r.asOf ? (
                <p className="text-xs text-muted">Logistics and contacts checked {r.asOf}</p>
              ) : null}
              {r.sources?.length ? (
                <details className="group/src mt-1.5">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <span aria-hidden className="transition-transform group-open/src:rotate-90">
                      ›
                    </span>
                    {r.sources.length} {r.sources.length === 1 ? "source" : "sources"}
                  </summary>
                  <ul className="mt-1.5 space-y-1 border-l border-border pl-2.5">
                    {r.sources.map((s) => (
                      <li key={s} className="truncate">
                        <a
                          href={s}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted underline hover:text-foreground"
                          title={s}
                        >
                          {s.replace(/^https?:\/\/(www\.)?/, "")}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        /*
         * Said plainly rather than shown as blanks. An unresearched county
         * inherits its state's rules, and the atlas has always labelled which
         * is which — a panel that just looked empty would imply we had looked
         * and found nothing.
         */
        <p className="mt-4 text-base leading-relaxed text-muted">
          No county-level research yet. {county.label} shows {state.name}&apos;s state defaults —
          the sale type, redemption window and statute on the state page apply.
        </p>
      )}

      {/*
        No "full county page" link.

        That page's remaining addition over this panel is state-level deal maths,
        which belongs with the state rather than repeated under every county in
        it. Everything else it holds — surviving liens, quiet title, format,
        platform, frequency, deposit, offices, notes, and the sources above — is
        already here.

        I removed this link believing the citations lived only on that page and
        would be stranded. They were already in this panel, a few lines up. The
        link was duplicating a panel that had quietly become complete.
      */}
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-medium uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-1.5 max-w-prose leading-relaxed">{children}</dd>
    </div>
  );
}

/**
 * A contact or office: linked when there is a URL, plain when there is not.
 *
 * The phone number rides along because half of what these offices answer is
 * not on their website, and a researched county that lists one should not make
 * the reader open the full page to find it.
 */
function Ref({ link }: { link: { label: string; url?: string; phone?: string } }) {
  return (
    <>
      {link.url ? (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          {link.label}
        </a>
      ) : (
        link.label
      )}
      {link.phone ? <span className="mt-0.5 block text-sm text-muted">{link.phone}</span> : null}
    </>
  );
}
