/**
 * Build a county tax-sale due diligence framework.
 *
 *   npm run framework -- --county 13089                 # next upcoming sale
 *   npm run framework -- --county 13089 --date 2026-10-06
 *   npm run framework -- --county 13089 --html          # also write an .html
 *   npm run framework -- --state GA --all               # every upcoming GA sale
 *
 * One document per county *per sale*, because the sale date, venue, start time
 * and inventory all change between them and those are the first eight rows of
 * the page. The statutory half is stable; the sale half is not.
 */
import "../lib/env";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getCounty } from "../lib/atlas";
import { buildFramework, longDate, type FrameworkAuction } from "../lib/framework/content";
import { frameworkDocx } from "../lib/framework/docx";
import { frameworkHtml } from "../lib/framework/html";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const OUT = arg("out") ?? path.join("artifacts", "frameworks");

async function main() {
  const fips = arg("county");
  const state = arg("state");
  const date = arg("date");
  if (!fips && !state) {
    console.error("Usage: npm run framework -- --county <FIPS> [--date YYYY-MM-DD] [--html]");
    console.error("       npm run framework -- --state <XX> --all");
    process.exit(1);
  }

  const rows = (await db.execute(sql`
    select a.county_fips fips, a.sale_date::text d, a.sale_type, a.platform, a.start_time,
           a.source_url, a.logistics, a.announced_parcel_count ann, a.sale_date_confirmed conf,
           (select count(*) from lots l where l.auction_id = a.id)::int lots
    from auctions a
    join counties c on c.fips = a.county_fips
    where a.delisted_at is null
      and a.sale_date >= current_date
      ${fips ? sql`and a.county_fips = ${fips}` : sql``}
      ${state ? sql`and c.state = ${state}` : sql``}
      ${date ? sql`and a.sale_date = ${date}::date` : sql``}
    order by a.sale_date
  `)) as unknown as any[];

  if (rows.length === 0) {
    console.error("No upcoming sale matches that.");
    process.exit(1);
  }

  /* One per county unless --all: the next sale is the one anybody is preparing for. */
  const chosen = flag("all") ? rows : [...new Map(rows.map((r) => [r.fips, r])).values()];
  mkdirSync(OUT, { recursive: true });

  for (const r of chosen) {
    const county = getCounty(r.fips);
    if (!county) { console.warn(`skipped ${r.fips}: not a county`); continue; }
    const auction: FrameworkAuction = {
      saleDate: r.d, saleType: r.sale_type, platform: r.platform, startTime: r.start_time,
      sourceUrl: r.source_url, logistics: r.logistics, lotCount: r.lots,
      announced: r.ann, saleDateConfirmed: r.conf,
    };
    const f = buildFramework(r.fips, auction);
    const base = `${county.name.replace(/[^A-Za-z0-9]+/g, "_")}_County_${county.state}_Framework_${r.d}`;

    writeFileSync(path.join(OUT, `${base}.docx`), await frameworkDocx(f));
    if (flag("html")) writeFileSync(path.join(OUT, `${base}.html`), frameworkHtml(f));

    console.log(`${base}.docx`);
    console.log(`   ${county.name} County, ${county.state} — ${longDate(r.d)}`);
    const ask = f.rows.filter((x) => x.source === "ask").length;
    console.log(`   ${f.sections.length} sections · ` +
                `${f.rows.filter((x) => x.source === "county").length} county-researched, ` +
                `${f.rows.filter((x) => x.source === "statute").length} statewide, ` +
                `${ask} to confirm with the county · ${f.sources.length} sources`);
  }
  console.log(`\nwritten to ${OUT}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.cause?.message ?? e); process.exit(1); });
