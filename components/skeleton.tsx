/**
 * Loading shapes for the parts of a page that wait on Postgres.
 *
 * These are the static shell. Under Cache Components everything outside a
 * <Suspense> boundary is prerendered and shipped on prefetch, so a click
 * paints the page's chrome and one of these immediately, and the query result
 * swaps in when it lands. The point is that the layout does not move when it
 * does: a skeleton that is the wrong height makes the content jump, which
 * reads as slower than showing nothing at all.
 *
 * So each shape mirrors the real thing it stands in for — same grid, same row
 * height, same number of rows as a typical result — rather than being a
 * generic grey box.
 */

/** One shimmering block. `w`/`h` are Tailwind classes so callers control size. */
export function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} aria-hidden />;
}

/**
 * A screen-reader announcement for content that is still loading.
 *
 * The visual skeleton is `aria-hidden`, so without this a screen reader hears
 * nothing at all between the click and the data arriving.
 */
export function LoadingNote({ children = "Loading…" }: { children?: React.ReactNode }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {children}
    </span>
  );
}

/** Stat tiles — the row of headline figures on the home and coverage pages. */
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <LoadingNote>Loading figures</LoadingNote>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-surface p-5">
          <Bar className="h-3 w-24" />
          <Bar className="mt-3 h-7 w-20" />
          <Bar className="mt-2 h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

/** The auction cards on /auctions, grouped under a date heading. */
export function AuctionListSkeleton({ groups = 3, perGroup = 3 }: { groups?: number; perGroup?: number }) {
  return (
    <div className="space-y-8">
      <LoadingNote>Loading auctions</LoadingNote>
      {Array.from({ length: groups }, (_, g) => (
        <section key={g}>
          <div className="mb-3 flex items-baseline gap-3 border-b border-border pb-2">
            <Bar className="h-4 w-32" />
            <Bar className="h-3 w-16" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: perGroup }, (_, i) => (
              <div key={i} className="rounded-xl border border-border bg-surface p-4">
                <Bar className="h-4 w-32" />
                <Bar className="mt-2 h-3 w-20" />
                <Bar className="mt-3 h-5 w-24 rounded-full" />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Bar className="h-8" />
                  <Bar className="h-8" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The month grid.
 *
 * Six rows of seven, at the same `min-h-44` as a real day square, so the
 * calendar occupies its final height before a single sale has loaded — this is
 * the page where a height change would be most obvious. Hidden below `xl` to
 * match the live grid; the agenda fallback is what a tablet actually sees.
 */
export function CalendarSkeleton() {
  return (
    <div>
      <LoadingNote>Loading the month</LoadingNote>
      {/* Filter chrome */}
      <div className="mb-5 space-y-2.5 rounded-xl border border-border bg-surface-2/40 p-3">
        {Array.from({ length: 4 }, (_, r) => (
          <div key={r} className="flex flex-wrap items-baseline gap-1.5">
            <Bar className="h-3 w-24 shrink-0" />
            {Array.from({ length: 5 }, (_, i) => (
              <Bar key={i} className="h-5 w-16 rounded-full" />
            ))}
          </div>
        ))}
      </div>
      <div className="hidden xl:block">
        <div className="grid grid-cols-7 overflow-hidden rounded-2xl border border-border bg-surface">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={`h${i}`} className="border-b border-border bg-surface-2/60 px-2 py-3">
              <Bar className="mx-auto h-3.5 w-10" />
            </div>
          ))}
          {Array.from({ length: 42 }, (_, i) => (
            <div
              key={i}
              className={`min-h-44 border-border p-2.5 ${(i + 1) % 7 === 0 ? "" : "border-r"} ${
                i < 35 ? "border-b" : ""
              }`}
            >
              <Bar className="h-4 w-6" />
              {i % 3 === 0 ? <Bar className="mt-3 h-3.5 w-full" /> : null}
              {i % 4 === 0 ? <Bar className="mt-1.5 h-3.5 w-4/5" /> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-5 xl:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i}>
            <Bar className="h-5 w-36" />
            <Bar className="mt-2 h-5 w-full" />
            <Bar className="mt-1.5 h-5 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A table of rows — lots on an auction, ingest runs on /status. */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <LoadingNote>Loading rows</LoadingNote>
      <div className="border-b border-border bg-surface-2/60 px-4 py-2">
        <Bar className="h-3 w-40" />
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className={`grid gap-4 px-4 py-3 ${r < rows - 1 ? "border-b border-border" : ""}`}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <Bar key={c} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A detail page: a header block, a stat row, then panels. */
export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <LoadingNote>Loading details</LoadingNote>
      <div>
        <Bar className="h-7 w-72" />
        <Bar className="mt-2 h-4 w-56" />
        <div className="mt-3 flex gap-2">
          <Bar className="h-6 w-24 rounded-full" />
          <Bar className="h-6 w-20 rounded-full" />
        </div>
      </div>
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Bar className="h-3 w-24" />
              <Bar className="mt-2 h-7 w-28" />
            </div>
          ))}
        </div>
      </div>
      <TableSkeleton rows={6} />
    </div>
  );
}
