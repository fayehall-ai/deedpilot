/**
 * Results crawler CLI — candidate past-sale rows for the price model.
 *
 *   npm run crawl:results -- --limit 40
 *   npm run crawl:results -- --state CO --state OH
 *
 * Writes a JSONL batch and a label-rule report. Admits nothing: rows only enter
 * the corpus through `deedpilot-copilot archive`, which refuses any source
 * without a stated semantics rule in labels.py.
 */
import "../lib/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crawlResults } from "../lib/archivist/results";
import type { SourceRegistry } from "../lib/prospector/types";

const args = (n: string) => {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${n}` && process.argv[i+1]) out.push(process.argv[i+1]); });
  return out;
};
const arg = (n: string) => args(n)[0];

async function main() {
  const registry = JSON.parse(readFileSync("data/source-registry.json", "utf8")) as SourceRegistry;
  const states = args("state").map((s) => s.toUpperCase());
  const limit = arg("limit") ? Number(arg("limit")) : undefined;

  console.log(`Crawling results from ${Object.keys(registry.counties).length} registry counties…`);
  const report = await crawlResults(registry, { limit, states });

  mkdirSync("data", { recursive: true });
  const out = "data/results-candidates.jsonl";
  writeFileSync(out, report.rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  console.log(`\nsources tried ${report.sourcesTried}, yielding ${report.sourcesYielding}`);
  console.log(`rows extracted: ${report.rows.length} -> ${out}`);
  const states2 = new Set(report.rows.map((r) => r.state));
  console.log(`states represented: ${states2.size} (${[...states2].sort().join(", ")})`);

  if (report.needsLabelRule.length) {
    console.log(`\nNEEDS A LABEL RULE before any of this can be fitted on:`);
    for (const h of report.needsLabelRule.slice(0, 20)) {
      console.log(
        `  ${String(h.rows).padStart(5)} rows  ${h.state}  ${h.host}` +
        `  median win $${h.medianWinningBid?.toLocaleString() ?? "?"}` +
        (h.medianOpeningRatio ? `  win/open ${h.medianOpeningRatio.toFixed(2)}x` : ""),
      );
    }
    console.log(`\n${report.needsLabelRule[0].question}`);
  }
  writeFileSync("data/results-crawl-report.json", JSON.stringify(report.needsLabelRule, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
