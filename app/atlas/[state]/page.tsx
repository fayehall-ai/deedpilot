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
import { AtlasCountyMap } from "@/components/atlas-county-map";
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
      <section className="mb-8 rounded-xl border border-border bg-surface p-4">
        <AtlasCountyMap stateAbbr={abbr} stateFips={counties[0]?.fips.slice(0, 2) ?? ""} stateName={name} />
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
