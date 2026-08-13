/**
 * Override validation invariants.
 * Run: npx tsx lib/admin/auction-overrides.test.ts
 *
 * This file exists because an invalid override is not a rejected form field —
 * it is stored, then read back inside `upsertAuction` through a Postgres cast,
 * and an out-of-domain value raises *there*. The auction would fail to ingest
 * on every future crawl with an error naming a cast rather than a bad edit, so
 * a county's sale would quietly leave the pipeline. Validation is the only
 * thing standing between a typo and that outcome.
 */
import {
  AUCTION_STATUSES,
  LISTING_KINDS,
  OVERRIDABLE,
  SALE_TYPES,
  isOverridable,
  validateOverrides,
} from "./auction-override-fields";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- the enum lists must come from the schema, not from memory ---------------

/*
 * The regression this guards. A hand-written list had "Foreclosure" and
 * "Unknown" as sale types — neither exists — and omitted "Hybrid".
 */
assert(SALE_TYPES.includes("Hybrid"), "SALE_TYPES must include Hybrid, which a mirrored list missed");
assert(
  !(SALE_TYPES as readonly string[]).includes("Foreclosure"),
  "Foreclosure is not a sale_type member and must not validate",
);
assert(SALE_TYPES.length === 4, `sale_type has 4 members, got ${SALE_TYPES.length}`);
assert(LISTING_KINDS.includes("sale_list"), "listing kinds must come from the schema");
assert(AUCTION_STATUSES.includes("postponed"), "auction statuses must come from the schema");

// --- the allow-list ----------------------------------------------------------

assert(isOverridable("saleDate"), "saleDate is the whole point and must be overridable");
assert(!isOverridable("lotCount"), "derived columns must not be overridable");
assert(!isOverridable("sourceUrl"), "provenance must not be rewritable by hand");

const notAllowed = validateOverrides({ lotCount: 5 });
assert(notAllowed.length === 1, "an unknown field is one error");
assert(notAllowed[0].includes("not overridable"), `error should say why, got: ${notAllowed[0]}`);

// --- every value is checked against its column's domain ----------------------

assert(validateOverrides({ saleDate: "2026-09-01" }).length === 0, "a real date validates");
assert(validateOverrides({ saleDate: "09/01/2026" }).length > 0, "US format must be rejected");
assert(validateOverrides({ saleDate: "2026-13-45" }).length > 0, "an impossible date must be rejected");
assert(validateOverrides({ saleDate: 20260901 }).length > 0, "a number is not a date");

assert(validateOverrides({ saleType: "Tax Deed" }).length === 0, "a real sale type validates");
assert(
  validateOverrides({ saleType: "Foreclosure" }).length > 0,
  "an out-of-domain enum value must be caught here, not by the upsert",
);

assert(validateOverrides({ listingKind: "sale_list" }).length === 0, "a real listing kind validates");
assert(validateOverrides({ listingKind: "saleList" }).length > 0, "camelCase is not the enum member");

assert(validateOverrides({ status: "cancelled" }).length === 0, "cancelled is a real status");
assert(validateOverrides({ saleDateConfirmed: true }).length === 0, "a boolean validates");
assert(validateOverrides({ saleDateConfirmed: "true" }).length > 0, "a string is not a boolean");

assert(validateOverrides({ title: "" }).length > 0, "an empty title is not a correction");
assert(validateOverrides({ startTime: "10:00 AM ET" }).length === 0, "published prose validates");

// --- every problem is reported, not just the first ---------------------------

const many = validateOverrides({ saleDate: "nope", saleType: "Foreclosure", lotCount: 1 });
assert(many.length === 3, `an operator fixing a form wants every problem, got ${many.length}`);

// --- the allow-list and the checkers cannot drift ----------------------------

for (const field of Object.keys(OVERRIDABLE)) {
  assert(isOverridable(field), `${field} is in OVERRIDABLE but isOverridable says no`);
  assert(
    typeof OVERRIDABLE[field as keyof typeof OVERRIDABLE] === "function",
    `${field} must carry a validator, not a bare true`,
  );
}

console.log("auction-override-fields.test.ts — all assertions passed");
