/**
 * Import de-duplication.
 * Run: npx tsx lib/import/plan.test.ts
 *
 * Every failure mode these assertions guard produces a *plausible* calendar
 * rather than an error: a county holding one sale twice on one day, or a
 * re-upload silently doubling 644 rows. Nothing raises, nothing logs, and the
 * only symptom is a page that looks slightly wrong to someone who knows the
 * county. That is why the rules live in a pure function with a test rather than
 * inside a transaction.
 */
import { planImport, type ExistingAuction } from "./plan";
import type { ResolvedAuction } from "./apply";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

const HINDS = "28049";

/** A resolved row with only the fields the planner reads. */
function row(over: Partial<ResolvedAuction> & { sourceId: string }): ResolvedAuction {
  return {
    externalId: `import:${over.sourceId}`,
    stateLabel: "Mississippi",
    countyLabel: "Hinds County",
    countyFips: HINDS,
    saleDate: "2026-08-31",
    saleType: "Tax Lien",
    platform: "govease",
    venue: "Online",
    startTime: null,
    title: null,
    announcedParcelCount: 100,
    aggregateSaleAmount: null,
    sourceUrl: "https://example.test/1",
    raw: {},
    line: 2,
    ...over,
  } as ResolvedAuction;
}

const crawled = (id: string, saleDate = "2026-08-31"): ExistingAuction => ({
  id,
  countyFips: HINDS,
  saleDate,
  externalId: "GOVEASE-77",
});
const imported = (id: string, sourceId: string, saleDate = "2026-08-31"): ExistingAuction => ({
  id,
  countyFips: HINDS,
  saleDate,
  externalId: `import:${sourceId}`,
});

const kinds = (rows: ResolvedAuction[], existing: ExistingAuction[]) =>
  planImport(rows, existing).decisions.map((d) => d.kind);

// ---------------------------------------------------------------------------
// A clean import
// ---------------------------------------------------------------------------

assert(
  JSON.stringify(kinds([row({ sourceId: "1" }), row({ sourceId: "2", saleDate: "2026-09-01" })], [])) ===
    JSON.stringify(["insert", "insert"]),
  "new sales in an empty database are inserted",
);

// ---------------------------------------------------------------------------
// 1. the same row twice in one file
// ---------------------------------------------------------------------------

assert(
  JSON.stringify(kinds([row({ sourceId: "1" }), row({ sourceId: "1" })], [])) ===
    JSON.stringify(["insert", "duplicate_in_file"]),
  "a repeated Auction ID inserts once and reports the repeat",
);

/*
 * Two Mississippi districts share a county and a date and differ only by id.
 * They are two real sales, not a duplicate, and collapsing them would lose one.
 */
assert(
  JSON.stringify(
    kinds(
      [
        row({ sourceId: "1", title: "District 1" }),
        row({ sourceId: "2", title: "District 2" }),
      ],
      [],
    ),
  ) === JSON.stringify(["insert", "insert"]),
  "two sales in one county on one day both import",
);

// ---------------------------------------------------------------------------
// 2. the same file uploaded twice
// ---------------------------------------------------------------------------

const reupload = planImport([row({ sourceId: "1" })], [imported("a-1", "1")]);
assert(reupload.decisions[0].kind === "update", "a row a previous upload created is updated");
assert(
  reupload.decisions[0].kind === "update" && reupload.decisions[0].id === "a-1",
  "and updated in place, by id",
);

/*
 * The platform is derived from the published sale site and can change between
 * exports. The unique index includes platform, so a lookup keyed on it would
 * miss the existing row and insert a second one — the exact duplicate this is
 * meant to prevent, arriving through the back door.
 */
const moved = planImport(
  [row({ sourceId: "1", platform: "bid4assets" })],
  [imported("a-1", "1")],
);
assert(
  moved.decisions[0].kind === "update",
  "a change of platform still matches the row it owns, rather than duplicating it",
);

/* A corrected sale date is likewise not a new sale. */
const moveddate = planImport(
  [row({ sourceId: "1", saleDate: "2026-09-15" })],
  [imported("a-1", "1", "2026-08-31")],
);
assert(
  moveddate.decisions[0].kind === "update",
  "a corrected sale date updates the same row rather than adding one",
);

// ---------------------------------------------------------------------------
// 3. a sale the crawler already holds
// ---------------------------------------------------------------------------

const collide = planImport([row({ sourceId: "1" })], [crawled("c-1")]);
assert(collide.decisions[0].kind === "merge", "one crawled sale and one imported row merge");
assert(
  collide.decisions[0].kind === "merge" && collide.decisions[0].id === "c-1",
  "into the crawled auction",
);
assert(collide.ambiguous.length === 0, "and that is not reported as ambiguous");

/* A different date in the same county is a different sale. */
assert(
  kinds([row({ sourceId: "1", saleDate: "2026-10-05" })], [crawled("c-1", "2026-08-31")])[0] ===
    "insert",
  "a crawled sale on another date does not absorb this one",
);

// ---------------------------------------------------------------------------
// Ambiguity is reported, never guessed
// ---------------------------------------------------------------------------

const twoImported = planImport(
  [row({ sourceId: "1", title: "District 1" }), row({ sourceId: "2", title: "District 2" })],
  [crawled("c-1")],
);
assert(
  JSON.stringify(twoImported.decisions.map((d) => d.kind)) === JSON.stringify(["insert", "insert"]),
  "two imported rows against one crawled sale merge into neither",
);
assert(twoImported.ambiguous.length === 1, "and the collision is reported once");
assert(
  twoImported.ambiguous[0].existing === 1 && twoImported.ambiguous[0].imported === 2,
  "with both counts, so a person can see the shape of it",
);

const twoCrawled = planImport([row({ sourceId: "1" })], [crawled("c-1"), crawled("c-2")]);
assert(twoCrawled.decisions[0].kind === "insert", "one row against two crawled sales picks neither");
assert(twoCrawled.ambiguous.length === 1, "and reports it");

/*
 * A crawled auction absorbs at most one row. Without that, a second row on the
 * same day would merge into the same auction and disappear — the merge would
 * report success while losing a sale.
 */
const consumed = planImport(
  [row({ sourceId: "1" }), row({ sourceId: "2", saleDate: "2026-09-01" })],
  [crawled("c-1", "2026-08-31"), crawled("c-2", "2026-09-01")],
);
assert(
  JSON.stringify(consumed.decisions.map((d) => d.kind)) === JSON.stringify(["merge", "merge"]),
  "two rows on two dates merge into their own matching auctions",
);
assert(
  consumed.decisions[0].kind === "merge" &&
    consumed.decisions[1].kind === "merge" &&
    consumed.decisions[0].id !== consumed.decisions[1].id,
  "and never both into the same one",
);

// ---------------------------------------------------------------------------
// A row this import owns wins over a merge candidate
// ---------------------------------------------------------------------------

/*
 * Re-uploading into a county that also has a crawled sale that day must update
 * the imported row, not merge it into the crawled one — otherwise every
 * re-upload would abandon its own row and start contributing to somebody
 * else's, leaving the original orphaned on the calendar forever.
 */
const both = planImport([row({ sourceId: "1" })], [imported("a-1", "1"), crawled("c-1")]);
assert(both.decisions[0].kind === "update", "ownership is checked before the merge");

// ---------------------------------------------------------------------------
// Counties do not bleed into each other
// ---------------------------------------------------------------------------

const other = planImport(
  [row({ sourceId: "1", countyFips: "29189" })],
  [crawled("c-1")],
);
assert(
  other.decisions[0].kind === "insert",
  "a sale on the same date in a different county is not a collision",
);

console.log(`plan.test.ts — ${passed} assertions passed`);
