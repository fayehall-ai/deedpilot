/**
 * Registry merge must never drop counties when a partial state run writes.
 * Run: npx tsx lib/prospector/merge.test.ts
 */
import { buildRegistry, mergeRegistry } from "./index";
import type { ProspectResult } from "./types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const base = buildRegistry([
  {
    fips: "48201",
    state: "TX",
    county: "Harris",
    verified: [
      {
        fips: "48201",
        state: "TX",
        url: "https://example.com/tx",
        host: "example.com",
        origin: "atlas",
        kind: "listing",
        isGovernment: true,
        confidence: 1,
        signals: [],
        verifiedOn: "2026-08-01",
        httpStatus: 200,
      },
    ],
    rejected: [],
    isGap: false,
    note: "ok",
  },
] satisfies ProspectResult[]);

const patch = buildRegistry([
  {
    fips: "12086",
    state: "FL",
    county: "Miami-Dade",
    verified: [
      {
        fips: "12086",
        state: "FL",
        url: "https://example.com/fl",
        host: "example.com",
        origin: "atlas",
        kind: "results",
        isGovernment: true,
        confidence: 0.8,
        signals: [],
        verifiedOn: "2026-08-01",
        httpStatus: 200,
      },
    ],
    rejected: [],
    isGap: false,
    note: "ok",
  },
] satisfies ProspectResult[]);

const merged = mergeRegistry(base, patch);
assert(merged.nCounties === 2, `expected 2 counties, got ${merged.nCounties}`);
assert(merged.counties["48201"]?.sources.length === 1, "TX must survive");
assert(merged.counties["12086"]?.sources.length === 1, "FL must be added");

// Patch overwrites same FIPS
const overwrite = buildRegistry([
  {
    fips: "48201",
    state: "TX",
    county: "Harris",
    verified: [],
    rejected: [],
    isGap: true,
    note: "gap now",
  },
] satisfies ProspectResult[]);
const m2 = mergeRegistry(merged, overwrite);
assert(m2.counties["48201"]?.isGap === true, "same FIPS patch wins");
assert(m2.counties["12086"] != null, "FL still present");

console.log("merge.test.ts: ok");
