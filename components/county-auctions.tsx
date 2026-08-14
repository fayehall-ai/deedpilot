"use client";

import Link from "next/link";

/**
 * Upcoming sales, shown under the map instead of on a page of their own.
 *
 * ## Why this is not a link
 *
 * "Which counties sell what?" and "when is the next sale there?" are one
 * question asked in two halves, and the site used to answer them in two places —
 * the map, and an `/auctions` route in the nav. Choosing a county meant leaving
 * the map to find out whether it had a sale, then coming back to choose another.
 *
 * The whole list is about a hundred and forty rows, so it ships with the page and
 * filters in the browser. Selecting a county is instant and costs no request.
 *
 * ## Why it is collapsed until a county is chosen
 *
 * Unfiltered, this is a wall of dates that answers a question nobody asked yet.
 * Collapsed it is one line that says how much there is; chosen a county, it opens
 * itself, because at that point it is the answer rather than an aside.
 */

export interface AuctionRow {
  id: string;
  saleDate: string;
  state: string;
  countyFips: string;
  countyName: string;
  lotCount: number;
  saleType: string | null;
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

/** Days from today, for the urgency tint. */
function daysAway(iso: string): number {
  const d = new Date(`${iso}T12:00:00`).getTime() - Date.now();
  return Math.ceil(d / 86_400_000);
}

function Row({ a }: { a: AuctionRow }) {
  const away = daysAway(a.saleDate);
  return (
    <Link
      href={`/auctions/${a.id}`}
      className="flex items-center gap-3 rounded-lg border border-border/60 bg-surface px-3 py-2.5
                 transition-colors hover:border-accent"
    >
      <div className="w-24 shrink-0">
        <div className="text-sm font-medium tabular-nums">{fmtDate(a.saleDate)}</div>
        <div
          className={`text-xs tabular-nums ${
            away <= 7 ? "font-medium text-accent" : "text-faint"
          }`}
        >
          {away <= 0 ? "today" : away === 1 ? "tomorrow" : `in ${away} days`}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {a.countyName} County, {a.state}
        </div>
        {a.saleType && <div className="text-xs text-muted">{a.saleType}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-medium tabular-nums">{a.lotCount.toLocaleString()}</div>
        <div className="text-xs text-faint">parcels</div>
      </div>
    </Link>
  );
}

export function CountyAuctions({
  auctions,
  countyFips,
  countyLabel,
  stateAbbr,
}: {
  auctions: AuctionRow[];
  /** Set when a county is selected on the map. */
  countyFips?: string | null;
  countyLabel?: string | null;
  /** Set when a state is open but no county chosen. */
  stateAbbr?: string | null;
}) {
  if (countyFips) {
    const mine = auctions
      .filter((a) => a.countyFips === countyFips)
      .sort((a, b) => a.saleDate.localeCompare(b.saleDate));

    return (
      <section className="mt-4">
        <h3 className="mb-2 text-sm font-semibold">
          Upcoming sales in {countyLabel}
          {mine.length > 0 && (
            <span className="ml-2 font-normal text-muted">
              {mine.length} scheduled · {mine.reduce((n, a) => n + a.lotCount, 0).toLocaleString()}{" "}
              parcels
            </span>
          )}
        </h3>
        {mine.length === 0 ? (
          /*
           * Said plainly, because an empty list here is ambiguous in a way that
           * matters: it can mean the county sells rarely, or that we have not
           * ingested it. Silence would let a reader assume the first.
           */
          <p className="rounded-lg border border-border/60 bg-surface px-3 py-2.5 text-sm text-muted">
            No sale currently scheduled for {countyLabel}. Counties publish their calendars at
            different times, so this can mean nothing is listed yet rather than nothing is coming.
          </p>
        ) : (
          <div className="space-y-1.5">
            {mine.map((a) => (
              <Row key={a.id} a={a} />
            ))}
          </div>
        )}
      </section>
    );
  }

  // No county chosen: the whole list, or the open state's, behind a disclosure.
  const scoped = stateAbbr ? auctions.filter((a) => a.state === stateAbbr) : auctions;
  const sorted = [...scoped].sort((a, b) => a.saleDate.localeCompare(b.saleDate));
  if (sorted.length === 0) return null;

  return (
    <details className="mt-4 rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-baseline gap-3 px-4 py-3">
        <span className="text-sm font-medium">Browse upcoming auctions as a list</span>
        <span className="text-sm text-muted">
          {sorted.length} sales
          {stateAbbr ? ` in ${stateAbbr}` : ""} ·{" "}
          {sorted.reduce((n, a) => n + a.lotCount, 0).toLocaleString()} parcels
        </span>
        <span className="ml-auto text-xs text-faint">show</span>
      </summary>
      <div className="space-y-1.5 border-t border-border p-4">
        {sorted.slice(0, 200).map((a) => (
          <Row key={a.id} a={a} />
        ))}
        {sorted.length > 200 && (
          <p className="pt-1 text-xs text-faint">
            Showing the first 200 of {sorted.length}. Select a county on the map to narrow it.
          </p>
        )}
      </div>
    </details>
  );
}
