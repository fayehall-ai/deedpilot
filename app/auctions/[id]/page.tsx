import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { countHiddenLots, getAuction, getAuctionLots } from "@/lib/queries";
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
import { resolveCountyRule, STATE_NAMES } from "@/lib/atlas";
import type { LinkRef } from "@/lib/atlas/types";
import { statuteFor } from "@/lib/deal/statute";
import { MIN_POPULATION as PROPSTREAM_MIN_POPULATION } from "@/lib/cape/propstream";
import { isImported, readAnnouncedDetail } from "@/lib/import/announced-detail";
import { parcelsShown, platformLabel } from "@/lib/format";


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
  /*
   * Withdrawn parcels are always hidden; land-only ones unless `?land=show` —
   * see lib/lots/land-only.ts. Every count and total below is over the parcels
   * shown.
   */
  const showLand = (await props.searchParams).land === "show";
  const [lots, { withdrawn, landOnly }] = await Promise.all([
    getAuctionLots(auction.id, { includeLandOnly: showLand }),
    countHiddenLots(auction.id),
  ]);
  const hiddenNote =
    [
      landOnly > 0 && !showLand ? `${num(landOnly)} land-only` : null,
      withdrawn > 0 ? `${num(withdrawn)} withdrawn` : null,
    ]
      .filter(Boolean)
      .join(", ") || null;
  const landToggle =
    landOnly > 0 ? (
      <Link
        href={showLand ? `/auctions/${auction.id}` : `/auctions/${auction.id}?land=show`}
        className="text-sm text-accent hover:underline"
      >
        {showLand
          ? `Hide ${num(landOnly)} land-only parcel(s)`
          : `Show ${num(landOnly)} land-only parcel(s)`}
      </Link>
    ) : null;
  const rule = resolveCountyRule(county.fips);
  const statute = statuteFor(county.state);

  const withBid = lots.filter((l) => l.openingBid !== null);
  const totalOpening = withBid.reduce((n, l) => n + Number(l.openingBid), 0);

  return (
    <div className="shell py-band">
      <Breadcrumbs
        items={[
          { href: "/auctions", label: "Auctions" },
          { label: `${county.name} County, ${county.state}` },
        ]}
      />

      <header className="mb-6">
        <div>
          <h1 className="text-section font-semibold">
            {county.name} County, {STATE_NAMES[county.state] ?? county.state}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-base text-muted">
            <span>
              {saleDate(auction.saleDate)} · {relativeDays(auction.saleDate)}
            </span>
            {auction.startTime ? <span>· {auction.startTime}</span> : null}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SaleTypeBadge type={auction.saleType} />
            <StatusBadge status={auction.status} />
            <span className="text-sm text-muted">via {platformLabel(auction.platform)}</span>
          </div>
        </div>
      </header>

      <div className="mb-6 grid gap-4 rounded-3xl border border-border bg-surface p-6 sm:grid-cols-4">
        {/*
          An announced sale has no parcel rows, and showing "0" here beside a
          confirmed date reads as a sale with nothing in it rather than one
          whose list has not been fetched. The county's own figure is shown
          instead, with the hint saying whose claim it is.
        */}
        <Stat
          label="Parcels"
          value={num(lots.length > 0 ? lots.length : parcelsShown(auction).count)}
          hint={
            lots.length === 0 && hiddenNote === null && parcelsShown(auction).count > 0
              ? "announced by the county — list not yet fetched"
              : hiddenNote
                ? `${hiddenNote} hidden`
                : undefined
          }
        />
        {/*
          With no parcels, `withBid.length === lots.length` is 0 === 0, which
          rendered "$0 — all parcels priced" on every imported sale. That is the
          precise claim this codebase refuses to let a missing bid sheet make:
          it tells a bidder every parcel opens free. No list means no answer, and
          `money(null)` is the em dash that says so.
        */}
        <Stat
          label="Opening bids"
          value={money(lots.length === 0 ? null : totalOpening)}
          hint={
            lots.length === 0
              ? "no parcel list yet"
              : withBid.length === lots.length
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

      {/*
        Everything the announcement carried, for a sale whose parcels are not in
        yet. Placed above the statutory caveats because it is the concrete part
        — where to turn up, how bidding runs, who to ring — and below the stats
        because those answer "is this worth reading at all".
      */}
      <AnnouncedFacts auction={auction} hasLots={lots.length > 0} />

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
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-base font-semibold hover:text-accent [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-muted transition-transform group-open/rules:rotate-90">
              ›
            </span>
            {county.name} County rules
            {rule.isStateDefault ? (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-normal uppercase tracking-wide text-muted">
                state defaults
              </span>
            ) : null}
          </summary>

          <div className="space-y-5 border-t border-border px-5 py-4">
            <dl className="grid gap-x-6 gap-y-3 text-base sm:grid-cols-2 lg:grid-cols-3">
              <Row label="Sale type" value={rule.type} />
              <Row label="Redemption period" value={rule.redemption} />
              <Row label="Investor return" value={rule.returns} />
              <Row label="Governing statute" value={rule.statute} />
              <Row label="Population" value={rule.county.population ? `${num(rule.county.population)} residents` : null} />
              <Row label="Checked" value={rule.asOf} />
            </dl>

            {/* Heading only when something sits under it — an empty section
                header reads as a section that failed to load. */}
            {rule.auctionFormat || rule.auctionFrequency || rule.auctionPlatform?.label || rule.depositRules ? (
            <section className="border-t border-border pt-4">
              <h3 className="mb-2 text-sm uppercase tracking-wide text-muted">Auction logistics</h3>
              <dl className="grid gap-x-6 gap-y-3 text-base sm:grid-cols-2 lg:grid-cols-3">
                <Row label="Format" value={rule.auctionFormat} />
                <Row label="Frequency" value={rule.auctionFrequency} />
                <RefRow label="Platform" link={rule.auctionPlatform} />
                <Row label="Deposit rules" value={rule.depositRules} />
              </dl>
            </section>
            ) : null}

            {/*
              Quiet title only. `survivingLiens` is already open above this in
              its own callout, and it is the single most expensive thing to miss
              — repeating it inside a closed disclosure would suggest it can be
              read here instead of there.
            */}
            {rule.quietTitle ? (
              <section className="border-t border-border pt-4">
                <h3 className="mb-2 text-sm uppercase tracking-wide text-muted">Title risk</h3>
                <p className="text-base leading-relaxed">{rule.quietTitle}</p>
              </section>
            ) : null}

            {rule.taxCollector || rule.clerkOfCourt || rule.propertyAppraiser || rule.gisMap ? (
              <section className="border-t border-border pt-4">
                <h3 className="mb-2 text-sm uppercase tracking-wide text-muted">
                  Offices and records
                </h3>
                <dl className="grid gap-x-6 gap-y-3 text-base sm:grid-cols-2 lg:grid-cols-3">
                  <RefRow label="Tax collector" link={rule.taxCollector} />
                  <RefRow label="Clerk of court" link={rule.clerkOfCourt} />
                  <RefRow label="Property appraiser" link={rule.propertyAppraiser} />
                  <RefRow label="GIS / parcel map" link={rule.gisMap} />
                </dl>
              </section>
            ) : null}

            {rule.growthNeighborhoods?.length ? (
              <section className="border-t border-border pt-4">
                <h3 className="mb-2 text-sm uppercase tracking-wide text-muted">
                  Areas trending up
                </h3>
                <ul className="space-y-1.5 text-sm">
                  {rule.growthNeighborhoods.map((g) => (
                    <li key={g.name} className="leading-relaxed">
                      <span className="font-medium">{g.name}</span>
                      <span className="text-muted"> — {g.why}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {rule.notes ? (
              <section className="border-t border-border pt-4">
                <h3 className="mb-2 text-sm uppercase tracking-wide text-muted">Notes</h3>
                <p className="text-sm leading-relaxed text-muted">{rule.notes}</p>
              </section>
            ) : null}

            {/*
              Dated and sourced, or it is just an assertion. Folded because the
              citations matter on challenge rather than on every read.
            */}
            {rule.sources?.length ? (
              <details className="group/src border-t border-border pt-4">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm uppercase tracking-wide text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className="transition-transform group-open/src:rotate-90">
                    ›
                  </span>
                  {rule.sources.length} source{rule.sources.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 space-y-1 border-l border-border pl-3">
                  {rule.sources.map((src) => (
                    <li key={src} className="truncate">
                      <a
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={src}
                        className="text-sm text-muted underline hover:text-foreground"
                      >
                        {src.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {rule.inherited.length > 0 ? (
              <p className="border-t border-border pt-3 text-sm text-muted">
                Inherited from {STATE_NAMES[county.state] ?? county.state} rather than researched
                for {county.name}: {rule.inherited.join(", ")}.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          Parcels{" "}
          <span className="text-sm font-normal text-muted">
            — ranked by assessed value over opening bid
          </span>
        </h2>
        {/*
          * CAPE Component Ten, which existed as a working endpoint that nothing
          * linked to. The export collapses four manual steps from the TDC
          * workflow — find a qualifying county, download its spreadsheet,
          * convert the PDF when there is not one, reshape it to the template —
          * and reaching it required knowing the route and pasting a UUID.
          *
          * Shown only above the population threshold the workflow itself sets.
          * The route enforces the same rule with a 422, so a link that appeared
          * regardless would offer a download that answers back with an error.
          */}
        {lots.length > 0 && (rule?.county.population ?? 0) >= PROPSTREAM_MIN_POPULATION ? (
          <a
            href={`/api/cape/${auction.id}/propstream${showLand ? "?land=show" : ""}`}
            className="text-sm text-accent hover:underline"
          >
            Download PropStream list ({num(lots.length)} parcels, CSV)
          </a>
        ) : null}
        {landToggle}
      </div>

      {lots.length === 0 && hiddenNote ? (
        <EmptyState title="Nothing left to show">
          Every parcel in this sale is hidden: {hiddenNote}. Land-only means no street address, a
          house number of zero, or a street with no number; withdrawn parcels are no longer on offer.
        </EmptyState>
      ) : lots.length === 0 ? (
        <EmptyState title="No parcels published yet">
          {parcelsShown(auction).count > 0 ? (
            <>
              The county has announced {num(parcelsShown(auction).count)} parcels for this sale, but
              the parcel list itself has not been fetched yet — so there is nothing to rank here.
              Counties often publish it only days before the sale. Check back closer to{" "}
              {saleDate(auction.saleDate)}.
            </>
          ) : (
            <>
              Counties often publish the parcel list only days before the sale. The auction date is
              confirmed; check back closer to {saleDate(auction.saleDate)}.
            </>
          )}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-left text-sm uppercase tracking-wide text-muted">
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
                          className="font-mono text-sm hover:text-accent hover:underline"
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

      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted">
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
/**
 * The imported announcement, rendered only when there is one.
 *
 * Shown for imported sales whether or not parcels have since arrived: a crawl
 * fills in the parcel list, but it does not supply the collector's phone number
 * or the registration terms, so this stays useful after enrichment rather than
 * being a placeholder that disappears.
 */
function AnnouncedFacts({
  auction,
  hasLots,
}: {
  auction: { externalId: string; raw: Record<string, unknown> | null };
  hasLots: boolean;
}) {
  if (!isImported(auction.externalId)) return null;
  const d = readAnnouncedDetail(auction.raw);
  if (!d) return null;

  return (
    <Card className="mb-6">
      <h2 className="mb-1 text-base font-semibold">As announced by the county</h2>
      <p className="mb-4 text-base text-muted">
        Published sale details.{" "}
        {hasLots
          ? "The parcel list below was fetched separately."
          : "The parcel list has not been fetched yet."}
      </p>

      {d.venue ? (
        <div className="mb-4">
          <div className="text-sm uppercase tracking-wide text-muted">Held at</div>
          <div className="mt-0.5 leading-relaxed">{d.venue}</div>
        </div>
      ) : null}

      {d.facts.length > 0 ? (
        <dl className="grid gap-3 sm:grid-cols-3">
          {d.facts.map((f) => (
            <div key={f.label}>
              <dt className="text-sm uppercase tracking-wide text-muted">{f.label}</dt>
              <dd className="mt-0.5 break-words leading-relaxed">
                {f.href ? (
                  <a
                    href={f.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {f.value}
                  </a>
                ) : (
                  f.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {d.contacts.length > 0 ? (
        <dl className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-4">
          {d.contacts.map((c) => (
            <div key={c.label}>
              <dt className="text-sm uppercase tracking-wide text-muted">{c.label}</dt>
              <dd className="mt-0.5 break-words leading-relaxed">
                {c.href ? (
                  <a href={c.href} className="text-accent hover:underline">
                    {c.value}
                  </a>
                ) : (
                  c.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {d.notes ? (
        <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed">{d.notes}</p>
      ) : null}

      {d.registration ? (
        <details className="mt-4 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-medium hover:text-accent">
            Registration and terms
          </summary>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">
            {d.registration}
          </p>
        </details>
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  const v = value?.trim();
  if (!v) return null;
  return (
    <div>
      <dt className="text-sm uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 leading-relaxed">{v}</dd>
    </div>
  );
}

/**
 * A county office: linked when there is a URL, plain when there is not.
 *
 * The phone number rides along because half of what these offices answer is not
 * on their website, and a bidder with a question two days before a sale needs
 * the number rather than another page to read.
 */
function RefRow({ label, link }: { label: string; link?: LinkRef | null }) {
  if (!link?.label) return null;
  return (
    <div>
      <dt className="text-sm uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 leading-relaxed">
        {link.url ? (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-accent"
          >
            {link.label}
          </a>
        ) : (
          link.label
        )}
        {link.phone ? <span className="block text-sm text-muted">{link.phone}</span> : null}
      </dd>
    </div>
  );
}
