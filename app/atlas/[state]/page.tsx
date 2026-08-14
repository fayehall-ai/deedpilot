import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  COUNTY_DATA,
  STATE_DATA,
  STATE_NAMES,
  countiesInState,
  countySlug,
  isCovered,
  stateFromSlug,
  stateSlug,
  toSaleType,
} from "@/lib/atlas";
import { num } from "@/lib/format";
import { Suspense } from "react";
import { connection } from "next/server";
import { AtlasExplorer } from "@/components/atlas-explorer";
import { getUpcomingAuctions } from "@/lib/queries";
import { STATE_PATHS, statePayload } from "@/lib/atlas/geo";
import { Breadcrumbs, Card, SaleTypeBadge } from "@/components/ui";

export function generateStaticParams() {
  return Object.keys(STATE_DATA).map((s) => ({ state: stateSlug(s) }));
}

export async function generateMetadata(
  props: PageProps<"/atlas/[state]">,
): Promise<Metadata> {
  const { state } = await props.params;
  const abbr = stateFromSlug(state);
  if (!abbr || !STATE_DATA[abbr]) return { title: "State not found" };
  const rule = STATE_DATA[abbr];
  const name = STATE_NAMES[abbr] ?? abbr;
  return {
    title: `${name} tax sales — ${rule.type}`,
    description: `${name} sells tax-defaulted property by ${rule.type.toLowerCase()}. Redemption: ${rule.redemption}. Return: ${rule.returns}.`,
  };
}

/** The map for this state, once the sale calendar has loaded. */
async function ExplorerWithAuctions({ abbr }: { abbr: string }) {
  // Request time before a query that filters on today; see app/page.tsx.
  await connection();
  const rows = await getUpcomingAuctions({});
  return (
    <AtlasExplorer
      states={STATE_PATHS}
      initialState={statePayload(abbr)}
      auctions={rows.map((r) => ({
        id: r.id,
        saleDate: r.saleDate,
        state: r.state,
        countyFips: r.countyFips,
        countyName: r.countyName,
        lotCount: r.lotCount ?? 0,
        saleType: r.saleType ?? null,
      }))}
    />
  );
}

export default async function StatePage(props: PageProps<"/atlas/[state]">) {
  const { state } = await props.params;
  const abbr = stateFromSlug(state);
  if (!abbr) notFound();

  const rule = STATE_DATA[abbr];
  if (!rule) notFound();

  const name = STATE_NAMES[abbr] ?? abbr;
  const counties = countiesInState(abbr);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/atlas", label: "Atlas" }, { label: name }]} />

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{name} tax sales</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SaleTypeBadge type={toSaleType(rule.type)} />
            {isCovered(abbr) ? (
              <Link
                href={`/auctions?state=${abbr}`}
                className="rounded-full border border-accent px-3 py-0.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
              >
                View live auctions →
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      {/*
        The county map, above the prose.
        
        Same drill-down thetaxdeed does with client state, but as routes: the
        national map sent you here, and each county here is a real page.
      */}
      {/*
        The same explorer as /atlas, opened on this state. Clicking a county
        selects it here rather than loading another page; the "Full county
        page" link in the panel is the way through when you want the whole
        record. Because it renders on the server too, the county map is in the
        HTML on first paint.
      */}
      <section className="mb-8">
        {/*
          Same map, same sale list. This page is where a state click from the
          home map lands, so leaving the auctions off here would put the answer
          one step behind the question again — which is the thing the section
          exists to prevent.
        */}
        <Suspense
          fallback={<AtlasExplorer states={STATE_PATHS} initialState={statePayload(abbr)} />}
        >
          <ExplorerWithAuctions abbr={abbr} />
        </Suspense>
      </section>

      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Redemption period</h2>
          <p className="text-sm leading-relaxed">{rule.redemption}</p>
        </Card>
        <Card>
          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Investor return</h2>
          <p className="text-sm leading-relaxed">{rule.returns}</p>
        </Card>
        <Card>
          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Governing statute</h2>
          <p className="text-sm leading-relaxed">{rule.statute}</p>
        </Card>
        <Card>
          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Notes</h2>
          <p className="text-sm leading-relaxed">{rule.notes}</p>
        </Card>
      </div>

      <h2 className="mb-3 text-lg font-semibold">
        Counties <span className="text-sm font-normal text-muted">({num(counties.length)})</span>
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {counties.map((c) => {
          const researched = Boolean(COUNTY_DATA[c.fips]);
          return (
            <Link
              key={c.fips}
              href={`/atlas/${stateSlug(abbr)}/${countySlug(c.name)}`}
              className="group rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors hover:border-accent"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm group-hover:text-accent">{c.name}</span>
                {researched ? (
                  <span
                    title="Individually researched"
                    className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-fg"
                  >
                    ✓
                  </span>
                ) : null}
              </div>
              {c.population ? (
                <div className="tnum mt-0.5 text-xs text-muted">
                  {num(c.population)} residents
                </div>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
