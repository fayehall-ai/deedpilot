"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { lookupProperty, type LookupState } from "@/app/lookup-action";
import { PropertyResult } from "./property-result";

/**
 * Look up any US property, inline.
 *
 * ## Why this is not a page
 *
 * It used to be a GET form pointing at `/property?q=…`. That sent the reader away
 * from the page they were on, emptied the input they had just typed into, and —
 * because the search takes around twenty seconds — left them on a route that
 * looked like it had failed to load.
 *
 * `useActionState` keeps all three problems from existing: the action returns the
 * query it was given, so the field can be restored exactly as typed; the result
 * renders beside the box that asked for it; and `useFormStatus` gives a real
 * pending state on a control that is genuinely slow.
 *
 * ## Why the input is uncontrolled with a key
 *
 * `defaultValue` plus a `key` derived from the last submitted query restores the
 * text after the action returns without making every keystroke a React render.
 * The reader can keep editing while a search is in flight.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium
                 text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
    >
      {pending && (
        <span
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current
                     border-t-transparent motion-reduce:animate-none"
          aria-hidden
        />
      )}
      {pending ? "Searching…" : "Search"}
    </button>
  );
}

/**
 * The wait is long enough that a spinner alone reads as a hang, so it says what
 * is happening and roughly how long it takes.
 */
function Pending() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-4 flex items-center gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <span
        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent
                   border-t-transparent motion-reduce:animate-none"
        aria-hidden
      />
      <p className="text-sm text-muted">
        Reading county assessor and listing sources — usually about twenty seconds.
      </p>
    </div>
  );
}

export function PropertySearch() {
  const [state, action] = useActionState<LookupState | null, FormData>(lookupProperty, null);

  return (
    <div className="w-full sm:max-w-md">
      <form action={action}>
        <label htmlFor="q" className="block text-sm font-medium">
          Look up any US property
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="q"
            name="q"
            type="search"
            required
            minLength={5}
            // Restores what was typed once the action returns; see the header.
            key={state?.query ?? ""}
            defaultValue={state?.query ?? ""}
            placeholder="1600 Pennsylvania Ave NW, Washington, DC"
            autoComplete="street-address"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm
                       placeholder:text-faint focus:border-accent focus:outline-none
                       focus:ring-2 focus:ring-accent/30"
          />
          <Submit />
        </div>
        <p className="mt-2 text-xs text-muted">
          Include the city or ZIP — an address alone is usually ambiguous.
        </p>

        <Pending />
      </form>

      {state?.error && (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm font-medium">That search could not run.</p>
          <p className="mt-1 text-sm text-muted">{state.error}</p>
        </div>
      )}

      {state?.data && state.citations && (
        <div className="mt-4">
          <PropertyResult data={state.data} citations={state.citations} ageHours={state.ageHours} />
        </div>
      )}
    </div>
  );
}
