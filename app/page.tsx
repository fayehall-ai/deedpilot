import Link from "next/link";
import { getPlatformStats } from "@/lib/queries";
import { num } from "@/lib/format";
import { COVERED_STATES, STATE_NAMES, COUNTY_DATA, ALL_COUNTIES } from "@/lib/atlas";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // The landing page must render even if Postgres is unreachable — a database
  // blip should not take the marketing site down with it.
  const stats = await getPlatformStats().catch(() => ({
    upcomingAuctions: 0,
    totalLots: 0,
    byState: [] as { state: string; counties: number; auctions: number; lots: number }[],
  }));

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

          <dl className="mt-14 grid gap-6 border-t border-border pt-8 sm:grid-cols-4">
            <HeroStat label="Counties mapped" value={num(ALL_COUNTIES.length)} />
            <HeroStat label="Researched in depth" value={num(Object.keys(COUNTY_DATA).length)} />
            <HeroStat label="Upcoming auctions" value={num(stats.upcomingAuctions)} />
            <HeroStat label="Lots tracked" value={num(stats.totalLots)} />
          </dl>
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
            wide — these five states carry the bulk of U.S. tax deed volume.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {COVERED_STATES.map((s) => {
              const row = stats.byState.find((b) => b.state === s);
              return (
                <Link
                  key={s}
                  href={`/auctions?state=${s}`}
                  className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
                >
                  <div className="font-medium">{STATE_NAMES[s]}</div>
                  <div className="tnum mt-2 text-2xl font-semibold">{num(row?.lots ?? 0)}</div>
                  <div className="text-xs text-muted">
                    lots · {num(row?.auctions ?? 0)} auctions
                  </div>
                </Link>
              );
            })}
          </div>

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
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="tnum mt-1 text-3xl font-semibold">{value}</dd>
    </div>
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
