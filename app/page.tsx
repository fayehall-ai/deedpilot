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
      {/*
        The ink band.
        
        The page was light from top to bottom, which reads as a brochure. This is
        an instrument someone runs during a live auction while deciding whether
        to commit tens of thousands — one deep band at the top says that before a
        word is read, and gives the light working surface below something to be
        the working surface *of*.
        
        The faint radial is the only ornament on the page: enough to stop a large
        flat field looking like a filled rectangle, not enough to notice.
      */}
      <section className="relative overflow-hidden bg-ink text-ink-fg">
        {/*
          Light, not paint.
          
          Two blooms and a hairline. Their site fills rectangles with blue, which
          is what dates it; the same hue behaving like a light source behind the
          content reads as current. The cyan is a second temperature so the field
          shifts across its width instead of being one flat wash.
          
          The top hairline is a gradient that fades at both ends — a full-width
          line at constant opacity looks like a table border.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0
                     [background:radial-gradient(58rem_30rem_at_12%_-14%,rgba(12,107,255,0.34),transparent_62%),radial-gradient(44rem_26rem_at_84%_6%,rgba(34,211,238,0.14),transparent_60%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px
                     [background:linear-gradient(90deg,transparent,rgba(90,162,255,0.55),transparent)]"
        />
        <div className="relative mx-auto max-w-[max(80rem,min(112rem,88vw))] px-4 py-16 sm:px-6 sm:py-24 lg:py-32">
          {/*
            The lookup sits top-right rather than under the copy: it is the one
            thing on this page a visitor might arrive already wanting to do, and
            it now answers in place instead of navigating away.
          */}
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl 2xl:max-w-[59rem]">
            {/*
              The eyebrow steps down from uppercase-widest to a quieter label.
              Wide-tracked caps in the accent colour shout before the headline
              gets a chance to speak, and the headline is the better sentence.
            */}
            {/* A live signal rather than a label: the dot is the only thing on
                the band that moves, and it says the data behind this is current. */}
            <p className="inline-flex items-center gap-2.5 text-sm font-medium text-ink-muted">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-70 motion-reduce:animate-none" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gold" />
              </span>
              Tax deed &amp; foreclosure auctions
            </p>
            {/*
              Bigger, and tighter as it grows. A 3xl headline beside a 3xl
              section heading gave the page no top — this now clearly leads, and
              negative tracking at display sizes is what stops large type reading
              as merely enlarged.
            */}
            <h1 className="mt-5 text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.032em] sm:text-6xl 2xl:text-7xl">
              Know your walk-away price
              <br className="hidden sm:block" />{" "}
              <span className="text-fade">before you raise the paddle.</span>
            </h1>
            <p className="mt-6 max-w-[46ch] text-lg leading-relaxed text-ink-muted">
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
                /*
                 * Gold, and it earns the exception.
                 *
                 * The rule elsewhere is blue for action, gold for distinction —
                 * but this is both: the single most important thing anyone can
                 * do on the page, on a navy ground where gold is simply the
                 * loudest colour available. A white pill was the safe choice and
                 * read as a system button rather than an invitation.
                 *
                 * One per screen. The Search control beside it stays neutral so
                 * this is unambiguously the primary.
                 */
                className="rounded-full bg-gold px-6 py-3 font-semibold text-ink
                           shadow-[0_10px_34px_-10px_color-mix(in_srgb,var(--gold)_85%,transparent)]
                           transition-all hover:brightness-105 hover:scale-[1.02] active:scale-[0.99]"
              >
                Browse upcoming auctions
              </Link>
              <Link
                href="/#atlas"
                className="text-sm font-medium text-ink-muted underline-offset-4 transition-colors
                           hover:text-ink-fg hover:underline"
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
        <div className="mx-auto max-w-[max(80rem,min(112rem,88vw))] px-4 py-8 sm:px-6">
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
        <div className="mx-auto max-w-[max(80rem,min(112rem,88vw))] px-4 py-12 sm:px-6">
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
        <div className="mx-auto max-w-[max(80rem,min(112rem,88vw))] px-4 py-12 sm:px-6">
          <div className="mb-6">
          </div>
          {/* compact: the per-county ingest log is 200 rows of ops detail. */}
          <CoverageReport compact />
        </div>
      </section>

      {/* --- Pricing ------------------------------------------------------- */}
      <section id="pricing" className="scroll-mt-16 bg-surface-2/20">
        <div className="mx-auto max-w-[max(80rem,min(112rem,88vw))] px-4 py-12 sm:px-6">
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
      <dl className="glass mt-14 grid grid-cols-2 gap-x-5 gap-y-8 rounded-2xl p-6 sm:grid-cols-3 sm:p-7 lg:grid-cols-5">
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
        <p className="mt-6 max-w-[62ch] text-sm leading-relaxed text-ink-muted">
          Plus {num(stats.leadLots)} parcels on delinquent rolls and lands-available inventory —
          research leads, not scheduled lots.{" "}
          <Link
            href="/#coverage"
            className="underline underline-offset-4 transition-colors hover:text-ink-fg"
          >
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
/**
 * One figure in the readout.
 *
 * Number first and large, label beneath and quiet — the opposite of the original
 * order. A row of small-caps labels above their values reads as a marketing
 * grid; values leading, hairline-separated, reads as an instrument telling you
 * what it currently holds.
 */
function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-ink-line pl-4 first:border-l-0 first:pl-0">
      <dd className="tnum text-3xl font-semibold leading-none tracking-[-0.02em]">{value}</dd>
      <dt className="mt-2 text-xs leading-snug text-ink-muted">{label}</dt>
    </div>
  );
}
