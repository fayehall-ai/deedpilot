/**
 * Find and sample the sale list a county publishes for itself.
 *
 *   npx tsx scripts/recon-sale-lists.ts --state KY --out artifacts/recon
 *   npx tsx scripts/recon-sale-lists.ts --state PA --out artifacts/recon
 *   npx tsx scripts/recon-sale-lists.ts --fips 42049 --out artifacts/recon
 *
 * Reconnaissance only — writes nothing to the database. For every sale in the
 * state that has no parcels, it tries the pages we already know about, finds
 * the likeliest sale-list PDF, and saves the first lines of its extracted text.
 *
 * Written for Pennsylvania and then generalised, because nothing in it was
 * actually about Pennsylvania: every state has counties that publish a list, a
 * directory entry pointing at roughly the right page, and a PDF that has to be
 * read before anyone can write a parser for it. Kentucky is the next test —
 * 27 upcoming sales, 28,864 announced parcels and not one of them held.
 *
 * ## Why a separate pass
 *
 * Writing a profile means looking at what one county's PDF actually says: the
 * columns run together in ways only that county does, and the regex has to be
 * written against the extracted text rather than the table a human sees. Doing
 * that county by county interactively costs a fetch and a wait each time.
 * Gathering the samples in one bounded sweep turns sixty separate
 * investigations into one reading session.
 *
 * ## Where the candidate pages come from
 *
 * Two sources we already hold, in order: the auction's own `source_url`, which
 * for most Pennsylvania sales is already the Tax Claim Bureau page, and any
 * `delinquent` or `foreclosure` link the OnlineSearches directory crawl found
 * for that county. Nothing is guessed from a URL pattern — a county that has
 * neither is reported as such, which is a finding rather than a failure.
 *
 * Every request goes through `politeFetch`, so a host that disallows us is
 * skipped and named instead of crawled.
 */
import "../lib/env";
import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, counties, lots } from "../lib/db/schema";
import { politeFetch } from "../lib/ingest/fetch";
import { pdfToText } from "../lib/ingest/parse";
import { profileFor } from "../lib/ingest/pa-taxclaim";
import directory from "../data/county-directory.json";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/**
 * A PDF that reads like a sale *list*.
 *
 * The first version matched on "upset|judicial|sale" alone and brought back
 * bidder registration forms, sale-condition sheets, a fee ordinance and last
 * year's results — 7 of 11 samples were not lists at all. Counties put the word
 * "sale" on everything in the folder, so the exclusions below do more work than
 * the inclusions.
 */
const SALE_PDF = /(upset|judicial|repository|tax[-_\s]*sale|sale[-_\s]*list|delinquent)/i;
/** Documents about a sale that are not the list of what is in it. */
const NOT_A_LIST =
  /(bidder|registration|application|affidavit|condition|instruction|ordinance|fee|result|form|notice[-_\s]*of[-_\s]*sale|faq|policy|rules)/i;
/** A link worth one hop when the landing page carries no list. */
const FOLLOW = /(tax[-_\s]*sale|upset|judicial|repository|sale[-_\s]*list|delinquent)/i;

function pdfsOn($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const out = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !/\.pdf(\?|$)/i.test(href)) return;
    try {
      out.add(new URL(href, pageUrl).toString());
    } catch {
      /* malformed href */
    }
  });
  return [...out];
}

/** Candidate pages for one county, best first. */
/**
 * The likeliest sale list among a page's PDFs.
 *
 * Current year first, because a Tax Claim folder keeps every prior year and the
 * newest file is the one describing a sale that has not happened. Dauphin is
 * the case: its folder holds a "2026-judicial-sale-list" for a sale that ran in
 * June, and no list at all for the September upset sale it has coming.
 */
function pickList(urls: string[]): string | null {
  const lists = urls.filter((u) => SALE_PDF.test(u) && !NOT_A_LIST.test(u));
  if (lists.length === 0) return null;
  const year = String(new Date().getFullYear());
  return lists.find((u) => u.includes(year)) ?? lists[0];
}

function candidatePages(fips: string, sourceUrl: string | null): string[] {
  const dir = (directory as Record<string, { links?: { kind?: string; url?: string }[] }>)[fips];
  const fromDir = (dir?.links ?? [])
    .filter((l) => /delinq|foreclos/i.test(l.kind ?? ""))
    .map((l) => l.url!)
    .filter(Boolean);
  return [...new Set([sourceUrl, ...fromDir].filter((u): u is string => Boolean(u)))];
}

async function main() {
  const outDir = arg("out") ?? join(process.cwd(), "artifacts", "recon");
  const only = arg("fips");
  /* A --fips implies its state; otherwise say which one. */
  const state = (arg("state") ?? (only ? "" : "PA")).toUpperCase();
  await mkdir(outDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      fips: auctions.countyFips,
      county: counties.name,
      saleDate: auctions.saleDate,
      announced: auctions.announcedParcelCount,
      sourceUrl: auctions.sourceUrl,
    })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(
      and(
        state ? eq(counties.state, state) : sql`true`,
        gte(auctions.saleDate, today),
        isNull(auctions.delistedAt),
        sql`not exists (select 1 from ${lots} l where l.auction_id = ${auctions.id})`,
      ),
    );

  /* One row per county — several sales can share a Tax Claim Bureau page. */
  const byCounty = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (only && r.fips !== only) continue;
    /* PA profiles are the only ones that exist; elsewhere nothing is done yet. */
    if (state === "PA" && profileFor(r.fips)) continue;
    const prev = byCounty.get(r.fips);
    if (!prev || (r.announced ?? 0) > (prev.announced ?? 0)) byCounty.set(r.fips, r);
  }

  console.log(`${byCounty.size} ${state || "selected"} county/counties to survey\n`);

  const found: string[] = [];
  const noPdf: string[] = [];
  const blocked: string[] = [];

  for (const [fips, r] of [...byCounty].sort(
    (a, b) => (b[1].announced ?? 0) - (a[1].announced ?? 0),
  )) {
    const label = `${r.county} (${fips}, ${r.announced ?? "?"} announced)`;
    const pages = candidatePages(fips, r.sourceUrl);
    if (pages.length === 0) {
      noPdf.push(`${label} — no candidate page`);
      console.log(`  ${label}: no candidate page`);
      continue;
    }

    let pdf: string | null = null;
    let why = "no sale-list PDF found";
    const blockedPages: string[] = [];

    for (const page of pages) {
      if (pdf) break;
      try {
        const res = await politeFetch(page);
        if (res.status !== 200) {
          why = `${page} → ${res.status}`;
          continue;
        }
        const $ = cheerio.load(res.body);
        pdf = pickList(pdfsOn($, res.url));
        if (pdf) break;

        /* One hop, the Luzerne shape: landing page links to a sale page. */
        const next = $("a[href]")
          .toArray()
          .map((el) => $(el).attr("href") ?? "")
          .find((h) => FOLLOW.test(h));
        if (!next) continue;
        const hop = await politeFetch(new URL(next, res.url).toString());
        if (hop.status !== 200) continue;
        pdf = pickList(pdfsOn(cheerio.load(hop.body), hop.url));
      } catch (e) {
        /*
         * A blocked candidate is a fact about that host, not about the county.
         * Erie's auction points at govease.com, which we may not crawl — and
         * the county's own eriecountypa.gov pages are in the directory right
         * behind it. Breaking here skipped 2,044 parcels for no reason.
         */
        why = e instanceof Error ? e.message.slice(0, 110) : String(e);
        if (/robots|policy/i.test(why)) blockedPages.push(why);
      }
    }

    if (!pdf) {
      /* Only a county with nothing left to try counts as blocked. */
      if (blockedPages.length > 0 && blockedPages.length === pages.length) {
        blocked.push(`${label} — ${blockedPages[0]}`);
        console.log(`  ${label}: every candidate page blocked`);
      } else {
        noPdf.push(`${label} — ${why}`);
        console.log(`  ${label}: ${why}`);
      }
      continue;
    }

    try {
      const text = await pdfToText(pdf);
      const lines = text.split("\n").filter((l) => l.trim()).slice(0, 40);
      await writeFile(
        join(outDir, `${fips}-${r.county!.replace(/\W+/g, "")}.txt`),
        `# ${label}\n# sale ${r.saleDate}\n# ${pdf}\n\n${lines.join("\n")}\n`,
        "utf8",
      );
      found.push(`${label} → ${pdf}`);
      console.log(`  ${label}: ${lines.length} line(s) sampled`);
    } catch (e) {
      noPdf.push(`${label} — PDF unreadable: ${e instanceof Error ? e.message.slice(0, 70) : e}`);
      console.log(`  ${label}: PDF unreadable`);
    }
  }

  console.log(`\n=== survey ===`);
  console.log(`sampled:      ${found.length}`);
  console.log(`no list PDF:  ${noPdf.length}`);
  console.log(`host blocks:  ${blocked.length}`);
  for (const b of blocked) console.log(`  ${b}`);
  console.log(`\nsamples in ${outDir}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
