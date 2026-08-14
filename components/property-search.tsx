/**
 * Look up any US property by address, from the front page.
 *
 * A plain GET form rather than a server action, so the result lives at a URL
 * that can be shared, reloaded and linked from a listing. That also keeps the
 * home page itself static — the form ships in the prerendered shell and the
 * search cost is paid on `/property`, not on every visit to `/`.
 */
export function PropertySearch() {
  return (
    <form action="/property" method="get" className="mt-8 max-w-2xl">
      <label htmlFor="q" className="block text-sm font-medium">
        Look up any US property
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="q"
          name="q"
          type="search"
          required
          minLength={5}
          placeholder="1600 Pennsylvania Ave NW, Washington, DC"
          autoComplete="street-address"
          className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-base
                     placeholder:text-faint focus:border-accent focus:outline-none
                     focus:ring-2 focus:ring-accent/30"
        />
        {/*
         * A plain button, not `SubmitButton`. That component reads
         * `useFormStatus`, which only reports pending for a server action — on a
         * GET navigation it would render a spinner state that never arrives.
         * The browser's own navigation indicator covers this, and `/property`
         * paints a skeleton while the search runs.
         */}
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg hover:opacity-90"
        >
          Search
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Reads the county assessor and listing sites live. Include the city or ZIP — an address
        alone is usually ambiguous.
      </p>
    </form>
  );
}
