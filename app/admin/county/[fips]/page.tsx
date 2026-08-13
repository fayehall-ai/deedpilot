import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs, Callout, Card, EmptyState, Stat } from "@/components/ui";
import { TableSkeleton } from "@/components/skeleton";
import { isAdmin } from "@/lib/admin/auth";
import { getCountyDetail } from "@/lib/admin/county-detail";
import { OVERRIDABLE } from "@/lib/admin/auction-override-fields";
import { clearAuctionOverrides, saveAuctionOverride } from "../../run-actions";

export const metadata: Metadata = {
  title: "County operations",
  robots: { index: false, follow: false },
};

const button =
  "rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90";
const input = "rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs";
const ghost =
  "rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-danger hover:text-danger";

const ago = (d: Date | null): string => {
  if (!d) return "never";
  const h = (Date.now() - d.getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * One county, everything about it.
 *
 * The console is otherwise organised by table — adapters, runs, queue, policy —
 * which is the right shape for asking "is the pipeline healthy" and the wrong
 * one for "why is Muskegon wrong". Operational questions are almost always about
 * a county, and answering one previously meant joining the atlas, the registry,
 * the calendar and three tables by hand.
 *
 * It is also where correcting an auction stops requiring a UUID. The overrides
 * panel on the main console takes an id typed by hand; here the correction sits
 * next to the sale it corrects.
 */
/*
 * The shell paints immediately; everything request-bound sits inside the
 * boundary. This Next refuses to prerender a route that reads uncached data
 * outside `<Suspense>`, and it is right to: the gate and the county's live
 * pipeline state have no business delaying the page chrome. Same structure as
 * `/admin`.
 */
export default function CountyOpsPage({ params }: { params: Promise<{ fips: string }> }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Suspense fallback={<TableSkeleton />}>
        <CountyOps params={params} />
      </Suspense>
    </main>
  );
}

async function CountyOps({ params }: { params: Promise<{ fips: string }> }) {
  // Awaited inside the boundary: `params` is request data, and resolving it in
  // the outer component would block the whole route from rendering.
  const { fips } = await params;
  await connection();
  if (!(await isAdmin())) {
    return (
      <Callout tone="warn" title="Not authorised">
        Open <a href="/admin" className="underline">the operations console</a> and sign in first.
      </Callout>
    );
  }

  const detail = await getCountyDetail(fips);
  if (!detail) notFound();

  const { county, rule, schedule, upcomingWindows, sources, auctionRows, runs, totals } = detail;
  const fields = Object.keys(OVERRIDABLE);

  return (
    <>
      <Breadcrumbs
        items={[
          { href: "/", label: "Home" },
          { href: "/admin", label: "Operations" },
          { label: `${county.name}, ${county.state}` },
        ]}
      />

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {county.name}, {county.state}
        </h1>
        <p className="mt-1 font-mono text-sm text-muted">
          {county.fips}
          {county.population ? ` · pop. ${county.population.toLocaleString()}` : ""}
        </p>
      </header>

      <div className="space-y-8">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Auctions on record" value={totals.auctions.toLocaleString()} />
          <Stat label="Parcels listed" value={totals.pendingLots.toLocaleString()} />
          <Stat label="Parcels withdrawn" value={totals.withdrawnLots.toLocaleString()} />
          <Stat label="Observations" value={totals.observations.toLocaleString()} />
        </section>

        {/* ---- what the law says (authored, not editable here) ---- */}
        <section>
          <h2 className="mb-1 text-lg font-semibold">Rules</h2>
          <p className="mb-3 text-sm text-muted">
            From the atlas, which lives in version control. Not editable here on purpose — a wrong
            assessment ratio silently shifts every walk-away price in the state and nothing downstream
            notices, so changing one is a reviewed commit rather than a form.
          </p>
          <Card>
            {rule ? (
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Sale type</dt>
                  <dd>
                    {rule.type || rule.saleType}
                    {rule.isStateDefault && (
                      <span className="ml-2 text-xs text-muted">inherited from the state</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Redemption</dt>
                  <dd>{rule.redemption || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Returns</dt>
                  <dd>{rule.returns || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Statute</dt>
                  <dd className="font-mono text-xs">{rule.statute || "—"}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted">No county rule on file.</p>
            )}
          </Card>
        </section>

        {/* ---- when it sells ---- */}
        <section>
          <h2 className="mb-1 text-lg font-semibold">Schedule</h2>
          <p className="mb-3 text-sm text-muted">
            What drives the crawl calendar. A <strong>typical</strong> or{" "}
            <strong>unresearched</strong> confidence means the dates below are projected, not
            published — a research lead rather than a date to drive to.
          </p>
          <Card>
            {schedule ? (
              <>
                <p className="text-sm">
                  <strong>{schedule.cadence}</strong> · confidence{" "}
                  <strong>{schedule.confidence}</strong> · list posts ~
                  {schedule.publishLeadDays} days ahead
                </p>
                <ul className="mt-3 space-y-1 text-sm">
                  {upcomingWindows.map((w) => (
                    <li key={w.saleDate} className="flex flex-wrap gap-x-3 text-muted">
                      <span className="font-mono tabular-nums text-foreground">{w.saleDate}</span>
                      <span>listing window opens {w.listingOpensOn}</span>
                      <span>results from {w.resultsOpenOn}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted">No schedule resolved for this county.</p>
            )}
          </Card>
        </section>

        {/* ---- where it publishes ---- */}
        <section>
          <h2 className="mb-1 text-lg font-semibold">Sources</h2>
          <p className="mb-3 text-sm text-muted">
            From <code className="font-mono text-xs">data/source-registry.json</code>, which is what
            the generic adapter actually reads. A government listing page outranks everything else.
          </p>
          <Card>
            {sources.length === 0 ? (
              <EmptyState title="No verified source of record.">
                This county is in the Prospector backlog — a crawl window opens and there is nothing
                to fetch.
              </EmptyState>
            ) : (
              <ul className="space-y-2 text-sm">
                {sources.map((s) => (
                  <li key={s.url}>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-xs uppercase tracking-wide text-muted">{s.kind}</span>
                      {s.isGovernment && <span className="text-xs text-accent">government</span>}
                      <span className="text-xs text-muted">confidence {s.confidence}</span>
                      <span className="text-xs text-muted">verified {s.verifiedOn}</span>
                    </div>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all font-mono text-xs underline"
                    >
                      {s.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        {/* ---- the sales, correctable in place ---- */}
        <section>
          <h2 className="mb-1 text-lg font-semibold">Auctions</h2>
          <p className="mb-3 text-sm text-muted">
            Corrections write to <code className="font-mono text-xs">operator_overrides</code> and
            outrank the county on every future crawl. Leave the value empty to clear one and return
            that field to whatever the source publishes.
          </p>
          {auctionRows.length === 0 ? (
            <EmptyState title="No auctions recorded for this county." />
          ) : (
            <div className="space-y-3">
              {auctionRows.map((a) => (
                <Card key={a.id}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-base font-medium tabular-nums">{a.saleDate}</span>
                    <span className="text-sm">{a.saleType}</span>
                    <span className="text-xs uppercase tracking-wide text-muted">{a.listingKind}</span>
                    {!a.saleDateConfirmed && (
                      <span className="text-xs text-danger">date projected, not published</span>
                    )}
                    {a.delistedAt && (
                      <span className="text-xs text-danger">
                        no longer on the county calendar since {a.delistedAt.toISOString().slice(0, 10)}
                      </span>
                    )}
                    {a.overrides && (
                      <span className="text-xs text-accent">
                        corrected by {a.editedBy ?? "admin"}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted">seen {ago(a.lastSeenAt)}</span>
                  </div>

                  <p className="mt-1 text-sm text-muted">
                    {a.pendingLots.toLocaleString()} listed
                    {a.withdrawnLots > 0 && ` · ${a.withdrawnLots.toLocaleString()} withdrawn`}
                    {" · "}
                    <a href={a.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                      source
                    </a>
                  </p>

                  {a.overrides && (
                    <ul className="mt-2 space-y-0.5">
                      {Object.entries(a.overrides).map(([field, value]) => (
                        <li key={field} className="font-mono text-xs text-accent">
                          {field} = {JSON.stringify(value)}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <form action={saveAuctionOverride} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="auctionId" value={a.id} />
                      <select name="field" className={input} defaultValue="saleDate">
                        {fields.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                      <input name="value" placeholder="new value" className={`${input} w-40`} />
                      <button type="submit" className={button}>
                        Correct
                      </button>
                    </form>
                    {a.overrides && (
                      <form action={clearAuctionOverrides}>
                        <input type="hidden" name="auctionId" value={a.id} />
                        <button type="submit" className={ghost}>
                          Clear corrections
                        </button>
                      </form>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* ---- what the crawler did ---- */}
        <section>
          <h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
          <Card>
            {runs.length === 0 ? (
              <p className="text-sm text-muted">This county has never been crawled.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr className="border-b border-border">
                      <th className="py-1.5 pr-3">When</th>
                      <th className="py-1.5 pr-3">Adapter</th>
                      <th className="py-1.5 pr-3">Status</th>
                      <th className="py-1.5 pr-3 text-right">Auctions</th>
                      <th className="py-1.5 pr-3 text-right">Parcels</th>
                      <th className="py-1.5 pr-3 text-right">Took</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r, i) => (
                      <tr key={`${r.adapter}-${i}`} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-3 whitespace-nowrap text-muted">{ago(r.startedAt)}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{r.adapter}</td>
                        <td className="py-1.5 pr-3">
                          <span className={r.status === "ok" ? "" : "text-danger"}>{r.status}</span>
                          {r.error && (
                            <div className="max-w-sm text-xs text-danger">{r.error.slice(0, 120)}</div>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{r.auctionsFound}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{r.lotsFound}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                          {r.durationMs == null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      </div>
    </>
  );
}
