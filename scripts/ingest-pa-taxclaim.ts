/**
 * Attach parcels to Pennsylvania sales from the county's own Tax Claim PDF.
 *
 *   npx tsx scripts/ingest-pa-taxclaim.ts --dry-run
 *   npx tsx scripts/ingest-pa-taxclaim.ts --fips 42079
 *   npx tsx scripts/ingest-pa-taxclaim.ts
 *
 * ## Why this attaches rather than discovers
 *
 * It is not an adapter and deliberately creates no auctions. The sales are
 * already in the database — imported from USTLA, with dates the county
 * published — and what is missing is their parcels. An adapter would discover
 * the same sale a second time under its own external id, and this repository
 * has just spent a day collapsing three records of one Lake County sale into
 * one. Writing lots onto the row that already exists avoids repeating that.
 *
 * So the unit of work is an auction that has no lots and a county profile, and
 * the output is lots on that auction. Nothing else is touched.
 *
 * ## What it costs
 *
 * Nothing. Every county here publishes its list as a public PDF on its own Tax
 * Claim Bureau page, fetched through `politeFetch` so the policy layer, live
 * robots and the per-host delay all stay in the path. The same parcels are sold
 * commercially; this reads the county's own copy.
 *
 * ## The honest limit
 *
 * `lib/ingest/pa-taxclaim.ts` carries one regex per county because Pennsylvania
 * is not one format — Luzerne and Somerset were read end to end and share
 * neither their identifier, their column order, nor how many price columns they
 * print. Counties without a profile are skipped and named, not guessed at. A
 * regex that half-matches a layout yields plausible parcels with wrong prices,
 * and a wrong price becomes a wrong bid.
 */
import "../lib/env";
import * as cheerio from "cheerio";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, counties, lots } from "../lib/db/schema";
import { politeFetch } from "../lib/ingest/fetch";
import { pdfToText } from "../lib/ingest/parse";
import { PA_PROFILES, parsePaList, profileFor, type PaCountyProfile } from "../lib/ingest/pa-taxclaim";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

/** Absolute URLs of every PDF linked from a page. */
function pdfsOn($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const out = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !/\.pdf(\?|$)/i.test(href)) return;
    try {
      out.add(new URL(href, pageUrl).toString());
    } catch {
      /* A malformed href is not worth failing the county over. */
    }
  });
  return [...out];
}

/**
 * The sale-list PDF for a county, following at most one hop.
 *
 * One hop, not a crawl: Luzerne's Tax Claim home links to `/tax-sales` and the
 * PDFs live there, which is the deepest any profiled county has been. Following
 * further would turn a targeted fetch into a spider over a county website.
 */
async function findListPdf(profile: PaCountyProfile): Promise<string | null> {
  const page = await politeFetch(profile.listPage);
  if (page.status !== 200) {
    console.log(`  ${profile.county}: ${profile.listPage} returned ${page.status}`);
    return null;
  }

  const $ = cheerio.load(page.body);
  const direct = pdfsOn($, page.url).find((u) => profile.pdf.test(u));
  if (direct) return direct;

  if (!profile.follow) return null;

  const next = $("a[href]")
    .toArray()
    .map((el) => $(el).attr("href") ?? "")
    .find((h) => profile.follow!.test(h));
  if (!next) return null;

  const hop = await politeFetch(new URL(next, page.url).toString());
  if (hop.status !== 200) return null;
  return pdfsOn(cheerio.load(hop.body), hop.url).find((u) => profile.pdf.test(u)) ?? null;
}

async function main() {
  const dry = flag("dry-run");
  const only = arg("fips");

  const profiles = only ? PA_PROFILES.filter((p) => p.fips === only) : PA_PROFILES;
  if (profiles.length === 0) {
    console.error(`No profile for ${only}. Profiled: ${PA_PROFILES.map((p) => p.fips).join(", ")}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const targets = await db
    .select({
      id: auctions.id,
      fips: auctions.countyFips,
      county: counties.name,
      saleDate: auctions.saleDate,
      announced: auctions.announcedParcelCount,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(
      and(
        eq(counties.state, "PA"),
        gte(auctions.saleDate, today),
        isNull(auctions.delistedAt),
        sql`not exists (select 1 from ${lots} l where l.auction_id = ${auctions.id})`,
      ),
    );

  const work = targets.filter((t) => profiles.some((p) => p.fips === t.fips));
  const blocked = profiles.filter((p) => p.blocked);
  if (blocked.length > 0 && !only) {
    for (const b of blocked) console.log(`  ${b.county}: parser verified, host blocks us — ${b.blocked}`);
  }
  const skipped = targets.filter((t) => !profileFor(t.fips));

  console.log(
    `${targets.length} PA sale(s) upcoming with no lots; ${work.length} have a county profile.`,
  );
  if (skipped.length > 0 && !only) {
    console.log(
      `  no profile yet: ${[...new Set(skipped.map((s) => `${s.county} (${s.fips})`))].join(", ")}`,
    );
  }
  if (work.length === 0) process.exit(0);

  let wrote = 0;
  for (const t of work) {
    const profile = profileFor(t.fips)!;
    console.log(`\n${profile.county} — sale ${t.saleDate}, ${t.announced ?? "?"} announced`);

    if (profile.blocked) {
      console.log(`  skipped — ${profile.blocked}`);
      continue;
    }

    /*
     * Per county, because one host's posture is not a fact about the others.
     * The first version let a PolicyBlockedError from Somerset abort the whole
     * run, discarding the counties after it in the list.
     */
    let pdf: string | null;
    try {
      pdf = await findListPdf(profile);
    } catch (e) {
      console.log(`  ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!pdf) {
      console.log(`  no sale-list PDF matched ${profile.pdf} — skipped`);
      continue;
    }
    console.log(`  ${pdf}`);

    let text: string;
    try {
      text = await pdfToText(pdf);
    } catch (e) {
      console.log(`  could not read the PDF: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const { lots: parsed, unmatched } = parsePaList(text, profile);
    console.log(
      `  ${parsed.length} parcel(s) parsed` +
        (unmatched.length > 0 ? `, ${unmatched.length} row-like line(s) did not match` : ""),
    );
    for (const u of unmatched.slice(0, 3)) console.log(`    unmatched: ${u.slice(0, 96)}`);

    /*
     * A profile that suddenly matches nothing has drifted from the county's
     * layout, and writing zero lots over a sale that announced hundreds would
     * look like the county published nothing. Left alone instead.
     */
    if (parsed.length === 0) {
      console.log(`  nothing parsed — profile may have drifted; left untouched`);
      continue;
    }

    if (dry) continue;

    const rows = parsed.map((l) => ({
      auctionId: t.id,
      countyFips: t.fips,
      dedupeKey: l.parcelNumber!.trim(),
      parcelNumber: l.parcelNumber,
      lotNumber: l.lotNumber,
      legalDescription: l.legalDescription,
      openingBid: l.openingBid === undefined ? null : String(l.openingBid),
      taxesOwed: l.taxesOwed === undefined ? null : String(l.taxesOwed),
      status: "pending" as const,
      sourceUrl: pdf,
    }));

    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(lots)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing({ target: [lots.auctionId, lots.dedupeKey] });
    }
    wrote += rows.length;
    console.log(`  wrote ${rows.length} lot(s)`);
  }

  console.log(dry ? `\n(dry run — nothing written)` : `\n${wrote} lot(s) written.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
