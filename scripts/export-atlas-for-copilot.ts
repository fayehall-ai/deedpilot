/**
 * Export atlas + statute params as JSON for the Python copilot runtime.
 *
 *   npx tsx scripts/export-atlas-for-copilot.ts
 *
 * Writes copilot/data/atlas_export.json (resolved rules for researched
 * counties + all state defaults + statute params).
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  ALL_COUNTIES,
  COUNTY_DATA,
  STATE_DATA,
  resolveCountyRule,
} from "../lib/atlas";
import { STATUTE_PARAMS } from "../lib/deal/statute";

const outDir = join(process.cwd(), "copilot", "data");
mkdirSync(outDir, { recursive: true });

const researchedFips = Object.keys(COUNTY_DATA);
const resolved = researchedFips
  .map((fips) => resolveCountyRule(fips))
  .filter((r): r is NonNullable<typeof r> => r !== null);

const payload = {
  exportedAt: new Date().toISOString(),
  version: "1.0.0",
  note:
    "Trusted atlas export for DeedPilot copilot. County research layered over state defaults; inherited fields listed per record.",
  states: STATE_DATA,
  statuteParams: STATUTE_PARAMS,
  counties: ALL_COUNTIES,
  resolvedRules: resolved,
  researchedFips,
};

const outPath = join(outDir, "atlas_export.json");
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(
  `Wrote ${outPath} (${resolved.length} resolved counties, ${Object.keys(STATE_DATA).length} states, ${Object.keys(STATUTE_PARAMS).length} statutes)`,
);
