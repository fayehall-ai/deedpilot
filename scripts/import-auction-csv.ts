/**
 * Fold the auction spreadsheets in `downloads/` into the crawl.
 *
 *   npx tsx scripts/import-auction-csv.ts            # report only
 *   npx tsx scripts/import-auction-csv.ts --apply    # write
 *
 * ## What these files are, and what they are good for
 *
 * One row per upcoming sale: date, start time, venue, a named contact with a
 * phone and an email, a parcel count, the bid procedure, and — for a little
 * over half of them — a link to the county's own property list.
 *
 * The obvious hope was that the links would fill the two hundred sales with no
 * located source. They do not: every row that matches a sale we hold already
 * has a `source_url`. What they carry instead is often a *better* URL — the
 * platform the sale actually runs on rather than the county page that mentions
 * it:
 *
 *   Collier, FL   ours: colliertaxcollector.com
 *                 csv : lienhub.com/county/collier/certsale/main
 *   Gadsden, FL   ours: …/Tax_deed_disclaimer.html
 *                 csv : gadsdenfl.realtaxlien.com
 *
 * A county page that mentions a sale is not a list a parser can read. That is
 * most of what "crawled, county published no parsable list" has been recording.
 *
 * ## Why overrides rather than rewriting `source_url`
 *
 * `lib/ingest/source-overrides.ts` already exists for exactly this — an
 * operator correction to where a county publishes, applied at the one choke
 * point every adapter passes through. It also reports a URL override as
 * *inapplicable* where the binding has no URL to replace, which is the honest
 * answer for `tx-lgbs` and `mi-taxsaleinfo`: they resolve a source from a law
 * firm's multi-county page or a platform catalog id, and there is no
 * per-county URL in them to swap. Writing `auctions.source_url` directly would
 * bypass that and quietly change provenance on a row nobody edited.
 *
 * ## The rows with no link are not waste
 *
 * Two hundred and ten say "No public online list link available—verify with
 * county". That is a positive statement that no list exists, which is worth
 * more than silence: it is the difference between a county we have not looked
 * at and one that genuinely does not publish. Reported, not written, until
 * there is a field that means it.
 */
import "../lib/env";
import { readdirSync, readFileSync } from "node:fs";
import { and, eq, gte, sql as dsql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, counties, ingestRuns, sourceOverrides } from "../lib/db/schema";

const APPLY = process.argv.includes("--apply");
const DIR = "downloads";

const ABBR: Record<string, string> = {
  Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",
  Delaware:"DE",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",
  Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",
  Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV",
  "New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC",
  "North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI",
  "South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",
  Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY",
};

/** Tolerant CSV: these are spreadsheet exports with quoted commas in addresses. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+county$/, "").replace(/[^a-z0-9]/g, "");
const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

async function main() {
  const rows: string[][] = [];
  for (const f of readdirSync(DIR).filter((x) => x.toLowerCase().endsWith(".csv"))) {
    const parsed = parseCSV(readFileSync(`${DIR}/${f}`, "utf8"));
    rows.push(...parsed.slice(1).filter((r) => r.length >= 18 && r[0].trim()));
  }
  console.log(`${rows.length} row(s) across the spreadsheets\n`);

  const live = await db
    .select({
      id: auctions.id,
      fips: counties.fips,
      name: counties.name,
      state: counties.state,
      sourceUrl: auctions.sourceUrl,
      startTime: auctions.startTime,
      lotCount: auctions.lotCount,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(gte(auctions.saleDate, dsql`current_date`));

  const byKey = new Map<string, (typeof live)[number]>();
  for (const r of live) byKey.set(`${r.state}|${norm(r.name)}`, r);

  /* The adapter a county is actually crawled by, for the override row. */
  const adapters = new Map<string, string>();
  for (const r of await db
    .selectDistinct({ fips: ingestRuns.countyFips, adapter: ingestRuns.adapter })
    .from(ingestRuns)) {
    if (r.fips && !adapters.has(r.fips)) adapters.set(r.fips, r.adapter);
  }

  let matched = 0, betterUrl = 0, wroteOverride = 0, noAdapter = 0;
  let timeFilled = 0, declaredNoList = 0;
  const examples: string[] = [];
  /* Where the counties are actually publishing now, counted. */
  const targets = new Map<string, number>();
  const byAdapter = new Map<string, number>();

  for (const r of rows) {
    const st = ABBR[r[1].trim()];
    if (!st) continue;
    const hit = byKey.get(`${st}|${norm(r[0])}`);
    if (!hit) continue;
    matched++;

    const link = (r[17] ?? "").trim();
    const startTime = (r[3] ?? "").trim();

    if (/no public online list/i.test(link)) declaredNoList++;

    if (/^https?:\/\//i.test(link) && host(link) && host(link) !== host(hit.sourceUrl ?? "")) {
      betterUrl++;
      targets.set(host(link), (targets.get(host(link)) ?? 0) + 1);
      const adapter = adapters.get(hit.fips);
      if (adapter) byAdapter.set(adapter, (byAdapter.get(adapter) ?? 0) + 1);
      if (!adapter) { noAdapter++; continue; }
      if (examples.length < 8) {
        examples.push(`${hit.name}, ${hit.state} [${adapter}]  ${host(hit.sourceUrl ?? "") || "—"} → ${host(link)}`);
      }
      if (APPLY) {
        const existing = await db
          .select({ id: sourceOverrides.id })
          .from(sourceOverrides)
          .where(and(eq(sourceOverrides.adapter, adapter), eq(sourceOverrides.countyFips, hit.fips)))
          .limit(1);
        if (existing.length === 0) {
          await db.insert(sourceOverrides).values({
            adapter,
            countyFips: hit.fips,
            url: link,
            enabled: true,
            note: "auction spreadsheet — county's own property-list link",
          });
          wroteOverride++;
        }
      }
    }

    if (!hit.startTime && startTime) {
      timeFilled++;
      if (APPLY) {
        await db.update(auctions).set({ startTime }).where(eq(auctions.id, hit.id));
      }
    }
  }

  console.log(`matched to an upcoming sale        : ${matched}`);
  console.log(`  a better list URL than ours      : ${betterUrl}`);
  console.log(`    of those, no known adapter     : ${noAdapter}  (skipped — nothing to override)`);
  console.log(`  start times we were missing      : ${timeFilled}`);
  console.log(`  rows declaring no list exists    : ${declaredNoList}`);
  console.log(APPLY ? `\nwrote ${wroteOverride} source override(s)` : `\nreport only — pass --apply to write`);
  if (examples.length) {
    console.log("\nbetter URLs:");
    for (const e of examples) console.log("  " + e);
  }
  if (targets.size) {
    /*
     * Grouped by destination, because a cluster of counties pointing at one
     * host is a platform we do not have an adapter for — a different and
     * larger finding than a handful of moved URLs.
     */
    console.log("\nwhere those counties actually publish:");
    for (const [h, n] of [...targets].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${h}`);
    }
    console.log("\nby the adapter that crawls them today:");
    for (const [a, n] of [...byAdapter].sort((x, y) => y[1] - x[1])) {
      console.log(`  ${String(n).padStart(3)}  ${a}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
