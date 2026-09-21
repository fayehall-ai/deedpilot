import { connection } from "next/server";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Breadcrumbs, Callout, Card } from "@/components/ui";
import { TableSkeleton } from "@/components/skeleton";
import { isAdmin } from "@/lib/admin/auth";
import { getAdapterHealth, getRecentRuns, getPolicies, getInventorySnapshot } from "@/lib/admin/ops";
import { getCapeOps } from "@/lib/admin/cape-ops";
import { getQueue, getSchedules } from "@/lib/admin/queue";
import { getSourceOverrides, getPolicyOverrides } from "@/lib/admin/ops";
import { signOut } from "./actions";
import { AdminGate } from "@/components/admin-gate";
import { OpsControls } from "./controls";
import { ScoutPanel } from "./scout-panel";
import { AuctionOverridesPanel } from "./auction-overrides-panel";
import { PlanPanel } from "./plan-panel";
import { Stage, Collapsed } from "@/components/stage";
import { whatNeedsAttention } from "@/lib/admin/attention";
import { DiscoverSummary, FunnelBars, PriceSummary, SummaryPending } from "./coverage-summary";
import { EnrichmentPanel } from "./enrichment-panel";
import { ImportPanel } from "./import-panel";
import { ImportHistoryPanel } from "./import-history-panel";
import { OpsPanel } from "./ops-panel";
import { StatutePanel } from "./statute-panel";
import { SourcesPanel } from "./sources-panel";
import { CapePanel } from "./cape-panel";
import { PolicyPanel } from "./policy-panel";
import { RunsPanel } from "./runs-panel";
import { InventoryPanel } from "./inventory-panel";

import { LabelQueuePanel } from "./label-queue-panel";
import { PipelinePanel } from "./pipeline-panel";
import { CadencePanel } from "./cadence-panel";
import { CoverageReport } from "@/components/coverage-report";

export const metadata: Metadata = {
  title: "Operations",
  robots: { index: false, follow: false },
};

/**
 * The operations console.
 *
 * `/coverage` and `/status` are the public honesty pages — what we ingest, and
 * whether the numbers mean what they appear to. This is the private one: when
 * each source last ran, what it returned, which hosts we have decided not to
 * crawl and why, and where every CAPE package is stuck.
 *
 * Token-gated, `noindex`, and never cached. There is no `unstable_instant`
 * block here on purpose: the whole point is the current state of the pipeline,
 * so a prerendered copy would be worse than useless.
 */
/*
 * The gate reads cookies and searchParams, both of which are request data. Done
 * at the top level of the page component that blocks the entire route from
 * rendering until they resolve — Next says so explicitly, and it is right: the
 * page chrome does not depend on who you are. Everything request-bound lives
 * inside the boundary, so the shell paints immediately and the gate resolves
 * behind it.
 */
export default function AdminPage(props: PageProps<"/admin">) {
  return (
    <Shell>
      <Suspense fallback={<TableSkeleton />}>
        <Gate searchParams={props.searchParams} />
      </Suspense>
    </Shell>
  );
}

async function Gate({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  /*
   * Request time, explicitly, before anything reads the cookie.
   *
   * Without this the gate resolved during prerendering. At build time there is
   * no cookie, so `isAdmin()` returned false and the *sign-in form* was baked
   * into the static shell — then Vercel served that shell from its CDN with
   * `x-vercel-cache: HIT` and an age of ten minutes. An operator holding a
   * valid `dp_admin` cookie got the anonymous prerender and the console never
   * appeared, because their request never reached a function.
   *
   * `vary` on this route lists rsc and the router headers and does NOT list
   * Cookie, so one cached copy is served to everybody. That is the whole bug,
   * and it also means the reverse would be far worse: if an authenticated
   * render were ever cached, every anonymous visitor would receive the
   * operations console. Pinning the gate to request time prevents both.
   *
   * The module header already said this page must never be cached. It said so
   * about `unstable_instant` and did not account for `cacheComponents` making
   * prerendering the default for everything else.
   */
  await connection();

  const params = await searchParams;
  const { e } = params;

  if (!(await isAdmin())) {
    return <AdminGate next="/admin" failed={e === "1"} />;
  }

  return (
    <>
      <div className="mb-6 flex justify-end">
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
          >
            Sign out
          </button>
        </form>
      </div>
      <Body outcome={params} />
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Operations" }]} />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="mt-1 text-sm text-muted">
          Sources, runs, access decisions and CAPE stage detail. Not public, not indexed.
        </p>
      </header>
      {children}
    </main>
  );
}



async function Body({
  outcome,
}: {
  /** Search params, carrying the result of the last run-now press. */
  outcome: Record<string, string | string[] | undefined>;
}) {
  /*
   * Reads the clock (relative "ago" stamps) and the live pipeline state, so
   * the request must be dynamic. Without this the build refuses the clock
   * read — the same rule that governs CalendarView and the CAPE board.
   */
  await connection();

  const [adapters, runs, inventory, cape, queue, schedules, sourceOv, policyOv, attention] =
    await Promise.all([
      getAdapterHealth(),
      getRecentRuns(40),
      getInventorySnapshot(),
      getCapeOps(),
      getQueue(20),
      getSchedules(),
      getSourceOverrides(),
      getPolicyOverrides(),
      whatNeedsAttention(),
    ]);
  const policies = getPolicies();

  const stale = adapters.filter((a) => a.lastRunAt === null);
  const failing = adapters.filter((a) => a.recentFailures > 0);
  const blocked = attention.filter((a) => a.state === "blocked");
  const needsRun = attention.filter((a) => a.state === "attention");

  return (
    <div className="space-y-6">
      {/*
        ---- what needs a person -------------------------------------------
        Above everything, because the page previously answered this only by
        being read end to end. `blocked` needs Faye; `attention` is work the
        system can do and hasn't.
      */}
      {attention.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            Nothing needs attention. The queue is clear, every crawled parcel is priceable, and no
            source has failed.
          </p>
        </Card>
      ) : (
        <Card>
          <h2 className="mb-3 text-base font-semibold">What needs you</h2>
          <ul className="space-y-3">
            {attention.map((a) => (
              <li key={a.label} className="flex gap-3">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    a.state === "blocked" ? "bg-danger" : "bg-warn"
                  }`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{a.label}</div>
                  <div className="text-xs text-muted">
                    {a.consequence} <span className="text-faint">— {a.stage}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        ---- coverage and data health --------------------------------------
        The overview that used to live on the landing page. Admins need to see
        the full picture of data health — the gold score, what counts as
        inventory, live inventory by state, and the operational detail the
        public page never showed.
      */}
      <Collapsed label="Coverage and data health" defaultOpen={false}>
        <Suspense fallback={<TableSkeleton />}>
          <CoverageReport />
        </Suspense>
      </Collapsed>

      {/*
        ---- the pipeline, in the order work flows through it ---------------
        Borrowed from the CAPE board: numbered stages, each collapsed to a
        line carrying the number that decides whether to open it. The console
        previously had fourteen peer sections, all expanded, with Run now and
        Schedules each appearing twice.
      */}
      <div className="space-y-3">
        <Stage
          n={1}
          title="Discover"
          question="Where does each county publish its sale list?"
          summary={
            <Suspense fallback={<SummaryPending />}>
              <DiscoverSummary />
            </Suspense>
          }
        >
          {/*
            First in the stage because it is the only control here that adds
            sales the crawler does not yet know exist. The Scout answers "where
            does this county publish", which is the same question one step
            later; an uploaded calendar answers "which sales are there at all".
          */}
          <Card>
            <h2 className="mb-1 text-base font-semibold">Import a sale calendar</h2>
            <p className="mb-3 text-sm text-muted">
              Loads announced sales from a CSV export. Rows arrive with a published parcel count
              and no parcels — they show on the calendar labelled as announced until a crawl
              fills them in.
            </p>
            <ImportPanel />
          </Card>
          {/*
            Directly under the control that causes it. "When was this last
            imported, and did it work" is asked in the same breath as "should I
            import it again", and the answer used to exist nowhere on this page
            — a calendar loaded from a terminal left no trace at all.
          */}
          <Suspense fallback={<TableSkeleton />}>
            <ImportHistoryPanel />
          </Suspense>
          <Suspense fallback={<TableSkeleton />}>
            <ScoutPanel />
          </Suspense>
          <LabelQueuePanel />
        </Stage>

        <Stage
          n={2}
          title="Crawl"
          question="What are we fetching today, and did it work?"
          state={queue.failed > 0 ? "attention" : "ok"}
          summary={`${queue.queued.toLocaleString()} queued · ${queue.failed} failed`}
          defaultOpen={needsRun.length > 0}
        >
          <Suspense fallback={<TableSkeleton />}>
            <PlanPanel />
          </Suspense>
          {(stale.length > 0 || failing.length > 0) && (
            <Callout tone="warn" title="Adapter health">
              <ul className="ml-4 list-disc space-y-1 text-sm">
                {stale.length > 0 && (
                  <li>
                    <strong>{stale.length}</strong> registered but never run:{" "}
                    {stale.map((a) => a.name).join(", ")}
                  </li>
                )}
                {failing.length > 0 && (
                  <li>
                    <strong>{failing.length}</strong> with failures in the last 7 days:{" "}
                    {failing.map((a) => `${a.name} (${a.recentFailures})`).join(", ")}
                  </li>
                )}
              </ul>
            </Callout>
          )}
          <Collapsed label="Adapter health, all sources" count={adapters.length}>
            <SourcesPanel adapters={adapters} />
          </Collapsed>
          <Collapsed label="Recent runs" count={runs.length}>
            <RunsPanel runs={runs} />
          </Collapsed>
        </Stage>

        <Stage
          n={3}
          title="Observe"
          question="What did the crawler see, including what it stopped seeing?"
          summary={`${inventory.inventoryParcels.toLocaleString()} parcels listed`}
        >
          <Suspense fallback={<TableSkeleton />}>
            <PipelinePanel />
          </Suspense>
          <Suspense fallback={<TableSkeleton />}>
            <AuctionOverridesPanel />
          </Suspense>
        </Stage>

        <Stage
          n={4}
          title="Price"
          question="How much of what we hold can a subscriber actually act on?"
          state={blocked.length > 0 ? "blocked" : "ok"}
          summary={
            <Suspense fallback={<SummaryPending />}>
              <PriceSummary />
            </Suspense>
          }
          defaultOpen={blocked.length > 0}
        >
          <Suspense fallback={<TableSkeleton />}>
            <FunnelBars />
          </Suspense>
          {/*
            Valuations sit under Price because that is the question they answer:
            a parcel without one cannot be priced, whatever else is known about
            it. This was the largest gap on the board and had no presence here at
            all until now.
          */}
          <Suspense fallback={<TableSkeleton />}>
            <EnrichmentPanel />
          </Suspense>
          {/*
            The ceiling on everything else in this stage. A parcel in a state
            with no statutory parameters cannot be priced however well it is
            enriched, so the statute list belongs beside the valuation gap
            rather than buried in a source file nobody opens.
          */}
          <Suspense fallback={<TableSkeleton />}>
            <StatutePanel />
          </Suspense>
          <Collapsed label="Inventory by state" count={inventory.states.length}>
            <InventoryPanel inventory={inventory} />
          </Collapsed>
        </Stage>

        <Stage
          n={5}
          title="Package"
          question="Is a sale complete enough to send to a subscriber?"
          state={cape.releasable === 0 && cape.packages > 0 ? "attention" : "ok"}
          summary={`${cape.releasable} of ${cape.packages} releasable`}
        >
          <CapePanel cape={cape} />
        </Stage>

        <Stage
          n={6}
          title="Operate"
          question="How hard does it run, what does it cost, and who changed what?"
          summary={`${schedules.filter((s) => s.enabled).length} schedule(s) on`}
        >
          <Suspense fallback={<TableSkeleton />}>
            <CadencePanel outcome={outcome} />
          </Suspense>
          <OpsPanel outcome={outcome} />
          <OpsControls
            adapters={adapters.map((a) => a.name)}
            queue={queue}
            schedules={schedules}
            sourceOverrides={sourceOv}
            policyOverrides={policyOv}
          />
          <Collapsed label="Access decisions" count={policies.length}>
            <PolicyPanel policies={policies} />
          </Collapsed>
        </Stage>
      </div>
    </div>
  );
}
