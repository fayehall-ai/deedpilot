import type { Metadata } from "next";
import Link from "next/link";
import { getIngestHealth, getPlatformStats } from "@/lib/queries";
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
 */
export default async function CoveragePage() {
  const [health, stats] = await Promise.all([
    getIngestHealth().catch(() => []),
    getPlatformStats().catch(() => ({ upcomingAuctions: 0, totalLots: 0, byState: [] })),
  ]);

  // Latest run per county.
  const latest = new Map<string, (typeof health)[number]>();
  for (const h of health) {
    const key = h.countyFips ?? h.adapter;
    if (!latest.has(key)) latest.set(key, h);
  }
  const rows = [...latest.values()];

  const blocked = SOURCE_POLICIES.filter((p) => p.decision !== "allow");

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

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Rules atlas</div>
          <div className="tnum mt-1 text-2xl font-semibold">All 50 states</div>
          <p className="mt-1 text-xs text-muted">3,142 counties, national</p>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Parcel-level states</div>
          <div className="tnum mt-1 text-2xl font-semibold">{COVERED_STATES.length}</div>
          <p className="mt-1 text-xs text-muted">
            {num(COVERED_STATES.reduce((n, s) => n + countiesInState(s).length, 0))} counties in
            scope
          </p>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Lots tracked</div>
          <div className="tnum mt-1 text-2xl font-semibold">{num(stats.totalLots)}</div>
          <p className="mt-1 text-xs text-muted">{num(stats.upcomingAuctions)} upcoming auctions</p>
        </Card>
      </div>

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
            <strong className="text-foreground">45 states</strong> have rules-atlas coverage only —
            no parcel-level inventory. See the{" "}
            <Link href="/atlas" className="underline">
              atlas
            </Link>{" "}
            for their statutes and auction logistics.
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
