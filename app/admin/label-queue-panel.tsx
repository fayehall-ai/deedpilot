import { Card, Callout } from "@/components/ui";
import { AdminTable, type AdminColumn } from "@/components/admin-table";
import { labelQueue, loadCandidates, summariseQueue, type LabelCandidate } from "@/lib/admin/label-queue";

const money = (n: number | null) =>
  n === null ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/**
 * Sources waiting on a semantics decision.
 *
 * The results crawl is the only thing that widens the price model, and it is
 * deliberately incapable of certifying its own output: a crawler that could
 * decide what its numbers mean would walk straight back into the bug this
 * system was rebuilt to prevent. So candidate rows sit outside the corpus until
 * somebody writes a rule in `labels.py`.
 *
 * This is the queue for that work, with the evidence attached. The quartiles do
 * most of the arguing — a page with a $137 median and one with a $232,500
 * median are visibly not recording the same quantity, whatever both columns are
 * called.
 */
export function LabelQueuePanel() {
  const rows = loadCandidates();
  if (rows.length === 0) return null;

  const queue = labelQueue(rows);
  const summary = summariseQueue(queue);

  const columns: AdminColumn<LabelCandidate>[] = [
    {
      key: "host",
      header: "Source",
      cell: (q) => (
        <>
          <span className="font-mono text-xs">{q.host}</span>
          <div className="text-xs text-muted">
            {q.state} · {q.counties.slice(0, 3).join(", ")}
            {q.counties.length > 3 ? ` +${q.counties.length - 3}` : ""}
          </div>
        </>
      ),
    },
    { key: "rows", header: "Rows", numeric: true, cell: (q) => q.rows.toLocaleString() },
    {
      key: "spread",
      header: "Winning bid — p25 / median / p75",
      cell: (q) => (
        <span className="font-mono text-xs tabular-nums">
          {money(q.p25)} / <strong>{money(q.median)}</strong> / {money(q.p75)}
        </span>
      ),
    },
    {
      key: "tell",
      header: "What the shape suggests",
      cell: (q) => (
        <div className="space-y-0.5 text-xs">
          {q.matchesOpeningBid > 0.8 && (
            <div className="text-warn">
              {(q.matchesOpeningBid * 100).toFixed(0)}% of rows equal the opening bid — likely a tax
              amount bid down on the rate, not a clearing price
            </div>
          )}
          {q.redemptionUnobserved && (
            <div className="text-danger">
              every row carries <code className="font-mono">redeemed: false</code> as a default —
              must not be fitted as observed non-redemption
            </div>
          )}
          {q.matchesOpeningBid <= 0.8 && !q.redemptionUnobserved && (
            <span className="text-muted">no strong tell — read the page</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Results awaiting a label rule</h2>
        <p className="mt-1 text-sm text-muted">
          {summary.rows.toLocaleString()} crawled rows from {summary.hosts} source
          {summary.hosts === 1 ? "" : "s"} across {summary.states.length} states, none of it in the
          corpus. A rule in <code className="font-mono text-xs">labels.py</code> states what a
          source&rsquo;s price column is and what its disposition flags observe; until one exists the
          Archivist refuses the batch rather than importing the labelled part and leaving a gap that
          later reads as market signal.
        </p>
      </div>

      {summary.unobservedRedemption > 0 && (
        <Callout
          tone="warn"
          title={`${summary.unobservedRedemption} source${summary.unobservedRedemption === 1 ? "" : "s"} carry redeemed=false as a schema default`}
        >
          The Cook County shape. Seventy thousand rows of that default once pinned Illinois at{" "}
          <code className="font-mono text-xs">p_redeem = 0.02</code> — the simulator concluded an
          Illinois lien almost never redeems, which is the entire thesis of buying one. A rule for
          these sources must record the disposition as unobserved.
        </Callout>
      )}

      <Card>
        <AdminTable
          rows={queue}
          columns={columns}
          rowKey={(q) => q.host}
          minWidth="52rem"
          empty="No candidate rows waiting."
        />
      </Card>
    </section>
  );
}
