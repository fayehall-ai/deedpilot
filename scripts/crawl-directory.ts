/**
 * Build the county office directory from OnlineSearches.
 *
 *   npx tsx scripts/crawl-directory.ts --state AR [--limit 5]
 *   npx tsx scripts/crawl-directory.ts --all
 *
 * Writes `data/county-directory.json`, keyed by FIPS: per county, the assessor,
 * collector, recorder, GIS, tax portal, and — the two worth the crawl — the
 * pages a county publishes its foreclosure and delinquent lists on.
 *
 * Every request goes through `politeFetch`, so the access policy, live
 * robots.txt and the 5s delay for this host are all enforced in the same place
 * they are for auction ingest. This script does not get its own rules.
 *
 * Resumable: existing entries are kept and only missing counties are fetched
 * unless `--refresh` is passed. At 5s a request, all 3,142 counties is roughly
 * four and a half hours, so stopping and restarting has to be free.
 */
import "../lib/env";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { politeFetch, PolicyBlockedError } from "../lib/ingest/fetch";
import { countiesInState, STATE_NAMES } from "../lib/atlas";
import {
  countyPageUrl,
  parseCountyPage,
  type DirectoryFile,
} from "../lib/directory/onlinesearches";

const OUT = join(process.cwd(), "data", "county-directory.json");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function load(): Promise<DirectoryFile> {
  try {
    return JSON.parse(await readFile(OUT, "utf8")) as DirectoryFile;
  } catch {
    return {};
  }
}

async function main() {
  const all = process.argv.includes("--all");
  const refresh = process.argv.includes("--refresh");
  const stateArg = arg("state")?.toUpperCase() ?? null;
  const limit = Number(arg("limit") ?? "0") || Infinity;

  if (!all && !stateArg) {
    console.error("pass --state XX or --all");
    process.exit(1);
  }

  const states = all ? Object.keys(STATE_NAMES) : [stateArg!];
  const out = await load();
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let blocked = 0;

  for (const state of states) {
    const counties = countiesInState(state);
    if (!counties.length) continue;

    for (const c of counties) {
      if (fetched >= limit) break;
      if (out[c.fips] && !refresh) {
        skipped++;
        continue;
      }

      const url = countyPageUrl(state, c.name);
      try {
        const res = await politeFetch(url);
        if (res.status !== 200) {
          failed++;
          console.log(`  ${state} ${c.name}: HTTP ${res.status}`);
          continue;
        }
        const entry = parseCountyPage({
          html: res.body,
          fips: c.fips,
          state,
          county: c.name,
          sourceUrl: url,
        });
        out[c.fips] = entry;
        fetched++;
        const kinds = entry.links.map((l) => l.kind).join(",");
        console.log(`  ${state} ${c.name}: ${entry.links.length} link(s) [${kinds}]`);
      } catch (e) {
        /*
         * A policy block is not a crawl failure — it is the policy layer doing
         * its job, and it must be visible rather than counted as a bad page.
         * If this ever fires the host's robots.txt has changed and the entry in
         * lib/ingest/policy.ts needs re-reading, not a retry.
         */
        if (e instanceof PolicyBlockedError) {
          blocked++;
          console.error(`  BLOCKED ${url}: ${e.message}`);
          break;
        }
        failed++;
        console.log(`  ${state} ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Checkpoint as we go. Four hours of crawling must not be lost to one
      // unhandled throw at county 2,900.
      if (fetched % 25 === 0) await save(out);
    }
  }

  await save(out);
  console.log(
    `\n${fetched} fetched, ${skipped} already had entries, ${failed} failed, ${blocked} blocked`,
  );
  console.log(`${Object.keys(out).length} counties in ${OUT}`);
  process.exit(0);
}

async function save(out: DirectoryFile) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
}

main();
