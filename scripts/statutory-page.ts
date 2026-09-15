/**
 * Build the county statutory reference page.
 *
 *   npx tsx scripts/statutory-page.ts            # writes artifacts/statutory-ground.html
 *
 * ## What the page is for
 *
 * Every one of the 3,142 counties has a rule, because every state has one and
 * `resolveCountyRule` falls back to it. That makes "do we have the statute for
 * this county" the wrong question — the answer is always yes — and the right
 * one "was it verified for the county, or inherited from the state". 1,010 are
 * the first; 2,132 are the second. A reader deciding whether to act on a
 * briefing needs to know which, and nothing in the product said so before.
 *
 * ## Why the data is shipped as inheritance rather than as rows
 *
 * A flat table of 3,142 counties would repeat each state's redemption prose
 * sixty times and hide the one thing worth seeing. The payload carries the 51
 * state rules in full and, per county, only the fields that actually differ —
 * which is both smaller and the shape the data really has.
 */
import "../lib/env";
import {
  ALL_COUNTIES, STATE_DATA, STATE_NAMES, TYPE_COLORS, TYPE_DESCRIPTIONS,
  resolveCountyRule, toSaleType,
} from "../lib/atlas";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const OUT = path.join("artifacts", "statutory-ground.html");
const TEMPLATE = path.join("templates", "statutory-ground.html");

async function main() {
  const upcoming = new Map<string, { n: number; lots: number; next: string }>();
  for (const r of (await db.execute(sql`
    select a.county_fips f, count(*)::int n, min(a.sale_date)::text next,
           coalesce(sum((select count(*) from lots l where l.auction_id = a.id)), 0)::int lots
    from auctions a
    where a.sale_date >= current_date and a.delisted_at is null
    group by 1`)) as unknown as any[]) {
    upcoming.set(r.f, { n: r.n, lots: r.lots, next: r.next });
  }

  const states: Record<string, any> = {};
  for (const [abbr, rule] of Object.entries(STATE_DATA)) {
    states[abbr] = { name: (STATE_NAMES as any)[abbr] ?? abbr, ...rule, counties: [] };
  }

  for (const c of ALL_COUNTIES) {
    const r = resolveCountyRule(c.fips);
    const s = states[c.state];
    if (!r || !s) continue;
    const base = (STATE_DATA as any)[c.state];
    const up = upcoming.get(c.fips);
    const row: any = { f: c.fips, n: c.name, r: r.isStateDefault ? 0 : 1 };
    if (c.population) row.p = c.population;
    if (!r.isStateDefault) {
      /* Only what differs from the state — see the header. */
      if (r.type && r.type !== base.type) row.t = r.type;
      if (r.redemption !== base.redemption) row.rd = r.redemption;
      if (r.returns !== base.returns) row.rt = r.returns;
      if (r.statute !== base.statute) row.st = r.statute;
      if ((r as any).survivingLiens) row.sl = (r as any).survivingLiens;
      if ((r as any).quietTitle) row.qt = (r as any).quietTitle;
      if ((r as any).asOf) row.as = (r as any).asOf;
    }
    if (up) { row.u = up.n; row.ul = up.lots; row.un = up.next; }
    row.b = toSaleType(r.type ?? base.type);
    s.counties.push(row);
  }
  for (const s of Object.values(states)) {
    (s as any).counties.sort((a: any, b: any) => a.n.localeCompare(b.n));
  }

  const payload = {
    generated: new Date().toISOString().slice(0, 10),
    typeColors: TYPE_COLORS,
    typeDescriptions: TYPE_DESCRIPTIONS,
    states,
  };

  const template = readFileSync(TEMPLATE, "utf8");
  if (!template.includes("__DATA__")) throw new Error(`${TEMPLATE} has no __DATA__ marker`);
  /* `</` inside a JSON string would close the script tag early. */
  const html = template.replace("__DATA__", JSON.stringify(payload).replace(/<\//g, "<\\/"));
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);

  const all = Object.values(states).flatMap((s: any) => s.counties);
  console.log(`${OUT}  (${Math.round(html.length / 1024)} KB)`);
  console.log(`  ${all.length} counties, ${all.filter((c: any) => c.r).length} county-verified`);
  console.log(`  ${all.filter((c: any) => c.u).length} with an upcoming sale`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.cause?.message ?? e); process.exit(1); });
