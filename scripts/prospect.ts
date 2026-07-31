/**
 * Source Prospector CLI.
 *
 *   npm run prospect -- --dry-run                 # candidate plan, no requests
 *   npm run prospect -- --state MI --limit 5      # verify a handful, live
 *   npm run prospect -- --no-llm                  # deterministic scoring only
 *   npm run prospect -- --out data/source-registry.json
 *
 * Defaults to the 152 counties that already carry researched atlas links, which
 * is the highest-yield set and costs the least to confirm. Sequential by design:
 * `politeFetch` enforces per-host delays and many counties share a host.
 */
import "../lib/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ALL_COUNTIES } from "../lib/atlas";
import {
  buildRegistry,
  countiesWithAtlasLinks,
  prospectCounties,
  registryCoverage,
} from "../lib/prospector";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const dryRun = flag("dry-run");
  const state = arg("state")?.toUpperCase();
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const out = arg("out") ?? "data/source-registry.json";

  let targets = countiesWithAtlasLinks();
  if (state) {
    const inState = new Set(ALL_COUNTIES.filter((c) => c.state === state).map((c) => c.fips));
    targets = targets.filter((f) => inState.has(f));
  }
  if (limit) targets = targets.slice(0, limit);

  console.log(
    `Prospecting ${targets.length} count${targets.length === 1 ? "y" : "ies"}` +
      `${state ? ` in ${state}` : ""}${dryRun ? " (dry run — no requests)" : ""}`,
  );

  const results = await prospectCounties(targets, {
    dryRun,
    useLlm: !flag("no-llm"),
  });

  if (dryRun) {
    for (const r of results.slice(0, 20)) {
      console.log(`  ${r.fips} ${r.county}, ${r.state}: ${r.note}`);
    }
    console.log(`\n${results.filter((r) => r.isGap).length} counties have no candidates at all.`);
    return;
  }

  for (const r of results) {
    const flagStr = r.isGap ? "GAP " : "    ";
    console.log(`${flagStr}${r.fips} ${r.county}, ${r.state}: ${r.note}`);
    for (const v of r.verified) {
      console.log(
        `       ${v.isGovernment ? "gov" : "   "} ${v.kind.padEnd(8)} ${v.confidence.toFixed(2)} ${v.url}`,
      );
    }
  }

  const registry = buildRegistry(results);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(registry, null, 2));
  const cov = registryCoverage(registry);
  console.log(
    `\nWrote ${out}: ${cov.nCounties} counties, ${cov.nVerified} verified sources, ` +
      `${cov.nGaps} gaps, ${Math.round(cov.govShare * 100)}% on government hosts.`,
  );
  console.log(`  by kind: ${JSON.stringify(cov.byKind)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
