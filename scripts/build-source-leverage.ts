/**
 * Derive per-state adapter leverage from researched county sources.
 *
 * The coverage work plan used to rank dark states by population, which is the
 * wrong axis: it asks "how big is this market" when the question is "how many
 * counties does one adapter buy me". Arkansas certifies every county to one
 * state office and never appeared on a population-ranked list; it turned out
 * to be 46 counties and 6,760 lots for a single adapter.
 *
 * Output: data/source-leverage.json, read by lib/coverage/scoreboard.ts.
 * Re-run when copilot/data/county_sources.json is refreshed.
 *
 *   npx tsx scripts/build-source-leverage.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policyFor } from "../lib/ingest/policy";

/**
 * Auction platforms that serve many counties behind one integration.
 *
 * `host` is the registrable domain used to ask `policy.ts` whether we may
 * crawl it, so a platform can never be ranked as reachable while the access
 * policy says otherwise.
 */
const PLATFORMS: ReadonlyArray<
  readonly [name: string, pattern: RegExp, host: string]
> = [
  ["realauction", /realauction|realtaxdeed|realforeclose/i, "realtaxdeed.com"],
  ["govease", /govease/i, "govease.com"],
  ["bid4assets", /bid4assets/i, "bid4assets.com"],
  ["zeus-sri", /zeusauction|sriservices|sri-taxsale/i, "sriservices.com"],
  ["tax-sale.info", /tax-sale\.info/i, "tax-sale.info"],
  ["grantstreet", /mytaxsale|lienhub|grantstreet|bidxxx/i, "grantstreet.com"],
  ["publicsurplus", /publicsurplus/i, "publicsurplus.com"],
  ["civicsource", /civicsource/i, "civicsource.com"],
  ["lienauction", /lienauction/i, "lienauction.com"],
  ["iltaxsale", /iltaxsale/i, "iltaxsale.com"],
  ["cosl", /cosl\.org/i, "cosl.org"],
  ["nysauctions", /nysauctions/i, "nysauctions.com"],
];

/**
 * Access status per platform, read from policy.ts rather than duplicated.
 *
 * Recorded alongside each state rather than used to filter it. An earlier
 * version dropped `requires_agreement` platforms from the ranking entirely,
 * which hid the largest inventory in the country: GovEase publishes 154
 * auctions across 13 states, and Bid4Assets a full county tax-sale calendar,
 * both readable in a browser with no login. Their robots.txt posture is a
 * crawler question, not a statement that the data is private, and the two are
 * easy to conflate into "no inventory here" — which is what happened.
 *
 * The work plan's job is to show the work. Whether a given source is
 * approached by crawler, by data agreement, or through the operator's own
 * browser session is a separate decision, made per source, by a human.
 */
function accessStatus(platform: string): "allow" | "requires_agreement" | "deny" {
  const entry = PLATFORMS.find(([name]) => name === platform);
  if (!entry) return "allow";
  return policyFor(entry[2])?.decision ?? "allow";
}

interface CountySource {
  fips: string;
  state: string;
  population?: number;
  auctionPlatformUrl?: string;
}

interface StateLeverage {
  state: string;
  /** Counties reachable by the single best source in this state. */
  bestSourceCounties: number;
  /** Which source that is. */
  bestSource: string;
  /** Other states the same platform serves — building it once covers them. */
  alsoUnlocks: string[];
  /** Researched counties in the state, the ceiling for any single adapter. */
  researchedCounties: number;
  /** Population in reachable counties, the tiebreak once leverage is equal. */
  reachablePopulation: number;
  /** Crawl posture of the best source. Annotated, never used to filter. */
  access: "allow" | "requires_agreement" | "deny";
}

function main() {
  const root = process.cwd();
  const raw = JSON.parse(
    readFileSync(join(root, "copilot", "data", "county_sources.json"), "utf8"),
  ) as { counties: CountySource[]; exportedAt?: string };

  const counties = raw.counties ?? [];

  // platform -> state -> {counties, population}
  const byPlatform = new Map<string, Map<string, { n: number; pop: number }>>();
  const researchedByState = new Map<string, number>();

  for (const c of counties) {
    researchedByState.set(c.state, (researchedByState.get(c.state) ?? 0) + 1);
    const url = c.auctionPlatformUrl ?? "";
    if (!url) continue;
    const hit = PLATFORMS.find(([, re]) => re.test(url));
    if (!hit) continue;
    const [name] = hit;
    if (!byPlatform.has(name)) byPlatform.set(name, new Map());
    const states = byPlatform.get(name)!;
    const cur = states.get(c.state) ?? { n: 0, pop: 0 };
    cur.n += 1;
    cur.pop += c.population ?? 0;
    states.set(c.state, cur);
  }

  const allStates = [...researchedByState.keys()].sort();
  const out: StateLeverage[] = [];

  for (const state of allStates) {
    let best: { source: string; n: number; pop: number; also: string[] } | null = null;

    for (const [platform, states] of byPlatform) {
      const here = states.get(state);
      if (!here) continue;
      if (!best || here.n > best.n) {
        best = {
          source: platform,
          n: here.n,
          pop: here.pop,
          also: [...states.keys()].filter((s) => s !== state).sort(),
        };
      }
    }

    out.push({
      state,
      bestSourceCounties: best?.n ?? 0,
      bestSource: best?.source ?? "none-known",
      alsoUnlocks: best?.also ?? [],
      researchedCounties: researchedByState.get(state) ?? 0,
      reachablePopulation: best?.pop ?? 0,
      access: best ? accessStatus(best.source) : "allow",
    });
  }

  out.sort((a, b) => b.bestSourceCounties - a.bestSourceCounties);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceExportedAt: raw.exportedAt ?? null,
    note:
      "Counties one adapter reaches, per state. Ranks the coverage work plan " +
      "by adapter leverage rather than state population. Every platform is " +
      "ranked; those needing an access decision carry access!=allow rather " +
      "than being dropped, so the inventory stays visible. Counts are " +
      "floors: only counties researched in depth " +
      "(roughly 50k+ population) are counted, so statewide sources like " +
      "Arkansas COSL are undercounted.",
    requiresAgreement: [...new Set(out.filter((s) => s.access !== "allow").map((s) => s.bestSource))],
    states: out,
  };

  const dest = join(root, "data", "source-leverage.json");
  writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n");

  console.log(`wrote ${dest}`);
  console.log(`${out.length} states from ${counties.length} researched counties\n`);
  console.log("top leverage:");
  for (const s of out.slice(0, 12)) {
    const also = s.alsoUnlocks.length ? ` (+${s.alsoUnlocks.length} states)` : "";
    const gate = s.access === "allow" ? "" : `  [${s.access}]`;
    console.log(
      `  ${s.state}  ${String(s.bestSourceCounties).padStart(3)} counties via ${s.bestSource}${also}${gate}`,
    );
  }
}

main();
