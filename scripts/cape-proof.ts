/**
 * Build the proofreading page from whatever scripts are in the database.
 *
 *   npx tsx scripts/cape-proof.ts                 # writes artifacts/cape-proof.html
 *   npx tsx scripts/cape-proof.ts --out /tmp/x.html
 *
 * ## Why the county half is counted separately
 *
 * 815 sales sit in 523 counties, and the statute, redemption, deed and
 * submarket sections are now written once per county and reused verbatim. That
 * changes what proofreading this actually costs. Ed does not have nineteen
 * Monmouth briefings to read; he has one Monmouth explanation of New Jersey
 * lien law, and nineteen short sale-day sections around it. A page that
 * presented all nineteen in full would ask him to re-read identical paragraphs
 * eighteen times and would bury the parts that differ.
 *
 * So every section carries `scope`, and a county-scoped one carries how many
 * sales it is spoken in. A correction to a shared paragraph is worth nineteen
 * corrections; the page says so rather than leaving him to notice.
 *
 * ## The template is the published page
 *
 * `templates/cape-proof.html` was extracted from the live artifact rather than
 * rewritten, so republishing cannot silently lose the review state Ed has
 * already recorded against it — the `db` collection is keyed by script slug and
 * the markup that reads it is the same markup.
 */
import "../lib/env";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, capeCountyScripts, capeProductions, counties } from "../lib/db/schema";
import { capePackageInputs } from "../lib/cape/inputs";
import { capeInputsHash } from "../lib/cape/components";
import { figurePhrases } from "../lib/cape/script";
import { policyFor } from "../lib/ingest/policy";
import { loadRegistry } from "../lib/ingest/adapters/generic";
import { ingestRuns } from "../lib/db/schema";

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i !== -1 ? process.argv[i + 1] : path.join("artifacts", "cape-proof.html");
})();

interface OutSection {
  heading: string;
  narration: string;
  /** "county" is reused across this county's sales; "sale" is written per sale. */
  scope: "county" | "sale";
}

interface OutScript {
  slug: string;
  county: string;
  state: string;
  saleDate: string;
  saleType: string | null;
  platform: string | null;
  /** Parcel rows this database holds. Zero is ordinary — see `announced`. */
  parcels: number;
  /**
   * Parcels the county says it is offering, where nothing has crawled the list.
   *
   * 389 of 461 packages are in exactly this state, and showing only `parcels`
   * rendered every one of them as "0 parcels" — which reads as a sale with
   * nothing in it, rather than a sale of 1,697 parcels whose list has not been
   * fetched. The two figures are different claims and the page now makes both.
   */
  announced: number | null;
  /**
   * Why this sale has no parcel list, in the reviewer's words.
   *
   * "List not crawled" is true of 90% of packages and tells a reader nothing
   * they can act on. The reasons behind it are completely different problems —
   * a platform we are contractually barred from, a county nobody has located a
   * source for, a source located and never tried, and a county page that simply
   * does not publish a parcel list — and only the reader can judge whether a
   * briefing is worth recording given which one applies.
   */
  whyNoList: string | null;
  /**
   * The address on file for this sale, shown when there is no parcel list.
   *
   * A reviewer told only "no county source has been located" cannot tell a
   * wrong address from a missing one, and those need opposite fixes. Seeing
   * `publicrecords.onlinesearches.com` next to that sentence says immediately
   * that the county was never pointed at its own site.
   */
  sourceUrl: string | null;
  /** True when the package was held and never went to audio. */
  held: boolean;
  /** Why it was held, in the operator's words. */
  heldWhy: string | null;
  flagged: string[];
  /**
   * The words behind each flagged figure, as they were written.
   *
   * The figure itself is not in the script: "480" is what the parser made of
   * "four hundred eighty". The page said "highlighted below" and highlighted
   * nothing, because it searched the narration for digits that were never
   * spoken — leaving a reviewer with an accusation they could not check.
   */
  flaggedPhrases: string[];
  title: string;
  takeaway: string;
  sections: OutSection[];
  /** How many upcoming sales share this county's standing sections. */
  sharedWith: number;
  /**
   * True when this script was written from the fact sheet currently in force.
   *
   * Shown rather than hidden. A regeneration pass takes hours, and during it
   * the page holds a mixture — a reviewer told "these are the scripts" while
   * three quarters of them still say "Assessor/GIS not in file" would waste an
   * afternoon reporting a fault that is already fixed and queued.
   */
  current: boolean;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const rows = await db
    .select({
      fips: counties.fips,
      county: counties.name,
      state: counties.state,
      saleDate: auctions.saleDate,
      saleType: auctions.saleType,
      platform: auctions.platform,
      lotCount: auctions.lotCount,
      announced: auctions.announcedParcelCount,
      sourceUrl: auctions.sourceUrl,
      script: capeProductions.script,
      figures: capeProductions.unsupportedFigures,
      stage: capeProductions.stage,
      error: capeProductions.error,
      auctionId: auctions.id,
      hash: capeProductions.inputsHash,
    })
    .from(capeProductions)
    .innerJoin(auctions, eq(auctions.id, capeProductions.auctionId))
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .orderBy(asc(counties.state), asc(counties.name), asc(auctions.saleDate));

  /*
   * Which sections came from a cached county half, resolved by matching text
   * rather than by position.
   *
   * Position would be the obvious way and would be wrong the first time a
   * county has no submarkets: the running order shifts and every later section
   * is mislabelled. The text is what was actually reused, so the text is what
   * identifies it.
   */
  /* What the fact sheet in force would hash to, per package. */
  const inputs = await capePackageInputs();
  const wanted = new Map(inputs.map((i) => [i.auctionId, capeInputsHash(i)]));

  /* Everything needed to say why a list is missing, read once. */
  const registry = loadRegistry();
  const crawlHistory = new Map<string, { runs: number; lots: number }>();
  for (const r of (await db
    .select({
      fips: ingestRuns.countyFips,
      runs: sql<number>`count(*)::int`,
      lots: sql<number>`coalesce(sum(${ingestRuns.lotsFound}), 0)::int`,
    })
    .from(ingestRuns)
    .groupBy(ingestRuns.countyFips)) as { fips: string | null; runs: number; lots: number }[]) {
    if (r.fips) crawlHistory.set(r.fips, { runs: r.runs, lots: r.lots });
  }

  const hostOf = (u: string | null) => {
    try {
      return u ? new URL(u).hostname.replace(/^www\./, "") : "";
    } catch {
      return "";
    }
  };

  /**
   * One sentence naming the actual obstacle.
   *
   * Ordered by which fact settles the question. A policy block settles it
   * whatever else is true; after that, whether anyone has located a source;
   * then whether it was ever tried; then what trying produced.
   */
  function whyNoList(fips: string, platform: string | null, sourceUrl: string | null): string {
    const host = hostOf(sourceUrl);
    const policy = host ? policyFor(host) : null;
    if (policy && policy.decision !== "allow") {
      return `${host} needs a data agreement before it can be read — the sale is real, the list is behind a platform we do not crawl`;
    }

    const entry = registry?.counties?.[fips];
    if (!entry || entry.isGap) {
      return /onlinesearches|publicrecords/i.test(host)
        ? `no county source has been located — the address on file is a records directory, not the county's own list`
        : `no county source has been located yet; nothing knows where this county publishes its list`;
    }

    const history = crawlHistory.get(fips);
    if (!history || history.runs === 0) {
      return `a source is on file and has never been fetched — this county has not been crawled yet`;
    }
    if (history.lots === 0) {
      return `crawled ${history.runs} time(s); the county page names the sale but publishes no parcel list a parser can read`;
    }
    return `crawled ${history.runs} time(s) and has yielded parcels before, but nothing for this sale yet`;
  }

  const halves = await db.select().from(capeCountyScripts);
  const countyText = new Map<string, Set<string>>();
  const countyUses = new Map<string, number>();
  for (const h of halves) {
    const secs = h.sections as unknown as {
      howItWorks: { narration: string };
      redemption: { narration: string };
      deedConveys: { narration: string };
      submarkets: { narration: string }[];
    };
    const all = [secs.howItWorks, secs.redemption, secs.deedConveys, ...(secs.submarkets ?? [])];
    countyText.set(h.countyFips, new Set(all.map((x) => x.narration)));
    countyUses.set(h.countyFips, h.usedCount);
  }

  const out: OutScript[] = [];
  let skipped = 0;
  let notUpcoming = 0;
  let heldBack = 0;
  const heldNames: string[] = [];

  for (const r of rows) {
    const s = r.script as unknown as {
      title: string;
      keyTakeaway: string;
      sections: { heading: string; narration: string }[];
    } | null;
    if (!s?.sections?.length) {
      skipped++;
      continue;
    }

    /*
     * Only packages the pipeline still considers upcoming.
     *
     * 33 stored scripts belong to sales that have passed or that no longer meet
     * the inventory bar, so nothing will ever rewrite them. Left in, they were
     * three per cent of the page permanently marked "older fact sheet" — which
     * meant the rewrite banner could never clear, and a reviewer was being
     * handed briefings for auctions that already happened. Neither is a thing
     * to proofread.
     */
    if (!wanted.has(r.auctionId)) {
      notUpcoming++;
      continue;
    }

    /*
     * A held script does not go to the reviewer.
     *
     * Held means the narration speaks a figure that is not in the computed
     * facts, and every such flag in this run turned out to be the verifier
     * failing to recognise a fact written one way and spoken another — a price
     * as "$110.25", deposit tiers as "$2k/$5k/$10k", a borough named Forty Fort.
     * Handing those to a proofreader spends an expert's afternoon confirming
     * that a number he can see in the source is in the source.
     *
     * The ones that are not false positives are worse to send: a held script is
     * blocked from production, so a reviewer would be correcting copy that
     * cannot ship until someone here has dealt with it anyway. Either way it is
     * this system's problem before it is his. The count is printed loudly so
     * nobody has to remember to look.
     */
    if ((r.figures ?? []).length > 0 || r.error) {
      heldBack++;
      if (heldNames.length < 10) heldNames.push(`${r.county}, ${r.state} ${r.saleDate}`);
      continue;
    }
    const shared = countyText.get(r.fips) ?? new Set<string>();
    out.push({
      slug: `${r.state.toLowerCase()}-${slugify(r.county)}-${r.saleDate}`,
      county: r.county,
      state: r.state,
      saleDate: r.saleDate,
      saleType: r.saleType,
      platform: r.platform,
      parcels: r.lotCount,
      announced: r.announced,
      whyNoList: r.lotCount > 0 ? null : whyNoList(r.fips, r.platform, r.sourceUrl),
      sourceUrl: r.lotCount > 0 ? null : r.sourceUrl,
      held: (r.figures ?? []).length > 0 || Boolean(r.error),
      heldWhy: r.error ?? null,
      flagged: r.figures ?? [],
      flaggedPhrases: [
        ...new Set(
          (r.figures ?? []).length === 0
            ? []
            : s.sections.flatMap((sec) => figurePhrases(sec.narration, r.figures ?? [])),
        ),
      ],
      title: s.title,
      takeaway: s.keyTakeaway,
      sections: s.sections.map((sec) => ({
        heading: sec.heading,
        narration: sec.narration,
        scope: shared.has(sec.narration) ? ("county" as const) : ("sale" as const),
      })),
      sharedWith: countyUses.get(r.fips) ?? 1,
      current: wanted.get(r.auctionId) === r.hash,
    });
  }

  const template = readFileSync("templates/cape-proof.html", "utf8");
  const marker = /\/\*DATA\*\/[\s\S]*?\/\*DATA\*\//;
  if (!marker.test(template)) throw new Error("templates/cape-proof.html has no /*DATA*/ marker");

  /* `</script>` inside a JSON string would end the tag early. */
  const json = JSON.stringify(out).replace(/</g, "\\u003c");
  const html = template.replace(marker, `/*DATA*/${json}/*DATA*/`);

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);

  const countySections = out.reduce((n, d) => n + d.sections.filter((x) => x.scope === "county").length, 0);
  const saleSections = out.reduce((n, d) => n + d.sections.filter((x) => x.scope === "sale").length, 0);
  const words = out.reduce(
    (n, d) => n + d.sections.reduce((m, x) => m + x.narration.trim().split(/\s+/).length, 0), 0);

  console.log(`${out.length} script(s) written to ${OUT}  (${Math.round(html.length / 1024)} KB)`);
  if (skipped) console.log(`  ${skipped} production row(s) had no script yet — omitted`);
  if (notUpcoming) {
    console.log(`  ${notUpcoming} script(s) for sales no longer upcoming — omitted`);
  }
  if (heldBack) {
    console.log(`\n  ${heldBack} HELD and withheld from review — deal with these before publishing:`);
    for (const n of heldNames) console.log(`    ${n}`);
    if (heldBack > heldNames.length) console.log(`    …and ${heldBack - heldNames.length} more`);
  }
  console.log(`  ${countySections} county-scoped section(s), ${saleSections} sale-scoped`);
  console.log(`  ${halves.length} county half/halves on file`);
  console.log(`  ${words.toLocaleString()} spoken words in total`);
  const fresh = out.filter((d) => d.current).length;

  console.log(`  ${fresh} of ${out.length} written from the fact sheet now in force`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
