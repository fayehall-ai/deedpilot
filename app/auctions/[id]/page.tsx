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

      {/*
        County rules, in place of the button that used to sit in the header.
        The button sent the reader to a different page mid-decision; the rules
        are context for the list below, so they belong next to it. Closed by
        default because the parcels are what the page is for — and the two
        things a bid is most often wrong about, surviving liens and the
        statutory caveats, are already open above this rather than folded away
        in here.
      */}
      {rule ? (
        <details className="group/rules mb-6 rounded-xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-semibold hover:text-accent [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-muted transition-transform group-open/rules:rotate-90">
              ›
            </span>
            {county.name} County rules
            {rule.isStateDefault ? (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted">
                state defaults
              </span>
            ) : null}
          </summary>

          <div className="border-t border-border px-5 py-4">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Row label="Sale type" value={rule.type} />
              <Row label="Redemption" value={rule.redemption} />
              <Row label="Return if redeemed" value={rule.returns} />
              <Row label="Governing statute" value={rule.statute} />
              <Row label="Format" value={rule.auctionFormat} />
              <Row label="Frequency" value={rule.auctionFrequency} />
              <Row label="Deposit rules" value={rule.depositRules} />
              <Row label="Quiet title" value={rule.quietTitle} />
              <Row label="Checked" value={rule.asOf} />
            </dl>

            {/*
              Named so the reader can tell researched from inherited. A county
              showing its state's redemption window is a different claim from
              one whose own was read off the county's notice, and the atlas has
              always labelled which is which.
            */}
            {rule.inherited.length > 0 ? (
              <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
                Inherited from {STATE_NAMES[county.state] ?? county.state} rather than researched
                for {county.name}: {rule.inherited.join(", ")}.
              </p>
            ) : null}

            <Link
              href={`/atlas/${stateSlug(county.state)}/${countySlug(county.name)}`}
              className="mt-4 inline-block text-sm text-accent hover:underline"
            >
              Full {county.name} County profile →
            </Link>
          </div>
        </details>
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

/**
 * One county-rule field, label above value.
 *
 * Renders nothing when there is no value. A rules panel padded with dashes
 * implies the county was researched and found to have no answer, when the truth
 * is usually that nobody has looked — and the `inherited` line below the grid
 * is where that distinction is actually made.
 */
function Row({ label, value }: { label: string; value?: string | null }) {
  const v = value?.trim();
  if (!v) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 leading-relaxed">{v}</dd>
    </div>
  );
}
