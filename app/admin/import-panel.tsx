"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Callout } from "@/components/ui";
import { uploadAuctionCsv, type ImportOutcome } from "./import-actions";

/**
 * Uploading a published sale calendar.
 *
 * ## Why the report is the output, not a toast
 *
 * A 644-row import is never simply "done". Some rows land as new sales, some
 * refresh rows a previous upload created, some fold into auctions the crawler
 * already had, and a few fail because a county label is ambiguous or a sale type
 * is one this system does not model. Every one of those is a different thing for
 * a person to do next, and collapsing them into "imported 644 rows" throws away
 * the only part of the operation that needed a human.
 *
 * So the panel renders the full accounting and, in particular, lists the
 * rejected rows with their line numbers. A row rejected at line 287 is fixable
 * in thirty seconds if you are told it is line 287, and effectively unfindable
 * if you are told that six rows failed.
 *
 * ## Why the counts are separated rather than summed
 *
 * "Inserted" and "merged into an existing crawled sale" are both successes and
 * mean opposite things about what changed. A calendar that was already fully
 * crawled produces an import of 644 merges and zero inserts, which looks like a
 * no-op and is in fact the correct and reassuring outcome. One number could not
 * say that.
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
      {pending ? "Importing…" : "Import calendar"}
    </button>
  );
}

export function ImportPanel() {
  const [outcome, action] = useActionState<ImportOutcome | null, FormData>(
    uploadAuctionCsv,
    null,
  );

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        <div>
          <label htmlFor="import-file" className="block text-sm font-medium">
            Sale calendar CSV
          </label>
          <p className="mt-1 text-xs text-muted">
            Needs the columns <code className="font-mono">State</code>,{" "}
            <code className="font-mono">County</code>, <code className="font-mono">Sale Date</code>,{" "}
            <code className="font-mono">Auction Type</code> and{" "}
            <code className="font-mono">Auction ID</code>. Extra columns are kept; the ID is what
            makes a re-upload update rather than duplicate.
          </p>
          <input
            id="import-file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className="mt-2 block w-full text-sm text-muted file:mr-3 file:rounded-lg
                       file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5
                       file:text-sm file:text-foreground hover:file:border-accent"
          />
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="enrich" defaultChecked className="mt-1" />
          <span>
            Queue crawls for the counties this file touches
            <span className="block text-xs text-muted">
              Fetches each county&rsquo;s own parcel list, which is what fills in the parcels,
              opening bids and deadlines an announcement does not carry. Skips counties already
              queued and counties whose sale list nobody has located yet.
            </span>
          </span>
        </label>

        <Submit />
      </form>

      {outcome?.error ? (
        <Callout tone="danger" title="Nothing was imported">
          {outcome.error}
        </Callout>
      ) : null}

      {outcome?.ok && outcome.report ? <Report outcome={outcome} /> : null}
    </div>
  );
}

function Report({ outcome }: { outcome: ImportOutcome }) {
  const r = outcome.report!;
  const e = outcome.enrichment;
  const n = (v: number) => v.toLocaleString();

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-2 p-4">
      <div>
        <h3 className="text-sm font-semibold">
          {n(r.totalRows)} rows read
          {r.dateRange ? (
            <span className="font-normal text-muted">
              {" "}
              · {r.dateRange.from} to {r.dateRange.to} · {n(r.countiesTouched.length)}{" "}
              {r.countiesTouched.length === 1 ? "county" : "counties"}
            </span>
          ) : null}
        </h3>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="New sales" value={n(r.inserted)} />
        <Figure label="Refreshed" value={n(r.updated)} hint="rows a previous upload created" />
        <Figure
          label="Already crawled"
          value={n(r.mergedIntoCrawled)}
          hint="folded into an existing auction; only the parcel count was added"
        />
        <Figure
          label="Not imported"
          value={n(r.rejected.length + r.duplicateInFile)}
          tone={r.rejected.length > 0 ? "warn" : undefined}
        />
      </dl>

      {r.duplicateInFile > 0 ? (
        <p className="text-xs text-muted">
          {n(r.duplicateInFile)} {r.duplicateInFile === 1 ? "row repeats" : "rows repeat"} an Auction
          ID that appears earlier in the same file; the first was kept.
        </p>
      ) : null}

      {r.rejected.length > 0 ? (
        <Callout tone="warn" title={`${n(r.rejected.length)} rows could not be imported`}>
          <ul className="ml-4 mt-1 list-disc space-y-0.5 text-xs">
            {r.rejected.slice(0, 25).map((x) => (
              <li key={x.line}>
                <span className="font-mono">line {x.line}</span>
                {x.label ? ` — ${x.label}` : ""} — {x.problem}
              </li>
            ))}
          </ul>
          {r.rejected.length > 25 ? (
            <p className="mt-1 text-xs text-muted">
              and {n(r.rejected.length - 25)} more — see the audit log.
            </p>
          ) : null}
        </Callout>
      ) : null}

      {r.ambiguous.length > 0 ? (
        <Callout
          tone="warn"
          title={`${n(r.ambiguous.length)} possible duplicates left for you to judge`}
        >
          <p className="text-xs">
            These counties already had auctions on the same date, but the pairing was not
            one-to-one, so the imported rows were added rather than merged. Worth a look in case
            one is the same sale under two records.
          </p>
          <ul className="ml-4 mt-1 list-disc space-y-0.5 text-xs">
            {r.ambiguous.slice(0, 15).map((a) => (
              <li key={`${a.countyFips}-${a.saleDate}`}>
                {a.countyLabel} on {a.saleDate} — {a.existing} already held, {a.imported} in the
                file
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {e ? (
        <div className="border-t border-border pt-3 text-xs text-muted">
          <p>
            <strong className="text-foreground">{n(e.queued)}</strong> counties queued for a parcel
            crawl
            {e.alreadyBusy > 0 ? `, ${n(e.alreadyBusy)} already had work in flight` : ""}.{" "}
            {n(e.awaitingParcels)} imported {e.awaitingParcels === 1 ? "sale is" : "sales are"} still
            holding a count with no parcels behind it.
          </p>
          {e.noAdapter.length > 0 || e.noSource.length > 0 ? (
            <p className="mt-1">
              {e.noAdapter.length > 0
                ? `${n(e.noAdapter.length)} counties have a known sale list but no parser. `
                : ""}
              {e.noSource.length > 0
                ? `${n(e.noSource.length)} have no located source — run the Prospector for those.`
                : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`tnum text-lg font-semibold ${tone === "warn" ? "text-warn" : ""}`}
      >
        {value}
      </dd>
      {hint ? <p className="text-[11px] leading-tight text-faint">{hint}</p> : null}
    </div>
  );
}
