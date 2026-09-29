import type { ReactNode } from "react";
import type { SearchedProperty } from "@/lib/property/providers/websearch";
import type { ReapiExtras } from "@/lib/property/address-lookup";
import { ParcelImagery } from "./parcel-imagery";

/**
 * One property lookup, rendered.
 *
 * Deliberately a plain synchronous component taking data as props, so the same
 * markup serves a server render and the inline client panel on the home page.
 * The lookup itself is a server action; this only draws the answer.
 *
 * ## Why this is one card, not a stack
 *
 * It used to render as three cream cards inside the hero's ~34rem lookup
 * column: figures, then a 520×340 aerial, then sources. The aerial sat in that
 * narrow track as a tall empty beige box while USGS loaded, and every field
 * wrapped. A listing card — address and price, a spec strip, the photograph
 * beside the remaining facts — is how this information is actually read.
 */

export interface ResultProps {
  data: SearchedProperty;
  citations: { url: string; title: string | null }[];
  /** Hours since this answer was read, when it came from the cache. */
  ageHours?: number;
  /** Resolved by the geocoder, not stated by a source. Absent when unplaceable. */
  location?: { lat: number; lon: number; matched: string };
  /** Which source answered: a county record through RealEstateAPI, or a web search. */
  source?: "realestateapi" | "web";
  /** Figures only a record carries. */
  extras?: ReapiExtras;
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

function SpecStrip({ p }: { p: SearchedProperty }) {
  const specs: { key: string; node: ReactNode }[] = [];
  if (p.beds != null) {
    specs.push({
      key: "beds",
      node: (
        <>
          <strong className="font-semibold">{p.beds}</strong> beds
        </>
      ),
    });
  }
  if (p.baths != null) {
    specs.push({
      key: "baths",
      node: (
        <>
          <strong className="font-semibold">{p.baths}</strong> baths
        </>
      ),
    });
  }
  if (p.buildingSqft) {
    specs.push({
      key: "size",
      node: (
        <>
          <strong className="tnum font-semibold">{p.buildingSqft.toLocaleString()}</strong> sqft
        </>
      ),
    });
  }
  if (p.lotSqft) {
    specs.push({
      key: "lot",
      node: (
        <>
          <strong className="tnum font-semibold">{p.lotSqft.toLocaleString()}</strong> sqft lot
        </>
      ),
    });
  }
  if (p.yearBuilt) {
    specs.push({
      key: "year",
      node: (
        <>
          Built <strong className="tnum font-semibold">{p.yearBuilt}</strong>
        </>
      ),
    });
  }

  if (specs.length === 0) return null;

  return (
    <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-border py-4 text-lg text-foreground">
      {specs.map((s, i) => (
        <span key={s.key} className="inline-flex items-center gap-3">
          {i > 0 ? (
            <span aria-hidden className="text-muted">
              ·
            </span>
          ) : null}
          {s.node}
        </span>
      ))}
    </p>
  );
}

const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? null : b ? "Yes" : "No");

function Remaining({ p, extras }: { p: SearchedProperty; extras?: ReapiExtras }) {
  return (
    <div className="min-w-0 flex-1">
      <dl className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
        {extras ? (
          <>
            <Field label="Assessed value" value={money(extras.assessedValue)} />
            <Field
              label="Estimated equity"
              value={
                extras.estimatedEquity !== null
                  ? `${money(extras.estimatedEquity)}${extras.equityPercent !== null ? ` (${extras.equityPercent}%)` : ""}`
                  : null
              }
            />
            <Field
              label="Open mortgage"
              value={extras.openMortgageBalance !== null ? (money(extras.openMortgageBalance) ?? "$0") : null}
            />
            <Field label="Owner occupied" value={yesNo(extras.ownerOccupied)} />
            <Field label="Absentee owner" value={yesNo(extras.absenteeOwner)} />
            <Field label="Tax delinquent since" value={extras.taxDelinquentYear} />
            <Field label="Parcel number" value={extras.apn} />
            <Field label="County" value={extras.county} />
          </>
        ) : null}
        <Field label="Type" value={p.propertyType} />
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
          <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Features</p>
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
          <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Neighbourhood</p>
          <p className="mt-1.5 text-base leading-relaxed text-foreground">{p.neighborhood}</p>
        </div>
      )}

      {p.comparables && (
        <div className="mt-6">
          <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Comparable sales</p>
          <p className="mt-1.5 text-base leading-relaxed text-foreground">{p.comparables}</p>
        </div>
      )}
    </div>
  );
}

function Listing({
  p,
  location,
  caption,
  extras,
}: {
  p: SearchedProperty;
  location?: ResultProps["location"];
  caption?: string | null;
  extras?: ReapiExtras;
}) {
  return (
    <div className="mt-6 flex flex-col gap-8 lg:flex-row lg:items-start">
      {/*
        Not wrapped. ParcelImagery renders nothing without coordinates, and a
        wrapper would leave a 520px empty column in the flex row when it does.
      */}
      <ParcelImagery
        latitude={location?.lat}
        longitude={location?.lon}
        caption={caption}
      />
      <Remaining p={p} extras={extras} />
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <article className="w-full min-w-0 rounded-3xl border border-border bg-surface p-[clamp(1.35rem,2vw,2.25rem)] text-foreground shadow-[var(--shadow-sm)]">
      {children}
    </article>
  );
}

export function PropertyResult({
  data: p,
  citations,
  ageHours = 0,
  location,
  source = "web",
  extras,
}: ResultProps) {
  const fromRecord = source === "realestateapi";
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
        <Card>
          <h3 className="font-display text-2xl font-medium">No record found for that address</h3>
          <p className="mt-2 text-base text-muted">{p.basis}</p>
        </Card>
      );
    }

    return (
      <Card>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
          <h3 className="min-w-0 font-display text-2xl font-medium tracking-tight">
            {p.closestMatch ? "Closest match" : "What was found"}
          </h3>
          <span className="self-start rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            not the exact address
          </span>
        </div>
        {p.closestMatch && <p className="mt-3 text-lg leading-relaxed">{p.closestMatch}</p>}
        <SpecStrip p={p} />
        <Listing p={p} location={location} caption={location?.matched} />

        <div className="mt-8 border-t border-border pt-6">
          <h4 className="font-display text-lg font-medium">Why this is not the exact property</h4>
          <p className="mt-2 text-base leading-relaxed text-muted">{p.basis}</p>
          <Sources citations={citations} />
        </div>

        <p className="mt-6 text-sm leading-relaxed text-muted">
          No value is shown for the address you entered, because it was not identified. The figures
          above describe the closest match and are context, not a valuation of your property.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <h3 className="min-w-0 font-display text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
          {p.addressLine ?? "This property"}
          {p.city ? `, ${p.city}` : ""} {p.zip ?? ""}
        </h3>
        <span
          className={`self-start rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${
            p.confidence === "stated"
              ? "bg-surface-2 text-muted"
              : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          }`}
        >
          {fromRecord
            ? "county record"
            : p.confidence === "stated"
              ? "stated by a source"
              : "derived from comparables"}
        </span>
      </div>

      {p.marketValue !== null && (
        <p className="tnum font-display mt-4 text-4xl font-medium text-foreground sm:text-5xl">
          {money(p.marketValue)}
        </p>
      )}
      <p className="mt-2 max-w-[62ch] text-base leading-relaxed text-muted">
        Estimated market value{fromRecord ? " from RealEstateAPI's valuation model" : ""}. This is{" "}
        <strong className="text-foreground">not</strong> an assessed value and is not used to price
        a bid.
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

      <SpecStrip p={p} />
      <Listing
        p={p}
        location={location}
        caption={location?.matched ?? p.addressLine}
        extras={extras}
      />

      <div className="mt-8 border-t border-border pt-6">
        <h4 className="font-display text-lg font-medium text-foreground">
          {fromRecord ? "Source" : "What was read"}
        </h4>
        <p className="mt-2 text-base leading-relaxed text-foreground">{p.basis}</p>
        <Sources citations={citations} />
      </div>

      <p className="mt-6 text-sm leading-relaxed text-muted">
        {fromRecord
          ? "Figures come from the county assessor record and RealEstateAPI's valuation model, not an appraisal, and the value is an as-is estimate rather than an after-repair value. Equity and mortgage are modelled from recorded loans. Verify against the county record before bidding."
          : "Figures come from public web sources read at the time of the search, not from a licensed data provider, and are an as-is estimate rather than an after-repair value. Verify against the county record before bidding."}
      </p>
    </Card>
  );
}
