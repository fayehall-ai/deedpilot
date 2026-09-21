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
 * The window and the one-per-county rule live in `lib/framework/select.ts`,
 * shared with the live /frameworks page and the weekly Drive delivery.
 */
import "../lib/env";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { longDate } from "../lib/framework/content";
import { frameworkDocx } from "../lib/framework/docx";
import { frameworkHtml, frameworkBook } from "../lib/framework/html";
import { frameworkSales, LEAD_DAYS, WEEKS } from "../lib/framework/select";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const OUT = arg("out") ?? path.join("artifacts", "frameworks");

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
  const lead = Number(arg("lead") ?? LEAD_DAYS);
  const weeks = Number(arg("weeks") ?? WEEKS);

  let failed = 0;
  const sales = await frameworkSales({
    fips, state, date, every: flag("every"), lead, weeks,
    onSkip: (f, why) => { failed++; console.warn(`  skipped ${f}: ${why}`); },
  });
  if (sales.length === 0) {
    console.error(date ? `No sale on ${date} matches that.` : `No sale between ${lead} and ${lead + weeks * 7} days out matches that.`);
    process.exit(1);
  }
  if (!date) console.log(`Window: sales ${lead} to ${lead + weeks * 7} days out (a week from now, ${weeks} weeks wide)\n`);

  mkdirSync(OUT, { recursive: true });
  let clean = 0;
  for (const s of sales) {
    const f = s.framework;
    writeFileSync(path.join(OUT, `${s.fileBase}.docx`), await frameworkDocx(f));
    /* A single-county run still gets its own page; a batch gets the book. */
    if (flag("html") && !flag("all")) writeFileSync(path.join(OUT, `${s.fileBase}.html`), frameworkHtml(f));
    const ask = f.rows.filter((x) => x.source === "ask").length;
    if (ask === 0) clean++;
    if (!flag("quiet")) {
      console.log(`${s.fileBase}.docx`);
      console.log(`   ${s.county.name} County, ${s.county.state} — ${longDate(s.saleDate)}`);
      console.log(`   ${f.sections.length} sections · ` +
                  `${f.rows.filter((x) => x.source === "county").length} county-researched, ` +
                  `${f.rows.filter((x) => x.source === "statute").length} statewide, ` +
                  `${ask} to confirm with the county · ${f.sources.length} sources`);
    }
  }

  if (flag("html")) {
    /*
     * One page holding every framework: a folder of files is shareable only as
     * a folder, a single page as a link. The same book is served live at
     * /frameworks; the .docx files remain the thing to email.
     */
    writeFileSync(path.join(OUT, "frameworks.html"), frameworkBook(sales.map((s) => ({ fips: s.fips, framework: s.framework }))));
    console.log(`\nframeworks.html — ${sales.length} frameworks in one page`);
  }
  console.log(`\n${sales.length} written to ${OUT}${failed ? `, ${failed} failed` : ""}`);
  console.log(`${clean} need nothing confirmed with the county; ${sales.length - clean} have at least one row this system does not hold`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.cause?.message ?? e); process.exit(1); });
