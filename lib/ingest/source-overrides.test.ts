/**
 * Source-override precedence invariants.
 * Run: npx tsx lib/ingest/source-overrides.test.ts
 *
 * This decides which URL a crawler fetches for a county. Getting it wrong sends
 * the crawler at another county's sale list and files the result under this one,
 * which is worse than the bug it fixes — before this existed, overrides were
 * simply inert.
 */
import { applyOverrides, urlKeyOf, type OverrideRow } from "./source-overrides";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const ov = (p: Partial<OverrideRow> & { countyFips: string }): OverrideRow => ({
  adapter: "generic-county",
  url: null,
  enabled: true,
  note: null,
  ...p,
});

const map = (...rows: OverrideRow[]) => new Map(rows.map((r) => [r.countyFips, r]));

/* Config shapes taken from the real adapters. */
const generic = {
  countyFips: "13121",
  config: { url: "https://county.gov/sales", countyName: "Fulton" } as Record<string, unknown>,
};
const clark = {
  countyFips: "32003",
  config: { sourceUrl: "https://treasurer.clarkcountynv.gov/auction" } as Record<string, unknown>,
};
const lgbs = {
  countyFips: "48201",
  config: { lgbsCounty: "Harris", state: "TX" } as Record<string, unknown>,
};
const taxsaleinfo = {
  countyFips: "26121",
  config: { catalogId: 9142, countyLabel: "Muskegon" } as Record<string, unknown>,
};

// --- no override changes nothing --------------------------------------------

const untouched = applyOverrides([generic, lgbs], map());
assert(untouched.bindings.length === 2, "bindings pass through untouched");
assert(untouched.bindings[0] === generic, "an untouched binding is the same object");
assert(untouched.rewritten.length === 0 && untouched.disabled.length === 0, "nothing reported");

// --- disabling works for every adapter, whatever its config shape ------------

for (const b of [generic, clark, lgbs, taxsaleinfo]) {
  const r = applyOverrides([b], map(ov({ countyFips: b.countyFips, enabled: false })));
  assert(r.bindings.length === 0, `${b.countyFips} must be removed when disabled`);
  assert(r.disabled[0] === b.countyFips, "the removal is reported");
}

// --- a URL override rewrites the key the binding actually uses --------------

const rewrittenGeneric = applyOverrides(
  [generic],
  map(ov({ countyFips: "13121", url: "https://moved.example.gov/list" })),
);
assert(
  rewrittenGeneric.bindings[0].config.url === "https://moved.example.gov/list",
  "generic-county carries `url` and must be rewritten there",
);
assert(rewrittenGeneric.bindings[0].config.countyName === "Fulton", "other config survives");
assert(rewrittenGeneric.rewritten[0] === "13121", "the rewrite is reported");

const rewrittenClark = applyOverrides(
  [clark],
  map(ov({ countyFips: "32003", url: "https://moved.example.gov/auction" })),
);
assert(
  rewrittenClark.bindings[0].config.sourceUrl === "https://moved.example.gov/auction",
  "clark-nv carries `sourceUrl` and must be rewritten there, not at `url`",
);
assert(rewrittenClark.bindings[0].config.url === undefined, "a `url` key must not be invented");

// --- the original binding is never mutated ----------------------------------

assert(generic.config.url === "https://county.gov/sales", "the input binding is left alone");

// --- an inapplicable URL override is reported, never silently dropped -------

/*
 * The whole point. `tx-lgbs` resolves its source from a law firm's multi-county
 * page; there is no per-county URL to replace. Swallowing the override here
 * would rebuild the bug this file exists to close, one level down.
 */
for (const b of [lgbs, taxsaleinfo]) {
  const r = applyOverrides([b], map(ov({ countyFips: b.countyFips, url: "https://somewhere.example" })));
  assert(r.rewritten.length === 0, `${b.countyFips} has no URL key and must not be rewritten`);
  assert(r.inapplicable.length === 1, "an unusable override must be reported");
  assert(
    r.inapplicable[0].reason.includes("inert"),
    `the reason must say the override does nothing, got: ${r.inapplicable[0].reason}`,
  );
  assert(r.bindings.length === 1, "the county still crawls from its own source");
}

// --- enabled with no URL keeps the registry's source ------------------------

const reEnabled = applyOverrides([generic], map(ov({ countyFips: "13121", enabled: true, url: null })));
assert(reEnabled.bindings.length === 1, "an enabled county with no URL still crawls");
assert(reEnabled.bindings[0].config.url === "https://county.gov/sales", "it keeps the registry URL");
assert(reEnabled.rewritten.length === 0, "nothing was rewritten");

// --- key detection -----------------------------------------------------------

assert(urlKeyOf({ url: "https://a" }) === "url", "url");
assert(urlKeyOf({ sourceUrl: "https://a" }) === "sourceUrl", "sourceUrl");
assert(urlKeyOf({ listUrl: "https://a" }) === "listUrl", "listUrl");
assert(urlKeyOf({ lgbsCounty: "Harris" }) === null, "no URL key");
assert(urlKeyOf({ url: "" }) === null, "an empty string is not a URL");
assert(urlKeyOf({ url: 42 }) === null, "a non-string is not a URL");
assert(urlKeyOf({ url: "https://a", sourceUrl: "https://b" }) === "url", "`url` wins on precedence");

// --- an override for a county the adapter does not serve is a no-op ---------

const foreign = applyOverrides([generic], map(ov({ countyFips: "99999", url: "https://x" })));
assert(foreign.bindings.length === 1 && foreign.rewritten.length === 0, "unrelated overrides are ignored");

console.log("source-overrides.test.ts — all assertions passed");
