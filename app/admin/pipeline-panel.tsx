import { sql } from "drizzle-orm";
import { Card, Callout, Stat } from "@/components/ui";
import { AdminTable, type AdminColumn } from "@/components/admin-table";
import { db } from "@/lib/db";
import { attritionCurve, type AttritionBucket } from "@/lib/ingest/observe";
import { isResearchDay, deskWeekday, DESK_TIMEZONE } from "@/lib/admin/research-day";

/**
 * What the pipeline observed, nationally.
 *
 * Reconciliation, the observation log and the delisting flag all landed with no
 * view above county level — a parcel could be withdrawn, a sale dropped from a
 * county calendar and an attrition curve accumulate, and the console would show
 * none of it. Per-county detail answers "why is Muskegon wrong"; this answers
 * "is the pipeline seeing what it should", which is a different question and the
 * one an operator opens the console asking.
 */
export async function PipelinePanel() {
  const [counts] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM lots WHERE status = 'withdrawn')::int          AS withdrawn,
      (SELECT count(*) FROM lots WHERE status = 'pending')::int            AS pending,
      (SELECT count(*) FROM auctions WHERE delisted_at IS NOT NULL)::int   AS delisted,
      (SELECT count(*) FROM lot_observations)::int                         AS observations,
      (SELECT count(DISTINCT observed_at) FROM lot_observations)::int      AS snapshots,
      (SELECT count(DISTINCT county_fips) FROM lot_observations)::int      AS observed_counties
  `)) as unknown as {
    withdrawn: number;
    pending: number;
    delisted: number;
    observations: number;
    snapshots: number;
    observed_counties: number;
  }[];

  const curve = await attritionCurve();
  const now = new Date();

  const columns: AdminColumn<AttritionBucket>[] = [
    { key: "window", header: "Days before the sale", cell: (b) => b.window },
    { key: "obs", header: "Observations", numeric: true, cell: (b) => b.observations.toLocaleString() },
    { key: "gone", header: "Departures", numeric: true, cell: (b) => b.departures.toLocaleString() },
    {
      key: "rate",
      header: "Departure rate",
      numeric: true,
      cell: (b) => `${(b.rate * 100).toFixed(1)}%`,
    },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Pipeline observations</h2>
        <p className="mt-1 text-sm text-muted">
          What the crawler saw, including what it stopped seeing. Every crawl writes one row per
          parcel — present or absent — so a parcel leaving a list is recorded rather than silently
          overwritten. Absences are marked <code className="font-mono text-xs">withdrawn</code> and
          never <code className="font-mono text-xs">redeemed</code>: the county publishes an absence,
          not a reason.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Parcels listed" value={counts.pending.toLocaleString()} />
        <Stat label="Parcels withdrawn" value={counts.withdrawn.toLocaleString()} />
        <Stat label="Sales delisted" value={counts.delisted.toLocaleString()} />
        <Stat label="Observations recorded" value={counts.observations.toLocaleString()} />
      </div>

      {counts.observations === 0 ? (
        <Callout tone="warn" title="No observations yet">
          The log fills as counties are crawled. Until a county is visited twice there is nothing to
          compare, so an attrition curve needs at least a second pass.
        </Callout>
      ) : (
        <Card>
          <h3 className="mb-1 font-medium">Pre-sale attrition</h3>
          <p className="mb-3 text-xs text-muted">
            What share of listed parcels stop being published, by how close the sale is. Built from{" "}
            {counts.snapshots.toLocaleString()} snapshot{counts.snapshots === 1 ? "" : "s"} across{" "}
            {counts.observed_counties.toLocaleString()} county
            {counts.observed_counties === 1 ? "" : " counties"}. Nobody sells this data — it requires
            having watched — and it is what tells a bidder whether a list is worth planning travel
            against.
          </p>
          <AdminTable
            rows={curve}
            columns={columns}
            rowKey={(b) => b.window}
            minWidth="30rem"
            empty="Not enough passes yet to compute a curve."
          />
        </Card>
      )}

      <Card>
        <h3 className="mb-1 font-medium">Standing schedule</h3>
        <ul className="space-y-1.5 text-sm text-muted">
          <li>
            <strong className="text-foreground">Crawl</strong> — nightly at 02:00 UTC. The dispatcher
            builds the calendar plan and queues county crawls by priority, capped at what one tick can
            drain.
          </li>
          <li>
            <strong className="text-foreground">Research</strong> — weekly, on the tick falling on a
            Sunday at the desk ({DESK_TIMEZONE}). Queues the four states with the most urgent
            no-source gap, at a priority below every crawl. Today is {deskWeekday(now)}
            {isResearchDay(now) ? " — research is due on tonight's tick." : "."}
          </li>
          <li>
            Adapter-wide sweeps in <em>Schedules</em> below are disabled and superseded: they
            re-fetched counties selling months away, and a capped adapter permanently starved its tail
            because the runner slices the first N bindings every time.
          </li>
        </ul>
      </Card>
    </section>
  );
}
