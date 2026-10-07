import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCachedBrief, getLot, getLotValuations } from "@/lib/queries";
import { computeMaxBid } from "@/lib/deal/maxbid";
import { briefInputsHash } from "@/lib/ai/brief";
import { money, relativeDays, saleDate } from "@/lib/format";
import { Breadcrumbs, Callout, Card, SaleTypeBadge, StatusBadge } from "@/components/ui";
import { DetailSkeleton } from "@/components/skeleton";
import { DealCalculator } from "@/components/deal-calculator";
import { ParcelBrief } from "@/components/parcel-brief";
import { HistoricalComps } from "@/components/historical-comps";
import { PropertyDetail } from "@/components/property-detail";
import { PropertyDetailTabs, PropertySummary } from "@/components/property-card";
import { buildPropertyView } from "@/lib/property/reapi-view";
import { taxYearFromRaw } from "@/lib/lots/tax-year";
import { StreetViewThumb } from "@/components/street-view";
import { streetViewLocation } from "@/lib/property/streetview";
import { SiteIntel } from "@/components/site-intel";
import { resolveCountyRule, countySlug, stateSlug, STATE_NAMES } from "@/lib/atlas";
import { getComparables } from "@/lib/history/comparables";
import { assessorLinks } from "@/lib/property/assessor-links";
import { mergeValuations, provenanceLabel } from "@/lib/property/merge";
import { intelSourcesChecked, signalsForLot } from "@/lib/property/signals/store";
import type { SaleType } from "@/lib/atlas/types";


export async function generateMetadata(props: PageProps<"/lots/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const row = await getLot(id);
  if (!row) return { title: "Parcel not found" };
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
  /*
   * Site intel is read, never fetched, on the request path. Overpass takes
   * tens of seconds per parcel and is regularly rate-limited; the background
   * worker owns that latency so the page never does. A parcel the loop has not
   * reached yet renders no section at all rather than a spinner over an
   * upstream nobody controls.
   */
  const siteSignals = await signalsForLot(lot.id);
  const checkedIntelSources = await intelSourcesChecked(lot.id);
  /*
   * Merged across providers, not `valuations[0]`. Providers differ in coverage
   * more than in value — RentCast returns a market estimate and little else,
   * ATTOM returns the whole assessment — so taking only the newest row let a
   * thin recent answer erase a rich older one. See lib/property/merge.ts.
   */
  const latestVal = mergeValuations(valuations);
  /*
   * `raw` stays the fallback for rows written before beds/baths/lot size had
   * columns. Reading the column first and the blob second means the page
   * improves as rows are re-enriched, without a backfill being a precondition
   * for showing anything.
   */
  const valRaw = (valuations[0]?.raw ?? {}) as Record<string, unknown>;
  /*
   * ATTOM's payload specifically, for the full-record panel. Picked by source
   * rather than by recency: it is the provider that returns the 179-field
   * profile, and a newer RentCast row carrying a market estimate and little
   * else would otherwise blank the whole panel.
   */
  const attomRaw = (valuations.find((v) => v.source === "attom")?.raw ?? null) as
    | Record<string, unknown>
    | null;
  /*
   * RealEstateAPI's PropertyDetail payload — mortgage, sale and foreclosure
   * history, tax and lot detail, schools, fair-market rents — drawn in full.
   */
  const reapiRaw = (valuations.find((v) => v.source === "realestateapi")?.raw ?? null) as
    | Record<string, unknown>
    | null;
  const beds = latestVal?.beds ?? (typeof valRaw.beds === "number" ? valRaw.beds : null);
  const baths =
    latestVal?.baths !== null && latestVal?.baths !== undefined
      ? Number(latestVal.baths)
      : typeof valRaw.baths === "number"
        ? valRaw.baths
        : null;
  const propertyType =
    latestVal?.propertyType ??
    (typeof valRaw.propertyType === "string" ? valRaw.propertyType : null);
  const rule = resolveCountyRule(county.fips);

  const openingBid = lot.openingBid === null ? undefined : Number(lot.openingBid);
  const assessedValue = lot.assessedValue === null ? undefined : Number(lot.assessedValue);
  /*
   * The merged provider market estimate, fed to the max-bid engine as an ARV
   * source. 789 upcoming parcels carry one and none of them reached the engine
   * before — 779 of those sit in states with no assessment ratio, so they
   * returned insufficient-data while a paid-for valuation sat in the database.
   */
  const marketValue =
    latestVal?.marketValue === null || latestVal?.marketValue === undefined
      ? undefined
      : Number(latestVal.marketValue);

  /*
   * One object, two consumers. The cached-brief hash and the visible calculator
   * both price this parcel, and they drifted: `marketValue` was threaded into
   * the server-side computeMaxBid but the DealCalculator JSX never got the
   * prop, so the number on screen fell through to an assumed floor while a
   * $137,500 AVM sat in the card directly above it. Spreading one object into
   * both makes that divergence a type error instead of a silent disagreement.
   */
  const dealInputs = {
    state: county.state,
    saleType: auction.saleType as SaleType,
    openingBid,
    assessedValue,
    marketValue,
    fips: county.fips,
  };

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
          deal: computeMaxBid(dealInputs),
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

  const numOrNull = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === "" ? null : Number(v);
  const view = buildPropertyView(reapiRaw, {
    parcelNumber: lot.parcelNumber,
    ownerName: lot.ownerName,
    countyName: county.name,
    beds,
    baths,
    buildingSqft: lot.buildingSqft ?? latestVal?.buildingSqft ?? null,
    lotSqft: latestVal?.lotSqft ?? null,
    acreage: numOrNull(lot.acreage),
    yearBuilt: lot.yearBuilt ?? latestVal?.yearBuilt ?? null,
    landUse: lot.landUse,
    propertyType,
    legalDescription: lot.legalDescription,
    assessedValue: assessedValue ?? null,
    assessedLand: numOrNull(latestVal?.assessedLand),
    assessedImprovement: numOrNull(latestVal?.assessedImprovement),
    marketValue: marketValue ?? null,
    lastSaleAmount: numOrNull(latestVal?.lastSaleAmount),
    lastSaleDate: latestVal?.lastSaleDate ?? null,
    openingBid: openingBid ?? null,
    taxesOwed: numOrNull(lot.taxesOwed),
    taxesOwedYear: taxYearFromRaw(lot.raw)?.label ?? null,
  });

  return (
    <div className="shell py-band">
      <Breadcrumbs
        items={[
          { href: "/auctions", label: "Auctions" },
          {
            href: `/auctions/${auction.id}`,
            label: `${county.name} County · ${saleDate(auction.saleDate)}`,
          },
          { label: lot.parcelNumber ?? "Parcel" },
        ]}
      />

      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-section font-semibold">
              {lot.addressLine ?? lot.parcelNumber ?? "Unaddressed parcel"}
            </h1>
            <p className="mt-1 text-base text-muted">
              {[lot.city, STATE_NAMES[county.state] ?? county.state, lot.zip]
                .filter(Boolean)
                .join(", ") || `${county.name} County, ${county.state}`}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SaleTypeBadge type={auction.saleType} />
              <StatusBadge status={lot.status} />
              <span className="text-sm text-muted">
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

      {/*
        Property first, in the wide column; the deal tools to the right.
        This page used to open with the max-bid calculator and push the parcel
        itself into a 380px sidebar — which asks the reader to price a thing
        before showing them what it is. The property card is the subject of the
        page, so it gets the width, the top, and the type scale; the calculator
        and the brief are what you do *about* it, and they sit alongside where
        both stay visible while you read.
      */}
      {/*
        minmax(0, 1fr), not 1fr: a plain 1fr column will not shrink below its
        content, and the property-detail history tables (up to 17 unwrapped
        columns) widened it to 2,700px, pushing the deal column off-screen.
      */}
      {/*
        PropStream's layout, because that is where bidders learned to read a
        property: four summary cards across the top, then the record in tabs.
        Full width, above the deal column, so the strip reads as one row.
      */}
      <div className="mb-6">
        <PropertySummary
          view={view}
          photo={
            <Suspense fallback={null}>
              <StreetViewThumb
                lotId={lot.id}
                location={streetViewLocation({ ...lot, state: county.state })}
              />
            </Suspense>
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-6">
          <Card>
            {/*
              The four figures a bid turns on, at a size you can read across the
              room. Opening bid and taxes owed are what you pay; assessed and
              market are what the county and the market think it is worth.
            */}
            <div className="grid grid-cols-2 gap-4 border-b border-border pb-4 sm:grid-cols-4">
              <Figure label="Opening bid" value={money(openingBid)} />
              <Figure label="Assessed value" value={money(assessedValue)}>
                {/*
                  The split, under the total it adds up to. Land and improvement
                  say what is actually being bought: $27,500 that is $9,000 land
                  and $18,500 structure is a house, and the same total as bare
                  land is not. Absent components are omitted rather than drawn
                  as $0, which would assert there is no structure.
                */}
                {latestVal?.assessedLand || latestVal?.assessedImprovement ? (
                  <>
                    {latestVal.assessedLand ? (
                      <span className="block">Land {money(latestVal.assessedLand)}</span>
                    ) : null}
                    {latestVal.assessedImprovement ? (
                      <span className="block">
                        Improvement {money(latestVal.assessedImprovement)}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </Figure>
              <Figure label="Market / AVM" value={money(latestVal?.marketValue)} />
              {/*
                The sale list's amount owed when it has one; otherwise the
                year's tax bill from the property record, labelled as the bill
                it is. Most lists publish no amount, and a bare "—" here read
                as if the parcel owed nothing.
              */}
              {lot.taxesOwed || !view.propertyTax ? (
                <Figure label="Taxes owed" value={money(lot.taxesOwed)}>
                  {view.taxesOwedPeriod}
                </Figure>
              ) : (
                <Figure
                  label={`Property tax${view.propertyTax.year ? ` ${view.propertyTax.year}` : ""}`}
                  value={money(view.propertyTax.amount)}
                >
                  Annual bill — the sale list gives no amount owed
                </Figure>
              )}
            </div>

            {/*
              The parcel's characteristics now live in the PropStream-style tabs
              below; this card keeps only what the auction itself decides.
            */}
            {lot.caseNumber ? (
              <p className="mt-3 text-sm text-muted">
                Case number <span className="font-mono text-xs text-foreground">{lot.caseNumber}</span>
              </p>
            ) : null}

            {/* Provenance stays on the card it describes, not in a footer. */}
            {latestVal ? (
              <p className="mt-3 text-xs text-muted">
                Property facts enriched via {provenanceLabel(latestVal)}
                {latestVal.fetchedAt
                  ? ` · ${new Date(latestVal.fetchedAt).toLocaleDateString()}`
                  : ""}
              </p>
            ) : null}
          </Card>

          <PropertyDetailTabs view={view} />

          {/*
            What surrounds it, after the record.

            The street photo shows the front of the parcel; this names what is
            next door, measures it and says why it matters. On the Houston test
            parcel that is a Union Pacific mainline at 344 ft, the Wallisville
            substation at 397 ft, and ten industrial parcels — none of which is
            visible in an assessment, a tax notice or a listing feed.
          */}
          <SiteIntel signals={siteSignals} checkedSources={checkedIntelSources} />

          <PropertyDetail raw={attomRaw} />

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
                    <span className="mt-0.5 block font-mono text-xs text-muted">
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
        </section>

        {/*
          The deal column. Sticky on tall screens so the max bid stays on
          screen while the property detail beside it scrolls — the two numbers
          are only useful read against each other.
        */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div>
            <h2 className="mb-3 text-lg font-semibold">Deal analysis</h2>
            <DealCalculator
              {...dealInputs}
              historyBucket={history.bucket}
              historyKey={history.key}
              thinListing={thinListing}
            />
          </div>

          <ParcelBrief
            lotId={lot.id}
            countyName={county.name}
            initialBrief={cached?.brief ?? null}
            initialModel={cached?.model ?? null}
          />

          {/*
            The "Fetch property details" card lived here and has been removed.

            It offered to do, one parcel at a time and on someone else's click,
            what the bulk pipeline already does for a whole county — and it was
            usually disabled anyway, since the page only renders once a lot has
            an address and a value. What it showed most readers was a dead
            button and a sentence about API providers they cannot configure.

            It also fronted an unauthenticated endpoint that spends money. That
            endpoint is now admin-only; see app/api/lots/[id]/enrich/route.ts.
          */}
        </aside>
      </div>
    </div>
  );
}

/**
 * A headline figure: big number, small label, optional detail beneath.
 *
 * Deliberately not a `Row` — these four are the numbers a bid turns on, and
 * they are meant to be read at a glance across the top of the card rather than
 * scanned down a list with everything else.
 */
function Figure({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="tnum mt-0.5 text-xl font-semibold">{value}</p>
      {children ? <div className="tnum mt-1 text-xs text-muted">{children}</div> : null}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  wrap,
  stacked,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
  wrap?: boolean;
  /**
   * Label above value instead of label-left/value-right.
   *
   * The side-by-side form is right in a narrow sidebar, where the gap between
   * the two is small. Dropped into a four-column grid it strands each label at
   * the far left of its cell and each value at the far right, and the reader
   * has to re-pair them by eye across a column of whitespace.
   */
  stacked?: boolean;
}) {
  return (
    <div className={wrap || stacked ? "" : "flex items-baseline justify-between gap-3"}>
      <dt className={`shrink-0 text-muted${stacked ? " text-xs uppercase tracking-wide" : ""}`}>
        {label}
      </dt>
      <dd
        className={`${mono ? "font-mono text-xs" : ""} ${
          wrap ? "mt-0.5 text-xs leading-relaxed" : stacked ? "tnum mt-0.5" : "tnum text-right"
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
