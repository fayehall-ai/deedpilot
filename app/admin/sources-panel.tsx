import { Card } from "@/components/ui";
import type { AdapterHealth } from "@/lib/admin/ops";

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

export function SourcesPanel({ adapters }: { adapters: AdapterHealth[] }) {
  return (
    <>

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
      
    </>
  );
}
