/**
 * CAPE — the county auction production board.
 *
 * All nine components of the TDC CAPE Auction Workflow System, evaluated per
 * upcoming sale. The document's own statement of purpose is what this renders:
 * that a researcher can see "which details still require verification", and
 * that anything unconfirmed is "clearly marked as requiring manual
 * verification".
 *
 * It reports; it does not write. Components Five, Six and Seven describe
 * authored and produced deliverables, and this board says what inputs exist for
 * them and whether they have been produced rather than generating them.
 */
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { Breadcrumbs, Card } from "@/components/ui";
import { AdminGate } from "@/components/admin-gate";
import { isAdmin } from "@/lib/admin/auth";
import { DetailSkeleton } from "@/components/skeleton";
import { getCapeAuctions, getCapeParcelCoverage } from "@/lib/queries";
import { buildPackage, type ItemState } from "@/lib/cape/components";
import { productionStates, publishedVideoUrls } from "@/lib/cape/inputs";
import { TIER_LABEL, TIER_RANK, type SourceTier } from "@/lib/cape/sources";
import { getCounty, resolveCountyRule } from "@/lib/atlas";
import { statuteFor } from "@/lib/deal/statute";
import directory from "@/data/county-directory.json";
import { pickLink, type CountyDirectory, type OfficeKind } from "@/lib/directory/onlinesearches";
import { num, saleDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "CAPE — auction intake and source verification",
  description:
    "County Auction Production Engine: every upcoming tax sale against the CAPE intake checklist, with the source tier and what still needs verification.",
  robots: { index: false, follow: false },
};

export default function CapePage(props: PageProps<"/cape">) {
  return (
    <div className="shell py-band">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "CAPE" }]} />
      <header className="mb-8 max-w-3xl">
        <h1 className="text-section">CAPE — production board</h1>
        <p className="mt-3 text-lg leading-relaxed text-muted">
          The County Auction Production Engine, run across every upcoming sale. Each package is
          measured against the nine components, its source tiered by how close the publisher sits
          to the authority for the sale, and its deadline set by Component Eight — Monday night for
          live auctions, Tuesday night for online. Sales in counties over 50,000 population carry a
          PropStream CSV, keyed on APN.
        </p>
      </header>
      <Suspense fallback={<DetailSkeleton />}>
        <Gate searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

/**
 * The same operations token as `/admin`, and deliberately not the site
 * password.
 *
 * This board is an operations surface: it names which packages are blocked and
 * on what, and it links the PropStream export, which carries owner names,
 * assessed values and computed max bids for every parcel in a sale. That is a
 * different class of thing from the public auction calendar, so it takes the
 * credential that guards the console rather than the one that merely says a
 * reader may look at the site.
 *
 * `connection()` before the cookie read, for the reason spelled out at length
 * in `app/admin/page.tsx`: without it the gate resolves during prerendering,
 * where there is no cookie, and Vercel serves the resulting sign-in form from
 * its CDN to everyone — including operators who hold a valid one.
 */
async function Gate({ searchParams }: { searchParams: PageProps<"/cape">["searchParams"] }) {
  await connection();
  const { e } = await searchParams;

  if (!(await isAdmin())) {
    return <AdminGate next="/cape" failed={e === "1"} />;
  }
  return <Board />;
}

async function Board() {
  /*
   * Component Eight is a deadline model, so "today" is genuinely a per-request
   * answer and this is where prerendering has to stop. Without `connection()`
   * the build refuses the clock read outright — the same rule that puts
   * `CopyrightYear` behind `use cache` in the layout and `connection()` at the
   * top of `CalendarView`. Baking today into the static shell would freeze
   * every overdue badge at build time.
   */
  await connection();
  const [rows, coverage, productions, videoUrls] = await Promise.all([
    getCapeAuctions(),
    getCapeParcelCoverage(),
    productionStates(),
    publishedVideoUrls(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const empty = { total: 0, withParcelNumber: 0, withAssessed: 0, withAddress: 0, withZoning: 0, withGeo: 0 };

  /*
   * The crawled county offices, which the first version of this board never
   * read: it passed `offices: {}` and Components Two, Three and Four duly
   * reported county contacts, the assessor, the tax office, the clerk and GIS
   * as outstanding on all 159 packages — while 751 counties sat in
   * `data/county-directory.json` with 314 assessor links and 263 GIS links.
   * The gap was in the wiring, not the data.
   */
  const dir = directory as Record<string, CountyDirectory>;
  const officesFor = (fips: string): Partial<Record<string, string>> => {
    const entry = dir[fips];
    if (!entry) return {};
    const out: Partial<Record<string, string>> = {};
    for (const kind of ["assessor", "collector", "recorder", "gis", "tax_portal"] as OfficeKind[]) {
      const hit = pickLink(entry, kind);
      if (hit) out[kind] = hit.url;
    }
    return out;
  };

  const assessed = rows.map((r) => ({
    row: r,
    cape: buildPackage({
      auctionId: r.id,
      countyName: r.countyName,
      state: r.state,
      saleDate: r.saleDate,
      saleDateConfirmed: r.saleDateConfirmed,
      saleType: r.saleType,
      sourceUrl: r.sourceUrl,
      platform: r.platform,
      startTime: null,
      registrationDeadline: r.registrationDeadline,
      depositDeadline: r.depositDeadline,
      lotCount: r.lotCount,
      listingKind: r.listingKind,
      rule: resolveCountyRule(r.countyFips),
      statute: statuteFor(r.state) ?? null,
      offices: officesFor(r.countyFips),
      population: getCounty(r.countyFips)?.population ?? null,
      parcels: coverage[r.id] ?? empty,
      today,
      production: productions[r.id] ?? null,
    }),
  }));

  const ready = assessed.filter((a) => a.cape.releasable);

  /* Component-level completion across every upcoming package. */
  const byComponent = assessed.length
    ? assessed[0].cape.components.map((c, idx) => ({
        n: c.n,
        title: c.title,
        mean: assessed.reduce((n, a) => n + a.cape.components[idx].score, 0) / assessed.length,
        counts: assessed.reduce(
          (acc, a) => {
            for (const k of ["have", "verify", "absent"] as ItemState[]) {
              acc[k] += a.cape.components[idx].counts[k];
            }
            return acc;
          },
          { have: 0, verify: 0, absent: 0 } as Record<ItemState, number>,
        ),
      }))
    : [];

  const overdue = assessed.filter((a) => a.cape.deadline.overdue);

  // Which of the nine is outstanding most often — the engineering work-list.
  const gaps = new Map<string, { label: string; n: number }>();
  for (const a of assessed) {
    for (const c of a.cape.components) {
      for (const it of c.items) {
        if (it.state !== "verify") continue;
        const g = gaps.get(it.label) ?? { label: it.label, n: 0 };
        g.n++;
        gaps.set(it.label, g);
      }
    }
  }
  const ranked = [...gaps.values()].sort((a, b) => b.n - a.n).slice(0, 12);

  const byTier = new Map<SourceTier, { auctions: number; parcels: number }>();
  for (const a of assessed) {
    const t = byTier.get(a.cape.source.tier) ?? { auctions: 0, parcels: 0 };
    t.auctions++;
    t.parcels += a.row.lotCount;
    byTier.set(a.cape.source.tier, t);
  }
  const tiers = [...byTier.entries()].sort((x, y) => TIER_RANK[x[0]] - TIER_RANK[y[0]]);

  const byDate = new Map<string, typeof assessed>();
  for (const a of assessed) {
    const day = byDate.get(a.row.saleDate) ?? [];
    day.push(a);
    byDate.set(a.row.saleDate, day);
  }

  return (
    <>
      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Releasable</div>
          <div className="tnum font-display mt-2 text-4xl font-medium" style={{ color: "var(--accent)" }}>
            {num(ready.length)}
            <span className="text-xl font-normal text-muted"> / {num(assessed.length)}</span>
          </div>
          <p className="mt-2 text-base text-muted">Passes Component Nine&apos;s quality gate</p>
        </Card>
        <Card>
          <div className="text-sm font-medium uppercase tracking-[0.12em] text-muted">Mean package</div>
          <div className="tnum font-display mt-2 text-4xl font-medium">
            {assessed.length
              ? Math.round(
                  (assessed.reduce((n, a) => n + a.cape.score, 0) / assessed.length) * 100,
                )
              : 0}
            %
          </div>
          <p className="mt-2 text-base text-muted">Across the nine components, averaged</p>
        </Card>
        <Card>
          <div className="text-sm font-medium uppercase tracking-[0.12em] text-muted">
            Government source of record
          </div>
          <div className="tnum font-display mt-2 text-4xl font-medium">
            {num(byTier.get("government")?.parcels ?? 0)}
          </div>
          <p className="mt-2 text-base text-muted">parcels from a county office or state agency</p>
        </Card>
      </div>

      {/* The work-list: which intake field is missing most often. */}
      {ranked.length > 0 ? (
        <section className="mb-10">
          <h2 className="font-display mb-4 text-2xl font-medium">Requiring manual verification</h2>
          <Card className="overflow-hidden p-0">
            <table className="w-full text-base">
              <thead className="border-b border-border bg-surface-2/50 text-left text-sm font-medium uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-5 py-3.5 font-medium">Item</th>
                  <th className="px-5 py-3.5 text-right font-medium">Packages</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ranked.map((g) => (
                  <tr key={g.label}>
                    <td className="px-5 py-3.5">{g.label}</td>
                    <td className="tnum px-5 py-3.5 text-right">{num(g.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}

      {byComponent.length > 0 ? (
        <section className="mb-10">
          <h2 className="font-display mb-4 text-2xl font-medium">The nine components</h2>
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead className="border-b border-border bg-surface-2/50 text-left text-sm font-medium uppercase tracking-[0.12em] text-muted">
                  <tr>
                    <th className="px-5 py-3.5 font-medium">Component</th>
                    <th className="px-5 py-3.5 text-right font-medium">Mean</th>
                    <th className="px-5 py-3.5 text-right font-medium">On record</th>
                    <th className="px-5 py-3.5 text-right font-medium">Needs verifying</th>
                    <th className="px-5 py-3.5 text-right font-medium">No source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {byComponent.map((c) => (
                    <tr key={c.n}>
                      <td className="px-5 py-3.5">
                        <span className="text-muted">{c.n}.</span> {c.title}
                      </td>
                      <td className="tnum px-5 py-3.5 text-right">{Math.round(c.mean * 100)}%</td>
                      <td className="tnum px-5 py-3.5 text-right">{num(c.counts.have)}</td>
                      <td className="tnum px-5 py-3.5 text-right">{num(c.counts.verify)}</td>
                      <td className="tnum px-5 py-3.5 text-right text-muted">
                        {c.counts.absent ? num(c.counts.absent) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="mt-3 text-base text-muted">
            &ldquo;No source&rdquo; is not a gap to close — those are items no source available to
            this product can answer, so they are excluded from the mean rather than counted
            against it.
            {overdue.length > 0 ? ` ${num(overdue.length)} package(s) are past their Component Eight deadline.` : ""}
          </p>
        </section>
      ) : null}

      <section className="mb-10">
        <h2 className="font-display mb-4 text-2xl font-medium">Where the sales come from</h2>
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead className="border-b border-border bg-surface-2/50 text-left text-sm font-medium uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-5 py-3.5 font-medium">Source tier</th>
                  <th className="px-5 py-3.5 text-right font-medium">Sales</th>
                  <th className="px-5 py-3.5 text-right font-medium">Parcels</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tiers.map(([tier, v]) => (
                  <tr key={tier}>
                    <td className="px-5 py-3.5">{TIER_LABEL[tier]}</td>
                    <td className="tnum px-5 py-3.5 text-right">{num(v.auctions)}</td>
                    <td className="tnum px-5 py-3.5 text-right">{num(v.parcels)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="font-display mb-4 text-2xl font-medium">Every upcoming sale</h2>
        <div className="space-y-8">
          {[...byDate.entries()].map(([day, group]) => (
            <div key={day}>
              <div className="mb-3 flex items-baseline gap-3 border-b border-border pb-2">
                <h3 className="font-display text-xl font-medium">{saleDate(day)}</h3>
                <span className="tnum text-base text-muted">
                  {num(group.length)} {group.length === 1 ? "sale" : "sales"}
                </span>
              </div>
              <ul className="divide-y divide-border overflow-hidden rounded-3xl border border-border/70 bg-surface shadow-[var(--shadow-sm)]">
                {group.map(({ row, cape }) => (
                  <li key={row.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] sm:items-start">
                    <div>
                      <Link href={`/auctions/${row.id}`} className="text-lg font-medium hover:text-accent">
                        {row.countyName} County, {row.state}
                      </Link>
                      <div className="tnum mt-1 text-base text-muted">
                        {num(row.lotCount)} parcels
                      </div>
                    </div>
                    <div>
                      <div className="text-base">{TIER_LABEL[cape.source.tier]}</div>
                      <div className="mt-0.5 break-all font-mono text-sm text-muted">{cape.source.host}</div>
                    </div>
                    <div className="sm:text-right">
                      <div className="tnum text-lg font-medium">{Math.round(cape.score * 100)}%</div>
                      <div
                        className={`mt-1 text-sm ${cape.deadline.overdue ? "font-medium text-warn" : "text-muted"}`}
                      >
                        due {cape.deadline.dueDate}
                        {cape.deadline.overdue ? " · overdue" : ""}
                      </div>
                      <div className="mt-2">
                        {cape.releasable ? (
                          <span className="inline-block rounded-full bg-accent/15 px-3 py-1 text-sm font-medium text-accent">
                            Releasable
                          </span>
                        ) : (
                          <span className="text-sm text-muted">{cape.blockedBy[0]}</span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm sm:justify-end">
                        {cape.components[9]?.items[0]?.state === "have" ? (
                          <a
                            href={`/api/cape/${row.id}/propstream`}
                            className="underline hover:text-foreground"
                          >
                            PropStream CSV
                          </a>
                        ) : null}
                        {videoUrls[row.id] ? (
                          <a
                            href={videoUrls[row.id]}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-foreground"
                          >
                            Briefing video ↗
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
