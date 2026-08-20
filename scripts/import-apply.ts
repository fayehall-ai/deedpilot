/**
 * Import a sale calendar for real.
 * Run: npm run import:apply -- data/leads/ustla_auctions_next_8_weeks.csv [--enrich]
 *
 * The same `importAuctionCsv` the console's upload button calls, so this and
 * the browser cannot drift. What it adds is a terminal path for a file too
 * large or too routine to click through, and a place for a future cron to hand
 * a nightly export to.
 *
 * Writes. Run `npm run import:dry-run` on the same file first — it takes the
 * same arguments and reports exactly what this would do, without doing it.
 */

import "../lib/env";
import { readFileSync } from "node:fs";
import { importAuctionCsv, UnreadableFile } from "../lib/import/run";
import { enqueueImportEnrichment } from "../lib/import/enrich";

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  const enrich = args.includes("--enrich");

  if (!path) {
    console.error("usage: npm run import:apply -- <file.csv> [--enrich]");
    process.exit(1);
  }

  let report;
  try {
    report = await importAuctionCsv(readFileSync(path, "utf8"));
  } catch (e) {
    if (e instanceof UnreadableFile) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  console.log(`rows read         ${report.totalRows}`);
  console.log(`inserted          ${report.inserted}`);
  console.log(`updated           ${report.updated}`);
  console.log(`merged            ${report.mergedIntoCrawled}`);
  console.log(`duplicate in file ${report.duplicateInFile}`);
  console.log(`not imported      ${report.rejected.length}`);
  if (report.dateRange) {
    console.log(`dates             ${report.dateRange.from} → ${report.dateRange.to}`);
  }
  console.log(`counties          ${report.countiesTouched.length}`);

  for (const r of report.rejected) {
    console.log(`  line ${r.line}: ${r.label} — ${r.problem}`);
  }
  for (const a of report.ambiguous) {
    console.log(
      `  ambiguous: ${a.countyLabel} on ${a.saleDate} — ${a.existing} held, ${a.imported} in file`,
    );
  }

  if (enrich) {
    const e = await enqueueImportEnrichment(report.countiesTouched, "cli");
    console.log("");
    console.log(`queued for crawl  ${e.queued}`);
    console.log(`already in flight ${e.alreadyBusy}`);
    console.log(`awaiting parcels  ${e.awaitingParcels}`);
    console.log(`no parser         ${e.noAdapter.length}`);
    console.log(`no located source ${e.noSource.length}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
