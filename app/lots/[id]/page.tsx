import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCachedBrief, getLot } from "@/lib/queries";
import { computeMaxBid } from "@/lib/deal/maxbid";
import { briefInputsHash } from "@/lib/ai/brief";
import { money, num, relativeDays, saleDate } from "@/lib/format";
import { Breadcrumbs, Callout, Card, SaleTypeBadge, StatusBadge } from "@/components/ui";
import { DealCalculator } from "@/components/deal-calculator";
import { ParcelBrief } from "@/components/parcel-brief";
import { HistoricalComps } from "@/components/historical-comps";
import { resolveCountyRule, countySlug, stateSlug, STATE_NAMES } from "@/lib/atlas";
import type { SaleType } from "@/lib/atlas/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/lots/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const row = await getLot(id);
  if (!row) return { title: "Lot not found" };
  const label = row.lot.addressLine ?? row.lot.parcelNumber ?? "Parcel";
  return { title: `${label} — ${row.county.name} County, ${row.county.state}` };
}

export default async function LotPage(props: PageProps<"/lots/[id]">) {
  const { id } = await props.params;
  const row = await getLot(id);
  if (!row) notFound();

  const { lot, auction, county } = row;
  const rule = resolveCountyRule(county.fips);

  const openingBid = lot.openingBid === null ? undefined : Number(lot.openingBid);
  const assessedValue = lot.assessedValue === null ? undefined : Number(lot.assessedValue);

  // Look for a brief already generated under the default assumptions — the
  // same inputs the "Generate brief" button posts — so a reload shows the
  // stored result instead of asking the user to buy it twice.
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

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs
        items={[
          { href: "/auctions", label: "Auctions" },
          { href: `/auctions/${auction.id}`, label: `${county.name} County · ${saleDate(auction.saleDate)}` },
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
                .join(", ")}
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

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* --- Deal analysis (the point of the page) --------------------- */}
        <section>
          <h2 className="mb-3 text-lg font-semibold">Deal analysis</h2>
          <DealCalculator
            state={county.state}
            saleType={auction.saleType as SaleType}
            openingBid={openingBid}
            assessedValue={assessedValue}
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

        {/* --- Parcel facts and jurisdiction ----------------------------- */}
        <aside className="space-y-4">
          <Card>
            <h3 className="mb-3 text-sm font-semibold">Parcel</h3>
            <dl className="space-y-2 text-sm">
              <Row label="Parcel number" value={lot.parcelNumber} mono />
              <Row label="Case number" value={lot.caseNumber} mono />
              <Row label="Opening bid" value={money(openingBid)} />
              <Row label="Assessed value" value={money(assessedValue)} />
              <Row label="Taxes owed" value={money(lot.taxesOwed)} />
              <Row label="Land use" value={lot.landUse} />
              <Row label="Acreage" value={lot.acreage ? num(lot.acreage) : null} />
              <Row
                label="Building"
                value={lot.buildingSqft ? `${num(lot.buildingSqft)} sqft` : null}
              />
              <Row label="Year built" value={lot.yearBuilt ? String(lot.yearBuilt) : null} />
              <Row label="Owner of record" value={lot.ownerName} />
            </dl>
            {lot.legalDescription ? (
              <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted">
                {lot.legalDescription}
              </p>
            ) : null}
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
