import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getAuction, getAuctionLots } from "@/lib/queries";
import { money, num, relativeDays, saleDate } from "@/lib/format";
import {
  Breadcrumbs,
  Callout,
  Card,
  EmptyState,
  SaleTypeBadge,
  StatusBadge,
  Stat,
} from "@/components/ui";
import { DetailSkeleton } from "@/components/skeleton";
import { resolveCountyRule, countySlug, stateSlug, STATE_NAMES } from "@/lib/atlas";
import { statuteFor } from "@/lib/deal/statute";


export async function generateMetadata(
  props: PageProps<"/auctions/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const row = await getAuction(id);
  if (!row) return { title: "Auction not found" };
  return {
    title: `${row.county.name} County, ${row.county.state} tax sale — ${saleDate(row.auction.saleDate)}`,
  };
}

/*
 * No `unstable_instant` here on purpose. Validation walks a route using sample
 * params, and this one is keyed on a database UUID — there is no id that is
 * stable enough to pin in source without it going stale the next time the
 * table is rebuilt. The Suspense boundary below is what actually makes the
 * navigation instant; the export would only have added build-time checking.
 */
export default function AuctionPage(props: PageProps<"/auctions/[id]">) {
  return (
    <>
      <Suspense fallback={<DetailSkeleton />}>
        <AuctionBody {...props} />
      </Suspense>
    </>
  );
}

async function AuctionBody(props: PageProps<"/auctions/[id]">) {
  const { id } = await props.params;
  const row = await getAuction(id);
  if (!row) notFound();

  const { auction, county } = row;
  const lots = await getAuctionLots(auction.id);
  const rule = resolveCountyRule(county.fips);
  const statute = statuteFor(county.state);

  const withBid = lots.filter((l) => l.openingBid !== null);
  const totalOpening = withBid.reduce((n, l) => n + Number(l.openingBid), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs
        items={[
          { href: "/auctions", label: "Auctions" },
          { label: `${county.name} County, ${county.state}` },
        ]}
      />

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {county.name} County, {STATE_NAMES[county.state] ?? county.state}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>
              {saleDate(auction.saleDate)} · {relativeDays(auction.saleDate)}
            </span>
            {auction.startTime ? <span>· {auction.startTime}</span> : null}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SaleTypeBadge type={auction.saleType} />
            <StatusBadge status={auction.status} />
            <span className="text-xs text-muted">via {auction.platform}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <a
            href={auction.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border px-4 py-2 text-sm hover:border-accent"
          >
            Official listing ↗
          </a>
          <Link
            href={`/atlas/${stateSlug(county.state)}/${countySlug(county.name)}`}
            className="rounded-lg bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90"
          >
            County rules
          </Link>
        </div>
      </header>

      <div className="mb-6 grid gap-4 rounded-xl border border-border bg-surface p-5 sm:grid-cols-4">
        <Stat label="Parcels" value={num(lots.length)} />
        <Stat
          label="Opening bids"
          value={money(totalOpening)}
          hint={
            withBid.length === lots.length
              ? "all parcels priced"
              : `${num(lots.length - withBid.length)} lot(s) have no published opening bid`
          }
        />
        <Stat
          label="Redemption"
          value={statute?.redemption ? `${statute.redemption.maxDays} days` : "None"}
          hint={
            statute?.redemption
              ? `${(statute.redemption.tiers[0].penalty * 100).toFixed(0)}% flat penalty`
              : "clear title at sale"
          }
        />
        <Stat
          label="Quiet title"
          value={
            statute
              ? `${money(statute.quietTitle.typicalLow, { compact: true })}–${money(
                  statute.quietTitle.typicalHigh,
                  { compact: true },
                )}`
              : "—"
          }
          hint={statute?.quietTitle.required ? "typically required" : "often unnecessary"}
        />
      </div>

      {rule?.survivingLiens ? (
        <div className="mb-6">
          <Callout tone="warn" title="What survives this sale">
            {rule.survivingLiens}
          </Callout>
        </div>
      ) : statute ? (
        <div className="mb-6">
          <Callout tone="warn" title={`${county.state} caveats`}>
            <ul className="list-disc space-y-1 pl-4">
              {statute.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}

      <h2 className="mb-3 text-lg font-semibold">
        Parcels{" "}
        <span className="text-sm font-normal text-muted">
          — ranked by assessed value over opening bid
        </span>
      </h2>

      {lots.length === 0 ? (
        <EmptyState title="No parcels published yet">
          Counties often publish the parcel list only days before the sale. The auction date is
          confirmed; check back closer to {saleDate(auction.saleDate)}.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Parcel</th>
                  <th className="px-4 py-2.5 font-medium">Address</th>
                  <th className="px-4 py-2.5 text-right font-medium">Opening bid</th>
                  <th className="px-4 py-2.5 text-right font-medium">Assessed</th>
                  <th className="px-4 py-2.5 text-right font-medium">Spread</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => {
                  const opening = l.openingBid === null ? null : Number(l.openingBid);
                  const assessed = l.assessedValue === null ? null : Number(l.assessedValue);
                  const spread =
                    opening !== null && assessed !== null ? assessed - opening : null;

                  return (
                    <tr
                      key={l.id}
                      className="border-b border-border/60 last:border-0 hover:bg-surface-2/40"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/lots/${l.id}`}
                          className="font-mono text-xs hover:text-accent hover:underline"
                        >
                          {l.parcelNumber ?? l.externalId ?? "—"}
                        </Link>
                      </td>
                      <td className="max-w-xs truncate px-4 py-2.5">
                        {l.addressLine ? (
                          <>
                            {l.addressLine}
                            {l.city ? <span className="text-muted"> · {l.city}</span> : null}
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">{money(opening)}</td>
                      <td className="tnum px-4 py-2.5 text-right">{money(assessed)}</td>
                      <td
                        className="tnum px-4 py-2.5 text-right font-medium"
                        style={{
                          color:
                            spread === null
                              ? undefined
                              : spread > 0
                                ? "var(--ok)"
                                : "var(--danger)",
                        }}
                      >
                        {money(spread)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={l.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="mt-4 max-w-3xl text-xs leading-relaxed text-muted">
        <strong className="text-foreground">Spread is not profit.</strong> It compares the opening
        bid to the county&apos;s assessed value, which is not market value —{" "}
        {statute
          ? statute.assessmentBasis
          : "assessment practice varies by state"}{" "}
        Open a parcel to run the full max-bid analysis, which accounts for the assessment ratio,
        surviving liens, quiet title, and holding costs.
      </p>
    </div>
  );
}
