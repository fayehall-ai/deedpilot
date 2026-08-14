import { cache } from "react";
import { buildCoverageFunnel } from "@/lib/coverage/funnel";
import { Card } from "@/components/ui";

/**
 * The coverage funnel, fetched where it is displayed instead of up front.
 *
 * ## Why this is its own file
 *
 * `buildCoverageFunnel()` takes **9.1 seconds** — measured, the slowest thing
 * the console touches by an order of magnitude over everything except the plan.
 * It used to sit in the ten-way `Promise.all` at the top of the console, which
 * meant nothing rendered until it finished: the attention block that resolves in
 * 236ms, the queue at 205ms and the schedules at 69ms all waited on it, for two
 * summary strings and a bar chart.
 *
 * `Stage.summary` is a `ReactNode`, so each of those can carry its own
 * `<Suspense>` and stream in late. The console paints on its fast data and the
 * coverage numbers arrive when they arrive.
 *
 * ## Why `cache()`
 *
 * Three components want the funnel — two summaries and the bars. Without
 * deduplication that is three independent nine-second builds in one render.
 * React's `cache` memoises per request, so it is computed once and awaited
 * three times.
 */
const funnel = cache(buildCoverageFunnel);

/** Placeholder that occupies the summary slot without implying a number. */
export function SummaryPending() {
  return <span className="text-faint">counting…</span>;
}

export async function DiscoverSummary() {
  const f = await funnel();
  return <>{f.stages[1].counties.toLocaleString()} counties sourced</>;
}

export async function PriceSummary() {
  const f = await funnel();
  return (
    <>
      {f.headline.toLocaleString()} of {f.totalCounties.toLocaleString()} counties priceable
    </>
  );
}

export async function FunnelBars() {
  const f = await funnel();
  return (
    <Card>
      <div className="space-y-1.5">
        {f.stages.map((st) => (
          <div key={st.key} className="flex items-center gap-3 text-sm">
            <span className="w-16 shrink-0 text-right tabular-nums font-medium">
              {st.counties.toLocaleString()}
            </span>
            <span
              className="h-2 shrink-0 rounded-sm bg-accent"
              style={{ width: `${Math.max(2, st.share * 160)}px` }}
              aria-hidden
            />
            <span className="min-w-0">
              {st.label}
              {st.needs !== "—" && <span className="ml-2 text-xs text-muted">needs {st.needs}</span>}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
