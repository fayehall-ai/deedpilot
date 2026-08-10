/**
 * The upcoming-auction list, as rendered by `/auctions`.
 *
 * It used to render on the home page too, under the calendar and showing the
 * same sales; that section came out once the calendar could show lot counts and
 * opening bids on its own. The flat list stays as a route because it is the
 * better view for scanning a whole season at once, which a month grid cannot do.
 *
 * `maxGroups` and `showFilters` are what the home section used and no caller
 * passes today. They are kept because an embedded, capped copy is the obvious
 * next thing anyone wants from this component — and because capping is stated
 * on the page rather than silently truncating, which is the part worth keeping.
 */
import Link from "next/link";
import { connection } from "next/server";
import { getUpcomingAuctions } from "@/lib/queries";
import { money, num, relativeDays, saleDate } from "@/lib/format";
import { EmptyState, SaleTypeBadge, StatusBadge } from "@/components/ui";
import { STATE_NAMES } from "@/lib/atlas";

export async function AuctionsList(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  /** Route the state chips point back at. */
  basePath?: string;
  /** Cap the day-groups shown. Uncapped on the route; see the note above. */
  maxGroups?: number;
  /**
   * Show the state chips. Turn them off wherever another control on the page
   * already reads the same `?state=` — two identical filter rows invite the
   * reader to wonder which one is in charge.
   */
  showFilters?: boolean;
}) {
  /*
   * `relativeDays` renders "in 6 days" against the clock, which is a
   * per-request answer. Marking request time here keeps a stale "tomorrow"
   * from being frozen into the prefetched shell.
   */
  await connection();
  const { state } = await props.searchParams;
  const stateFilter = typeof state === "string" ? state.toUpperCase() : undefined;
  const base = props.basePath ?? "/auctions";

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
    <>
      <header className="mb-6">
        <p className="mt-1 text-sm text-muted">
          {num(rows.length)} scheduled {rows.length === 1 ? "sale" : "sales"} across{" "}
          {num(new Set(rows.map((r) => r.countyFips)).size)} counties.
        </p>
      </header>

      {props.showFilters === false ? null : (
        /* Dynamic tabs based on real data, not a hardcoded list.
           This is why new states now appear. */
        <div className="mb-6 flex flex-wrap gap-2">
          <FilterChip href={base} label="All states" active={!stateFilter} />
          {availableStates.map((s) => (
            <FilterChip
              key={s}
              href={`${base}?state=${s}`}
              label={STATE_NAMES[s] ?? s}
              active={stateFilter === s}
            />
          ))}
        </div>
      )}

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
          {[...byDate.entries()].slice(0, props.maxGroups ?? Infinity).map(([date, group]) => (
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

      {/* A capped list that just stops is indistinguishable from one that has
          run out. Say what was left off. */}
      {props.maxGroups && byDate.size > props.maxGroups ? (
        <p className="mt-6 text-sm text-muted">
          Showing the next {props.maxGroups} sale {props.maxGroups === 1 ? "day" : "days"} of{" "}
          {num(byDate.size)}.{" "}
          <Link href="/auctions" className="underline hover:text-foreground">
            See every scheduled sale
          </Link>
          .
        </p>
      ) : null}
    </>
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
