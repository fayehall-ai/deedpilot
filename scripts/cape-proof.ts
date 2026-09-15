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
import { asc, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, capeCountyScripts, capeProductions, counties } from "../lib/db/schema";
import { capePackageInputs } from "../lib/cape/inputs";
import { capeInputsHash } from "../lib/cape/components";

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
  parcels: number;
  /** True when the package was held and never went to audio. */
  held: boolean;
  /** Why it was held, in the operator's words. */
  heldWhy: string | null;
  flagged: string[];
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
    const shared = countyText.get(r.fips) ?? new Set<string>();
    out.push({
      slug: `${r.state.toLowerCase()}-${slugify(r.county)}-${r.saleDate}`,
      county: r.county,
      state: r.state,
      saleDate: r.saleDate,
      saleType: r.saleType,
      platform: r.platform,
      parcels: r.lotCount,
      held: (r.figures ?? []).length > 0 || Boolean(r.error),
      heldWhy: r.error ?? null,
      flagged: r.figures ?? [],
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
  console.log(`  ${countySections} county-scoped section(s), ${saleSections} sale-scoped`);
  console.log(`  ${halves.length} county half/halves on file`);
  console.log(`  ${words.toLocaleString()} spoken words in total`);
  const fresh = out.filter((d) => d.current).length;
  console.log(`  ${out.filter((d) => d.held).length} held (unsupported figure or wrong county)`);
  console.log(`  ${fresh} of ${out.length} written from the fact sheet now in force`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
