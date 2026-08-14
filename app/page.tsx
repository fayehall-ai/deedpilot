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
import { connection } from "next/server";
import { getUpcomingAuctions } from "@/lib/queries";
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
/*
 * The property lookup is a server action invoked from this route, so its ceiling
 * is this route's. A cold search is ~27s and has run past 45; the default is not
 * something to find out about from a reader seeing "This page couldn't load".
 * The action stops itself at 55s, well inside this.
 */
export const maxDuration = 120;

/**
 * The map, once the sale calendar has loaded.
 *
 * Separated so the map paints from the static shell and the auction list fills
 * in behind it. The fallback is the same map without sales rather than a
 * skeleton — the geography is already known, and flashing a grey box in place of
 * something we can render is a worse trade than a list arriving a moment late.
 */
async function ExplorerWithAuctions() {
  /*
   * Request time, before the query. `getUpcomingAuctions` filters on today, so
   * without this the build refuses it as uncached data — and rightly: a "today"
   * resolved at build time would freeze into the prefetched shell and start
   * listing sales that have already happened. `AuctionsList` marks the same
   * boundary for the same reason.
   */
  await connection();
  const rows = await getUpcomingAuctions({});
  return (
    <AtlasExplorer
      states={STATE_PATHS}
      auctions={rows.map((r) => ({
        id: r.id,
        saleDate: r.saleDate,
        state: r.state,
        countyFips: r.countyFips,
        countyName: r.countyName,
        lotCount: r.lotCount ?? 0,
        saleType: r.saleType ?? null,
      }))}
    />
  );
}

export default function HomePage(props: PageProps<"/">) {
  return (
    <div>
      {/* --- Hero --------------------------------------------------------- */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
          {/*
            The lookup sits top-right rather than under the copy: it is the one
            thing on this page a visitor might arrive already wanting to do, and
            it now answers in place instead of navigating away.
          */}
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            {/*
              The eyebrow steps down from uppercase-widest to a quieter label.
              Wide-tracked caps in the accent colour shout before the headline
              gets a chance to speak, and the headline is the better sentence.
            */}
            <p className="text-sm font-medium text-accent">Tax deed &amp; foreclosure auctions</p>
            {/*
              Bigger, and tighter as it grows. A 3xl headline beside a 3xl
              section heading gave the page no top — this now clearly leads, and
              negative tracking at display sizes is what stops large type reading
              as merely enlarged.
            */}
            <h1 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-[-0.028em] sm:text-5xl">
              Know your walk-away price before you raise the paddle.
            </h1>
            <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-muted">
              Every county&apos;s tax sale rules, live auction inventory, and a co-pilot that
              computes your maximum bid — accounting for the liens that survive, the quiet title
              you&apos;ll have to file, and the redemption window that may hand the property back.
            </p>

            {/*
              One primary action, one quiet one. Two buttons of equal weight ask
              the reader to choose between them; a filled button beside a plain
              link tells them which one is the answer.
            */}
            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link
                href="/#calendar"
                className="rounded-full bg-accent px-6 py-3 font-medium text-accent-fg
                           shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90"
              >
                Browse upcoming auctions
              </Link>
              <Link
                href="/#atlas"
                className="text-sm font-medium text-muted underline-offset-4 transition-colors
                           hover:text-foreground hover:underline"
              >
                Explore the atlas — free
              </Link>
            </div>
          </div>

          <div className="w-full lg:w-[26rem] lg:shrink-0">
            <PropertySearch />
          </div>
          </div>

          <HeroStats />
        </div>
      </section>

      {/* --- Calendar ------------------------------------------------------ */}
      <section id="calendar" className="scroll-mt-16 border-b border-border bg-surface-2/20">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="mb-6">
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
          <div className="mb-6">
          </div>
          {/*
            Map first, list second. The map answers "what kind of state is
            this" at a glance, which the list cannot; the list stays because it
            is scannable, searchable by the browser's own find, and reachable
            without a pointing device.
          */}
          {/*
            The map is fed the sale calendar so a county click can answer "and
            when does it sell" without leaving. Behind its own boundary because
            the map itself is static and should not wait on a query.
          */}
          <Suspense fallback={<AtlasExplorer states={STATE_PATHS} />}>
            <ExplorerWithAuctions />
          </Suspense>
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
          <div className="mb-6">
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
