/**
 * Class B expander: dry-run generic adapter over registry counties looking for
 * free HTML tables (no LLM). Ingest any county that returns lots.
 *
 *   npm run scan:html -- --limit 40
 *   npm run scan:html -- --limit 40 --ingest
 */

import "../lib/env";
import { readFileSync } from "node:fs";
import { runAdapter } from "../lib/ingest/runner";
import { getAdapter } from "../lib/ingest/adapters";
import type { SourceRegistry } from "../lib/prospector/types";

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const adapter = getAdapter("generic-county");
  if (!adapter) throw new Error("generic-county missing");

  const registry = JSON.parse(
    readFileSync("data/source-registry.json", "utf8"),
  ) as SourceRegistry;

  const skip = new Set((arg("skip-states") ?? "TX,MI").split(",").map((s) => s.trim()));
  const limit = arg("limit") ? Number(arg("limit")) : 50;
  const doIngest = flag("ingest");

  const fipsList = Object.entries(registry.counties)
    .filter(([, c]) => !c.isGap && !skip.has(c.state) && (c.sources?.length ?? 0) > 0)
    .filter(([, c]) => {
      const kinds = new Set((c.sources ?? []).map((s) => s.kind));
      return !(
        kinds.size > 0 &&
        [...kinds].every((k) => k === "calendar" || k === "rules" || k === "unknown")
      );
    })
    .map(([fips]) => fips)
    .sort()
    .slice(0, limit);

  console.log(`Scanning ${fipsList.length} counties (ingest=${doIngest})…`);

  const hits: { fips: string; lots: number }[] = [];

  for (const fips of fipsList) {
    const summary = await runAdapter(adapter, {
      countyFips: fips,
      dryRun: !doIngest,
      onProgress: () => {},
    });
    const lots = summary.totals.lots;
    if (lots > 0) {
      hits.push({ fips, lots });
      console.log(`HIT ${fips} lots=${lots}${doIngest ? " (written)" : " (dry-run)"}`);
    } else {
      process.stdout.write(".");
    }
  }

  console.log(`\nDone. hits=${hits.length}/${fipsList.length}`);
  for (const h of hits) console.log(`  ${h.fips}: ${h.lots}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
