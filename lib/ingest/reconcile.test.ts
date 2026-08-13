/**
 * Reconciliation guard invariants.
 * Run: npx tsx lib/ingest/reconcile.test.ts
 *
 * No network, no database — `shouldReconcile` is pure precisely so the decision
 * that can destroy real inventory is testable in isolation. Every case below is
 * a shape this system has actually produced: a selector returning a handful of
 * rows, a partial county run, a sale that legitimately sheds parcels in its
 * final days.
 */
import { MIN_RETENTION, shouldReconcile } from "./reconcile";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- the ordinary case -------------------------------------------------------

const normal = shouldReconcile({ seen: 54, absent: 6, status: "ok" });
assert(normal.reconcile, "54 of 60 surviving is ordinary attrition and must reconcile");
assert(
  normal.reason.includes("90%"),
  `the reason should state the retention it acted on, got: ${normal.reason}`,
);

// --- breakage must never be read as a cleared sale ---------------------------

/*
 * The case this guard exists for. A moved table selector yields a token handful
 * of rows; without the retention floor, 297 real parcels are withdrawn and the
 * subscriber loses every one of them.
 */
const broken = shouldReconcile({ seen: 3, absent: 297, status: "ok" });
assert(!broken.reconcile, "3 of 300 is breakage, not a sale clearing out");
assert(
  broken.reason.includes("refusing"),
  `a refusal must say so in words an operator can act on, got: ${broken.reason}`,
);

const empty = shouldReconcile({ seen: 0, absent: 40, status: "ok" });
assert(!empty.reconcile, "a crawl returning nothing must never withdraw everything");

// --- only a clean run is evidence -------------------------------------------

for (const status of ["partial", "failed", "blocked"] as const) {
  const r = shouldReconcile({ seen: 54, absent: 6, status });
  assert(!r.reconcile, `status ${status} must not reconcile — part of the crawl did not happen`);
  assert(r.reason.includes(status), `the refusal should name the status, got: ${r.reason}`);
}

// --- nothing to do -----------------------------------------------------------

const none = shouldReconcile({ seen: 54, absent: 0, status: "ok" });
assert(!none.reconcile, "no absences means no work");

// --- the threshold itself ----------------------------------------------------

/*
 * Exactly at the floor must pass, because the floor is expressed as "below
 * MIN_RETENTION refuses". A county shedding half its list in the last days
 * before a sale is unusual but real, and refusing it would discard the very
 * observation this module was built to record.
 */
const atFloor = shouldReconcile({ seen: 50, absent: 50, status: "ok" });
assert(atFloor.reconcile, `retention of exactly ${MIN_RETENTION} must reconcile, not refuse`);

const belowFloor = shouldReconcile({ seen: 49, absent: 51, status: "ok" });
assert(!belowFloor.reconcile, "just below the floor must refuse");

// --- a single-parcel auction -------------------------------------------------

const onlyOne = shouldReconcile({ seen: 1, absent: 1, status: "ok" });
assert(onlyOne.reconcile, "1 of 2 is at the floor and must reconcile");

console.log("reconcile.test.ts — all assertions passed");
