"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Callout } from "@/components/ui";
import { addCountySource, type CountySourceOutcome } from "./county-source-actions";

/**
 * "The list is right there on the county's site" — tell the crawler so.
 */
function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add and crawl"}
    </button>
  );
}

export function CountySourcePanel() {
  const [outcome, action] = useActionState<CountySourceOutcome | null, FormData>(addCountySource, null);
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">County</span>
          <input
            name="county"
            required
            placeholder="Clayton, GA  or  13063"
            className="w-48 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex min-w-72 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">Its list page or PDF</span>
          <input
            name="url"
            type="url"
            required
            placeholder="https://… the page that links the sale list, or the PDF itself"
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <Submit />
      </form>
      {outcome ? (
        <Callout tone={outcome.ok ? "info" : "warn"}>{outcome.message}</Callout>
      ) : null}
    </div>
  );
}
