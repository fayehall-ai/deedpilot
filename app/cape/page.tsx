/**
 * CAPE — the auction intake and source-verification board.
 *
 * Components One and Two of the TDC CAPE Auction Workflow System, which asks
 * that every upcoming sale be entered against a fixed set of fields and that a
 * researcher can see, per sale, "which details still require verification".
 *
 * This is the answer to that question rather than a place to type it. Every one
 * of the nine intake fields already has somewhere to live in the schema, so the
 * work is not capture — it is showing which are filled, where each came from,
 * and what is outstanding.
 */
import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Breadcrumbs, Card } from "@/components/ui";
import { DetailSkeleton } from "@/components/skeleton";
import { getCapeAuctions } from "@/lib/queries";
import { assessIntake } from "@/lib/cape/intake";
import { TIER_LABEL, TIER_RANK, type SourceTier } from "@/lib/cape/sources";
import { resolveCountyRule } from "@/lib/atlas";
import { num, saleDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "CAPE — auction intake and source verification",
  description:
    "County Auction Production Engine: every upcoming tax sale against the CAPE intake checklist, with the source tier and what still needs verification.",
};

export default function CapePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "CAPE" }]} />
      <header className="mb-6 max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">
          CAPE — auction intake
        </h1>
        <p className="mt-2 leading-relaxed text-muted">
          The County Auction Production Engine checks every upcoming sale against a fixed intake
          set and tiers the source it came from. A sale is ready when all nine fields are present,
          the county published the date, and the document is a parcel list rather than a
          delinquent roll.
        </p>
      </header>
      <Suspense fallback={<DetailSkeleton />}>
        <Board />
      </Suspense>
    </div>
  );
}

async function Board() {
  const rows = await getCapeAuctions();

  const assessed = rows.map((r) => ({
    row: r,
    cape: assessIntake({
      auctionId: r.id,
      countyFips: r.countyFips,
      countyName: r.countyName,
      state: r.state,
      saleDate: r.saleDate,
      saleDateConfirmed: r.saleDateConfirmed,
      saleType: r.saleType,
      sourceUrl: r.sourceUrl,
      platform: r.platform,
      registrationDeadline: r.registrationDeadline,
      depositDeadline: r.depositDeadline,
      lotCount: r.lotCount,
      listingKind: r.listingKind,
      rule: resolveCountyRule(r.countyFips),
    }),
  }));

  const ready = assessed.filter((a) => a.cape.ready);

  // Which of the nine is outstanding most often — the engineering work-list.
  const gaps = new Map<string, { label: string; n: number }>();
  for (const a of assessed) {
    for (const f of a.cape.fields) {
      if (f.present) continue;
      const g = gaps.get(f.key) ?? { label: f.label, n: 0 };
      g.n++;
      gaps.set(f.key, g);
    }
  }
  const ranked = [...gaps.values()].sort((a, b) => b.n - a.n);

  const byTier = new Map<SourceTier, { auctions: number; parcels: number }>();
  for (const a of assessed) {
    const t = byTier.get(a.cape.source.tier) ?? { auctions: 0, parcels: 0 };
    t.auctions++;
    t.parcels += a.row.lotCount;
    byTier.set(a.cape.source.tier, t);
  }
  const tiers = [...byTier.entries()].sort((x, y) => TIER_RANK[x[0]] - TIER_RANK[y[0]]);

  return (
    <>
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Investor-ready</div>
          <div className="tnum mt-1 text-3xl font-semibold" style={{ color: "var(--accent)" }}>
            {num(ready.length)}
            <span className="text-base font-normal text-muted"> / {num(assessed.length)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            All nine intake fields, a county-published date, and a parcel list
          </p>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Mean intake</div>
          <div className="tnum mt-1 text-3xl font-semibold">
            {assessed.length
              ? Math.round(
                  (assessed.reduce((n, a) => n + a.cape.intakeScore, 0) / assessed.length) * 100,
                )
              : 0}
            %
          </div>
          <p className="mt-1 text-xs text-muted">Share of the nine fields present, averaged</p>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">
            Component Two — source of record
          </div>
          <div className="tnum mt-1 text-3xl font-semibold">
            {num(byTier.get("government")?.parcels ?? 0)}
          </div>
          <p className="mt-1 text-xs text-muted">
            parcels from a county office or state agency
          </p>
        </Card>
      </div>

      {/* The work-list: which intake field is missing most often. */}
      {ranked.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">What is outstanding</h2>
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Intake field</th>
                  <th className="px-4 py-2.5 text-right font-medium">Sales missing it</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ranked.map((g) => (
                  <tr key={g.label}>
                    <td className="px-4 py-2.5">{g.label}</td>
                    <td className="tnum px-4 py-2.5 text-right">{num(g.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Where the sales come from</h2>
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Source tier</th>
                  <th className="px-4 py-2.5 text-right font-medium">Sales</th>
                  <th className="px-4 py-2.5 text-right font-medium">Parcels</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tiers.map(([tier, v]) => (
                  <tr key={tier}>
                    <td className="px-4 py-2.5">{TIER_LABEL[tier]}</td>
                    <td className="tnum px-4 py-2.5 text-right">{num(v.auctions)}</td>
                    <td className="tnum px-4 py-2.5 text-right">{num(v.parcels)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Every upcoming sale</h2>
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Sale</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                  <th className="px-4 py-2.5 text-right font-medium">Intake</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {assessed.map(({ row, cape }) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2.5">
                      <Link href={`/auctions/${row.id}`} className="hover:text-accent">
                        {row.countyName} County, {row.state}
                      </Link>
                      <div className="text-xs text-muted">
                        {saleDate(row.saleDate)} · {num(row.lotCount)} parcels
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div>{TIER_LABEL[cape.source.tier]}</div>
                      <div className="font-mono text-[11px] text-muted">{cape.source.host}</div>
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {Math.round(cape.intakeScore * 100)}%
                    </td>
                    <td className="px-4 py-2.5">
                      {cape.ready ? (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">
                          Ready
                        </span>
                      ) : (
                        <span className="text-xs text-muted">{cape.blockedBy}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </>
  );
}
