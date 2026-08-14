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

async function Result({ q }: { q: string }) {
  const { lookupAddress } = await import("@/lib/property/providers/websearch");

  let data: Awaited<ReturnType<typeof lookupAddress>>;
  try {
    data = await lookupAddress(q);
  } catch (e) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
        <p className="font-medium">That search could not run.</p>
        <p className="mt-1 text-sm text-muted">{e instanceof Error ? e.message : String(e)}</p>
      </div>
    );
  }

  const { data: p, citations } = data;

  if (!p.found || p.confidence === "none") {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">No record found for that address</h2>
        <p className="mt-2 text-sm text-muted">{p.basis}</p>
        <p className="mt-3 text-sm text-muted">
          Nothing was found that describes this exact property. A nearby or similar property is
          not shown in its place — a valuation for the wrong parcel is worse than none.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {p.addressLine ?? q}
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
          <Field label="Owner" value={p.ownerName} />
        </dl>
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
