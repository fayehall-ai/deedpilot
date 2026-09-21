/**
 * Import the Auction Scout xlsx into the calendar.
 *
 * Converts the "Auction Scout" sheet from the TD Collective's expanded xlsx
 * report into a format compatible with `import-auction-csv.ts`, then runs
 * the same import logic.
 *
 * ## Usage
 *
 *   npx tsx scripts/import-auction-scout-xlsx.ts                    # report only
 *   npx tsx scripts/import-auction-scout-xlsx.ts --apply            # write to DB
 *   npx tsx scripts/import-auction-scout-xlsx.ts --file path.xlsx   # custom file
 *
 * ## Refresh workflow
 *
 * When Ed delivers a new Auction Scout xlsx:
 *
 *   1. Copy the new file to `data/auction-scout/`
 *   2. Run this script with `--apply` pointing at the new file
 *   3. The script updates venue, contact, and source URL overrides on matching
 *      auctions already in the calendar
 *
 * ## What gets imported
 *
 * From the "Auction Scout" sheet:
 *   - County, state, sale date
 *   - Venue/location (from "Sale Address" or "Sale Method / Location")
 *   - Contact name, phone, email
 *   - Auction property list URL (when available)
 *
 * The script matches rows to existing auctions by state + county name and
 * updates their logistics and source overrides. It does not create new auctions.
 *
 * ## Implementation
 *
 * Uses auction-scout-xlsx-to-csv.py (Python/openpyxl) for xlsx parsing, then
 * feeds the result to import-auction-csv.ts for the database import.
 */
import "../lib/env";
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const SCOUT_DIR = "data/auction-scout";

function findLatestXlsx(): string | null {
  if (!existsSync(SCOUT_DIR)) return null;
  const files = readdirSync(SCOUT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .sort()
    .reverse();
  return files.length ? path.join(SCOUT_DIR, files[0]) : null;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

async function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const xlsxPath = argValue("file") ?? findLatestXlsx();
  if (!xlsxPath || !existsSync(xlsxPath)) {
    console.error(
      `No xlsx file found. Either:\n` +
      `  - Place an Auction Scout xlsx in ${SCOUT_DIR}/\n` +
      `  - Or pass --file path/to/report.xlsx`,
    );
    process.exit(1);
  }

  // Step 1: Convert xlsx to CSV using Python script
  console.log("Step 1: Converting xlsx to CSV...\n");
  const convertCode = await runCommand("python3", [
    "scripts/auction-scout-xlsx-to-csv.py",
    xlsxPath,
  ]);
  if (convertCode !== 0) {
    console.error("xlsx conversion failed");
    process.exit(convertCode);
  }

  // Step 2: Run the import
  const applyFlag = process.argv.includes("--apply");
  console.log(`\nStep 2: Running import ${applyFlag ? "with --apply" : "(report only)"}...`);
  console.log("─".repeat(60) + "\n");

  const importArgs = ["tsx", "scripts/import-auction-csv.ts"];
  if (applyFlag) importArgs.push("--apply");

  const importCode = await runCommand("npx", importArgs);
  
  console.log("\n" + "─".repeat(60));
  if (importCode === 0) {
    console.log("Import complete.");
    if (!applyFlag) {
      console.log("Run with --apply to write changes to the database.");
    }
  }
  process.exit(importCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
