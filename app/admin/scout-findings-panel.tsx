import { desc, eq, sql } from "drizzle-orm";
import { Card } from "@/components/ui";
import { db } from "@/lib/db";
import { scoutFindings } from "@/lib/db/schema";
import { deskDateTime } from "@/lib/desk-time";
import { approveScoutFinding, dismissScoutFinding } from "./scout-workbook-actions";

/**
 * What the AI Auction Scout found and would not put in the calendar on its own.
 *
 * Research rows go straight in only when they are confirmed against the county's
 * own page. The rest wait here with the reason, the page they were read from,
 * and two buttons. Approve runs the same matcher on that row alone and trusts
 * it; if the row still cannot be placed — its date disagrees with a sale the
 * calendar already holds — it stays, with the new reason, because that is fixed
 * on the county page rather than here. Dismissed rows are not asked about again
 * when next Sunday's research finds them.
 */

const btn =
  "rounded-lg border border-border px-3 py-1 text-xs font-medium hover:border-accent disabled:opacity-60";

export async function ScoutFindingsPanel() {
  const [pending, recent, [{ n }]] = await Promise.all([
    db
      .select()
      .from(scoutFindings)
      .where(eq(scoutFindings.status, "pending"))
      .orderBy(scoutFindings.saleDate)
      .limit(60),
    db
      .select()
      .from(scoutFindings)
      .where(sql`${scoutFindings.status} <> 'pending'`)
      .orderBy(desc(scoutFindings.decidedAt))
      .limit(8),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(scoutFindings)
      .where(eq(scoutFindings.status, "pending")) as Promise<{ n: number }[]>,
  ]);

  return (
    <Card>
      <h2 className="mb-1 text-base font-semibold">Scout findings waiting for you</h2>
      <p className="mb-3 text-sm text-muted">
        Sales the Auction Scout found but would not add on its own — {Number(n)} waiting. Approve adds
        or fills the sale; dismiss hides it for good.
      </p>

      {pending.length === 0 ? (
        <p className="text-sm text-muted">Nothing waiting.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {pending.map((f) => {
            const row = f.finding as Record<string, string | boolean | null>;
            return (
              <li key={f.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {f.saleDate} · {f.county}, {f.state}
                    {row.saleKind ? <span className="text-muted"> · {String(row.saleKind)}</span> : null}
                    {row.auctionFormat ? <span className="text-muted"> · {String(row.auctionFormat)}</span> : null}
                  </div>
                  <div className="text-xs text-muted">
                    {f.reason}
                    {row.sourceUrl ? (
                      <>
                        {" — "}
                        <a href={String(row.sourceUrl)} target="_blank" rel="noreferrer" className="underline">
                          source
                        </a>
                      </>
                    ) : null}
                    {f.outcome ? <span className="text-faint"> · last try: {f.outcome}</span> : null}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <form action={approveScoutFinding}>
                    <input type="hidden" name="id" value={f.id} />
                    <button type="submit" className={btn}>
                      Approve
                    </button>
                  </form>
                  <form action={dismissScoutFinding}>
                    <input type="hidden" name="id" value={f.id} />
                    <button type="submit" className={btn}>
                      Dismiss
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {recent.length ? (
        <div className="mt-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Recently decided</h3>
          <ul className="space-y-1 text-xs text-muted">
            {recent.map((f) => (
              <li key={f.id}>
                {f.saleDate} {f.county}, {f.state} — {f.status}
                {f.outcome ? `: ${f.outcome}` : ""}
                {f.decidedAt ? <span className="text-faint"> · {f.decidedBy}, {deskDateTime(f.decidedAt)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
