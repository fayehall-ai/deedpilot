/**
 * Lot status vocabulary invariants.
 * Run: npx tsx lib/ingest/lot-status.test.ts
 *
 * This parser is the only place an adapter may assert *why* a parcel left a
 * sale. Everything else — `reconcile.ts` — records that it left and refuses to
 * say why. So a wrong mapping here does not merely mislabel a row, it
 * manufactures an observation nobody made.
 */
import { parseLotStatus, statusWasAsserted } from "./lot-status";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- the plain cases ---------------------------------------------------------

assert(parseLotStatus("SOLD") === "sold", "sold");
assert(parseLotStatus("Redeemed") === "redeemed", "redeemed");
assert(parseLotStatus("CANCELLED") === "cancelled", "cancelled");
assert(parseLotStatus("Withdrawn") === "withdrawn", "withdrawn");
assert(parseLotStatus("Struck to County") === "struck", "struck");

// --- defaults are honest -----------------------------------------------------

assert(parseLotStatus("") === "pending", "empty text is pending, not a disposition");
assert(parseLotStatus(null) === "pending", "null is pending");
assert(parseLotStatus("Open for bid") === "pending", "an open parcel is pending");
assert(
  parseLotStatus("Fnord-9") === "pending",
  "an unfamiliar word must not be guessed into a disposition",
);
assert(!statusWasAsserted(""), "nothing published is not an assertion");
assert(!statusWasAsserted("Open"), "an open status asserts no disposition");
assert(statusWasAsserted("REDEEMED"), "a published disposition is an assertion");

// --- the regression this file exists for ------------------------------------

/*
 * One Florida path read `/redeem|cancel|sold/.test(raw) ? "redeemed" : "pending"`,
 * so every sold and every cancelled parcel was recorded as redeemed — into the
 * exact column a redemption analysis reads.
 */
assert(parseLotStatus("Sold") !== "redeemed", "a sold parcel is never redeemed");
assert(parseLotStatus("Cancelled") !== "redeemed", "a cancelled parcel is never redeemed");

// --- precedence when a page carries several words ---------------------------

/*
 * Counties write prose, not enums. A sale is terminal, so it outranks a
 * redemption window merely being mentioned.
 */
assert(
  parseLotStatus("SOLD - redemption period expires 2027-01-02") === "sold",
  "a sold parcel mentioning redemption is sold",
);
assert(
  parseLotStatus("Struck to county — no bid received") === "struck",
  "struck outranks the absence of a bid being described",
);
assert(
  parseLotStatus("Cancelled: owner bankruptcy stay") === "cancelled",
  "a bankruptcy stay is a cancellation, not a redemption",
);

// --- the vocabulary counties actually use ------------------------------------

for (const [text, expected] of [
  ["Taxes Paid", "redeemed"],
  ["PAID IN FULL", "redeemed"],
  ["Paid prior to sale", "redeemed"],
  ["Removed from sale", "withdrawn"],
  ["Pulled by tax collector", "withdrawn"],
  ["Postponed", "withdrawn"],
  ["No bid", "struck"],
  ["Escheated to the state", "struck"],
  ["Bankruptcy", "cancelled"],
  ["Sale set aside", "cancelled"],
  ["Awarded to bidder 44", "sold"],
] as const) {
  assert(
    parseLotStatus(text) === expected,
    `"${text}" should read as ${expected}, got ${parseLotStatus(text)}`,
  );
}

console.log("lot-status.test.ts — all assertions passed");
