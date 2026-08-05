import type { Metadata } from "next";
import Link from "next/link";
import { getIngestHealth, getPlatformStats } from "@/lib/queries";
import { buildCoverageScoreboard } from "@/lib/coverage/scoreboard";
import { num } from "@/lib/format";
import { Breadcrumbs, Callout, Card, EmptyState, StatusBadge } from "@/components/ui";
import { COVERED_STATES, STATE_NAMES, countiesInState } from "@/lib/atlas";
import { SOURCE_POLICIES } from "@/lib/ingest/policy";

export const metadata: Metadata = {
  title: "Coverage and data health",
  description:
    "Which counties DeedPilot ingests, where the data comes from, what is blocked, and when each source last ran cleanly.",
};

export const dynamic = "force-dynamic";

/**
 * The honesty page.
 *
 * Aggregators tend to present coverage as a marketing number and hide the
 * gaps. A bidder who assumes a county is covered, and finds out on sale day
 * that it never ingested, has lost a real opportunity. This page shows the
 * gaps deliberately.
 *
 * Gold score = live nation + history nation + price nation (see
 * docs/self-improving-coverage-loop.md).
 */
export default async function CoveragePage() {
  const [health, stats, board] = await Promise.all([
    getIngestHealth().catch(() => []),
    getPlatformStats().catch(() => ({
      upcomingAuctions: 0,
      skeletonAuctions: 0,
      totalLots: 0,
      lotsWithAssessed: 0,
      leadAuctions: 0,
      leadLots: 0,
      byState: [] as { state: string; counties: number; auctions: number; lots: number }[],
    })),
    buildCoverageScoreboard().catch(() => null),
  ]);

  // Latest run per county.
  const latest = new Map<string, (typeof health)[number]>();
  for (const h of health) {
    const key = h.countyFips ?? h.adapter;
    if (!latest.has(key)) latest.set(key, h);
  }
  const rows = [...latest.values()];

  const blocked = SOURCE_POLICIES.filter((p) => p.decision !== "allow");
  const autoRate =
    stats.totalLots > 0 ? stats.lotsWithAssessed / stats.totalLots : 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Coverage" }]} />

      <header className="mb-6 max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">Coverage and data health</h1>
        <p className="mt-2 leading-relaxed text-muted">
          What we ingest, where it comes from, and what is not covered. A county that stopped
          returning lots looks exactly like a county with no sale scheduled — this page is how you
          tell the difference.
        </p>
      </header>

      {/* --- Gold gauges (vector, not vanity) --------------------------- */}
      {board ? (
        <section className="mb-8">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-lg font-semibold">National gold score</h2>
            <p className="text-xs text-muted">
              Updated {new Date(board.generatedAt).toLocaleString("en-US")} · run{" "}
              <code className="font-mono">npm run flywheel:coverage -- --plan</code>
            </p>
          </div>
          <div className="mb-4 grid gap-4 sm:grid-cols-4">
            <Card>
              <div className="text-xs uppercase tracking-wide text-muted">Gold score</div>
              <div className="tnum mt-1 text-3xl font-semibold" style={{ color: "var(--accent)" }}>
                {(board.gold.score * 100).toFixed(1)}%
              </div>
              <p className="mt-1 text-xs text-muted">
                live {Math.round(board.gold.weights.live * 100)}% · history{" "}
                {Math.round(board.gold.weights.history * 100)}% · price{" "}
                {Math.round(board.gold.weights.price * 100)}%
                {board.gold.penalties > 0
                  ? ` · −${(board.gold.penalties * 100).toFixed(1)}pt skeletons`
                  : ""}
              </p>
            </Card>
            <Card>
              <div className="text-xs uppercase tracking-wide text-muted">Live nation</div>
              <div className="tnum mt-1 text-2xl font-semibold">
                {board.live.statesWithLots}
                <span className="text-base font-normal text-muted"> / 51</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {num(board.live.totalLotsUpcoming)} lots · {num(board.live.countiesWithLots)}{" "}
                counties · {num(board.live.upcomingAuctionsWithLots)} sales
              </p>
            </Card>
            <Card>
              <div className="text-xs uppercase tracking-wide text-muted">History nation</div>
              <div className="tnum mt-1 text-2xl font-semibold">
                {board.history.statesWithPriceUsable.length}
                <span className="text-base font-normal text-muted"> states</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {board.history.nPriceUsable != null
                  ? `${num(board.history.nPriceUsable)} price-usable / ${num(board.history.nRows ?? 0)} rows`
                  : "export status.json"}
              </p>
            </Card>
            <Card>
              <div className="text-xs uppercase tracking-wide text-muted">Price nation</div>
              <div className="tnum mt-1 text-2xl font-semibold">
                {board.statute.nStates}
                <span className="text-base font-normal text-muted"> statutes</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {num(board.live.lotsAutoPriceable)} auto-priceable lots (
                {(board.maxbid.autoPriceableRate * 100).toFixed(0)}% of inventory)
              </p>
            </Card>
          </div>

          {board.live.skeletonAuctions > 0 ? (
            <Callout tone="warn" title="Skeleton auctions">
              {num(board.live.skeletonAuctions)} upcoming auction row(s) have zero lots and are
              hidden from browse. Purge with{" "}
              <code className="font-mono">npm run purge:skeletons</code>.
            </Callout>
          ) : null}

          {board.workPlan.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold">Top work (meta-controller)</h3>
              <Card className="overflow-hidden p-0">
                <ol className="divide-y divide-border text-sm">
                  {board.workPlan.slice(0, 8).map((w, i) => (
                    <li key={i} className="flex gap-3 px-4 py-2.5">
                      <span
                        className="tnum shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs"
                        title={`class ${w.class}`}
                      >
                        {w.class}
                      </span>
                      <div>
                        <div className="font-medium">{w.title}</div>
                        <div className="text-xs text-muted">{w.reason}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Rules atlas</div>
          <div className="tnum mt-1 text-2xl font-semibold">All 50 states</div>
          <p className="mt-1 text-xs text-muted">3,142 counties, national</p>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Parcel-level targets</div>
          <div className="tnum mt-1 text-2xl font-semibold">{COVERED_STATES.length}</div>
          <p className="mt-1 text-xs text-muted">
            {num(COVERED_STATES.reduce((n, s) => n + countiesInState(s).length, 0))} counties in
            scope ({COVERED_STATES.join(", ")})
          </p>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Real inventory</div>
          <div className="tnum mt-1 text-2xl font-semibold">{num(stats.totalLots)}</div>
          <p className="mt-1 text-xs text-muted">
            {num(stats.upcomingAuctions)} sales with lots
            {stats.lotsWithAssessed != null
              ? ` · ${num(stats.lotsWithAssessed)} assessed (${(autoRate * 100).toFixed(0)}%)`
              : ""}
          </p>
        </Card>
      </div>

      {/*
        The distinction this page exists to make. Counties publish delinquent
        rolls, lands-available inventory and sale lists in the same place and
        the same format; only the last is something to bid on. Folding them
        together inflates inventory by multiples and quietly buries the
        priceable lots in parcels that were never for sale.
      */}
      {stats.leadLots > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">What counts as inventory</h2>
          <Card>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">
                  Published sale lists
                </dt>
                <dd className="tnum mt-1 text-2xl font-semibold">{num(stats.totalLots)}</dd>
                <p className="mt-1 text-xs text-muted">
                  Parcels on a county&apos;s list for a specific, published sale date. These are
                  the only lots counted as inventory anywhere on the site.
                </p>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">
                  Leads, not lots
                </dt>
                <dd className="tnum mt-1 text-2xl font-semibold text-muted">
                  {num(stats.leadLots)}
                </dd>
                <p className="mt-1 text-xs text-muted">
                  Delinquent rolls, lands-available inventory, and lists sitting under a date
                  projected from a state&apos;s typical schedule rather than published by the
                  county. Most owners on a delinquent roll pay before any levy, so treating one
                  as an auction listing would overstate what is for sale by multiples.
                </p>
              </div>
            </dl>
          </Card>
        </section>
      ) : null}

      {board && board.live.byState.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Live inventory by state</h2>
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/50 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">State</th>
                    <th className="px-4 py-2.5 text-right font-medium">Counties</th>
                    <th className="px-4 py-2.5 text-right font-medium">Auctions</th>
                    <th className="px-4 py-2.5 text-right font-medium">Lots</th>
                    <th className="px-4 py-2.5 text-right font-medium">Assessed</th>
                    <th className="px-4 py-2.5 text-right font-medium">Auto max-bid</th>
                  </tr>
                </thead>
                <tbody>
                  {board.live.byState.map((s) => (
                    <tr key={s.state} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2.5">
                        <Link href={`/auctions?state=${s.state}`} className="hover:underline">
                          {STATE_NAMES[s.state] ?? s.state}
                        </Link>
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">{num(s.counties)}</td>
                      <td className="tnum px-4 py-2.5 text-right">{num(s.auctions)}</td>
                      <td className="tnum px-4 py-2.5 text-right">{num(s.lots)}</td>
                      <td className="tnum px-4 py-2.5 text-right">
                        {num(s.withAssessed)}
                        <span className="ml-1 text-xs text-muted">
                          ({s.lots ? Math.round((s.withAssessed / s.lots) * 100) : 0}%)
                        </span>
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">{num(s.autoPriceable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      ) : null}

      {blocked.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Sources we do not scrape</h2>
          <div className="space-y-3">
            {blocked.map((p) => (
              <Callout key={p.host} tone="warn" title={p.host}>
                <span className="mb-1 block font-medium capitalize text-foreground">
                  {p.decision.replace(/_/g, " ")}
                </span>
                {p.reason}
              </Callout>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Latest ingest per county</h2>
        {rows.length === 0 ? (
          <EmptyState title="No ingest runs recorded yet">
            Run <code className="font-mono">npm run ingest -- --all</code> to populate auction
            inventory.
          </EmptyState>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/50 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">County</th>
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Auctions</th>
                    <th className="px-4 py-2.5 text-right font-medium">Lots</th>
                    <th className="px-4 py-2.5 text-right font-medium">Rejected</th>
                    <th className="px-4 py-2.5 text-right font-medium">Repaired</th>
                    <th className="px-4 py-2.5 font-medium">Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2.5">
                        {r.countyName ? `${r.countyName}, ${r.state}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted">{r.adapter}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={r.status} />
                        {r.error ? (
                          <div className="mt-1 max-w-md text-xs text-muted">{r.error}</div>
                        ) : null}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">{num(r.auctionsFound)}</td>
                      <td className="tnum px-4 py-2.5 text-right">{num(r.lotsFound)}</td>
                      <td
                        className="tnum px-4 py-2.5 text-right"
                        style={{ color: r.rejected > 0 ? "var(--danger)" : undefined }}
                      >
                        {num(r.rejected)}
                      </td>
                      <td
                        className="tnum px-4 py-2.5 text-right"
                        style={{ color: r.repaired > 0 ? "var(--warn)" : undefined }}
                      >
                        {num(r.repaired)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {r.finishedAt ? new Date(r.finishedAt).toLocaleString("en-US") : "running"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section className="mt-8 max-w-3xl">
        <h2 className="mb-2 text-lg font-semibold">Not covered</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted">
          <li>
            <strong className="text-foreground">
              {board ? board.statute.nMissing : 44} states
            </strong>{" "}
            lack reviewed statutory max-bid parameters. See{" "}
            <Link href="/atlas" className="underline">
              atlas
            </Link>{" "}
            for prose rules.
          </li>
          <li>
            <strong className="text-foreground">In-person sales</strong> (Georgia&apos;s courthouse
            steps, most Texas constable sales) publish a list but have no live bid feed. We can tell
            you what is selling and what it is worth; we cannot follow the bidding.
          </li>
          <li>
            <strong className="text-foreground">Comparable sales and skip trace</strong> are not
            included. Valuation is derived from county assessed value and the state&apos;s
            assessment ratio, which is an estimate, not an appraisal.
          </li>
        </ul>
      </section>
    </div>
  );
}
