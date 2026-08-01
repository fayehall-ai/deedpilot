import Link from "next/link";
import type { Metadata } from "next";
import { getUpcomingAuctions } from "@/lib/queries";
import { money, num, relativeDays, saleDate } from "@/lib/format";
import { Breadcrumbs, EmptyState, SaleTypeBadge, StatusBadge } from "@/components/ui";
import { STATE_NAMES } from "@/lib/atlas";

export const metadata: Metadata = {
  title: "Upcoming tax sale auctions",
  description:
    "Every upcoming tax deed, tax lien, and redeemable deed auction we track, with lot counts and opening bids.",
};

export const dynamic = "force-dynamic";

export default async function AuctionsPage(props: PageProps<"/auctions">) {
  const { state } = await props.searchParams;
  const stateFilter = typeof state === "string" ? state.toUpperCase() : undefined;

  // Fetch once unfiltered. Derive dynamic tabs from actual data (so new states
  // from registry + ingest appear as soon as they have scheduled sales).
  // Then filter for the current view + header counts.
  const allRows = await getUpcomingAuctions({});
  const rows = stateFilter
    ? allRows.filter((r) => r.state === stateFilter)
    : allRows;

  // Dynamic list of states that currently have upcoming auctions in the DB.
  // New states from prospecting/ingest will automatically get their own tab.
  // Sorted alphabetically by full name.
  const availableStates = Array.from(
    new Set(allRows.map((r) => r.state))
  ).sort((a, b) => {
    const na = STATE_NAMES[a] ?? a;
    const nb = STATE_NAMES[b] ?? b;
    return na.localeCompare(nb);
  });

  // Group by sale date so the page reads as a calendar, which is how bidders
  // actually plan — they block out a day, then decide which counties to work.
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDate.has(r.saleDate)) byDate.set(r.saleDate, []);
    byDate.get(r.saleDate)!.push(r);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Auctions" }]} />

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Upcoming auctions</h1>
        <p className="mt-1 text-sm text-muted">
          {num(rows.length)} scheduled {rows.length === 1 ? "sale" : "sales"} across{" "}
          {num(new Set(rows.map((r) => r.countyFips)).size)} counties.
        </p>
      </header>

      {/* Dynamic tabs based on real data, not a hardcoded list.
          This is why new states now appear. */}
      <div className="mb-6 flex flex-wrap gap-2">
        <FilterChip href="/auctions" label="All states" active={!stateFilter} />
        {availableStates.map((s) => (
          <FilterChip
            key={s}
            href={`/auctions?state=${s}`}
            label={STATE_NAMES[s] ?? s}
            active={stateFilter === s}
          />
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No upcoming auctions for this filter">
          Auction inventory is ingested per county on a schedule. If you expected a sale here, check{" "}
          <Link href="/coverage" className="underline">
            coverage
          </Link>{" "}
          to see whether that county is ingesting cleanly.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {[...byDate.entries()].map(([date, group]) => (
            <section key={date}>
              <div className="mb-3 flex items-baseline gap-3 border-b border-border pb-2">
                <h2 className="text-sm font-semibold">{saleDate(date)}</h2>
                <span className="text-xs text-muted">{relativeDays(date)}</span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((a) => (
                  <Link
                    key={a.id}
                    href={`/auctions/${a.id}`}
                    className="group rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium group-hover:text-accent">
                          {a.countyName} County
                        </div>
                        <div className="text-xs text-muted">{STATE_NAMES[a.state] ?? a.state}</div>
                      </div>
                      <StatusBadge status={a.status} />
                    </div>

                    <div className="mt-3">
                      <SaleTypeBadge type={a.saleType} />
                    </div>

                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-xs text-muted">Lots</dt>
                        <dd className="tnum font-medium">{num(a.lotCount)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Opening bids</dt>
                        <dd className="tnum font-medium">
                          {money(a.totalOpeningBids, { compact: true })}
                        </dd>
                      </div>
                    </dl>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        active
          ? "border-accent bg-accent text-accent-fg"
          : "border-border text-muted hover:border-accent hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
