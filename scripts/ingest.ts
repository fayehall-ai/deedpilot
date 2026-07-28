/**
 * Ingestion CLI.
 *
 *   npm run ingest -- --adapter tx-lgbs
 *   npm run ingest -- --adapter tx-lgbs --county 48373 --dry-run
 *   npm run ingest -- --all --limit 3
 */
import "../lib/env";
import { runAdapter } from "../lib/ingest/runner";
import { ADAPTERS, getAdapter } from "../lib/ingest/adapters";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const dryRun = flag("dry-run");
  const countyFips = arg("county");
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const names = flag("all") ? ADAPTERS.map((a) => a.name) : [arg("adapter")].filter(Boolean);

  if (names.length === 0) {
    console.error("Usage: npm run ingest -- --adapter <name> [--county FIPS] [--limit N] [--dry-run]");
    console.error(`Available adapters: ${ADAPTERS.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }

  for (const name of names) {
    const adapter = getAdapter(name!);
    if (!adapter) {
      console.error(`Unknown adapter: ${name}`);
      process.exit(1);
    }

    const summary = await runAdapter(adapter, {
      countyFips,
      dryRun,
      limit,
      onProgress: (m) => console.log(m),
    });

    console.log(`\n=== ${summary.adapter} ===`);
    console.log(`counties processed: ${summary.counties.length}`);
    console.log(`auctions:           ${summary.totals.auctions}`);
    console.log(`lots:               ${summary.totals.lots}`);
    console.log(`rejected:           ${summary.totals.rejected}`);
    console.log(`fields repaired:    ${summary.totals.repaired}`);
    console.log(`failed counties:    ${summary.totals.failed}`);
    console.log(`blocked by policy:  ${summary.totals.blocked}`);
    if (dryRun) console.log("(dry run — nothing written)");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
