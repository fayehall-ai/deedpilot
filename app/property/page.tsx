import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { PropertySearch } from "@/components/property-search";

/**
 * One property, looked up live by web search.
 *
 * ## Why a page rather than an inline result
 *
 * The search costs a paid searched call and takes tens of seconds. Putting the
 * result at its own URL means a lookup can be shared, reloaded and linked to
 * from a listing, and it keeps the home page's static shell free of a component
 * that must never prerender.
 *
 * ## Why every figure is shown with its source
 *
 * A dollar amount with no provenance is the thing this project refuses
 * everywhere else — the whole market-practice pass exists because an unsourced
 * number was already available by asking a model from memory. A searched
 * valuation is weaker evidence than a county assessor's record, and the page
 * says so rather than rendering a confident number and hoping the reader infers
 * the caveat.
 */

export const metadata: Metadata = {
  // The root layout applies `template: "%s · DeedPilot"`, so the suffix must
  // not be repeated here — it renders as "… · DeedPilot · DeedPilot".
  title: "Property lookup",
  robots: { index: false, follow: false },
};

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 motion-reduce:animate-none">
      <div className="h-5 w-2/3 rounded bg-surface-2" />
      <div className="h-24 rounded bg-surface-2" />
      <div className="h-4 w-1/2 rounded bg-surface-2" />
      <p className="text-sm text-muted">
        Reading county assessor and listing sources — this takes a few seconds.
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-faint">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? null : `$${Math.round(n).toLocaleString()}`;

/**
 * What the search engine said, shown while the checked answer is still being
 * written.
 *
 * Retrieval finishes in about five seconds and extraction takes fifteen more,
 * so this fills the gap with something true rather than a spinner. It is
 * labelled provisional and unverified in the markup, not only in a tooltip,
 * because it is exactly the kind of figure this project refuses to treat as
 * usable: a summary line with no URL behind the number.
 *
 * It is replaced in place the moment the extracted answer resolves.
 */
function Provisional({ answer, sources }: { answer: string | null; sources: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">First look</h2>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          unverified
        </span>
        <span className="ml-auto inline-flex items-center gap-2 text-xs text-muted">
          <span
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            aria-hidden
          />
          checking {sources} source{sources === 1 ? "" : "s"}…
        </span>
      </div>
      {answer && <p className="mt-3 text-sm leading-relaxed">{answer}</p>}
      <p className="mt-3 text-xs text-muted">
        A search engine&apos;s summary, with no source attached to the figure. It is shown because
        it arrives first, not because it is checked — the confirmed answer replaces it below.
      </p>
    </div>
  );
}

/** The finished answer: cached if fresh, otherwise retrieved and extracted. */
async function Result({ q }: { q: string }) {
  const [{ retrievePhase, extractPhase }, cacheMod] = await Promise.all([
    import("@/lib/property/providers/websearch"),
    import("@/lib/property/lookup-cache"),
  ]);

  const cached = await cacheMod.getCached<import("@/lib/property/providers/websearch").SearchedProperty>(q);
  if (cached) {
    return <Answer p={cached.result} citations={cached.citations} ageHours={cached.ageHours} />;
  }

  let retrieval: Awaited<ReturnType<typeof retrievePhase>>;
  try {
    retrieval = await retrievePhase(q);
  } catch (e) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
        <p className="font-medium">That search could not run.</p>
        <p className="mt-1 text-sm text-muted">{e instanceof Error ? e.message : String(e)}</p>
      </div>
    );
  }

  /*
   * The provisional line is the *fallback* for the checked answer, so React
   * swaps one for the other with no extra plumbing: whatever is inside the
   * boundary replaces whatever was in the fallback, in place.
   */
  return (
    <Suspense fallback={<Provisional answer={retrieval.answer} sources={retrieval.sources.length} />}>
      <Extracted q={q} retrieval={retrieval} />
    </Suspense>
  );
}

async function Extracted({
  q,
  retrieval,
}: {
  q: string;
  retrieval: Awaited<ReturnType<typeof import("@/lib/property/providers/websearch").retrievePhase>>;
}) {
  const { extractPhase } = await import("@/lib/property/providers/websearch");
  const { putCached } = await import("@/lib/property/lookup-cache");

  let data: Awaited<ReturnType<typeof extractPhase>>;
  try {
    data = await extractPhase(q, retrieval);
  } catch (e) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
        <p className="font-medium">That search could not run.</p>
        <p className="mt-1 text-sm text-muted">{e instanceof Error ? e.message : String(e)}</p>
      </div>
    );
  }

  await putCached(q, data.data, data.citations);
  return <Answer p={data.data} citations={data.citations} ageHours={0} />;
}

function Answer({
  p,
  citations,
  ageHours,
}: {
  p: import("@/lib/property/providers/websearch").SearchedProperty;
  citations: { url: string; title: string | null }[];
  ageHours: number;
}) {

  /*
   * The exact property was not pinned down.
   *
   * This used to stop here: "No record found", and nothing else. That is the
   * right answer for enrichment, where a valuation for the wrong parcel becomes
   * a wrong bid — but it is a poor one for a person who typed an address, because
   * the search very often did find the building, the complex and comparable
   * units, and simply could not confirm the unit number.
   *
   * So the valuation is still withheld — no marketValue, no price on a property
   * we did not identify — while everything that is genuinely known is shown, each
   * fact labelled with which property it describes.
   */
  const exact = p.found && p.confidence !== "none";
  if (!exact) {
    const hasContext =
      p.closestMatch || p.propertyType || p.neighborhood || p.features.length > 0 || p.comparables;

    if (!hasContext) {
      return (
        <div className="rounded-xl border border-border bg-surface p-5">
          <h2 className="font-semibold">No record found for that address</h2>
          <p className="mt-2 text-sm text-muted">{p.basis}</p>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold tracking-tight">
              {p.closestMatch ? "Closest match" : "What was found"}
            </h2>
            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              not the exact address
            </span>
          </div>

          {p.closestMatch && <p className="mt-3 leading-relaxed">{p.closestMatch}</p>}

          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <Field label="Type" value={p.propertyType} />
            <Field label="Beds" value={p.beds} />
            <Field label="Baths" value={p.baths} />
            <Field label="Size" value={p.buildingSqft ? `${p.buildingSqft.toLocaleString()} sqft` : null} />
            <Field label="Lot" value={p.lotSqft ? `${p.lotSqft.toLocaleString()} sqft` : null} />
            <Field label="Year built" value={p.yearBuilt} />
            <Field label="Status" value={p.status} />
            <Field
              label="Estimate range"
              value={
                p.estimateLow && p.estimateHigh
                  ? `${money(p.estimateLow)} – ${money(p.estimateHigh)}`
                  : null
              }
            />
          </dl>

          {p.features.length > 0 && (
            <div className="mt-5">
              <dt className="text-xs uppercase tracking-wide text-faint">Features</dt>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {p.features.slice(0, 12).map((f) => (
                  <li key={f} className="rounded bg-surface-2 px-2 py-0.5 text-sm">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {p.neighborhood && (
            <div className="mt-5">
              <dt className="text-xs uppercase tracking-wide text-faint">Neighbourhood</dt>
              <p className="mt-1 text-sm leading-relaxed">{p.neighborhood}</p>
            </div>
          )}

          {p.comparables && (
            <div className="mt-5">
              <dt className="text-xs uppercase tracking-wide text-faint">Comparable sales</dt>
              <p className="mt-1 text-sm leading-relaxed">{p.comparables}</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-surface p-5">
          <h3 className="text-sm font-semibold">Why this is not the exact property</h3>
          <p className="mt-2 text-sm text-muted">{p.basis}</p>
          {citations.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {citations.slice(0, 8).map((c) => (
                <li key={c.url}>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline underline-offset-2 hover:opacity-80"
                  >
                    {c.title ?? new URL(c.url).hostname}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs leading-relaxed text-muted">
          No value is shown for the address you entered, because it was not identified. The figures
          above describe the closest match and are context, not a valuation of your property.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {p.addressLine ?? "This property"}
            {p.city ? `, ${p.city}` : ""} {p.zip ?? ""}
          </h2>
          <span
            className={`rounded px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide ${
              p.confidence === "stated"
                ? "bg-surface-2 text-muted"
                : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            }`}
          >
            {p.confidence === "stated" ? "stated by a source" : "derived from comparables"}
          </span>
        </div>

        {p.marketValue !== null && (
          <p className="mt-4 text-3xl font-semibold tabular-nums">{money(p.marketValue)}</p>
        )}
        <p className="mt-1 text-sm text-muted">
          Estimated market value. This is <strong>not</strong> an assessed value and is not used to
          price a bid.
          {ageHours > 0 && (
            /*
             * A cached answer says how old it is. Serving a fortnight-old
             * valuation without saying so would make the page look live when it
             * is not, and "when was this read" is the first thing a reader needs
             * in order to decide whether to trust it.
             */
            <>
              {" "}
              Read{" "}
              {ageHours < 24
                ? `${ageHours} hour${ageHours === 1 ? "" : "s"} ago`
                : `${Math.floor(ageHours / 24)} day${Math.floor(ageHours / 24) === 1 ? "" : "s"} ago`}
              .
            </>
          )}
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Field label="Type" value={p.propertyType} />
          <Field label="Beds" value={p.beds} />
          <Field label="Baths" value={p.baths} />
          <Field label="Building" value={p.buildingSqft ? `${p.buildingSqft.toLocaleString()} sqft` : null} />
          <Field label="Lot" value={p.lotSqft ? `${p.lotSqft.toLocaleString()} sqft` : null} />
          <Field label="Year built" value={p.yearBuilt} />
          <Field label="Last sale" value={money(p.lastSaleAmount)} />
          <Field label="Sale date" value={p.lastSaleDate} />
          <Field label="Status" value={p.status} />
          <Field label="Owner" value={p.ownerName} />
        </dl>

        {p.features.length > 0 && (
          <div className="mt-5">
            <dt className="text-xs uppercase tracking-wide text-faint">Features</dt>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {p.features.slice(0, 12).map((f) => (
                <li key={f} className="rounded bg-surface-2 px-2 py-0.5 text-sm">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        {p.neighborhood && (
          <div className="mt-5">
            <dt className="text-xs uppercase tracking-wide text-faint">Neighbourhood</dt>
            <p className="mt-1 text-sm leading-relaxed">{p.neighborhood}</p>
          </div>
        )}

        {p.comparables && (
          <div className="mt-5">
            <dt className="text-xs uppercase tracking-wide text-faint">Comparable sales</dt>
            <p className="mt-1 text-sm leading-relaxed">{p.comparables}</p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface p-5">
        <h3 className="text-sm font-semibold">What was read</h3>
        <p className="mt-2 text-sm text-muted">{p.basis}</p>
        {citations.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {citations.slice(0, 8).map((c) => (
              <li key={c.url}>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline underline-offset-2 hover:opacity-80"
                >
                  {c.title ?? new URL(c.url).hostname}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
       * Said plainly rather than buried. A reader who arrived from the max-bid
       * copy on the home page could reasonably assume this figure feeds a bid,
       * and it does not — the pricing engine takes county assessor data, and a
       * searched estimate is explicitly barred from the assessed-value path
       * because it would be divided by the assessment ratio and inflated.
       */}
      <p className="text-xs leading-relaxed text-muted">
        Figures come from public web sources read at the time of the search, not from a licensed
        data provider, and are an as-is estimate rather than an after-repair value. Verify against
        the county record before bidding.
      </p>
    </div>
  );
}

/**
 * Reads the query and decides what to render.
 *
 * Separate from the page component because `searchParams` is request data, and
 * under `cacheComponents` awaiting it at the top level opts the whole route out
 * of prerendering — the build fails with "Uncached data was accessed outside of
 * <Suspense>", which is the correct complaint: the heading, the nav and the
 * search form do not depend on the query, so none of them should wait for it.
 *
 * The admin console's `Gate` has exactly this shape for exactly this reason.
 */
async function Lookup({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  if (!query) {
    return <p className="text-sm text-muted">Enter an address above to look up a property.</p>;
  }
  return <Result q={query} />;
}

/*
 * `searchParams` typed directly rather than via `PageProps<"/property">`.
 * Next generates route-literal types at build time, so a route added in this
 * change does not exist in the union until after a build — typechecking a new
 * page against it fails on a first run and passes on the second, which is a
 * trap for whoever adds the next page.
 */
export default function PropertyPage(props: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <nav className="text-sm text-muted">
        <Link href="/" className="underline hover:text-foreground">
          Home
        </Link>{" "}
        / Property lookup
      </nav>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Property lookup</h1>
      <PropertySearch />

      <div className="mt-8">
        <Suspense fallback={<Skeleton />}>
          <Lookup searchParams={props.searchParams} />
        </Suspense>
      </div>
    </div>
  );
}
