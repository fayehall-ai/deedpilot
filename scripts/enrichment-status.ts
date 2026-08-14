/**
 * Where every county stands on valuations, and the one command to run next.
 *
 *   npx tsx scripts/enrichment-status.ts
 *   npx tsx scripts/enrichment-status.ts --state NM
 *
 * Today produced five scripts with no stated order between them, which is how a
 * pipeline is forgotten: the next person reads `bulk-cadastre`, `bulk-rentcast`,
 * `geocode-lots`, `discover-parcel-layers` and `verify-parcel-layer` and has no
 * way to know that running the fourth before the third wastes a day.
 *
 * This is the entry point. It reads the shape of each county — how many lots
 * carry a parcel number, an address, a city — and prints the single next action,
 * with what it would reach and what it would cost. `lib/property/pipeline.ts`
 * holds the rule; this only renders it.
 */
import "../lib/env";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { ALL_COUNTIES } from "../lib/atlas";
import { nextAction, STAGE_ORDER, type CountyShape } from "../lib/property/pipeline";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const only = arg("state")?.toUpperCase();

  const rows = (await db.execute(sql`
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
    GROUP BY 1`)) as unknown as {
    county_fips: string; lots: number; valued: number;
    with_parcel: number; with_addr: number; with_city: number;
  }[];

  const shapes: CountyShape[] = [];
  for (const r of rows) {
    const c = ALL_COUNTIES.find((x) => x.fips === r.county_fips);
    if (!c) continue;
    if (only && c.state !== only) continue;
    shapes.push({
      fips: c.fips, state: c.state, name: c.name,
      lots: r.lots, valued: r.valued,
      withParcel: r.with_parcel, withNumberedAddress: r.with_addr, withCity: r.with_city,
    });
  }

  const totalLots = shapes.reduce((n, s) => n + s.lots, 0);
  const totalValued = shapes.reduce((n, s) => n + s.valued, 0);
  console.log(
    `\nValuation coverage: ${totalValued.toLocaleString()} / ${totalLots.toLocaleString()} ` +
      `(${Math.round((totalValued / Math.max(1, totalLots)) * 100)}%)\n`,
  );

  console.log("Pipeline, cheapest first:");
  for (const s of STAGE_ORDER) console.log(`  ${s.label.padEnd(42)} ${s.cost}`);

  // Grouped by what to do, because the action is the useful unit — running one
  // command for eleven counties beats reading eleven rows that say the same thing.
  const byCommand = new Map<string, { rec: ReturnType<typeof nextAction>; counties: CountyShape[] }>();
  for (const shape of shapes) {
    const rec = nextAction(shape);
    if (rec.stage === "already-valued") continue;
    const key = rec.command ?? `none:${rec.stage}`;
    const e = byCommand.get(key) ?? { rec, counties: [] };
    e.counties.push(shape);
    byCommand.set(key, e);
  }

  const groups = [...byCommand.values()].sort(
    (a, b) =>
      b.counties.reduce((n, c) => n + (c.lots - c.valued), 0) -
      a.counties.reduce((n, c) => n + (c.lots - c.valued), 0),
  );

  console.log(`\nWhat to do next — ${groups.length} action(s), largest gap first:\n`);
  for (const g of groups) {
    const gap = g.counties.reduce((n, c) => n + (c.lots - c.valued), 0);
    const names = g.counties
      .sort((a, b) => b.lots - b.valued - (a.lots - a.valued))
      .slice(0, 4)
      .map((c) => `${c.name} ${c.state}`)
      .join(", ");
    console.log(`  ${gap.toLocaleString()} lots unvalued — ${names}${g.counties.length > 4 ? ` +${g.counties.length - 4} more` : ""}`);
    console.log(`    why: ${g.rec.why}`);
    console.log(`    run: ${g.rec.command ?? "(nothing free is left; see the stage note above)"}\n`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
