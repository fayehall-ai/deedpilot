import { connection } from "next/server";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Breadcrumbs, Callout, Card, EmptyState, Stat } from "@/components/ui";
import { TableSkeleton } from "@/components/skeleton";
import { adminConfigured, isAdmin } from "@/lib/admin/auth";
import { getAdapterHealth, getRecentRuns, getPolicies, getInventorySnapshot } from "@/lib/admin/ops";
import { getCapeOps } from "@/lib/admin/cape-ops";
import { signIn, signOut } from "./actions";

export const metadata: Metadata = {
  title: "Operations",
  robots: { index: false, follow: false },
};

/**
 * The operations console.
 *
 * `/coverage` and `/status` are the public honesty pages — what we ingest, and
 * whether the numbers mean what they appear to. This is the private one: when
 * each source last ran, what it returned, which hosts we have decided not to
 * crawl and why, and where every CAPE package is stuck.
 *
 * Token-gated, `noindex`, and never cached. There is no `unstable_instant`
 * block here on purpose: the whole point is the current state of the pipeline,
 * so a prerendered copy would be worse than useless.
 */
/*
 * The gate reads cookies and searchParams, both of which are request data. Done
 * at the top level of the page component that blocks the entire route from
 * rendering until they resolve — Next says so explicitly, and it is right: the
 * page chrome does not depend on who you are. Everything request-bound lives
 * inside the boundary, so the shell paints immediately and the gate resolves
 * behind it.
 */
export default function AdminPage(props: PageProps<"/admin">) {
  return (
    <Shell>
      <Suspense fallback={<TableSkeleton />}>
        <Gate searchParams={props.searchParams} />
      </Suspense>
    </Shell>
  );
}

async function Gate({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  const { e } = await searchParams;

  if (!adminConfigured()) {
    return (
      <Callout tone="warn" title="No admin token configured">
        Set <code className="font-mono text-xs">DEEDPILOT_ADMIN_TOKEN</code> in the environment to
        open this console. Until it is set, access is denied rather than granted — a missing
        variable must not become an open door.
      </Callout>
    );
  }

  if (!(await isAdmin())) {
    return (
      <Card>
        <form action={signIn} className="max-w-sm space-y-3">
          <label htmlFor="token" className="block text-sm font-medium">
            Operations token
          </label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="current-password"
            autoFocus
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm"
          />
          {e ? <p className="text-sm text-danger">That token was not accepted.</p> : null}
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Unlock
          </button>
        </form>
      </Card>
    );
  }

  return (
    <>
      <div className="mb-6 flex justify-end">
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
          >
            Sign out
          </button>
        </form>
      </div>
      <Body />
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Operations" }]} />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="mt-1 text-sm text-muted">
          Sources, runs, access decisions and CAPE stage detail. Not public, not indexed.
        </p>
      </header>
      {children}
    </main>
  );
}

const ago = (iso: string | null): string => {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

async function Body() {
  /*
   * Reads the clock (relative "ago" stamps) and the live pipeline state, so
   * the request must be dynamic. Without this the build refuses the clock
   * read — the same rule that governs CalendarView and the CAPE board.
   */
  await connection();

  const [adapters, runs, inventory, cape] = await Promise.all([
    getAdapterHealth(),
    getRecentRuns(40),
    getInventorySnapshot(),
    getCapeOps(),
  ]);
  const policies = getPolicies();

  const stale = adapters.filter((a) => a.lastRunAt === null);
  const failing = adapters.filter((a) => a.recentFailures > 0);

  return (
    <div className="space-y-8">
      {/* ---- headline state ---- */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Biddable auctions" value={inventory.inventoryAuctions.toLocaleString()} />
        <Stat label="Biddable parcels" value={inventory.inventoryParcels.toLocaleString()} />
        <Stat label="Lead-list parcels" value={inventory.leadParcels.toLocaleString()} />
        <Stat label="CAPE releasable" value={`${cape.releasable} / ${cape.packages}`} />
      </section>

      {(stale.length > 0 || failing.length > 0) && (
        <Callout tone="warn" title="Needs attention">
          <ul className="ml-4 list-disc space-y-1 text-sm">
            {stale.length > 0 && (
              <li>
                <strong>{stale.length}</strong> adapter{stale.length === 1 ? "" : "s"} registered but
                never run: {stale.map((a) => a.name).join(", ")}
              </li>
            )}
            {failing.length > 0 && (
              <li>
                <strong>{failing.length}</strong> adapter{failing.length === 1 ? "" : "s"} with
                failures in the last 7 days:{" "}
                {failing.map((a) => `${a.name} (${a.recentFailures})`).join(", ")}
              </li>
            )}
          </ul>
        </Callout>
      )}

      {/* ---- sources ---- */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Sources</h2>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">Adapter</th>
                  <th className="py-2 pr-3">Last run</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3 text-right">Runs</th>
                  <th className="py-2 pr-3 text-right">Counties</th>
                  <th className="py-2 pr-3 text-right">Producing</th>
                  <th className="py-2 pr-3 text-right">Auctions</th>
                  <th className="py-2 pr-3 text-right">Parcels</th>
                  <th className="py-2 pr-3 text-right">Median</th>
                </tr>
              </thead>
              <tbody>
                {adapters.map((a) => (
                  <tr key={a.name} className="border-b border-border/50 align-top last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-muted">{a.platform}</div>
                      {a.lastError ? (
                        <div className="mt-1 max-w-md text-xs text-danger">{a.lastError.slice(0, 160)}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{ago(a.lastRunAt)}</td>
                    <td className="py-2 pr-3">{a.lastStatus ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{a.runs.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{a.countiesTouched}</td>
                    {/*
                      Counties that ever produced a parcel, against counties touched.
                      This column is why the generic adapter's real contribution is
                      visible at a glance rather than buried in a run count.
                    */}
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {a.countiesProducing}
                      {a.countiesTouched > 0 ? (
                        <span className="ml-1 text-xs text-muted">
                          {pct(a.countiesProducing / a.countiesTouched)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{a.auctionsFound.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{a.lotsFound.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {a.medianDurationMs == null ? "—" : `${(a.medianDurationMs / 1000).toFixed(1)}s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      {/* ---- CAPE stages ---- */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">CAPE stages</h2>
        <p className="mb-3 text-sm text-muted">
          Across {cape.packages} upcoming package{cape.packages === 1 ? "" : "s"}, mean score{" "}
          {pct(cape.meanScore)}. Ranked by how many packages each stage holds back.
        </p>
        {cape.stages.length === 0 ? (
          <EmptyState title="No upcoming packages to assess." />
        ) : (
          <div className="space-y-3">
            {[...cape.stages]
              .sort((a, b) => b.packagesBlocked - a.packagesBlocked || a.n - b.n)
              .map((s) => (
                <Card key={s.n}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">
                        {s.n}. {s.title}
                      </span>
                      <span className="text-sm text-muted">{pct(s.mean)} mean</span>
                      <span className="ml-auto text-sm">
                        {s.packagesBlocked > 0 ? (
                          <span className="text-danger">{s.packagesBlocked} blocked</span>
                        ) : (
                          <span className="text-muted">complete</span>
                        )}
                      </span>
                    </summary>
                    <table className="mt-3 w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-muted">
                        <tr className="border-b border-border">
                          <th className="py-1.5 pr-3">Item</th>
                          <th className="py-1.5 pr-3 text-right">Have</th>
                          <th className="py-1.5 pr-3 text-right">Verify</th>
                          <th className="py-1.5 pr-3 text-right">Absent</th>
                          <th className="py-1.5 pr-3">Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.items.map((it) => (
                          <tr key={it.label} className="border-b border-border/50 align-top last:border-0">
                            <td className="py-1.5 pr-3">{it.label}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{it.have}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {it.verify || <span className="text-muted">—</span>}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {it.absent ? <span className="text-danger">{it.absent}</span> : <span className="text-muted">—</span>}
                            </td>
                            <td className="py-1.5 pr-3 text-xs text-muted">{it.sample ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </Card>
              ))}
          </div>
        )}
      </section>

      {/* ---- blockers ---- */}
      {cape.blockers.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">What blocks release</h2>
          <Card>
            <ul className="space-y-1.5 text-sm">
              {cape.blockers.map((b) => (
                <li key={b.reason} className="flex gap-3">
                  <span className="w-12 shrink-0 text-right tabular-nums text-muted">{b.packages}</span>
                  <span>{b.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* ---- access policy ---- */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Access decisions</h2>
        <p className="mb-3 text-sm text-muted">
          Reviewed per host and held in version control, not in the database — a decision not to
          crawl a source is a judgement with reasoning attached.
        </p>
        <Card>
          <ul className="space-y-3 text-sm">
            {policies.map((p) => (
              <li key={p.host}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs">{p.host}</span>
                  <span
                    className={
                      p.decision === "allow"
                        ? "text-xs text-muted"
                        : "text-xs font-medium text-danger"
                    }
                  >
                    {p.decision.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-muted">{p.minDelayMs / 1000}s delay</span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{p.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {/* ---- recent runs ---- */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Adapter</th>
                  <th className="py-2 pr-3">County</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3 text-right">Auctions</th>
                  <th className="py-2 pr-3 text-right">Parcels</th>
                  <th className="py-2 pr-3 text-right">Took</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={`${r.adapter}-${r.startedAt}-${i}`} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted">{ago(r.startedAt)}</td>
                    <td className="py-1.5 pr-3">{r.adapter}</td>
                    <td className="py-1.5 pr-3">
                      {r.county ? `${r.county}, ${r.state}` : <span className="text-muted">—</span>}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={r.status === "ok" ? "" : "text-danger"}>{r.status}</span>
                      {r.error ? (
                        <div className="max-w-sm text-xs text-danger">{r.error.slice(0, 120)}</div>
                      ) : null}
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
        </Card>
      </section>

      {/* ---- inventory by state ---- */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Inventory by state</h2>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">State</th>
                  <th className="py-2 pr-3 text-right">Auctions</th>
                  <th className="py-2 pr-3 text-right">Parcels held</th>
                  <th className="py-2 pr-3 text-right">Biddable auctions</th>
                </tr>
              </thead>
              <tbody>
                {inventory.states.map((s) => (
                  <tr key={s.state} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{s.state}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.auctions.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.parcels.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {s.inventory > 0 ? s.inventory : <span className="text-muted">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
