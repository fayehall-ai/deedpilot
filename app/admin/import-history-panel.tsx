import { Card, Callout } from "@/components/ui";
import { deskDateTime } from "@/lib/desk-time";
import { readImportHistory, type ImportRecord } from "@/lib/import/history";

/**
 * When each calendar was loaded, from where, and what each stage did.
 *
 * ## Why this is not the "Recent changes" table
 *
 * The audit table on the Plan panel lists every console action and truncates
 * `detail` to ninety characters of JSON, which for an import is roughly the
 * opening brace. It answers "did somebody touch this console" and cannot answer
 * "was the calendar imported, when, and did it work" — the question actually
 * asked when the site looks short of sales.
 *
 * So this reads the same rows and renders the part that matters: the stages,
 * side by side, in the order they ran. Anything that did not import is listed
 * with the line number to fix, because a rejected row is only actionable if you
 * are told which line it was.
 *
 * ## Why the stage counts do not add up to the row count, on purpose
 *
 * They tell a story rather than balance a ledger. `read` counts what was in the
 * file, `translate` what became an auction, `resolve` what found a county, and
 * `write` what the database did with it — and a single row can be counted in
 * `resolve.resolved` and then land as a `merge` rather than an `insert`. Forcing
 * them into one total would hide exactly the distinction each stage exists to
 * draw.
 */

/**
 * Read inside the helper rather than the component body, matching
 * `runs-panel` and `sources-panel`: the clock is not a render input, and
 * reading it in render is what the purity rule is there to stop.
 */
function ago(at: Date): string {
  const mins = Math.round((Date.now() - at.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function bytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function secs(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Where the file came from, in the operator's words rather than the enum's. */
function viaLabel(via: ImportRecord["via"]): string {
  return via === "cli" ? "terminal" : via === "console" ? "upload" : "—";
}

/** One stage, as a count and the words for what it counted. */
function Stage({ name, headline, detail }: { name: string; headline: string; detail: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-xs uppercase tracking-[0.12em] text-muted">{name}</div>
      <div className="tnum mt-0.5 text-sm font-medium">{headline}</div>
      <div className="mt-0.5 text-xs leading-snug text-muted">{detail}</div>
    </div>
  );
}

function Stages({ rec }: { rec: ImportRecord }) {
  const s = rec.stages;
  if (!s) {
    return (
      <p className="text-sm text-muted">
        Recorded before per-stage logging existed, so only the summary survives.
      </p>
    );
  }
  const w = s.write;
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-4">
      <Stage
        name="1 · Read"
        headline={`${s.read.rows.toLocaleString()} rows`}
        detail={`${s.read.columns} columns${s.read.blank ? ` · ${s.read.blank} blank skipped` : ""}`}
      />
      <Stage
        name="2 · Translate"
        headline={`${s.translate.parsed.toLocaleString()} parsed`}
        detail={s.translate.rejected ? `${s.translate.rejected} unreadable` : "all rows readable"}
      />
      <Stage
        name="3 · Resolve"
        headline={`${s.resolve.resolved.toLocaleString()} matched`}
        detail={
          [
            s.resolve.viaParent ? `${s.resolve.viaParent} municipal` : "",
            s.resolve.rejected ? `${s.resolve.rejected} no county` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "every county found"
        }
      />
      <Stage
        name="4 · Write"
        headline={`${w.inserted.toLocaleString()} new`}
        detail={
          [
            `${w.updated.toLocaleString()} refreshed`,
            `${w.merged.toLocaleString()} merged`,
            w.duplicateInFile ? `${w.duplicateInFile} dupes in file` : "",
            w.ambiguous ? `${w.ambiguous} ambiguous` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        }
      />
    </div>
  );
}

function Row({ rec }: { rec: ImportRecord }) {
  return (
    <div className="border-b border-border/50 py-4 first:pt-0 last:border-0 last:pb-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{deskDateTime(rec.at)}</span>
        <span className="text-xs text-muted">{ago(rec.at)}</span>
        {!rec.ok && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--danger)]">
            refused
          </span>
        )}
        <span className="min-w-0 break-all font-mono text-xs text-muted">{rec.source}</span>
        <span className="text-xs text-muted">
          via {viaLabel(rec.via)} · {rec.actor}
          {rec.bytes !== null ? ` · ${bytes(rec.bytes)}` : ""}
          {rec.durationMs !== null ? ` · ${secs(rec.durationMs)}` : ""}
        </span>
      </div>

      {rec.ok ? (
        <>
          <Stages rec={rec} />
          {(rec.dateRange || rec.counties !== null) && (
            <p className="mt-3 text-xs text-muted">
              {rec.dateRange ? (
                <>
                  Sales dated{" "}
                  <span className="tnum">
                    {rec.dateRange.from} → {rec.dateRange.to}
                  </span>
                </>
              ) : null}
              {rec.dateRange && rec.counties !== null ? " · " : ""}
              {rec.counties !== null ? `${rec.counties.toLocaleString()} counties touched` : ""}
            </p>
          )}
          {rec.rejectedTotal > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted underline underline-offset-2">
                {/* One expression: a line break between the count and the plural
                    "s" renders as "4 row s did not import". */}
                {`${rec.rejectedTotal.toLocaleString()} row${
                  rec.rejectedTotal === 1 ? "" : "s"
                } did not import`}
              </summary>
              <ul className="mt-2 space-y-1">
                {rec.rejects.map((r) => (
                  <li key={r.line} className="text-xs text-muted">
                    <span className="tnum font-mono">line {r.line}</span> · {r.label} —{" "}
                    {r.problem}
                  </li>
                ))}
              </ul>
              {rec.rejectedTotal > rec.rejects.length && (
                <p className="mt-1.5 text-xs text-muted">
                  … and {(rec.rejectedTotal - rec.rejects.length).toLocaleString()} more, not kept
                  with the record.
                </p>
              )}
            </details>
          )}
        </>
      ) : (
        <p className="text-sm text-[var(--danger)]">{rec.error ?? "The file could not be read."}</p>
      )}
    </div>
  );
}

export async function ImportHistoryPanel() {
  const history = await readImportHistory(20);
  const lastApplied = history.find((h) => h.ok);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Import history</h2>
        {lastApplied ? (
          <span className="text-sm text-muted">
            Last import {ago(lastApplied.at)} · {deskDateTime(lastApplied.at)}
          </span>
        ) : null}
      </div>

      {history.length === 0 ? (
        <Callout title="Nothing recorded yet">
          Every import from this point on writes here — uploads and terminal runs alike. Calendars
          loaded before this log existed left no trace, so an empty list does not mean an empty
          calendar.
        </Callout>
      ) : (
        <div>
          {history.map((rec) => (
            <Row key={rec.id} rec={rec} />
          ))}
        </div>
      )}
    </Card>
  );
}
