/**
 * Scout scheduling assertions. Planning is pure, so none of this needs a
 * database, a network, or a real clock.
 * Run: npx tsx lib/scout/scout.test.ts
 */
import {
  adapterBacklog,
  backoffDays,
  isBackedOff,
  planScout,
  priorityOf,
  healthFromResults,
  sourceIndexFromRegistry,
  type CountyHealth,
} from "./schedule";

import { nextSaleWindows } from "../atlas/calendar";
import type { SourceRegistry, VerifiedSource } from "../prospector/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const HARRIS = "48201"; // TX — first Tuesday, statutory
const GENESEE = "26049"; // MI — biannual, statutory
const MARICOPA = "04013"; // AZ — annual February
const WY = "56001"; // unresearched

// --- backoff -----------------------------------------------------------------

assert(backoffDays(0) === 0, "healthy county is not delayed");
assert(backoffDays(1) === 1, "first failure waits a day");
assert(backoffDays(3) === 4, "third failure waits four days");
assert(backoffDays(20) === 30, "backoff is capped at 30 days");

const sick: CountyHealth = { consecutiveFailures: 3, lastAttempt: "2026-09-01" };
assert(isBackedOff(sick, "2026-09-03"), "still waiting two days after a 4-day backoff");
assert(!isBackedOff(sick, "2026-09-05"), "eligible again after the window");
assert(!isBackedOff({ consecutiveFailures: 0, lastAttempt: "2026-09-01" }, "2026-09-01"), "healthy");
assert(!isBackedOff(undefined, "2026-09-01"), "unknown county is not backed off");

// --- priority ----------------------------------------------------------------

const near = priorityOf({
  kind: "listing", confidence: "statutory", saleDate: "2026-09-03", date: "2026-09-01", hasAdapter: true,
});
const far = priorityOf({
  kind: "listing", confidence: "statutory", saleDate: "2026-09-25", date: "2026-09-01", hasAdapter: true,
});
assert(near > far, "an imminent sale outranks a distant one");

const listing = priorityOf({
  kind: "listing", confidence: "typical", saleDate: "2026-09-10", date: "2026-09-01", hasAdapter: true,
});
const results = priorityOf({
  kind: "results", confidence: "typical", saleDate: "2026-09-10", date: "2026-09-01", hasAdapter: true,
});
assert(listing > results, "listings are perishable, results are not");

const statutory = priorityOf({
  kind: "results", confidence: "statutory", saleDate: "2026-09-10", date: "2026-09-01", hasAdapter: true,
});
const guessed = priorityOf({
  kind: "results", confidence: "unresearched", saleDate: "2026-09-10", date: "2026-09-01", hasAdapter: true,
});
assert(statutory > guessed, "a known date outranks a guessed one");

// --- planning ----------------------------------------------------------------

const on = new Date("2026-09-01T00:00:00Z");
const fips = [HARRIS, GENESEE, MARICOPA, WY];

const full = planScout({
  fipsList: fips,
  adapterByCounty: { [HARRIS]: "tx-lgbs", [GENESEE]: "mi-taxsaleinfo" },
  sourceByCounty: { [HARRIS]: "https://a.gov", [GENESEE]: "https://b.gov", [WY]: "https://c.gov" },
  on,
});

assert(full.tasks.every((t) => t.adapter !== null), "every task has a parser");
assert(full.tasks.length > 0, "Harris is mid-listing-window on its sale day");
assert(
  full.tasks[0].priority >= full.tasks[full.tasks.length - 1].priority,
  "queue is ordered by priority",
);

// A county with a source but no adapter is a backlog entry, not a silent drop.
// Sweep dates are anchored to a fixed epoch with a per-county phase, so derive a
// date inside Wyoming's own window rather than assuming it shares Harris's.
const wyWindow = nextSaleWindows(WY, { from: new Date("2026-09-01T00:00:00Z"), count: 1 })[0];
const wyOn = new Date(`${wyWindow.listingOpensOn}T00:00:00Z`);
const wyPlan = planScout({
  fipsList: [WY],
  adapterByCounty: {},
  sourceByCounty: { [WY]: "https://c.gov" },
  on: wyOn,
});
const wySkip = wyPlan.skipped.find((s) => s.fips === WY);
assert(wySkip?.reason === "no_adapter", `WY should be a no_adapter skip, got ${wySkip?.reason}`);
assert(wySkip!.detail.includes("https://c.gov"), "backlog entry carries the source URL");

const backlog = adapterBacklog(wyPlan);
assert(backlog.some((b) => b.fips === WY && b.url === "https://c.gov"), "backlog is actionable");

// Coverage must account for every due county exactly once.
const accounted =
  full.coverage.runnable +
  full.coverage.noAdapter +
  full.coverage.noSource +
  full.coverage.backedOff +
  full.coverage.recentlyCrawled;
assert(
  accounted === full.coverage.dueToday,
  `coverage must balance: ${accounted} accounted vs ${full.coverage.dueToday} due`,
);

// --- skips -------------------------------------------------------------------

const noSources = planScout({ fipsList: [WY], adapterByCounty: {}, sourceByCounty: {}, on });
assert(
  noSources.skipped.every((s) => s.reason === "no_source"),
  "county with neither adapter nor source is a no_source skip",
);

const backedOff = planScout({
  fipsList: [HARRIS],
  adapterByCounty: { [HARRIS]: "tx-lgbs" },
  sourceByCounty: {},
  healthByCounty: { [HARRIS]: { consecutiveFailures: 5, lastAttempt: "2026-08-31" } },
  on,
});
assert(backedOff.tasks.length === 0, "a failing county is not hammered");
assert(backedOff.skipped.every((s) => s.reason === "backed_off"), "and says why");

const ranToday = planScout({
  fipsList: [HARRIS],
  adapterByCounty: { [HARRIS]: "tx-lgbs" },
  sourceByCounty: {},
  healthByCounty: { [HARRIS]: { consecutiveFailures: 0, lastAttempt: "2026-09-01" } },
  on,
});
assert(ranToday.tasks.length === 0, "a county crawled inside the re-crawl interval is not repeated");
assert(
  ranToday.skipped.every((s) => s.reason === "recently_crawled"),
  "and reports the interval that suppressed it",
);

// --- capping -----------------------------------------------------------------

const capped = planScout({
  fipsList: fips,
  adapterByCounty: { [HARRIS]: "tx-lgbs", [GENESEE]: "mi-taxsaleinfo", [MARICOPA]: "az", [WY]: "x" },
  sourceByCounty: {},
  on,
  maxTasks: 1,
});
assert(capped.tasks.length <= 1, "maxTasks caps the queue");
assert(capped.coverage.runnable === capped.tasks.length, "coverage reports the capped count");

// --- registry flattening prefers the government listing ----------------------

const mk = (over: Partial<VerifiedSource>): VerifiedSource => ({
  fips: GENESEE, state: "MI", url: "https://x", host: "x", origin: "atlas",
  kind: "listing", isGovernment: false, confidence: 0.5, signals: [],
  verifiedOn: "2026-07-30", httpStatus: 200, ...over,
});
const registry: SourceRegistry = {
  builtAt: "", nCounties: 1, nVerified: 3, nGaps: 0,
  counties: {
    [GENESEE]: {
      state: "MI", county: "Genesee", isGap: false,
      sources: [
        mk({ url: "https://vendor.com/l", kind: "listing", isGovernment: false, confidence: 0.99 }),
        mk({ url: "https://co.gov/rules", kind: "rules", isGovernment: true }),
        mk({ url: "https://co.gov/list", kind: "listing", isGovernment: true }),
      ],
    },
  },
};
assert(
  sourceIndexFromRegistry(registry)[GENESEE] === "https://co.gov/list",
  "government listing beats a high-confidence vendor and a government rules page",
);

// --- health transitions ------------------------------------------------------

const h0: Record<string, CountyHealth> = {};
const h1 = healthFromResults(
  h0,
  [{ countyFips: HARRIS, status: "failed" }],
  "2026-09-01",
);
assert(h1[HARRIS].consecutiveFailures === 1, "failure increments");

const h2 = healthFromResults(
  h1,
  [{ countyFips: HARRIS, status: "ok" }],
  "2026-09-02",
);
assert(h2[HARRIS].consecutiveFailures === 0, "success resets the counter");

// A policy block is permanent and expected — backing off would only delay the
// day someone notices the county needs an agreement or a government source.
const h3 = healthFromResults(
  h2,
  [{ countyFips: HARRIS, status: "blocked" }],
  "2026-09-03",
);
assert(h3[HARRIS].consecutiveFailures === 0, "a policy block is not a failure");
assert(h3[HARRIS].lastAttempt === "2026-09-02", "a block does not count as an attempt");

console.log("scout tests ok", {
  dueToday: full.coverage.dueToday,
  runnable: full.coverage.runnable,
  noAdapter: full.coverage.noAdapter,
  backlog: backlog.length,
});
