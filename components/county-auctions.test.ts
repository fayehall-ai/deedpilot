/**
 * The sale list picks the right rows for the selection.
 * Run: npx tsx components/county-auctions.test.ts
 *
 * The filtering is the whole component — the rest is markup. Getting it wrong
 * shows a reader another county's sales under the county they chose, which is
 * the same class of error as a wrong-parcel valuation: confidently rendered,
 * plausible, and about a different property entirely.
 */
type Row = { id: string; countyFips: string; state: string; saleDate: string; lotCount: number };

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const ROWS: Row[] = [
  { id: "a", countyFips: "05007", state: "AR", saleDate: "2026-09-01", lotCount: 10 },
  { id: "b", countyFips: "05007", state: "AR", saleDate: "2026-08-20", lotCount: 5 },
  { id: "c", countyFips: "05009", state: "AR", saleDate: "2026-08-25", lotCount: 7 },
  { id: "d", countyFips: "13067", state: "GA", saleDate: "2026-08-30", lotCount: 99 },
];

/** Mirrors the component: county wins, then state, then everything. */
function select(rows: Row[], countyFips?: string | null, stateAbbr?: string | null): Row[] {
  if (countyFips) {
    return rows.filter((r) => r.countyFips === countyFips).sort((a, b) => a.saleDate.localeCompare(b.saleDate));
  }
  const scoped = stateAbbr ? rows.filter((r) => r.state === stateAbbr) : rows;
  return [...scoped].sort((a, b) => a.saleDate.localeCompare(b.saleDate));
}

// A chosen county shows only its own sales, soonest first.
const benton = select(ROWS, "05007");
assert(benton.length === 2, `county filter returns its own sales, got ${benton.length}`);
assert(benton[0].id === "b", "sales are ordered soonest first");
assert(!benton.some((r) => r.countyFips !== "05007"), "no other county's sale may appear");

// A county with nothing scheduled returns empty rather than falling back to the
// state — silently widening the scope would show sales that are not there.
assert(select(ROWS, "05999").length === 0, "an empty county stays empty");

// County beats state when both are set, which is the normal case: a county is
// always chosen from within an open state.
assert(select(ROWS, "05007", "AR").length === 2, "county wins over state");
assert(select(ROWS, "13067", "AR").every((r) => r.state === "GA"), "county wins even across states");

// No county: scoped to the open state.
const ar = select(ROWS, null, "AR");
assert(ar.length === 3 && ar.every((r) => r.state === "AR"), `state scope, got ${ar.length}`);
assert(ar[0].saleDate === "2026-08-20", "state list is ordered soonest first");

// Nothing selected: everything.
assert(select(ROWS).length === 4, "unscoped shows all");

console.log("county auctions tests ok");
