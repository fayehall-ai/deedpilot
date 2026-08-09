/**
 * Sync `lib/atlas/county-rules.ts` from the tax-deed-map research repo.
 *
 * The two repos share a schema and a lineage: tax-deed-map is where the
 * per-county due-diligence research is done (the "LA-standard bump" playbook
 * in its docs/), and DeedPilot's atlas is a copy of it. The copy went stale at
 * 152 counties while the research reached 1,010, which is why nearly every
 * county page here renders state defaults and why the source registry had two
 * `listing` URLs in the whole country.
 *
 * This is a one-way sync, upstream → here, and it is deliberately dumb: it
 * copies fields, validates them, and writes a deterministic file. It does not
 * merge, because there is nothing to merge — every one of the 152 local
 * entries is a strict subset of its upstream counterpart, verified by
 * comparing all 152 before this script was written.
 *
 * It refuses rather than guesses:
 *   - a FIPS that is not a real county is dropped, not invented
 *   - a field the CountyRule type does not declare aborts the run, because a
 *     silently ignored field is research that looks present and is not
 *   - an entry with no `asOf` is dropped: an undated claim about deposit rules
 *     or a platform URL is worse than no claim, and the atlas pages label
 *     every figure with its check date
 *
 * Usage:
 *   npx tsx scripts/sync-county-atlas.ts [--source <path>] [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ALL_COUNTIES } from "../lib/atlas";
import type { CountyRule } from "../lib/atlas/types";

const require = createRequire(import.meta.url);

const DEFAULT_SOURCE = "/Users/fayehall/tax-deed-map/data/county-data.js";
const TARGET = new URL("../lib/atlas/county-rules.ts", import.meta.url).pathname;

/**
 * Every key `CountyRule` declares. A key outside this set means the upstream
 * schema moved; the run aborts so the field can be added to the type on
 * purpose rather than dropped on the floor.
 */
const ALLOWED_FIELDS = new Set([
  "type",
  "notes",
  "auctionFormat",
  "auctionPlatform",
  "auctionFrequency",
  "depositRules",
  "taxCollector",
  "clerkOfCourt",
  "propertyAppraiser",
  "survivingLiens",
  "quietTitle",
  "gisMap",
  "growthNeighborhoods",
  "asOf",
  "sources",
]);

/**
 * Drop nulls, recursively.
 *
 * Upstream writes `phone: null` for a contact it did not research. The atlas
 * treats an absent field and an unresearched one as the same thing — both fall
 * back to the state default and render as empty — while `null` is neither, and
 * the CountyRule type rightly refuses it. Stripping keeps "we did not check"
 * from being encoded as a value.
 */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null).map((v) => stripNulls(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

/** Field order in the generated file — stable so diffs stay readable. */
const FIELD_ORDER = [
  "type",
  "notes",
  "auctionFormat",
  "auctionPlatform",
  "auctionFrequency",
  "depositRules",
  "taxCollector",
  "clerkOfCourt",
  "propertyAppraiser",
  "survivingLiens",
  "quietTitle",
  "gisMap",
  "growthNeighborhoods",
  "asOf",
  "sources",
] as const;

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const sourceIdx = args.indexOf("--source");
  const sourcePath = sourceIdx >= 0 ? args[sourceIdx + 1] : DEFAULT_SOURCE;

  const { COUNTY_DATA: upstream } = require(sourcePath) as {
    COUNTY_DATA: Record<string, Record<string, unknown>>;
  };

  const byFips = new Map(ALL_COUNTIES.map((c) => [c.fips, c]));
  const existing = readFileSync(TARGET, "utf8");
  const header = existing.slice(0, existing.indexOf("export const COUNTY_DATA"));
  const beforeCount = (existing.match(/^ {2}"\d{5}":/gm) ?? []).length;

  const kept: [string, CountyRule][] = [];
  const dropped: { fips: string; reason: string }[] = [];
  const unknownFields = new Set<string>();

  for (const fips of Object.keys(upstream).sort()) {
    const entry = upstream[fips];

    for (const k of Object.keys(entry)) if (!ALLOWED_FIELDS.has(k)) unknownFields.add(k);

    const county = byFips.get(fips);
    if (!county) {
      dropped.push({ fips, reason: "not a county in the atlas" });
      continue;
    }
    if (!entry.asOf) {
      dropped.push({ fips, reason: "no asOf — an undated claim is not publishable" });
      continue;
    }

    const rule: Record<string, unknown> = {};
    for (const f of FIELD_ORDER) {
      if (entry[f] === undefined || entry[f] === null) continue;
      rule[f] = stripNulls(entry[f]);
    }
    kept.push([fips, rule as CountyRule]);
  }

  if (unknownFields.size) {
    console.error(
      `Upstream carries fields CountyRule does not declare: ${[...unknownFields].join(", ")}.\n` +
        `Add them to lib/atlas/types.ts and to ALLOWED_FIELDS/FIELD_ORDER here, then re-run.\n` +
        `Refusing to write — silently dropping researched fields is the failure this guard exists for.`,
    );
    process.exit(1);
  }

  const body = kept
    .map(([fips, rule]) => {
      const county = byFips.get(fips)!;
      const lines = FIELD_ORDER.filter((f) => (rule as Record<string, unknown>)[f] !== undefined).map(
        (f) => `    ${f}: ${JSON.stringify((rule as Record<string, unknown>)[f])},`,
      );
      return `  "${fips}": { // ${county.name} County, ${county.state}\n${lines.join("\n")}\n  },`;
    })
    .join("\n");

  const out = `${header}export const COUNTY_DATA: Record<string, CountyRule> = {\n${body}\n};\n`;

  const states = new Set(kept.map(([f]) => byFips.get(f)!.state));
  console.log(`source:   ${sourcePath}`);
  console.log(`upstream: ${Object.keys(upstream).length} entries`);
  console.log(`kept:     ${kept.length} counties across ${states.size} states`);
  console.log(`was:      ${beforeCount} counties`);
  if (dropped.length) {
    console.log(`dropped:  ${dropped.length}`);
    for (const d of dropped.slice(0, 10)) console.log(`   ${d.fips} — ${d.reason}`);
    if (dropped.length > 10) console.log(`   … and ${dropped.length - 10} more`);
  }

  if (dryRun) {
    console.log("\n(dry run — nothing written)");
    return;
  }
  writeFileSync(TARGET, out);
  console.log(`\nwrote ${TARGET} (${(out.length / 1024).toFixed(0)} KB)`);
}

main();
