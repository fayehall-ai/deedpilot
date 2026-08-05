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
 * Platforms we may not crawl, read from the access policy rather than
 * duplicated here.
 *
 * This matters more than it looks. Ranking by raw county count puts GovEase
 * states (AL, MS, TN…) at the top of the work plan, and every one of them is
 * unreachable: liveauctions.govease.com serves `Disallow: /`. A plan that
 * ranks work nobody can do is worse than the population ranking it replaced.
 */
function blockedPlatforms(): Set<string> {
  const blocked = new Set<string>();
  for (const [name, , host] of PLATFORMS) {
    const policy = policyFor(host);
    if (policy && policy.decision !== "allow") blocked.add(name);
  }
  return blocked;
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
}

function main() {
  const root = process.cwd();
  const raw = JSON.parse(
    readFileSync(join(root, "copilot", "data", "county_sources.json"), "utf8"),
  ) as { counties: CountySource[]; exportedAt?: string };

  const counties = raw.counties ?? [];
  const BLOCKED = blockedPlatforms();

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
      if (BLOCKED.has(platform)) continue;
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
    });
  }

  out.sort((a, b) => b.bestSourceCounties - a.bestSourceCounties);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceExportedAt: raw.exportedAt ?? null,
    note:
      "Counties one adapter reaches, per state. Ranks the coverage work plan " +
      "by adapter leverage rather than state population. Platforms whose " +
      "access policy is not `allow` are excluded — their counties are not " +
      "reachable inventory, and ranking them would fill the plan with work " +
      "nobody can do. Counts are floors: only counties researched in depth " +
      "(roughly 50k+ population) are counted, so statewide sources like " +
      "Arkansas COSL are undercounted.",
    blockedPlatforms: [...BLOCKED],
    states: out,
  };

  const dest = join(root, "data", "source-leverage.json");
  writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n");

  console.log(`wrote ${dest}`);
  console.log(`${out.length} states from ${counties.length} researched counties\n`);
  console.log("top leverage:");
  for (const s of out.slice(0, 12)) {
    const also = s.alsoUnlocks.length ? ` (+${s.alsoUnlocks.length} states)` : "";
    console.log(
      `  ${s.state}  ${String(s.bestSourceCounties).padStart(3)} counties via ${s.bestSource}${also}`,
    );
  }
}

main();
