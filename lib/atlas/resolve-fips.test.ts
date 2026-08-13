/**
 * County name → FIPS resolution invariants.
 * Run: npx tsx lib/atlas/resolve-fips.test.ts
 *
 * This is the gate between researched rows and the source registry. A wrong
 * answer attaches a verified sale-list URL to the wrong county and the crawler
 * fetches it forever, so every case below is about refusing rather than
 * reaching. The name shapes are real ones sources use.
 */
import { ALL_COUNTIES } from "./index";
import { foldCountyName, isIndependentCity, resolveFips, summarise } from "./resolve-fips";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const fipsOf = (name: string, state: string) => {
  const r = resolveFips(name, state);
  return r.ok ? r.fips : null;
};

// --- the ordinary shapes -----------------------------------------------------

assert(fipsOf("Fulton", "GA") === "13121", "bare county name");
assert(fipsOf("Fulton County", "GA") === "13121", "county suffix");
assert(fipsOf("DeKalb", "GA") === "13089", "internal capital");
assert(fipsOf("Orleans Parish", "LA") === "22071", "Louisiana parish");
assert(fipsOf("Miami-Dade", "FL") === "12086", "hyphenated");
assert(fipsOf("Miami Dade", "FL") === "12086", "hyphen dropped by the source");
assert(fipsOf("St. Johns", "FL") === fipsOf("Saint Johns", "FL"), "St. and Saint are one county");
assert(fipsOf("Anchorage", "AK") !== null, "Alaska has no 'County' noun");
assert(fipsOf("Matanuska-Susitna Borough", "AK") !== null, "Alaska borough suffix");

// --- diacritics --------------------------------------------------------------

/*
 * The atlas normaliser drops every non-[a-z0-9] character, so "doña" folds to
 * "doa" and never meets a source writing "Dona Ana".
 */
assert(fipsOf("Doña Ana", "NM") === "35013", "accented form resolves");
assert(fipsOf("Dona Ana", "NM") === "35013", "unaccented form resolves to the same county");
assert(foldCountyName("Doña Ana") === foldCountyName("Dona Ana"), "both forms must fold alike");

// --- independent cities: the ambiguity that must never be guessed -----------

for (const [name, state] of [
  ["Baltimore", "MD"],
  ["Richmond", "VA"],
  ["St. Louis", "MO"],
] as const) {
  const r = resolveFips(name, state);
  assert(!r.ok, `a bare "${name}" in ${state} names both a county and a city and must not resolve`);
  if (!r.ok) {
    assert(r.reason === "ambiguous", `${name} should be ambiguous, got ${r.reason}`);
    assert(r.candidates.length === 2, `${name} should offer both candidates to the reviewer`);
  }
}

assert(fipsOf("Baltimore County", "MD") === "24005", "an explicit County marker picks the county");
assert(fipsOf("Baltimore City", "MD") === "24510", "an explicit City marker picks the city");
assert(fipsOf("Richmond County", "VA") === "51159", "VA county");
assert(fipsOf("Richmond city", "VA") === "51760", "VA independent city, lowercased as the Census writes it");
assert(fipsOf("City of Richmond", "VA") === "51760", "the 'City of X' form");
assert(fipsOf("St. Louis County", "MO") === "29189", "MO county");
assert(fipsOf("St. Louis City", "MO") === "29510", "MO independent city");

assert(isIndependentCity("24510"), "Baltimore city is an independent city");
assert(!isIndependentCity("24005"), "Baltimore County is not");
/*
 * The reason the >= 500 rule is confined to four states: Texas runs to 48507,
 * which is Zavala County and emphatically not a city.
 */
assert(!isIndependentCity("48507"), "Zavala County TX must not be read as an independent city");

// --- a county with no counterpart still resolves -----------------------------

assert(fipsOf("Manassas", "VA") !== null, "an independent city with no same-named county resolves");

// --- municipal states are a finding, not a failure ---------------------------

for (const town of ["New Britain", "Bridgeport"]) {
  const r = resolveFips(town, "CT");
  assert(!r.ok, `${town} is a town, not a county`);
  if (!r.ok) {
    assert(
      r.reason === "municipal_state",
      `CT towns must report as municipal, not as a data-quality failure; got ${r.reason}`,
    );
    assert(r.detail.includes(town), "the detail should carry the town name for whoever works CT");
  }
}

/* Hartford is both a CT county and a town, so it resolves — and that is correct. */
assert(fipsOf("Hartford", "CT") === "09003", "Hartford County exists and resolves");

// --- refusals ----------------------------------------------------------------

const nf = resolveFips("Nowhere", "GA");
assert(!nf.ok && nf.reason === "not_found", "an invented county is not found");

const bad = resolveFips("Fulton", "ZZ");
assert(!bad.ok && bad.reason === "unknown_state", "an unknown state is its own outcome");

const emptyName = resolveFips("   ", "GA");
assert(!emptyName.ok, "an empty name must not resolve");

// --- summarising a batch -----------------------------------------------------

const batch = summarise([
  resolveFips("Fulton", "GA"),
  resolveFips("Baltimore", "MD"),
  resolveFips("Bridgeport", "CT"),
  resolveFips("Nowhere", "GA"),
]);
assert(batch.resolved === 1, `expected 1 resolved, got ${batch.resolved}`);
assert(batch.ambiguous === 1, `expected 1 ambiguous, got ${batch.ambiguous}`);
assert(batch.municipal === 1, `expected 1 municipal, got ${batch.municipal}`);
assert(batch.notFound === 1, `expected 1 not found, got ${batch.notFound}`);

// --- every county must resolve to itself ------------------------------------

/*
 * The strongest check available: fold all 3,142 atlas entries through their own
 * names. It is what caught that stripping `city` was safe — Carson City NV,
 * James City and Charles City VA keep resolving uniquely — and it would catch
 * any future normaliser change that quietly merged two real counties.
 *
 * Exactly twelve entities are expected to come back ambiguous: six county /
 * independent-city pairs sharing a name.
 */
const roundTrip = ALL_COUNTIES.map((c) => ({ county: c, result: resolveFips(c.name, c.state) }));

for (const { county, result } of roundTrip) {
  if (result.ok) {
    assert(
      result.fips === county.fips,
      `${county.name}, ${county.state} resolved to ${result.fips} but is ${county.fips}`,
    );
  } else {
    assert(
      result.reason === "ambiguous",
      `${county.name}, ${county.state} failed to resolve from its own name (${result.reason})`,
    );
  }
}

const rt = summarise(roundTrip.map((r) => r.result));
assert(rt.notFound === 0, `every atlas county must resolve from its own name; ${rt.notFound} did not`);
assert(rt.municipal === 0, "an atlas county is never a municipal-state miss");
assert(
  rt.ambiguous === 12,
  `expected 12 ambiguous entities (6 county/city pairs: Baltimore MD, St. Louis MO, ` +
    `Fairfax/Franklin/Richmond/Roanoke VA), got ${rt.ambiguous}`,
);
assert(rt.resolved === ALL_COUNTIES.length - 12, "the rest must resolve uniquely");

console.log(
  `resolve-fips.test.ts — all assertions passed (${rt.resolved}/${ALL_COUNTIES.length} round-tripped, ${rt.ambiguous} ambiguous by design)`,
);
