import { Card, Callout, Stat } from "@/components/ui";
import { getScoutReport } from "@/lib/admin/scout-jobs";
import { SCAN_STATES } from "@/lib/ai/scout-report";
import { getScoutPrompt } from "@/lib/admin/scout-prompt";
import { generateScoutReport, saveScoutPromptAction } from "./scout-actions";

const button =
  "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90";
const input = "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm";
const ghost =
  "rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground";

const STATUS_TONE: Record<string, string> = {
  done: "text-foreground",
  queued: "text-muted",
  leased: "text-accent",
  failed: "text-danger",
  cancelled: "text-muted",
  "not run": "text-muted",
};

/**
 * The Auction Scout report.
 *
 * Shows the assembled rows and, beside them, what has NOT been answered — the
 * states still queued, the ones that failed, and the counties that need a
 * person. A research report that shows only its findings reads as complete
 * whether or not it is, and this one is assembled from jobs that finish across
 * different dispatcher ticks, so "nothing for Texas yet" and "no Texas sales"
 * must never look the same on screen.
 */
export async function ScoutPanel() {
  const [report, prompt] = await Promise.all([getScoutReport(), getScoutPrompt()]);
  const { totals, window } = report;
  const done = report.states.filter((s) => s.status === "done").length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Auction Scout report</h2>
        <form action={generateScoutReport} className="flex items-center gap-2">
          <select name="state" className={input} defaultValue="ALL">
            <option value="ALL">All {SCAN_STATES.length} states</option>
            <option value="BACKLOG">Backlog — states with a sale coming and no source</option>
            {SCAN_STATES.map((s) => (
              <option key={s} value={s}>
                {s} only
              </option>
            ))}
          </select>
          <button type="submit" className={button}>
            Generate Auction Scout Report
          </button>
        </form>
      </div>

      <p className="text-sm text-muted">
        Queues one live-web research pass per state, scanning{" "}
        {window?.end ? (
          <>
            <strong>{window.start}</strong> to <strong>{window.end}</strong>
          </>
        ) : (
          <>
            every sale scheduled on or after <strong>{window?.start ?? "today"}</strong>, with no end
            date
          </>
        )}
        . Each state is a paid searched call that runs a minute or two, so the queue drains across
        dispatcher ticks rather than while you wait. Rows appear as states land.
      </p>

      {/*
        The brief itself, editable. It is the product here — what a report must
        cover changes when the desk's priorities change, and that should not
        need a deploy. Collapsed by default so the console still opens on the
        report rather than on a wall of prose.
      */}
      <Card>
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            Research prompt{" "}
            <span className="font-normal text-muted">
              — {prompt.edited ? `edited${prompt.updatedAt ? ` ${prompt.updatedAt.toISOString().slice(0, 10)}` : ""}` : "built-in default"}
            </span>
          </summary>
          <form action={saveScoutPromptAction} className="mt-3 space-y-2">
            <textarea
              name="template"
              rows={16}
              defaultValue={prompt.template}
              spellCheck={false}
              className="w-full rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed"
            />
            <p className="text-xs text-muted">
              <code className="font-mono">{"{{STATE}}"}</code> (required),{" "}
              <code className="font-mono">{"{{START}}"}</code>, <code className="font-mono">{"{{END}}"}</code>,{" "}
              <code className="font-mono">{"{{HUB}}"}</code> and{" "}
              <code className="font-mono">{"{{COUNTY_SCOPE}}"}</code> are filled in per run. One run
              researches one state, which is why <code className="font-mono">{"{{STATE}}"}</code> cannot be
              dropped. Saved changes apply to the next state the queue picks up, not to work already
              running.
            </p>
            <div className="flex gap-2">
              <button type="submit" className={button}>
                Save prompt
              </button>
              <button type="submit" name="intent" value="reset" className={ghost}>
                Reset to default
              </button>
            </div>
          </form>
        </details>
      </Card>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Auction rows" value={totals.rows.toLocaleString()} />
        <Stat label="States covered" value={`${totals.statesCovered} / ${report.states.length}`} />
        <Stat label="Urgent (7 days)" value={totals.urgent.toLocaleString()} />
        <Stat label="Manual verification" value={totals.manualVerification.toLocaleString()} />
      </section>

      {totals.notRun > 0 && (
        <Callout tone="warn" title={`${totals.notRun} state${totals.notRun === 1 ? "" : "s"} never scanned`}>
          Listed below as <em>not run</em>. They hold no rows because nobody has asked for them yet —
          not because they have no sales.
        </Callout>
      )}

      {totals.pending > 0 && (
        <Callout tone="warn" title={`${totals.pending} state${totals.pending === 1 ? "" : "s"} still to run`}>
          The report below is partial. The dispatcher runs daily on this plan; drain it now with{" "}
          <code className="font-mono text-xs">GET /api/cron/dispatch?token=…</code> using the operations
          token.
        </Callout>
      )}

      {totals.failed > 0 && (
        <Callout tone="warn" title={`${totals.failed} state${totals.failed === 1 ? "" : "s"} failed`}>
          A failed state is blank, not empty — nothing was searched. Reasons are in the table below.
        </Callout>
      )}

      {/* ---- per-state coverage: what was asked, not only what was found ---- */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1.5 pr-3">State</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 pr-3 text-right">Rows</th>
                <th className="py-1.5 pr-3 text-right">Counties</th>
                <th className="py-1.5 pr-3 text-right">Searches</th>
                <th className="py-1.5">Summary</th>
              </tr>
            </thead>
            <tbody>
              {report.states.map((s) => (
                <tr key={s.state} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3 font-medium">{s.state}</td>
                  <td className={`py-1.5 pr-3 ${STATUS_TONE[s.status] ?? ""}`}>{s.status}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.rows}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.countiesChecked || "—"}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.searchCount || "—"}</td>
                  <td className="py-1.5 text-muted">{s.error ?? s.summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---- the rows themselves ---- */}
      {report.rows.length > 0 && (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              {report.rows.length} sale{report.rows.length === 1 ? "" : "s"} in window
            </h3>
            <a href="/admin/scout-report" className={button} download>
              Download .xlsx
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1.5 pr-3">Sale date</th>
                  <th className="py-1.5 pr-3">County</th>
                  <th className="py-1.5 pr-3">ST</th>
                  <th className="py-1.5 pr-3">Kind</th>
                  <th className="py-1.5 pr-3">Platform</th>
                  <th className="py-1.5 pr-3">County list / PDF</th>
                  <th className="py-1.5">Verification</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={`${r.state}-${r.county}-${r.saleDate}`} className="border-t border-border">
                    <td className="py-1.5 pr-3 tabular-nums">{r.saleDate}</td>
                    <td className="py-1.5 pr-3">{r.county}</td>
                    <td className="py-1.5 pr-3">{r.state}</td>
                    <td className="py-1.5 pr-3 text-muted">{r.saleKind}</td>
                    <td className="py-1.5 pr-3 text-muted">{r.platform ?? "—"}</td>
                    <td className="py-1.5 pr-3">
                      {r.countyListUrl ? (
                        <a
                          href={r.countyListUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent underline underline-offset-2"
                        >
                          list
                        </a>
                      ) : (
                        <span className="text-muted">none posted</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {r.verification === "confirmed" ? (
                        <span className="text-muted">confirmed</span>
                      ) : (
                        <span className="text-danger">manual verification required</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">
            {done} of {report.states.length} states reported · {report.citations.length} sources read ·
            every row carries the page it was read from.
          </p>
        </Card>
      )}
    </section>
  );
}
