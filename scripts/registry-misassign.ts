/**
 * Remove registry sources recorded against a county that does not own them.
 *
 *   npx tsx scripts/registry-misassign.ts            # report
 *   npx tsx scripts/registry-misassign.ts --apply    # write
 *
 * ## The failure
 *
 * `https://calhouncounty.org/revenue/index.html` is recorded as a source for
 * Calhoun County in Florida, Illinois, Mississippi, South Carolina, West
 * Virginia, Arkansas *and* Alabama. One domain, seven counties, and at most one
 * of them can own it — Alabama, as it happens, which is the only one whose entry
 * carries an `atlas` origin rather than a followed link.
 *
 * The mechanism is the pattern generator: it produces `calhouncounty.org` from
 * "Calhoun County" in every state that has one, the prospector follows it, finds
 * genuine tax-sale wording, and records a verified source. Nothing in that chain
 * ever asks which Calhoun the page is about.
 *
 * It matters because a misassignment is worse than a gap. The crawler files what
 * it finds under the county it was told, so a wrong source does not fail — it
 * produces confident parcels for the wrong county. `zeus.ts` documents the same
 * failure from the other end: a national index pinned to St. Joseph County put
 * 8,611 Lake County parcels under the wrong one.
 *
 * ## What is deliberately left alone
 *
 * Statewide publishers, which are real and are the highest-leverage sources in
 * the registry: `cosl.org` is Arkansas's Commissioner of State Lands for 46
 * counties, `tax.newmexico.gov` sells for 32, `taxva.com` and `pbfcm.com` are
 * firms running many counties each. Counting counties per host would condemn all
 * of them, so the test is not "how many" but "does the hostname name a county" —
 * a claim only a county-specific domain makes, and one the registry can check
 * against itself.
 *
 * Also left alone: several distinct URLs on one county's own domain. Hoke County
 * has five `hokecounty.net` pages and Wayne five on `waynegov.com`, which looked
 * like five counties sharing a host and is in fact one county with five pages.
 */
import "../lib/env";
import { readFileSync, writeFileSync } from "node:fs";
import { ALL_COUNTIES } from "../lib/atlas";
import { STATEWIDE_SOURCES } from "../lib/prospector/candidates";

const APPLY = process.argv.includes("--apply");
const PATH = "data/source-registry.json";

/** Hosts that are never a county's sale list, whatever else is true. */
const NEVER_A_SOURCE = [
  "helpscoutdocs.com",
  "onlinesearches.com",
  "wikipedia.org",
  "facebook.com",
  "youtube.com",
  "linkedin.com",
];

type Source = { url: string; host?: string; origin?: string };
type Entry = { state: string; county: string; sources: Source[]; isGap: boolean };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const hostOf = (s: Source) => {
  const h = s.host ?? (() => { try { return new URL(s.url).hostname; } catch { return ""; } })();
  return h.toLowerCase().replace(/^www\./, "");
};

function main() {
  const reg = JSON.parse(readFileSync(PATH, "utf8")) as {
    counties: Record<string, Entry>; nVerified?: number; nGaps?: number;
  };

  /*
   * County names long enough to be distinctive. "Lee" and "Union" turn up
   * inside unrelated hostnames often enough that matching them would condemn
   * good sources, so short names never trigger the ownership test.
   */
  const distinctive = ALL_COUNTIES
    .filter((c) => squash(c.name).length >= 5)
    .map((c) => squash(c.name));

  /**
   * Does this hostname claim a county, and which name does it claim?
   *
   * The name has to sit immediately before the word "county" — `calhouncounty`,
   * `oklahomacounty`, `rowancountync`. Matching a bare name anywhere in the host
   * condemned `comptroller.texas.gov`, the Texas state comptroller, because
   * Texas County exists in Oklahoma and Missouri. A state agency is not a county
   * domain and must not be judged as one.
   */
  const claimedName = (host: string): string | null => {
    const h = squash(host);
    for (const n of distinctive) if (h.includes(`${n}county`)) return n;
    return null;
  };

  /** Which counties each host is recorded for. */
  const hostToFips = new Map<string, Set<string>>();
  for (const [fips, e] of Object.entries(reg.counties)) {
    for (const s of e.sources ?? []) {
      const h = hostOf(s);
      if (!h) continue;
      if (!hostToFips.has(h)) hostToFips.set(h, new Set());
      hostToFips.get(h)!.add(fips);
    }
  }

  /**
   * For a host that names a county and is recorded for several, the one county
   * that may keep it: the one whose entry cites it from researched atlas data
   * rather than from a followed pattern. If none does, nobody keeps it — a
   * source nobody can vouch for is exactly the kind that reads as confident and
   * is wrong.
   */
  const owner = new Map<string, string | null>();
  for (const [host, fipsSet] of hostToFips) {
    if (fipsSet.size < 2) continue;
    const name = claimedName(host);
    if (!name) continue;

    /*
     * The county the hostname actually names wins, whatever the origins say.
     *
     * Preferring an `atlas` origin first got this backwards: Canadian County's
     * entry cited `oklahomacounty.org` from researched data, so the rule handed
     * Oklahoma County's own domain to Canadian and proposed stripping it from
     * Oklahoma. A domain that says "oklahomacounty" belongs to Oklahoma County;
     * the citation only tells us who wrote it down first.
     */
    const byName = [...fipsSet].filter((f) => squash(reg.counties[f].county) === name);

    /*
     * Name first, then provenance, and the order of those two is the whole fix.
     *
     * Preferring provenance first handed Oklahoma County's own domain to
     * Canadian County, because Canadian's entry happened to cite it from
     * researched data. Preferring name alone then picked Calhoun, Florida out of
     * the seven states with a Calhoun County — arbitrarily, since all seven
     * match equally. So the name narrows the field to the counties that could
     * own it, and a researched citation decides among them.
     */
    const cites = (fips: string) =>
      reg.counties[fips].sources.some((x) => hostOf(x) === host && x.origin === "atlas");

    const claimed: string | null =
      byName.length === 1
        ? byName[0]
        : (byName.find(cites) ?? [...fipsSet].find(cites) ?? null);

    owner.set(host, claimed);
  }

  /*
   * One identical URL recorded for many counties is a directory — unless the
   * registry already knows it as a statewide publisher.
   *
   * That distinction is the whole difficulty. `cosl.org` genuinely is one page
   * serving 46 Arkansas counties, and `tax.newmexico.gov` 32, so "same URL,
   * many counties" cannot condemn on its own. What separates them is that the
   * real ones are declared: `STATEWIDE_SOURCES` lists them per state, because
   * somebody established that the state sells centrally. Anything else reaching
   * the same shape got there by being followed from several counties at once,
   * which is how `publicrecords.onlinesearches.com` became 42 counties' source.
   *
   * `tctanj.org` looks exactly like that case and is not: the New Jersey tax
   * collectors' association is *declared*, `coversAllCounties: true`, because
   * New Jersey sells at municipal level and has no county page to find. The
   * declaration is what tells the two apart, and it is the reason this test
   * reads the list rather than counting.
   */
  const declaredStatewide = new Set<string>();
  for (const sources of Object.values(STATEWIDE_SOURCES)) {
    for (const s of sources) {
      try { declaredStatewide.add(new URL(s.url).hostname.toLowerCase().replace(/^www\./, "")); }
      catch { /* a malformed entry is not a host */ }
    }
  }

  const urlToFips = new Map<string, Set<string>>();
  for (const [fips, e] of Object.entries(reg.counties)) {
    for (const s of e.sources ?? []) {
      if (!urlToFips.has(s.url)) urlToFips.set(s.url, new Set());
      urlToFips.get(s.url)!.add(fips);
    }
  }
  /** Identical URLs serving 3+ counties that nobody declared statewide. */
  const directoryUrls = new Set(
    [...urlToFips]
      .filter(([url, fipsSet]) => {
        if (fipsSet.size < 3) return false;
        try { return !declaredStatewide.has(new URL(url).hostname.toLowerCase().replace(/^www\./, "")); }
        catch { return false; }
      })
      .map(([url]) => url),
  );

  let dropped = 0, deduped = 0, touched = 0, newGaps = 0;
  const lines: string[] = [];

  for (const [fips, e] of Object.entries(reg.counties)) {
    const before = e.sources.length;
    if (before === 0) continue;

    const seenUrl = new Set<string>();
    const kept: Source[] = [];

    for (const s of e.sources) {
      const h = hostOf(s);

      if (seenUrl.has(s.url)) { deduped++; continue; }
      seenUrl.add(s.url);

      if (h && NEVER_A_SOURCE.some((bad) => h === bad || h.endsWith(`.${bad}`))) {
        lines.push(`  ${e.county}, ${e.state}  drop ${h}  — never a county sale list`);
        dropped++;
        continue;
      }

      if (directoryUrls.has(s.url)) {
        lines.push(`  ${e.county}, ${e.state}  drop ${h}  — one page recorded for ${urlToFips.get(s.url)!.size} counties`);
        dropped++;
        continue;
      }

      if (owner.has(h) && owner.get(h) !== fips) {
        const who = owner.get(h);
        lines.push(
          `  ${e.county}, ${e.state}  drop ${h}  — ${
            who ? `belongs to ${reg.counties[who].county}, ${reg.counties[who].state}` : "no county can vouch for it"
          }`,
        );
        dropped++;
        continue;
      }

      kept.push(s);
    }

    if (kept.length !== before) {
      touched++;
      e.sources = kept;
      if (kept.length === 0 && !e.isGap) { e.isGap = true; newGaps++; }
    }
  }

  for (const l of lines.slice(0, 30)) console.log(l);
  if (lines.length > 30) console.log(`  …and ${lines.length - 30} more`);

  console.log(`\n${dropped} misassigned source(s) removed`);
  console.log(`${deduped} duplicate row(s) collapsed`);
  console.log(`${touched} county entries changed, ${newGaps} newly marked as gaps`);

  if (APPLY) {
    reg.nVerified = Object.values(reg.counties).filter((c) => c.sources.length > 0).length;
    reg.nGaps = Object.values(reg.counties).filter((c) => c.sources.length === 0).length;
    writeFileSync(PATH, JSON.stringify(reg, null, 2));
    console.log(`\nwritten — ${reg.nVerified} counties with a source, ${reg.nGaps} gaps`);
  } else {
    console.log("\nreport only — pass --apply to write");
  }
}

main();
