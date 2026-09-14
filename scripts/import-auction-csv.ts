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
 * ## Venue, contact and start time
 *
 * The other half of each row is logistics: a start time, the building the sale
 * is held in, and a named person at the county with a line and an address. No
 * adapter reads any of that off a county page, so before this ran the CAPE
 * checklist reported "Location" and "Official county contacts" as unverified on
 * every package in the system — and "Auction time" on every package too, for a
 * different and dumber reason, which `lib/cape/inputs.ts` now records.
 *
 * Venue and contact land on `auctions.logistics`, a column no adapter writes
 * and which `upsertAuction` therefore never overwrites. The start time is
 * different: `auctions.start_time` *is* adapter-owned, and the first version of
 * this script set it directly — which the 02:00 crawl then reverted, because
 * the upsert writes `coalesce(operator_overrides->>'startTime', excluded.start_time)`
 * and neither half held it any more. That is the exact failure
 * `lib/admin/auction-overrides.ts` was built to prevent, so the time now goes
 * through the override tier like any other correction, and only where the
 * county has published nothing itself.
 *
 * ## What is deliberately not imported
 *
 * "Bid Procedures" reads "Bid Up or Premium" on all 455 rows. A column with one
 * value across every county in nine states is not an observation, it is a
 * default somebody typed once — and it is wrong wherever a state bids down the
 * interest or allocates by rotation. Importing it would have put a confident
 * false sentence about bidding mechanics into hundreds of briefings.
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
import type { AuctionLogistics } from "../lib/db/schema";
import { policyFor } from "../lib/ingest/policy";
import { validateOverrides } from "../lib/admin/auction-override-fields";

/** Names this import wherever a value from it is shown or spoken. */
const SOURCE = "the TDC sale calendar";

/**
 * Clean a spreadsheet cell.
 *
 * These were pasted out of county web pages, so a fair number carry `&nbsp;`
 * and `&amp;nbsp;` as literal text and trail a run of empty comma-separated
 * fields — "Online auction, &nbsp;, &nbsp;, &nbsp;". Typos in the addresses
 * themselves ("Clevevland", "Timiami Trail") are left exactly as they are: they
 * are what the source says, and a venue is shown to a bidder as something to
 * confirm rather than as something we have checked.
 */
function cell(v: string | undefined): string | null {
  const s = (v ?? "")
    .replace(/&(amp;)?nbsp;?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*,\s*)+$/, "")
    .trim();
  return s || null;
}

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
      overrides: auctions.operatorOverrides,
      logistics: auctions.logistics,
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
  let venueOnline = 0, venuePhysical = 0, contactFilled = 0, logisticsWritten = 0;
  const examples: string[] = [];
  /* Where the counties are actually publishing now, counted. */
  const targets = new Map<string, number>();
  const byAdapter = new Map<string, number>();
  const blocked = new Map<string, number>();
  const badTimes = new Map<string, number>();
  let blockedByPolicy = 0;

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

      /* A link in a spreadsheet is not permission to fetch it. */
      const policy = policyFor(host(link));
      if (policy && policy.decision !== "allow") {
        blockedByPolicy++;
        blocked.set(host(link), (blocked.get(host(link)) ?? 0) + 1);
        continue;
      }
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

    /*
     * Venue and contact, as one object with its provenance attached.
     *
     * Rewritten wholesale rather than merged: every key in it comes from this
     * one spreadsheet row, so a merge could only ever splice a new venue onto a
     * stale contact. `importedAt` makes a re-import visible instead of silent.
     */
    const venueText = cell(r[7]);
    const contact = {
      name: cell(r[8]) ?? undefined,
      phone: cell(r[9]) ?? undefined,
      fax: cell(r[10]) ?? undefined,
      email: cell(r[11]) ?? undefined,
    };
    const hasContact = Boolean(contact.name || contact.phone || contact.email);

    if (venueText || hasContact) {
      const online = /^online\b/i.test(venueText ?? "");
      if (venueText && online) venueOnline++;
      else if (venueText) venuePhysical++;
      if (hasContact) contactFilled++;
      logisticsWritten++;

      const logistics: AuctionLogistics = {
        ...(venueText
          ? { venue: { text: venueText, kind: online ? "online" : ("in_person" as const) } }
          : {}),
        ...(hasContact ? { contact } : {}),
        source: SOURCE,
        importedAt: new Date().toISOString().slice(0, 10),
      };
      if (APPLY) {
        await db.update(auctions).set({ logistics }).where(eq(auctions.id, hit.id));
      }
    }

    /*
     * The start time goes in as an operator correction, not as a column write.
     *
     * `upsertAuction` sets `start_time` from
     * `coalesce(operator_overrides->>'startTime', excluded.start_time)` on every
     * crawl. Writing the column directly looked like it worked and was gone by
     * the next morning — the failure `lib/admin/auction-overrides.ts` exists to
     * stop. Validated through the same allow-list the admin form uses, because
     * an out-of-domain value here raises inside that upsert and would retire the
     * auction from every future crawl.
     *
     * Only where the county has published nothing: a real sale notice outranks a
     * spreadsheet, and where both exist the county is the one to believe.
     */
    if (!hit.startTime && startTime && !(hit.overrides ?? {}).startTime) {
      const problems = validateOverrides({ startTime });
      if (problems.length) {
        badTimes.set(startTime, (badTimes.get(startTime) ?? 0) + 1);
      } else {
        timeFilled++;
        if (APPLY) {
          await db
            .update(auctions)
            .set({
              operatorOverrides: { ...(hit.overrides ?? {}), startTime },
              editedBy: "sale-calendar-import",
              editedAt: new Date(),
            })
            .where(eq(auctions.id, hit.id));
        }
      }
    }
  }

  console.log(`matched to an upcoming sale        : ${matched}`);
  console.log(`  a better list URL than ours      : ${betterUrl}`);
  console.log(`    of those, no known adapter     : ${noAdapter}  (skipped — nothing to override)`);
  console.log(`    of those, policy says no       : ${blockedByPolicy}  (capture-only or robots-denied)`);
  console.log(`  start times we were missing      : ${timeFilled}  (as operator overrides)`);
  console.log(`  venue + contact to write         : ${logisticsWritten}`);
  console.log(`    of those, an online sale       : ${venueOnline}`);
  console.log(`    of those, a physical venue     : ${venuePhysical}`);
  console.log(`    carrying a named contact       : ${contactFilled}`);
  console.log(`  rows declaring no list exists    : ${declaredNoList}`);
  console.log(
    APPLY
      ? `\nwrote ${wroteOverride} source override(s) and ${logisticsWritten} logistics row(s)`
      : `\nreport only — pass --apply to write`,
  );
  if (badTimes.size) {
    console.log("\nstart times the override validator refused:");
    for (const [t, n] of [...badTimes].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${JSON.stringify(t)}`);
    }
  }
  if (examples.length) {
    console.log("\nbetter URLs:");
    for (const e of examples) console.log("  " + e);
  }
  if (blocked.size) {
    console.log("\nrefused on policy — a spreadsheet link is not permission:");
    for (const [h, n] of [...blocked].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${h}  (${policyFor(h)?.decision})`);
    }
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
