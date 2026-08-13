import { Card } from "@/components/ui";
import type { PolicyRow } from "@/lib/admin/ops";

export function PolicyPanel({ policies }: { policies: PolicyRow[] }) {
  return (
    <>

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
      
    </>
  );
}
