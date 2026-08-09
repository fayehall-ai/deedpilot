import Link from "next/link";
import { Suspense } from "react";
import { getPlatformStats } from "@/lib/queries";
import { num } from "@/lib/format";
import { COVERED_STATES, STATE_NAMES, COUNTY_DATA, ALL_COUNTIES } from "@/lib/atlas";
import { Card } from "@/components/ui";
import { StatsSkeleton } from "@/components/skeleton";


/*
 * No `unstable_instant`. The home page reads only cached aggregates, so it is
 * already fully prerenderable — validation flags the static `metadata` export
 * as the sole thing preventing that, which is not a problem worth solving by
 * making the page dynamic. The Suspense boundary stays: it is what shows a
 * skeleton instead of a blank hero if the cache is cold.
 */
export default function HomePage() {
  return (
    <div>
      <Suspense fallback={<StatsSkeleton />}>
        <HomeBody />
      </Suspense>
    </div>
  );
}

async function HomeBody() {
  // The landing page must render even if Postgres is unreachable — a database
  // blip should not take the marketing site down with it.
  const stats = await getPlatformStats().catch(() => ({
    upcomingAuctions: 0,
    skeletonAuctions: 0,
    totalLots: 0,
    lotsWithAssessed: 0,
    leadAuctions: 0,
    leadLots: 0,
    byState: [] as { state: string; counties: number; auctions: number; lots: number }[],
  }));

  // States with parcels a bidder can actually act on today, biggest first.
  // getPlatformStats only returns states that already have lots (>0).
  const withInventory = stats.byState.slice(0, 10);
  // 0-lot shells no longer appear in byState; surface residual skeleton debt if any.
  const scheduledAuctions = stats.skeletonAuctions ?? 0;

  return (
    <div>
      {/* --- Hero --------------------------------------------------------- */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="max-w-3xl">
            <p className="text-sm font-medium uppercase tracking-widest text-accent">
              Tax deed &amp; foreclosure auctions
            </p>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Know your walk-away price before you raise the paddle.
            </h1>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted">
              Every county&apos;s tax sale rules, live auction inventory, and a co-pilot that
              computes your maximum bid — accounting for the liens that survive, the quiet title
              you&apos;ll have to file, and the redemption window that may hand the property back.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/auctions"
                className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg hover:opacity-90"
              >
                Browse upcoming auctions
              </Link>
              <Link
                href="/atlas"
                className="rounded-lg border border-border px-5 py-2.5 font-medium hover:border-accent"
              >
                Explore the atlas — free
              </Link>
            </div>
          </div>

          <dl className="mt-14 grid gap-6 border-t border-border pt-8 sm:grid-cols-5">
            <HeroStat label="Counties mapped" value={num(ALL_COUNTIES.length)} />
            <HeroStat label="Researched in depth" value={num(Object.keys(COUNTY_DATA).length)} />
            <HeroStat label="States with inventory" value={num(stats.byState.length)} />
            <HeroStat label="Upcoming auctions" value={num(stats.upcomingAuctions)} />
            <HeroStat
              label="Lots on published sale lists"
              value={num(stats.totalLots)}
            />
          </dl>

          {/*
            Counted separately and named for what it is. A delinquent roll is a
            useful lead list and a terrible auction listing — most owners on it
            pay before any sale — so it never joins the number above.
          */}
          {stats.leadLots > 0 ? (
            <p className="mt-6 text-sm text-muted">
              Plus {num(stats.leadLots)} parcels on delinquent rolls and lands-available
              inventory — research leads, not scheduled lots.{" "}
              <Link href="/coverage" className="underline hover:text-fg">
                How we count
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      {/* --- What it does -------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">The spread is not the profit</h2>
        <p className="mt-2 max-w-2xl leading-relaxed text-muted">
          A $14,000 opening bid on a property assessed at $831,000 looks like a life-changing deal.
          Then Georgia assesses at 40% of market value, Texas hands the owner 180 days to redeem, a
          municipal lien survives the sale, and the title insurer won&apos;t write a policy until
          you&apos;ve spent $5,000 on a quiet title action. DeedPilot does that arithmetic before
          you bid, not after.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <Feature title="Rules for every county">
            All {num(ALL_COUNTIES.length)} counties, with {num(Object.keys(COUNTY_DATA).length)}{" "}
            researched in depth — auction platform, deposit deadlines, what survives the sale, and
            what quiet title actually costs. Where a county inherits its state&apos;s defaults, we
            say so on the page instead of implying research we haven&apos;t done.
          </Feature>
          <Feature title="Live auction inventory">
            Parcel-level listings for {COVERED_STATES.length} states, pulled from the government
            source of record and the platforms that permit it. Every lot carries its opening bid,
            assessed value, and its own deal analysis.
          </Feature>
          <Feature title="A bidding co-pilot">
            Per-parcel risk briefs and a deterministic max bid — never a number a language model
            invented. On sale day it tracks the lots you care about and tells you when to stop.
          </Feature>
        </div>
      </section>

      {/* --- Coverage ------------------------------------------------------ */}
      <section className="border-t border-border bg-surface-2/40">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Where we have live inventory</h2>
          <p className="mt-2 max-w-2xl leading-relaxed text-muted">
            The rules atlas is national. Parcel-level auction data is deliberately deep rather than
            wide — we are actively expanding live inventory beyond the original high-volume states via the source registry and generic extraction.
          </p>

          {/*
            Driven by what is actually in the database, not by COVERED_STATES.
            The hardcoded five hid real coverage: the generic adapter had put
            186 lots into New Mexico and the page could not show them, because
            NM is not one of the original five. A coverage surface that cannot
            report coverage is worse than no coverage surface.
          */}
          <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {withInventory.map((row) => (
              <Link
                key={row.state}
                href={`/auctions?state=${row.state}`}
                className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
              >
                <div className="font-medium">{STATE_NAMES[row.state] ?? row.state}</div>
                <div className="tnum mt-2 text-2xl font-semibold">{num(row.lots)}</div>
                <div className="text-xs text-muted">
                  lots · {num(row.auctions)} auctions
                </div>
              </Link>
            ))}
          </div>

          {scheduledAuctions > 0 ? (
            <p className="mt-4 text-sm text-muted">
              <span className="tnum font-medium text-fg">{num(scheduledAuctions)}</span> calendar
              row{scheduledAuctions === 1 ? "" : "s"} still have no parcel list (hidden from browse;
              see{" "}
              <Link href="/coverage" className="underline">
                coverage
              </Link>
              ).
            </p>
          ) : null}

          <p className="mt-4 text-xs text-muted">
            A state showing zero has no sale currently published, or its ingestion is still being
            built —{" "}
            <Link href="/coverage" className="underline">
              see the coverage report
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="tnum mt-1 text-3xl font-semibold">{value}</dd>
    </>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </Card>
  );
}
