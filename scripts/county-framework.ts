/**
 * Build a county tax-sale due diligence framework.
 *
 *   npm run framework -- --county 13089                 # next upcoming sale
 *   npm run framework -- --county 13089 --date 2026-10-06
 *   npm run framework -- --county 13089 --html          # also write an .html
 *   npm run framework -- --state GA --every             # every upcoming GA sale
 *   npm run framework -- --all --html                   # every county with a sale
 *
 * One document per county *per sale*, because the sale date, venue, start time
 * and inventory all change between them and those are the first eight rows of
 * the page. The statutory half is stable; the sale half is not.
 *
 * ## Why "all counties" means the ones with a sale in the window, not 3,142
 *
 * The document is anchored to an auction: its first eight rows are that sale's
 * date, venue, check-in window and format. A county with nothing scheduled has
 * no auction to anchor to, and a framework with an empty top half is not a
 * shorter document, it is a misleading one. The statutory half of every county
 * — all 3,142 — already has a home on the Statutory Ground page; this is the
 * half that only exists when a sale does.
 *
 * ## The window: a week out, eight weeks wide
 *
 * `LEAD_DAYS` exists because a framework is a research instrument, and research
 * needs time to be done. A document for a sale three days away cannot change
 * what anybody does: the title search will not come back, the site visit will
 * not happen, and the deposit is already late. Seven days is the same floor
 * CAPE production uses for the same reason.
 *
 * `WEEKS` exists because the far end goes stale. A county can move a sale date,
 * pull the list, or publish a venue two months out, and a framework written
 * today for a sale in March asserts things nobody has checked recently. Eight
 * weeks is far enough to plan a season and near enough that the sale notice it
 * quotes is the one that will run.
 */
import "../lib/env";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getCounty } from "../lib/atlas";
import { buildFramework, longDate, type Framework, type FrameworkAuction } from "../lib/framework/content";
import { frameworkDocx } from "../lib/framework/docx";
import { frameworkHtml, frameworkBook } from "../lib/framework/html";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const OUT = arg("out") ?? path.join("artifacts", "frameworks");

/** Nearest a sale can be and still leave time to act on the document. */
const LEAD_DAYS = Number(arg("lead") ?? 7);
/** How far ahead to look, from the lead date. */
const WEEKS = Number(arg("weeks") ?? 8);

async function main() {
  const fips = arg("county");
  const state = arg("state");
  const date = arg("date");
  if (!fips && !state && !flag("all")) {
    console.error("Usage: npm run framework -- --county <FIPS> [--date YYYY-MM-DD] [--html]");
    console.error("       npm run framework -- --state <XX> [--every]");
    console.error("       npm run framework -- --all [--every] [--html]");
    process.exit(1);
  }

  const rows = (await db.execute(sql`
    select a.county_fips fips, a.sale_date::text d, a.sale_type, a.platform, a.start_time,
           a.source_url, a.logistics, a.announced_parcel_count ann, a.sale_date_confirmed conf,
           (select count(*) from lots l where l.auction_id = a.id)::int lots
    from auctions a
    join counties c on c.fips = a.county_fips
    where a.delisted_at is null
      ${date
        /* A named date is an instruction, not a suggestion — the window does not apply. */
        ? sql`and a.sale_date = ${date}::date`
        /* Cast the bounds: `current_date + $1` on an untyped bind is ambiguous to Postgres. */
        : sql`and a.sale_date >= current_date + (${LEAD_DAYS})::int
              and a.sale_date <= current_date + (${LEAD_DAYS + WEEKS * 7})::int`}
      ${fips ? sql`and a.county_fips = ${fips}` : sql``}
      ${state ? sql`and c.state = ${state}` : sql``}
    order by a.sale_date
  `)) as unknown as any[];

  if (rows.length === 0) {
    console.error(
      date ? `No sale on ${date} matches that.`
           : `No sale between ${LEAD_DAYS} and ${LEAD_DAYS + WEEKS * 7} days out matches that.`);
    process.exit(1);
  }

  if (!date) {
    console.log(`Window: sales ${LEAD_DAYS} to ${LEAD_DAYS + WEEKS * 7} days out ` +
                `(a week from now, ${WEEKS} weeks wide) — ${rows.length} sales\n`);
  }

  /*
   * One per county unless --every. The next sale is the one anybody is
   * preparing for, and a county running monthly would otherwise produce nine
   * near-identical documents whose only difference is the date.
   */
  const chosen = flag("every") ? rows : [...new Map(rows.map((r) => [r.fips, r])).values()];
  mkdirSync(OUT, { recursive: true });

  const made: { county: string; state: string; date: string; file: string;
                lots: number; ask: number; saleType: string }[] = [];
  const built: { fips: string; framework: Framework }[] = [];
  let failed = 0;

  for (const r of chosen) {
    const county = getCounty(r.fips);
    if (!county) { console.warn(`skipped ${r.fips}: not a county`); failed++; continue; }
    try {
    const auction: FrameworkAuction = {
      saleDate: r.d, saleType: r.sale_type, platform: r.platform, startTime: r.start_time,
      sourceUrl: r.source_url, logistics: r.logistics, lotCount: r.lots,
      announced: r.ann, saleDateConfirmed: r.conf,
    };
    const f = buildFramework(r.fips, auction);
    const base = `${county.name.replace(/[^A-Za-z0-9]+/g, "_")}_County_${county.state}_Framework_${r.d}`;

    writeFileSync(path.join(OUT, `${base}.docx`), await frameworkDocx(f));
    /* A single-county run still gets its own page; a batch gets the book. */
    if (flag("html") && !flag("all")) writeFileSync(path.join(OUT, `${base}.html`), frameworkHtml(f));

    console.log(`${base}.docx`);
    console.log(`   ${county.name} County, ${county.state} — ${longDate(r.d)}`);
    const ask = f.rows.filter((x) => x.source === "ask").length;
    made.push({ county: county.name, state: county.state, date: r.d, file: base,
                lots: r.lots, ask, saleType: f.rows[3].value });
    built.push({ fips: r.fips, framework: f });
    if (!flag("quiet")) {
      console.log(`${base}.docx`);
      console.log(`   ${county.name} County, ${county.state} — ${longDate(r.d)}`);
      console.log(`   ${f.sections.length} sections · ` +
                  `${f.rows.filter((x) => x.source === "county").length} county-researched, ` +
                  `${f.rows.filter((x) => x.source === "statute").length} statewide, ` +
                  `${ask} to confirm with the county · ${f.sources.length} sources`);
    }
    } catch (e) {
      /* One county's missing rule must not cost the other 484. */
      failed++;
      console.warn(`  ${county.name}, ${county.state}: ${(e as Error).message}`);
    }
  }

  if (flag("html")) {
    /*
     * One page holding every framework, not 485 pages plus a contents list.
     *
     * A folder of files is shareable only as a folder; a single page is
     * shareable as a link, which is what anyone actually sends. It also stays
     * under the artifact host's 255-file ceiling, which 485 documents would
     * not. The .docx files on disk remain the thing to email.
     */
    writeFileSync(path.join(OUT, "frameworks.html"), frameworkBook(built));
    console.log(`\nframeworks.html — ${built.length} frameworks in one page`);
  }
  const clean = made.filter((m) => m.ask === 0).length;
  console.log(`\n${made.length} written to ${OUT}${failed ? `, ${failed} failed` : ""}`);
  console.log(`${clean} need nothing confirmed with the county; ` +
              `${made.length - clean} have at least one row this system does not hold`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.cause?.message ?? e); process.exit(1); });
