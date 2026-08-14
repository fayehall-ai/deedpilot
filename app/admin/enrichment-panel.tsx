import { sql } from "drizzle-orm";
import { Card } from "@/components/ui";
import { Collapsed } from "@/components/stage";
import { nextAction, type CountyShape } from "@/lib/property/pipeline";
import { ALL_COUNTIES } from "@/lib/atlas";

/**
 * Where valuations come from, and what is still missing one.
 *
 * ## Why this belongs on the console
 *
 * Valuation coverage moved from 18% to 86% of pending inventory in a day and
 * none of it was visible here. The console's job is to answer "what needs a
 * person", and enrichment now has answers to that question — four public-records
 * requests waiting on county replies, a portal submission nobody has made — that
 * existed only in a terminal script and a commit message.
 *
 * A number that only appears when someone runs a CLI is a number nobody watches.
 *
 * ## Why it groups by action rather than by county
 *
 * There are 25 counties with a gap and about six distinct reasons for it. Listed
 * per county the page says the same thing twenty-five times; grouped by the
 * command that fixes it, one line covers twenty-eight Arkansas counties. The
 * grouping is `nextAction`'s, so the console and `npm run enrich:status` cannot
 * drift apart — they read the same rule.
 *
 * ## Why "exhausted" is its own state
 *
 * Arkansas sits at 90% and its remaining 566 parcels return 0% on re-runs: they
 * are not in the state cadastre and never will be. Showing them as outstanding
 * work invites someone to grind a sweep that cannot succeed, which is exactly
 * what happened before the hit rate was measured properly.
 */

async function conn() {
  const [{ db }] = await Promise.all([import("@/lib/db")]);
  return db;
}

export async function EnrichmentPanel() {
  const db = await conn();

  const [sources, rows] = (await Promise.all([
    db.execute(sql`
      SELECT source, count(*)::int n FROM lot_valuations GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    db.execute(sql`
      SELECT a.county_fips,
             count(*)::int lots,
             count(GREATEST(l.assessed_value, v.market_value))::int valued,
             count(l.parcel_number)::int with_parcel,
             count(*) FILTER (WHERE l.address_line ~ '^[0-9]')::int with_addr,
             count(l.city)::int with_city
      FROM lots l
      JOIN auctions a ON a.id = l.auction_id
      LEFT JOIN lot_valuations v ON v.lot_id = l.id
      WHERE l.status = 'pending'
      GROUP BY 1`),
  ])) as unknown as [
    { source: string; n: number }[],
    {
      county_fips: string; lots: number; valued: number;
      with_parcel: number; with_addr: number; with_city: number;
    }[],
  ];

  const shapes: CountyShape[] = [];
  for (const r of rows) {
    const c = ALL_COUNTIES.find((x) => x.fips === r.county_fips);
    if (!c) continue;
    shapes.push({
      fips: c.fips, state: c.state, name: c.name,
      lots: r.lots, valued: r.valued,
      withParcel: r.with_parcel, withNumberedAddress: r.with_addr, withCity: r.with_city,
    });
  }

  const totalLots = shapes.reduce((n, s) => n + s.lots, 0);
  const totalValued = shapes.reduce((n, s) => n + s.valued, 0);
  const pct = Math.round((totalValued / Math.max(1, totalLots)) * 100);

  const byCommand = new Map<string, { why: string; command: string | null; counties: CountyShape[] }>();
  for (const s of shapes) {
    const rec = nextAction(s);
    if (rec.stage === "already-valued") continue;
    const key = rec.command ?? `none:${rec.stage}`;
    const e = byCommand.get(key) ?? { why: rec.why, command: rec.command, counties: [] };
    e.counties.push(s);
    byCommand.set(key, e);
  }
  const groups = [...byCommand.values()]
    .map((g) => ({ ...g, gap: g.counties.reduce((n, c) => n + (c.lots - c.valued), 0) }))
    .sort((a, b) => b.gap - a.gap);

  const paid = new Set(["rentcast", "attom", "batchdata", "websearch"]);
  const free = sources.filter((s) => !paid.has(s.source)).reduce((n, s) => n + s.n, 0);
  const total = sources.reduce((n, s) => n + s.n, 0);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-2xl font-semibold tabular-nums">{pct}%</span>
          <span className="text-sm text-muted">
            {totalValued.toLocaleString()} of {totalLots.toLocaleString()} pending parcels have a
            valuation
          </span>
          <span className="ml-auto text-sm text-muted">
            {/* The share that costs nothing is the number worth watching, because
                it is the one that decides whether coverage can grow for free. */}
            <span className="font-medium tabular-nums text-foreground">
              {Math.round((free / Math.max(1, total)) * 100)}%
            </span>{" "}
            of valuations came from a free source
          </span>
        </div>

        <div className="mt-4 space-y-1.5">
          {sources.map((s) => (
            <div key={s.source} className="flex items-center gap-3 text-sm">
              <span className="w-20 shrink-0 text-right tabular-nums font-medium">
                {s.n.toLocaleString()}
              </span>
              <span
                className={`h-2 shrink-0 rounded-sm ${paid.has(s.source) ? "bg-amber-500" : "bg-accent"}`}
                style={{ width: `${Math.max(2, (s.n / Math.max(1, sources[0].n)) * 200)}px` }}
                aria-hidden
              />
              <span className="min-w-0 truncate">
                {s.source}
                {paid.has(s.source) && <span className="ml-2 text-xs text-muted">metered</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Collapsed label="Counties still missing valuations" count={groups.length}>
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.command ?? g.why} className="rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium tabular-nums">{g.gap.toLocaleString()} parcels</span>
                <span className="text-sm text-muted">
                  {g.counties
                    .sort((a, b) => b.lots - b.valued - (a.lots - a.valued))
                    .slice(0, 3)
                    .map((c) => `${c.name} ${c.state}`)
                    .join(", ")}
                  {g.counties.length > 3 && ` +${g.counties.length - 3} more`}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">{g.why}</p>
              {g.command ? (
                <code className="mt-2 block overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs">
                  {g.command}
                </code>
              ) : (
                <p className="mt-2 text-xs text-faint">
                  No free route remains. These are parcels the available sources do not carry —
                  re-running a sweep returns nothing.
                </p>
              )}
            </div>
          ))}
        </div>
      </Collapsed>
    </div>
  );
}
