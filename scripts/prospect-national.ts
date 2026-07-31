/**
 * National discovery run.
 *
 * Walks counties round-robin across states so a partial run still gives a
 * representative national picture rather than finishing Alabama and nothing
 * else. Writes incrementally, so an interrupted run keeps what it found.
 */
import "../lib/env";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { ALL_COUNTIES } from "../lib/atlas";
import { buildRegistry, prospectCounty, registryCoverage } from "../lib/prospector";
import type { ProspectResult, SourceRegistry } from "../lib/prospector/types";

const OUT = "data/source-registry.json";
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i+1] : undefined; };

async function main() {
  const limit = Number(arg("limit") ?? 400);
  const perState = Number(arg("per-state") ?? 100);

  // Resume: keep counties already resolved.
  const done = new Map<string, ProspectResult>();
  if (existsSync(OUT)) {
    const prior = JSON.parse(readFileSync(OUT, "utf8")) as SourceRegistry;
    for (const [fips, e] of Object.entries(prior.counties)) {
      if (!e.isGap) done.set(fips, { fips, state: e.state, county: e.county, verified: e.sources, rejected: [], isGap: false, note: "resumed" });
    }
  }

  const byState = new Map<string, string[]>();
  for (const c of ALL_COUNTIES) {
    if (done.has(c.fips)) continue;
    const list = byState.get(c.state) ?? [];
    if (list.length < perState) list.push(c.fips);
    byState.set(c.state, list);
  }

  // Round-robin so a partial run is nationally representative.
  const queue: string[] = [];
  const states = [...byState.keys()].sort();
  for (let i = 0; queue.length < limit; i++) {
    let progressed = false;
    for (const s of states) {
      const l = byState.get(s)!;
      if (i < l.length) { queue.push(l[i]); progressed = true; }
      if (queue.length >= limit) break;
    }
    if (!progressed) break;
  }

  console.log(`[national] ${queue.length} counties across ${states.length} states (${done.size} already resolved)`);
  const results: ProspectResult[] = [...done.values()];
  let n = 0;

  for (const fips of queue) {
    const r = await prospectCounty(fips, { includePatterns: true, useLlm: false, maxCandidates: 6 });
    results.push(r);
    n++;
    if (!r.isGap) console.log(`  ✓ ${r.county}, ${r.state}  ${r.verified[0].confidence.toFixed(2)} ${r.verified[0].url.slice(0,88)}`);
    if (n % 10 === 0) {
      mkdirSync("data", { recursive: true });
      writeFileSync(OUT, JSON.stringify(buildRegistry(results), null, 2));
      const c = registryCoverage(buildRegistry(results));
      console.log(`[national] ${n}/${queue.length} — ${c.nCounties - c.nGaps} resolved, ${c.nGaps} gaps`);
    }
  }

  mkdirSync("data", { recursive: true });
  const registry = buildRegistry(results);
  writeFileSync(OUT, JSON.stringify(registry, null, 2));
  const cov = registryCoverage(registry);
  const resolvedStates = new Set(Object.values(registry.counties).filter(e => !e.isGap).map(e => e.state));
  console.log(`\n[national] DONE ${cov.nCounties} counties: ${cov.nCounties - cov.nGaps} resolved, ${cov.nGaps} gaps`);
  console.log(`[national] states with >=1 verified source: ${resolvedStates.size}`);
  console.log(`[national] government share: ${Math.round(cov.govShare*100)}%  by kind: ${JSON.stringify(cov.byKind)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
