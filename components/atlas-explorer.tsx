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

/** A modified click means the reader wants a new tab — never intercept it. */
function opensElsewhere(e: React.MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

const TYPE_COLOR: Record<string, string> = {
  "Tax Lien": "var(--type-lien)",
  "Tax Deed": "var(--type-deed)",
  "Redeemable Deed": "var(--type-redeemable)",
  Hybrid: "var(--type-hybrid)",
};

export function AtlasExplorer({
  states,
  initialState = null,
}: {
  states: StatePath[];
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

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div>
        {/* Breadcrumb + reset, mirroring where you are in the drill-down. */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
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

        <div className="relative rounded-xl border border-border bg-surface p-3">
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
              className="h-auto max-h-[28rem] w-full"
              role="img"
              aria-label={`Counties of ${openState.name}`}
            >
              {openState.counties.map((c) => (
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
                  <title>
                    {`${c.label} — ${c.researched ? "researched individually" : "showing state defaults"}`}
                  </title>
                  <path
                    d={c.d}
                    fill={
                      county?.fips === c.fips
                        ? "var(--accent)"
                        : c.researched
                          ? "var(--accent)"
                          : "var(--surface-2)"
                    }
                    fillOpacity={county?.fips === c.fips ? 1 : c.researched ? 0.85 : 1}
                    stroke={county?.fips === c.fips ? "var(--foreground)" : "var(--border)"}
                    strokeWidth={county?.fips === c.fips ? 1.2 : 0.4}
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer transition-opacity hover:opacity-100"
                  />
                </a>
              ))}
            </svg>
          ) : (
            <svg
              viewBox={`${NATIONAL_VIEWBOX.x} ${NATIONAL_VIEWBOX.y} ${NATIONAL_VIEWBOX.width} ${NATIONAL_VIEWBOX.height}`}
              className="h-auto w-full"
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
                  <title>
                    {`${s.name} — ${s.saleType}. ${s.counties} counties`}
                    {s.researched > 0 ? `, ${s.researched} researched` : ""}
                    {s.covered ? ", live auction inventory" : ""}
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
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
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
 * Deliberately a summary, not the county page. Everything here is already on
 * `/atlas/<state>/<county>` with its sources and check dates, and that page is
 * what a person should read before bidding — the panel exists to let someone
 * compare several counties quickly without losing the map.
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
      <aside className="rounded-xl border border-border bg-surface p-4">
        <p className="text-xs uppercase tracking-wide text-muted">Select a state</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight">Tax sale system</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Colour is how the state sells: a lien, a deed, a redeemable deed, or a hybrid. Select one
          to see its counties and which of them have been researched individually.
        </p>
      </aside>
    );
  }

  if (!county) {
    const researched = state.counties.filter((c) => c.researched).length;
    return (
      <aside className="rounded-xl border border-border bg-surface p-4">
        <p className="text-xs uppercase tracking-wide text-muted">{state.saleType}</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight">{state.name}</h3>
        <p className="mt-2 text-sm text-muted">
          {state.counties.length} counties · {researched} researched individually
        </p>
        {state.stateNotes ? (
          <p className="mt-3 text-sm leading-relaxed text-muted">{state.stateNotes}</p>
        ) : null}
        <a
          href={`/atlas/${state.slug}`}
          className="mt-4 inline-block text-sm underline hover:text-foreground"
        >
          Full {state.name} page →
        </a>
      </aside>
    );
  }

  const r = county.rule;
  return (
    <aside className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{state.name}</p>
      <h3 className="mt-1 text-lg font-semibold tracking-tight">{county.label}</h3>

      {r ? (
        <dl className="mt-3 space-y-3 text-sm">
          {r.auctionFormat ? <Field label="Format">{r.auctionFormat}</Field> : null}
          {r.auctionPlatform?.label ? (
            <Field label="Platform">
              {r.auctionPlatform.url ? (
                <a
                  href={r.auctionPlatform.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  {r.auctionPlatform.label}
                </a>
              ) : (
                r.auctionPlatform.label
              )}
            </Field>
          ) : null}
          {r.auctionFrequency ? <Field label="Frequency">{r.auctionFrequency}</Field> : null}
          {r.taxCollector?.label ? (
            <Field label="Tax collector">
              {r.taxCollector.url ? (
                <a
                  href={r.taxCollector.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  {r.taxCollector.label}
                </a>
              ) : (
                r.taxCollector.label
              )}
            </Field>
          ) : null}
          {r.asOf ? <Field label="Checked">{r.asOf}</Field> : null}
        </dl>
      ) : (
        /*
         * Said plainly rather than shown as blanks. An unresearched county
         * inherits its state's rules, and the atlas has always labelled which
         * is which — a panel that just looked empty would imply we had looked
         * and found nothing.
         */
        <p className="mt-3 text-sm leading-relaxed text-muted">
          No county-level research yet. {county.label} shows {state.name}&apos;s state defaults —
          the sale type, redemption window and statute on the state page apply.
        </p>
      )}

      <a
        href={`/atlas/${state.slug}/${county.slug}`}
        className="mt-4 inline-block text-sm underline hover:text-foreground"
      >
        Full county page →
      </a>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 leading-relaxed">{children}</dd>
    </div>
  );
}
