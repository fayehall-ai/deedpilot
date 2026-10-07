import type { ReactNode } from "react";
import type { SearchedProperty } from "@/lib/property/providers/websearch";
import type { ReapiExtras } from "@/lib/property/address-lookup";
import type { PropertyView } from "@/lib/property/reapi-view";
import { StreetViewFrame } from "./street-view-frame";
import { PropertyDetailTabs, PropertySummary } from "./property-card";

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
  /** Hours since this answer was read, when it came from the cache. */
  ageHours?: number;
  /** Figures only a record carries. */
  extras?: ReapiExtras;
  /** Google's photograph of the front, when the lookup found one. */
  streetView?: { location: string; date: string | null };
  /** The parcel page's card, when the lookup kept the full record. */
  view?: PropertyView;
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
  extras,
  streetView,
}: {
  p: SearchedProperty;
  extras?: ReapiExtras;
  streetView?: ResultProps["streetView"];
}) {
  return (
    <div className="mt-6 flex flex-col gap-8 lg:flex-row lg:items-start">
      {/*
        The front of the house and nothing else — the lookup shows Street View
        only. Absent where Google has no photograph, and the facts take the row.
      */}
      {streetView ? (
        <div className="w-full lg:w-[min(28rem,45%)] lg:shrink-0">
          <StreetViewFrame
            src={`/api/streetview?${new URLSearchParams({ location: streetView.location })}`}
            label={streetView.location}
            mapsQuery={streetView.location}
            date={streetView.date}
          />
        </div>
      ) : null}
      <Remaining p={p} extras={extras} />
    </div>
  );
}

function Card({ children, tight = false }: { children: ReactNode; tight?: boolean }) {
  return (
    <article
      className={`w-full min-w-0 rounded-3xl border border-border bg-surface text-foreground shadow-[var(--shadow-sm)] ${
        // The four-card strip needs the width the listing card spent on padding.
        tight ? "p-3 sm:p-4" : "p-[clamp(1.35rem,2vw,2.25rem)]"
      }`}
    >
      {children}
    </article>
  );
}

/**
 * A RealEstateAPI property record — the only source the lookup uses now. There
 * is no "closest match" or "what was read" section: those described the web
 * search, which returned other properties' figures and cited the pages it read.
 */
export function PropertyResult({ data: p, ageHours = 0, extras, streetView, view }: ResultProps) {
  /*
   * The parcel page's layout, so an address looked up on the home page reads
   * exactly like a parcel in a sale: the four-card strip, then the tabs.
   */
  if (view) {
    return (
      <Card tight>
        <div className="flex flex-col gap-2 px-2 pt-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
          <h3 className="min-w-0 font-display text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            {p.addressLine ?? "This property"}
            {p.city ? `, ${p.city}` : ""} {p.zip ?? ""}
          </h3>
          <span className="self-start rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted">
            county record{ageHours > 0 ? ` · read ${ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d`} ago` : ""}
          </span>
        </div>
        <div className="mt-6">
          <PropertySummary
            view={view}
            photo={
              streetView ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/streetview?${new URLSearchParams({ location: streetView.location })}`}
                  alt={`Street view of ${streetView.location}`}
                  width={640}
                  height={480}
                  loading="lazy"
                  decoding="async"
                  className="block aspect-[4/3] w-full rounded-xl bg-surface-2 object-cover"
                />
              ) : null
            }
          />
        </div>
        <div className="mt-6">
          <PropertyDetailTabs view={view} />
        </div>
        <p className="mx-2 mt-8 mb-2 border-t border-border pt-6 text-sm leading-relaxed text-muted">
          Figures come from the county assessor record and RealEstateAPI&apos;s valuation model, not
          an appraisal; the estimated value is as-is, not after-repair, and is not used to price a
          bid. Equity and mortgage are modelled from recorded loans. Verify against the county
          record before bidding.
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
        <span className="self-start rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted">
          county record
        </span>
      </div>

      {p.marketValue !== null && (
        <>
          <p className="tnum font-display mt-4 text-4xl font-medium text-foreground sm:text-5xl">
            {money(p.marketValue)}
          </p>
          <p className="mt-2 max-w-[62ch] text-base leading-relaxed text-muted">
            Estimated market value from RealEstateAPI&apos;s valuation model. This is{" "}
            <strong className="text-foreground">not</strong> an assessed value and is not used to
            price a bid.
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
        </>
      )}

      <SpecStrip p={p} />
      <Listing p={p} extras={extras} streetView={streetView} />

      <p className="mt-8 border-t border-border pt-6 text-sm leading-relaxed text-muted">
        Figures come from the county assessor record and RealEstateAPI&apos;s valuation model, not
        an appraisal, and the value is an as-is estimate rather than an after-repair value. Equity
        and mortgage are modelled from recorded loans. Verify against the county record before
        bidding.
      </p>
    </Card>
  );
}
