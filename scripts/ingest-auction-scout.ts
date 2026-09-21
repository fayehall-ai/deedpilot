/**
 * Read the Auction Scout workbook into the calendar, from the terminal.
 *
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx>                  # plan only
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx> --apply          # write
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx> --tab "Auction Scout"
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx> --verbose        # every match
 *
 * With no file, the newest xlsx in `data/auction-scout/`. The same ingest runs
 * from the console's workbook upload; the rules are in `lib/import/scout-ingest.ts`.
 */
import "../lib/env";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describePlan, ingestWorkbook } from "../lib/import/scout-ingest";
import { SCOUT_TABS } from "../lib/import/scout-workbook";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const DIR = "data/auction-scout";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function workbookPath(): string {
  const given = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--tab");
  if (given) return given;
  const newest = readdirSync(DIR)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .map((f) => path.join(DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) throw new Error(`no workbook given and none in ${DIR}/`);
  return newest;
}

async function main() {
  const file = workbookPath();
  const only = arg("tab");
  const tabs = only ? SCOUT_TABS.filter((t) => t === only) : SCOUT_TABS;
  if (only && tabs.length === 0) throw new Error(`--tab must be one of: ${SCOUT_TABS.join(", ")}`);

  const results = await ingestWorkbook(readFileSync(file), path.basename(file), { apply: APPLY, via: "cli", tabs });
  for (const { tab, plan, result } of results) {
    console.log(`\n━━ ${tab}  (${path.basename(file)}) ━━`);
    for (const line of describePlan(plan, { verbose: VERBOSE })) console.log(line);
    if (result) {
      console.log(
        `\nwrote ${result.filled} fill(s) and ${result.inserted} new sale(s); ` +
          `queued ${result.enrichment.queued} county crawl(s) (${result.enrichment.alreadyBusy} already busy)`,
      );
    }
  }
  if (!APPLY) console.log("\nplan only — pass --apply to write");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
