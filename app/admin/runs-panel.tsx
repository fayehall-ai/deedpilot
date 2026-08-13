import { Card } from "@/components/ui";
import type { RunRow } from "@/lib/admin/ops";

const ago = (iso: string | null): string => {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export function RunsPanel({ runs }: { runs: RunRow[] }) {
  return (
    <>

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
                      {r.county ? (
                        r.countyFips ? (
                          <a href={`/admin/county/${r.countyFips}`} className="underline">
                            {r.county}, {r.state}
                          </a>
                        ) : (
                          `${r.county}, ${r.state}`
                        )
                      ) : (
                        <span className="text-muted">—</span>
                      )}
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
      
    </>
  );
}
