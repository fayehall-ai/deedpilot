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
 *
 * ## Why this returns a fragment
 *
 * The home hero is a two-column grid: copy, then this lookup. Nesting the
 * result inside the lookup column trapped a listing in ~34rem — fields wrapped,
 * the aerial became a tall empty box. The panel stays in that column; the
 * result is a sibling that spans both tracks.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex shrink-0 items-center gap-2 rounded-full bg-ink-fg px-6 py-3 text-base
                 font-semibold text-ink shadow-[0_8px_24px_-12px_rgba(255,255,255,0.5)]
                 transition-transform hover:scale-[1.02] disabled:cursor-wait disabled:opacity-60"
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

export function PropertySearch() {
  const [state, action] = useActionState<LookupState | null, FormData>(lookupProperty, null);

  return (
    <>
      <div className="w-full min-w-0">
        <div className="glass rounded-3xl p-[clamp(1.35rem,1.6vw,2rem)]">
          <h2 className="font-display text-xl font-medium text-ink-fg">Look up any address</h2>
          <div className="mt-4">
            <form action={action}>
              {/*
                Styled for the ink band it sits on. A surface-coloured field on a dark
                ground is nearly invisible, and this is the one control a visitor may
                have arrived specifically to use.

                No visible label, and no hint underneath. Both said what the
                placeholder already demonstrates — that it is an address field, and
                that the example carries a city and a state. Three lines of chrome
                around one input made the control look more demanding than typing an
                address actually is.

                The label became `aria-label` rather than disappearing: a search box
                still needs a name for anyone not looking at the placeholder.
              */}
              <div className="flex gap-2">
                <input
                  id="q"
                  name="q"
                  type="search"
                  aria-label="Look up any US property by address"
                  required
                  minLength={5}
                  // Restores what was typed once the action returns; see the header.
                  key={state?.query ?? ""}
                  defaultValue={state?.query ?? ""}
                  placeholder="1600 Pennsylvania Ave NW, Washington, DC"
                  autoComplete="street-address"
                  className="min-w-0 flex-1 rounded-full border border-white/12 bg-white/[0.06] px-5 py-3
                             text-base text-ink-fg backdrop-blur placeholder:text-ink-muted/70
                             transition-all focus:border-accent-on-ink/60 focus:bg-white/10
                             focus:shadow-[0_0_0_4px_rgba(12,107,255,0.14)] focus:outline-none"
                />
                <Submit />
              </div>
            </form>

            {/*
              The same street address in several places. Each is its own tiny
              form on the same action, so picking one runs that search and puts
              the full address in the box.
            */}
            {state?.choices && (
              <div className="mt-4 rounded-3xl border border-border bg-surface p-4 text-foreground">
                <p className="text-base font-medium">That address is in more than one place. Which one?</p>
                <ul className="mt-3 space-y-2">
                  {state.choices.map((c) => (
                    <li key={c}>
                      <form action={action}>
                        <input type="hidden" name="q" value={c} />
                        <button
                          type="submit"
                          className="w-full rounded-xl border border-border px-4 py-2.5 text-left text-base hover:border-accent hover:text-accent"
                        >
                          {c}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {state?.error && (
              <div className="mt-4 rounded-3xl border border-red-300 bg-red-50 p-4 text-foreground dark:border-red-900 dark:bg-red-950/40">
                <p className="text-base font-medium">That search could not run.</p>
                <p className="mt-1 text-base text-muted">{state.error}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {state?.data && (
        <div className="min-w-0 lg:col-span-2">
          <PropertyResult
            data={state.data}
            ageHours={state.ageHours}
            extras={state.extras}
            streetView={state.streetView}
            view={state.view}
            context={state.context}
          />
        </div>
      )}
    </>
  );
}
