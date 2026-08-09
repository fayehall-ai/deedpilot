import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCachedBrief, getLot, getLotValuations } from "@/lib/queries";
import { computeMaxBid } from "@/lib/deal/maxbid";
import { briefInputsHash } from "@/lib/ai/brief";
import { money, num, relativeDays, saleDate } from "@/lib/format";
import { Breadcrumbs, Callout, Card, SaleTypeBadge, StatusBadge } from "@/components/ui";
import { DetailSkeleton } from "@/components/skeleton";
import { DealCalculator } from "@/components/deal-calculator";
import { ParcelBrief } from "@/components/parcel-brief";
import { HistoricalComps } from "@/components/historical-comps";
import { PropertyEnrichButton } from "@/components/property-enrich-button";
import { resolveCountyRule, countySlug, stateSlug, STATE_NAMES } from "@/lib/atlas";
import { getComparables } from "@/lib/history/comparables";
import { assessorLinks } from "@/lib/property/assessor-links";
import { configuredEnrichmentProviders } from "@/lib/property/enrich";
import type { SaleType } from "@/lib/atlas/types";


export async function generateMetadata(props: PageProps<"/lots/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const row = await getLot(id);
  if (!row) return { title: "Lot not found" };
  const label = row.lot.addressLine ?? row.lot.parcelNumber ?? "Parcel";
  return { title: `${label} — ${row.county.name} County, ${row.county.state}` };
}

/*
 * No `unstable_instant` here on purpose. Validation walks a route using sample
 * params, and this one is keyed on a database UUID — there is no id that is
 * stable enough to pin in source without it going stale the next time the
 * table is rebuilt. The Suspense boundary below is what actually makes the
 * navigation instant; the export would only have added build-time checking.
 */
export default function LotPage(props: PageProps<"/lots/[id]">) {
  return (
    <>
      <Suspense fallback={<DetailSkeleton />}>
        <LotBody {...props} />
      </Suspense>
    </>
  );
}

async function LotBody(props: PageProps<"/lots/[id]">) {
  const { id } = await props.params;
  const row = await getLot(id);
  if (!row) notFound();

  const { lot, auction, county } = row;
  const valuations = await getLotValuations(lot.id);
  const latestVal = valuations[0] ?? null;
  const valRaw = (latestVal?.raw ?? {}) as Record<string, unknown>;
  const beds = typeof valRaw.beds === "number" ? valRaw.beds : null;
  const baths = typeof valRaw.baths === "number" ? valRaw.baths : null;
  const propertyType =
    typeof valRaw.propertyType === "string" ? valRaw.propertyType : null;
  const rule = resolveCountyRule(county.fips);

  const openingBid = lot.openingBid === null ? undefined : Number(lot.openingBid);
  const assessedValue = lot.assessedValue === null ? undefined : Number(lot.assessedValue);

  const history = getComparables({
    state: county.state,
    saleType: auction.saleType,
    assessedValue,
    openingBid,
    fips: county.fips,
    limit: 1,
  });

  const cached = rule
    ? await getCachedBrief(
        lot.id,
        briefInputsHash({
          lot,
          auction,
          rule,
          deal: computeMaxBid({
            state: county.state,
            saleType: auction.saleType as SaleType,
            openingBid,
            assessedValue,
            fips: county.fips,
          }),
        }),
      ).catch(() => null)
    : null;

  const gmaps =
    lot.latitude && lot.longitude
      ? `https://www.google.com/maps/search/?api=1&query=${lot.latitude},${lot.longitude}`
      : lot.addressLine
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            `${lot.addressLine}, ${lot.city ?? ""} ${county.state}`,
          )}`
        : null;

  const external = assessorLinks({
    state: county.state,
    fips: county.fips,
    countyName: county.name,
    parcelNumber: lot.parcelNumber,
  });

  const thinListing = !assessedValue && !lot.addressLine;
  const providers = configuredEnrichmentProviders();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs
        items={[
          { href: "/auctions", label: "Auctions" },
          {
            href: `/auctions/${auction.id}`,
            label: `${county.name} County · ${saleDate(auction.saleDate)}`,
          },
          { label: lot.parcelNumber ?? "Lot" },
        ]}
      />

      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {lot.addressLine ?? lot.parcelNumber ?? "Unaddressed parcel"}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {[lot.city, STATE_NAMES[county.state] ?? county.state, lot.zip]
                .filter(Boolean)
                .join(", ") || `${county.name} County, ${county.state}`}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SaleTypeBadge type={auction.saleType} />
              <StatusBadge status={lot.status} />
              <span className="text-xs text-muted">
                Sells {saleDate(auction.saleDate)} · {relativeDays(auction.saleDate)}
              </span>
            </div>
          </div>

          {gmaps ? (
            <a
              href={gmaps}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-border px-4 py-2 text-sm hover:border-accent"
            >
              View on map ↗
            </a>
          ) : null}
        </div>
      </header>

      {thinListing ? (
        <div className="mb-6">
          <Callout tone="warn" title="Sale list only has parcel # and opening bid">
            The clerk published a thin list — not a PropStream-style property card. Max bid needs
            an after-repair value: enter comps below, open the county appraiser, or fetch details
            if a property API key is configured.
          </Callout>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section>
          <h2 className="mb-3 text-lg font-semibold">Deal analysis</h2>
          <DealCalculator
            state={county.state}
            saleType={auction.saleType as SaleType}
            openingBid={openingBid}
            assessedValue={assessedValue}
            fips={county.fips}
            historyBucket={history.bucket}
            historyKey={history.key}
            thinListing={thinListing}
          />

          <div className="mt-6">
            <ParcelBrief
              lotId={lot.id}
              countyName={county.name}
              initialBrief={cached?.brief ?? null}
              initialModel={cached?.model ?? null}
            />
          </div>
        </section>

        <aside className="space-y-4">
          <Card>
            <h3 className="mb-3 text-sm font-semibold">Parcel</h3>
            <dl className="space-y-2 text-sm">
              <Row label="Parcel number" value={lot.parcelNumber} mono />
              <Row label="Case number" value={lot.caseNumber} mono />
              <Row label="Opening bid" value={money(openingBid)} />
              <Row label="Assessed value" value={money(assessedValue)} />
              {latestVal?.marketValue ? (
                <Row label="Market / AVM" value={money(latestVal.marketValue)} />
              ) : null}
              {latestVal?.lastSaleAmount ? (
                <Row
                  label="Last sale"
                  value={`${money(latestVal.lastSaleAmount)}${
                    latestVal.lastSaleDate ? ` · ${latestVal.lastSaleDate}` : ""
                  }`}
                />
              ) : null}
              <Row label="Taxes owed" value={money(lot.taxesOwed)} />
              <Row label="Land use" value={lot.landUse ?? propertyType} />
              {(beds !== null || baths !== null) && (
                <Row
                  label="Beds / baths"
                  value={[
                    beds !== null ? `${beds} bd` : null,
                    baths !== null ? `${baths} ba` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              )}
              <Row label="Acreage" value={lot.acreage ? num(lot.acreage) : null} />
              <Row
                label="Building"
                value={lot.buildingSqft ? `${num(lot.buildingSqft)} sqft` : null}
              />
              <Row label="Year built" value={lot.yearBuilt ? String(lot.yearBuilt) : null} />
              <Row label="Owner of record" value={lot.ownerName} />
              {latestVal ? (
                <Row
                  label="Enriched via"
                  value={`${latestVal.source}${
                    latestVal.fetchedAt
                      ? ` · ${new Date(latestVal.fetchedAt).toLocaleDateString()}`
                      : ""
                  }`}
                />
              ) : null}
            </dl>
            {lot.legalDescription ? (
              <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted">
                {lot.legalDescription}
              </p>
            ) : null}
          </Card>

          <Card>
            <h3 className="mb-2 text-sm font-semibold">Property details</h3>
            <p className="mb-3 text-xs leading-relaxed text-muted">
              Pull address, assessed value, and property facts from a commercial property API
              (PropStream-style).{" "}
              {providers.length
                ? `Configured: ${providers.join(", ")}.`
                : "No API key set yet — links below still work."}
            </p>
            <PropertyEnrichButton lotId={lot.id} />
          </Card>

          <Card>
            <h3 className="mb-2 text-sm font-semibold">County records</h3>
            <p className="mb-3 text-xs leading-relaxed text-muted">
              Official appraiser / assessor — free, always available. Copy the parcel number if the
              link opens a search page.
            </p>
            <ul className="space-y-2">
              {external.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-accent hover:underline"
                  >
                    {l.label} ↗
                  </a>
                  {l.searchOnly && lot.parcelNumber ? (
                    <span className="mt-0.5 block font-mono text-[11px] text-muted">
                      search: {lot.parcelNumber}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h3 className="mb-3 text-sm font-semibold">
              {county.name} County rules
            </h3>
            {rule ? (
              <dl className="space-y-2 text-sm">
                <Row label="Sale type" value={rule.type} />
                <Row label="Redemption" value={rule.redemption} wrap />
                <Row label="Return if redeemed" value={rule.returns} wrap />
                <Row label="Statute" value={rule.statute} wrap />
              </dl>
            ) : null}
            <Link
              href={`/atlas/${stateSlug(county.state)}/${countySlug(county.name)}`}
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              Full county profile →
            </Link>
          </Card>

          <HistoricalComps
            state={county.state}
            saleType={auction.saleType}
            assessedValue={assessedValue}
            openingBid={openingBid}
            fips={county.fips}
          />

          {rule?.survivingLiens ? (
            <Callout tone="danger" title="Liens that survive">
              {rule.survivingLiens}
            </Callout>
          ) : null}

          {rule?.quietTitle ? (
            <Callout tone="warn" title="Quiet title">
              {rule.quietTitle}
            </Callout>
          ) : null}

          <Card>
            <h3 className="mb-2 text-sm font-semibold">Verify before you bid</h3>
            <p className="text-xs leading-relaxed text-muted">
              This record was compiled from{" "}
              <a
                href={lot.sourceUrl ?? auction.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                the published sale list
              </a>
              . Parcels are pulled, redeemed, and re-priced up to the moment of sale. Confirm the
              lot is still in the sale, and confirm the opening bid, directly with the county.
            </p>
            {rule?.taxCollector?.url ? (
              <a
                href={rule.taxCollector.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs text-accent hover:underline"
              >
                {rule.taxCollector.label} ↗
              </a>
            ) : null}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className={wrap ? "" : "flex items-baseline justify-between gap-3"}>
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd
        className={`${mono ? "font-mono text-xs" : ""} ${
          wrap ? "mt-0.5 text-xs leading-relaxed" : "tnum text-right"
        }`}
      >
        {value === null || value === undefined || value === "" ? (
          <span className="text-muted">—</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
