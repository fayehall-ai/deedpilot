/**
 * The Statutory Ground page: every county's tax-sale law, one page.
 *
 * All 3,142 counties from the atlas, with each county's upcoming sales from the
 * database, poured into `templates/statutory-ground.html` at its `__DATA__`
 * marker. Served live at `/statutory` and written to a file by
 * `npm run statutory:page`; it used to be only the file, published by hand.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  ALL_COUNTIES, STATE_DATA, STATE_NAMES, TYPE_COLORS, TYPE_DESCRIPTIONS,
  resolveCountyRule, toSaleType,
} from "../atlas";

export interface StatutoryPage {
  html: string;
  counties: number;
  verified: number;
  withUpcoming: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the payload is the template's own loose JSON shape */
export async function statutoryPage(): Promise<StatutoryPage> {
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
      /* Only what differs from the state: the page reads the state's value otherwise. */
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

  const template = readFileSync(path.join(process.cwd(), "templates", "statutory-ground.html"), "utf8");
  if (!template.includes("__DATA__")) throw new Error("templates/statutory-ground.html has no __DATA__ marker");
  /* `</` inside a JSON string would close the script tag early. */
  const html = template.replace("__DATA__", JSON.stringify(payload).replace(/<\//g, "<\\/"));

  const all = Object.values(states).flatMap((s: any) => s.counties);
  return {
    html,
    counties: all.length,
    verified: all.filter((c: any) => c.r).length,
    withUpcoming: all.filter((c: any) => c.u).length,
  };
}
