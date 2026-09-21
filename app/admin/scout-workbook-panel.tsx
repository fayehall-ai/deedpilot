"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Callout } from "@/components/ui";
import { uploadScoutWorkbook, type WorkbookOutcome } from "./scout-workbook-actions";

/**
 * Uploading Ed's expanded Auction Scout workbook.
 *
 * Reads the "Auction Scout" tab and then the "Sep-Oct Source Import" tab, and
 * prints the same plan the terminal would: sales matched and filled, sales
 * added, and — the part that needs a person — near-miss dates and ambiguous
 * days, which are left alone. Preview first on a new workbook; applying the
 * same one twice changes nothing.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm
                 font-medium text-white transition-opacity hover:opacity-90
                 disabled:cursor-wait disabled:opacity-60"
    >
      {pending && (
        <span
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current
                     border-t-transparent motion-reduce:animate-none"
          aria-hidden
        />
      )}
      {pending ? "Reading the workbook…" : "Read workbook"}
    </button>
  );
}

export function ScoutWorkbookPanel() {
  const [outcome, action] = useActionState<WorkbookOutcome | null, FormData>(uploadScoutWorkbook, null);

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        <div>
          <label htmlFor="scout-workbook" className="block text-sm font-medium">
            Auction Scout workbook (.xlsx)
          </label>
          <p className="mt-1 text-xs text-muted">
            The expanded report with its <code className="font-mono">Auction Scout</code> and{" "}
            <code className="font-mono">Sep-Oct Source Import</code> tabs. Download it from Google
            Sheets with File → Download → Microsoft Excel.
          </p>
          <input
            id="scout-workbook"
            name="file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            className="mt-2 block w-full text-sm text-muted file:mr-3 file:rounded-lg
                       file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5
                       file:text-sm file:text-foreground hover:file:border-accent"
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="preview" defaultChecked className="mt-1" />
          <span>
            Preview only
            <span className="block text-xs text-muted">
              Shows what the workbook would change without writing anything. Untick to apply.
            </span>
          </span>
        </label>
        <Submit />
      </form>

      {outcome?.error ? (
        <Callout tone="danger" title="Nothing was written">
          {outcome.error}
        </Callout>
      ) : null}

      {outcome?.ok && outcome.tabs
        ? outcome.tabs.map((t) => (
            <div key={t.tab} className="space-y-2">
              <h3 className="text-sm font-semibold">
                {t.tab} {outcome.applied ? "— applied" : "— preview"}
              </h3>
              {t.wrote ? <p className="text-sm text-muted">{t.wrote}</p> : null}
              <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed">
                {t.lines.join("\n")}
              </pre>
            </div>
          ))
        : null}
    </div>
  );
}
