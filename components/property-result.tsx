import type { SearchedProperty } from "@/lib/property/providers/websearch";
import { ParcelImagery } from "./parcel-imagery";

/**
 * One property lookup, rendered.
 *
 * Deliberately a plain synchronous component taking data as props, so the same
 * markup serves a server render and the inline client panel on the home page.
 * The lookup itself is a server action; this only draws the answer.
 */

export interface ResultProps {
  data: SearchedProperty;
  citations: { url: string; title: string | null }[];
  /** Hours since this answer was read, when it came from the cache. */
  ageHours?: number;
  /** Resolved by the geocoder, not stated by a source. Absent when unplaceable. */
  location?: { lat: number; lon: number; matched: string };
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? null : `$${Math.round(n).toLocaleString()}`;

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-sm font-medium uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="tnum mt-1 text-lg font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Sources({ citations }: { citations: ResultProps["citations"] }) {
  if (citations.length === 0) return null;
  return (
    <ul className="mt-4 space-y-2 text-base">
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
  );
}

function Detail({ p }: { p: SearchedProperty }) {
  return (
    <>
      {/*
        Two columns, not four. This panel sits in the hero's lookup column —
        about 400px — and four fields across made every value wrap or shrink
        to the faint inherited ink-fg of the navy band behind it.
      */}
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5">
        <Field label="Type" value={p.propertyType} />
        <Field label="Beds" value={p.beds} />
        <Field label="Baths" value={p.baths} />
        <Field label="Size" value={p.buildingSqft ? `${p.buildingSqft.toLocaleString()} sqft` : null} />
        <Field label="Lot" value={p.lotSqft ? `${p.lotSqft.toLocaleString()} sqft` : null} />
        <Field label="Year built" value={p.yearBuilt} />
        <Field label="Status" value={p.status} />
        <Field label="Last sale" value={money(p.lastSaleAmount)} />
        <Field label="Sale date" value={p.lastSaleDate} />
        <Field label="Owner" value={p.ownerName} />
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
        <div className="mt-6">
          <dt className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Features</dt>
          <ul className="mt-2 flex flex-wrap gap-2">
            {p.features.slice(0, 12).map((f) => (
              <li key={f} className="rounded-full bg-surface-2 px-3 py-1 text-base text-foreground">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.neighborhood && (
        <div className="mt-6">
          <dt className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Neighbourhood</dt>
          <p className="mt-1.5 text-base leading-relaxed text-foreground">{p.neighborhood}</p>
        </div>
      )}

      {p.comparables && (
        <div className="mt-6">
          <dt className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Comparable sales</dt>
          <p className="mt-1.5 text-base leading-relaxed text-foreground">{p.comparables}</p>
        </div>
      )}
    </>
  );
}

export function PropertyResult({ data: p, citations, ageHours = 0, location }: ResultProps) {
  const exact = p.found && p.confidence !== "none";

  /*
   * Not the exact property.
   *
   * The valuation is withheld — no price on a property that was not identified —
   * but everything genuinely known is shown, labelled as describing the closest
   * match rather than the address that was typed.
   */
  if (!exact) {
    const hasContext =
      p.closestMatch || p.propertyType || p.neighborhood || p.features.length > 0 || p.comparables;

    if (!hasContext) {
      return (
        <div className="rounded-3xl border border-border bg-surface p-6 text-foreground">
          <h3 className="font-display text-xl font-medium">No record found for that address</h3>
          <p className="mt-2 text-base text-muted">{p.basis}</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-3xl border border-border bg-surface p-6 text-foreground">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-display text-xl font-medium tracking-tight">
              {p.closestMatch ? "Closest match" : "What was found"}
            </h3>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              not the exact address
            </span>
          </div>
          {p.closestMatch && <p className="mt-3 text-lg leading-relaxed">{p.closestMatch}</p>}
          <Detail p={p} />
        </div>

        {/*
          Shown even here, because the coordinates came from the geocoder
          placing the address that was typed — not from the closest match. The
          picture is of the right place even when the valuation is not.
        */}
        <ParcelImagery
          latitude={location?.lat}
          longitude={location?.lon}
          caption={location?.matched}
        />

        <div className="rounded-3xl border border-border bg-surface p-6 text-foreground">
          <h4 className="font-display text-lg font-medium">Why this is not the exact property</h4>
          <p className="mt-2 text-base leading-relaxed text-muted">{p.basis}</p>
          <Sources citations={citations} />
        </div>

        <p className="text-sm leading-relaxed text-ink-muted">
          No value is shown for the address you entered, because it was not identified. The figures
          above describe the closest match and are context, not a valuation of your property.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-border bg-surface p-6 text-foreground">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="font-display text-xl font-medium tracking-tight text-foreground">
            {p.addressLine ?? "This property"}
            {p.city ? `, ${p.city}` : ""} {p.zip ?? ""}
          </h3>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${
              p.confidence === "stated"
                ? "bg-surface-2 text-muted"
                : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            }`}
          >
            {p.confidence === "stated" ? "stated by a source" : "derived from comparables"}
          </span>
        </div>

        {p.marketValue !== null && (
          <p className="tnum font-display mt-5 text-4xl font-medium text-foreground">
            {money(p.marketValue)}
          </p>
        )}
        <p className="mt-2 text-base leading-relaxed text-muted">
          Estimated market value. This is <strong className="text-foreground">not</strong> an
          assessed value and is not used to price a bid.
          {ageHours > 0 && (
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

        <Detail p={p} />
      </div>

      {/*
        Placed after the figures rather than above them.

        The number is what was asked for; the picture is what makes it mean
        something. Leading with the image would also imply the search returned
        a photograph, when what it returned is a valuation and the photograph
        comes from a separate, federal source.
      */}
      <ParcelImagery
        latitude={location?.lat}
        longitude={location?.lon}
        caption={location?.matched ?? p.addressLine}
      />

      <div className="rounded-3xl border border-border bg-surface p-6 text-foreground">
        <h4 className="font-display text-lg font-medium text-foreground">What was read</h4>
        <p className="mt-2 text-base leading-relaxed text-foreground">{p.basis}</p>
        <Sources citations={citations} />
      </div>

      <p className="text-sm leading-relaxed text-ink-muted">
        Figures come from public web sources read at the time of the search, not from a licensed
        data provider, and are an as-is estimate rather than an after-repair value. Verify against
        the county record before bidding.
      </p>
    </div>
  );
}
