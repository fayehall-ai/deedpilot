import { Card, EmptyState } from "@/components/ui";
import type { CapeOps } from "@/lib/admin/cape-ops";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function CapePanel({ cape }: { cape: CapeOps }) {
  return (
    <>

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

      {cape.blockers.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium">What blocks release</h3>
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
        </div>
      )}
    </>
  );
}
