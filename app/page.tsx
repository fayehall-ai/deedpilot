import Link from "next/link";
import { PropertySearch } from "@/components/property-search";
import { Suspense } from "react";
import { getPlatformStats } from "@/lib/queries";
import { num } from "@/lib/format";
import { COUNTY_DATA, ALL_COUNTIES } from "@/lib/atlas";
import { CalendarSkeleton } from "@/components/skeleton";
import { CalendarView } from "@/components/calendar-view";
import { AtlasStates } from "@/components/atlas-states";
import { AtlasExplorer } from "@/components/atlas-explorer";
import { STATE_PATHS } from "@/lib/atlas/geo";
import { CoverageReport } from "@/components/coverage-report";
import { PricingPlans } from "@/components/pricing-plans";

/*
 * One page, one section per nav item.
 *
 * Every Suspense boundary here is a *sibling*. That is load-bearing, not
 * stylistic: an earlier version wrapped the whole body in one async component
 * and nested the calendar, auctions and coverage boundaries inside it. React
 * then had to swap a resolved parent into a subtree that already held resolved
 * children, and threw
 *
 *   HierarchyRequestError: Failed to execute 'insertBefore' on 'Node':
 *   The new child element contains the parent
 *
 * followed by hydration error #418. The page prerendered, streamed correct
 * HTML, and passed the build — and came out blank in the browser. Keeping the
 * boundaries flat means each section resolves on its own and none of them can
 * ever contain another.
 *
 * There is exactly one boundary now, and the count is the point. An earlier
 * four-boundary version passed every local check and then failed on Vercel:
 * the server sent complete HTML — 386 auction links, all four
 * `$RC("B:n","S:n")` completion scripts — and the browser left every one of
 * them stranded in React's staging container. No error, no CSP, just a
 * permanent skeleton. Behind a CDN the whole stream replays at once rather
 * than progressively, and the reveal scheduler never ran them.
 *
 * So only the genuinely request-time section gets one. The hero figures and the
 * coverage report read `use cache` data and prerender into the static shell
 * instead, which is both faster and one less thing that has to reveal
 * correctly. Anything added here should keep that shape: cached and prerendered
 * unless it truly cannot be, and never nested inside another boundary.
 */
export default function HomePage(props: PageProps<"/">) {
  return (
    <div>
      {/* --- Hero --------------------------------------------------------- */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="max-w-3xl">
            <p className="text-sm font-medium uppercase tracking-widest text-accent">
              Tax deed &amp; foreclosure auctions
            </p>
            <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              Know your walk-away price before you raise the paddle.
            </h1>
            <p className="mt-3 max-w-2xl leading-relaxed text-muted">
              Every county&apos;s tax sale rules, live auction inventory, and a co-pilot that
              computes your maximum bid — accounting for the liens that survive, the quiet title
              you&apos;ll have to file, and the redemption window that may hand the property back.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/#calendar"
                className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg hover:opacity-90"
              >
                Browse upcoming auctions
              </Link>
              <Link
                href="/#atlas"
                className="rounded-lg border border-border px-5 py-2.5 font-medium hover:border-accent"
              >
                Explore the atlas — free
              </Link>
            </div>

            <PropertySearch />
          </div>

          <HeroStats />
        </div>
      </section>

      {/* --- Calendar ------------------------------------------------------ */}
      <section id="calendar" className="scroll-mt-16 border-b border-border bg-surface-2/20">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">What is selling, and when</h2>
            <Link href="/calendar" className="text-sm text-muted underline hover:text-foreground">
              Open the full calendar
            </Link>
          </div>
          <Suspense fallback={<CalendarSkeleton />}>
            <CalendarView searchParams={props.searchParams} basePath="/" />
          </Suspense>
        </div>
      </section>

      {/* --- Atlas ---------------------------------------------------------
          Only the state grid collapses into a section. The 1,010 county pages
          beneath it stay real routes — they are the SEO surface, and an anchor
          on this page is not something a search engine can index. */}
      <section id="atlas" className="scroll-mt-16 border-b border-border bg-surface-2/20">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">Rules for every county</h2>
            <Link href="/atlas" className="text-sm text-muted underline hover:text-foreground">
              Open the atlas
            </Link>
          </div>
          {/*
            Map first, list second. The map answers "what kind of state is
            this" at a glance, which the list cannot; the list stays because it
            is scannable, searchable by the browser's own find, and reachable
            without a pointing device.
          */}
          <AtlasExplorer states={STATE_PATHS} />
          <details className="group/states mt-8">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="transition-transform group-open/states:rotate-90">
                ›
              </span>
              Browse all 51 as a list
            </summary>
            <div className="mt-4">
              <AtlasStates heading={false} intro={false} />
            </div>
          </details>
        </div>
      </section>

      {/* --- Coverage ------------------------------------------------------ */}
      <section id="coverage" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">
              What we cover, and what we do not
            </h2>
            <Link href="/coverage" className="text-sm text-muted underline hover:text-foreground">
              Full coverage report
            </Link>
          </div>
          {/* compact: the per-county ingest log is 200 rows of ops detail. */}
          <CoverageReport compact />
        </div>
      </section>

      {/* --- Pricing ------------------------------------------------------- */}
      <section id="pricing" className="scroll-mt-16 bg-surface-2/20">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <h2 className="mb-6 text-2xl font-semibold tracking-tight">Pricing</h2>
          <PricingPlans heading={false} />
        </div>
      </section>
    </div>
  );
}

/**
 * The headline figures.
 *
 * Falls back to zeros rather than throwing: a database blip should degrade the
 * hero to "0 upcoming auctions", not take the landing page down with it.
 */
async function HeroStats() {
  const stats = await getPlatformStats().catch(() => ({
    upcomingAuctions: 0,
    skeletonAuctions: 0,
    totalLots: 0,
    lotsWithAssessed: 0,
    leadAuctions: 0,
    leadLots: 0,
    byState: [] as { state: string; counties: number; auctions: number; lots: number }[],
  }));

  return (
    <>
      <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border pt-6 sm:grid-cols-3 lg:grid-cols-5">
        <HeroStat label="Counties mapped" value={num(ALL_COUNTIES.length)} />
        <HeroStat label="Researched in depth" value={num(Object.keys(COUNTY_DATA).length)} />
        <HeroStat label="States with inventory" value={num(stats.byState.length)} />
        <HeroStat label="Upcoming auctions" value={num(stats.upcomingAuctions)} />
        <HeroStat label="Parcels on published sale lists" value={num(stats.totalLots)} />
      </dl>

      {/*
        Counted separately and named for what it is. A delinquent roll is a
        useful lead list and a terrible auction listing — most owners on it pay
        before any sale — so it never joins the number above.
      */}
      {stats.leadLots > 0 ? (
        <p className="mt-4 text-sm text-muted">
          Plus {num(stats.leadLots)} parcels on delinquent rolls and lands-available inventory —
          research leads, not scheduled lots.{" "}
          <Link href="/#coverage" className="underline hover:text-fg">
            How we count
          </Link>
        </p>
      ) : null}
    </>
  );
}

/**
 * One figure and its label, as a single grid cell.
 *
 * The wrapping <div> is the fix, not decoration. These used to return a bare
 * <dt>/<dd> fragment into a five-column grid, so each element became its own
 * cell: the labels and values landed in alternating columns and read as
 * "Counties mapped / 3,142 / Researched in depth / 1,010 / States with
 * inventory" across one row and the matching numbers across the next. A <div>
 * inside <dl> is valid HTML5 and exists for exactly this.
 */
function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="tnum mt-0.5 text-2xl font-semibold">{value}</dd>
    </div>
  );
}
