import { Card, Callout, Stat } from "@/components/ui";
import { db } from "@/lib/db";
import { adminAudit } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { backlogStates, buildPlan, planGaps } from "@/lib/admin/plan-jobs";
import { buildCoverageFunnel } from "@/lib/coverage/funnel";
import { deskDateTime } from "@/lib/desk-time";

const REASON_COPY: Record<string, string> = {
  no_source: "due for a crawl with no verified source — the Prospector's backlog",
  no_adapter: "source known, nothing can parse it yet",
  backed_off: "failing repeatedly; waiting out the backoff",
  recently_crawled: "inside its re-crawl interval, nothing to do today",
};

/**
 * Today's crawl plan, and the log of what people changed.
 *
 * Both were previously invisible. The plan existed only behind
 * `npm run scout -- --plan` in a terminal, which meant the national coverage
 * backlog — the largest single number in this system — could not be seen from
 * the console at all. The audit log was written by every console action and
 * read by nothing.
 */
export async function PlanPanel() {
  const [plan, audit, funnel] = await Promise.all([
    buildPlan(),
    db.select().from(adminAudit).orderBy(desc(adminAudit.createdAt)).limit(15),
    buildCoverageFunnel(),
  ]);
  const gaps = planGaps(plan);
  const backlog = backlogStates(plan).slice(0, 8);

  return (
    <section className="space-y-4">
      {/* ---- one coverage number ---- */}
      <div>
        <h2 className="text-lg font-semibold">Coverage</h2>
        <p className="mt-1 text-sm text-muted">
          One funnel rather than two tallies. Each stage is a strict subset of the one above, so the
          headline cannot be inflated by counting a county at a stage it has not reached. The last
          stage is the commercial one and the easiest to forget: coverage is counties × priceable
          states, and those multiply.
        </p>
      </div>
      <Card>
        <p className="mb-3 text-sm">
          <strong className="text-lg tabular-nums">{funnel.headline.toLocaleString()}</strong> of{" "}
          {funnel.totalCounties.toLocaleString()} counties hold inventory a subscriber can price —{" "}
          <strong>{((funnel.headline / funnel.totalCounties) * 100).toFixed(1)}%</strong>.
        </p>
        <div className="space-y-1.5">
          {funnel.stages.map((st) => (
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
                {st.needs !== "—" && (
                  <span className="ml-2 text-xs text-muted">needs {st.needs}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <div>
        <h2 className="text-lg font-semibold">Crawl plan — {plan.date}</h2>
        <p className="mt-1 text-sm text-muted">
          Which counties are inside a crawl window today, what can actually be run, and why the rest
          cannot. The dispatcher queues the top of this list by priority: a listing crawl three days
          from a sale scores near 115, a distant results crawl near 0.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Due today" value={plan.coverage.dueToday.toLocaleString()} />
        <Stat label="Runnable" value={plan.coverage.runnable.toLocaleString()} />
        <Stat label="No source" value={(gaps.no_source ?? 0).toLocaleString()} />
        <Stat label="No adapter" value={(gaps.no_adapter ?? 0).toLocaleString()} />
      </div>

      {(gaps.no_source ?? 0) > 0 && (
        <Callout tone="warn" title={`${gaps.no_source} counties due with no verified source`}>
          This is the coverage bottleneck, and it is a crawl to run rather than parsers to write.
          Point the Auction Scout at it with the <strong>Backlog</strong> option above.
        </Callout>
      )}

      <Card>
        <h3 className="mb-2 font-medium">Why counties were skipped</h3>
        <ul className="space-y-1.5 text-sm">
          {Object.entries(gaps)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => (
              <li key={reason} className="flex gap-3">
                <span className="w-16 shrink-0 text-right tabular-nums font-medium">{n.toLocaleString()}</span>
                <span className="text-muted">{REASON_COPY[reason] ?? reason}</span>
              </li>
            ))}
        </ul>
      </Card>

      {backlog.length > 0 && (
        <Card>
          <h3 className="mb-1 font-medium">Where research would pay</h3>
          <p className="mb-3 text-xs text-muted">
            States with an <em>upcoming</em> sale and no source, soonest first. Results windows for
            sales already held are excluded — a finished sale carries no urgency.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[24rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3">State</th>
                  <th className="py-1.5 pr-3 text-right">Counties</th>
                  <th className="py-1.5 pr-3">Soonest sale</th>
                </tr>
              </thead>
              <tbody>
                {backlog.map((s) => (
                  <tr key={s.state} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{s.state}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.counties}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{s.soonestSale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {plan.tasks.length > 0 && (
        <Card>
          <h3 className="mb-2 font-medium">Next up, by priority</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3 text-right">Priority</th>
                  <th className="py-1.5 pr-3">County</th>
                  <th className="py-1.5 pr-3">Kind</th>
                  <th className="py-1.5 pr-3">Adapter</th>
                  <th className="py-1.5 pr-3">Why</th>
                </tr>
              </thead>
              <tbody>
                {plan.tasks.slice(0, 12).map((t) => (
                  <tr key={`${t.fips}-${t.kind}-${t.saleDate}`} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{t.priority}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      <a href={`/admin/county/${t.fips}`} className="underline">
                        {t.fips}
                      </a>{" "}
                      {t.state}
                    </td>
                    <td className="py-1.5 pr-3">{t.kind}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{t.adapter}</td>
                    <td className="py-1.5 pr-3 text-muted">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.tasks.length > 12 && (
            <p className="mt-2 text-xs text-muted">
              … and {plan.tasks.length - 12} more. The dispatcher caps how many it queues per tick, so
              the remainder stays due tomorrow rather than growing the queue without bound.
            </p>
          )}
        </Card>
      )}

      {/* ---- audit ---- */}
      <div>
        <h3 className="font-medium">Recent changes</h3>
        <p className="mt-1 text-xs text-muted">
          Every console action writes here. Until now nothing read it back, so each change survived
          the person who made it and nobody could see it.
        </p>
      </div>
      <Card>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">No changes recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3">When</th>
                  <th className="py-1.5 pr-3">Action</th>
                  <th className="py-1.5 pr-3">Target</th>
                  <th className="py-1.5 pr-3">Actor</th>
                  <th className="py-1.5 pr-3">Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} className="border-b border-border/50 align-top last:border-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                      {deskDateTime(a.createdAt)}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{a.action}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{a.target ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-xs">{a.actor}</td>
                    <td className="py-1.5 pr-3 font-mono text-[0.65rem] text-muted">
                      {a.detail ? JSON.stringify(a.detail).slice(0, 90) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
