/**
 * County label resolution.
 * Run: npx tsx lib/import/counties.test.ts
 *
 * The cases that matter here are the six `(state, name)` collisions, because
 * those are the ones that resolve to *something* whatever you do. An import
 * that files St. Louis City's sale under St. Louis County produces a valid row,
 * on a real calendar, under a real FIPS, with nothing downstream able to notice
 * — so the assertions below pin both halves of every pair in both directions.
 */
import { CountyIndex, normalizeCountyName, describeFailure } from "./counties";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

/* A stand-in for the reference table: the collisions, plus the names whose
 * designator is genuinely part of the name, plus the awkward spellings. */
const index = new CountyIndex([
  { fips: "28049", name: "Hinds", state: "MS", stateName: "Mississippi" },
  { fips: "29189", name: "St. Louis", state: "MO", stateName: "Missouri" },
  { fips: "29510", name: "St. Louis", state: "MO", stateName: "Missouri" },
  { fips: "24005", name: "Baltimore", state: "MD", stateName: "Maryland" },
  { fips: "24510", name: "Baltimore", state: "MD", stateName: "Maryland" },
  { fips: "51159", name: "Richmond", state: "VA", stateName: "Virginia" },
  { fips: "51760", name: "Richmond", state: "VA", stateName: "Virginia" },
  { fips: "51036", name: "Charles City", state: "VA", stateName: "Virginia" },
  { fips: "51095", name: "James City", state: "VA", stateName: "Virginia" },
  { fips: "22001", name: "Acadia", state: "LA", stateName: "Louisiana" },
  { fips: "02110", name: "Juneau", state: "AK", stateName: "Alaska" },
  { fips: "02020", name: "Anchorage", state: "AK", stateName: "Alaska" },
  { fips: "02261", name: "Valdez-Cordova", state: "AK", stateName: "Alaska" },
  { fips: "22059", name: "LaSalle", state: "LA", stateName: "Louisiana" },
  { fips: "48507", name: "Zavala", state: "TX", stateName: "Texas" },
  { fips: "13175", name: "Laurens", state: "GA", stateName: "Georgia" },
  { fips: "13059", name: "Clarke", state: "GA", stateName: "Georgia" },
  { fips: "34005", name: "Burlington", state: "NJ", stateName: "New Jersey" },
  { fips: "42101", name: "Philadelphia", state: "PA", stateName: "Pennsylvania" },
  { fips: "29186", name: "Ste. Genevieve", state: "MO", stateName: "Missouri" },
  { fips: "51740", name: "Portsmouth", state: "VA", stateName: "Virginia" },
  { fips: "09003", name: "Hartford", state: "CT", stateName: "Connecticut" },
]);

const fips = (state: string, county: string): string | null => {
  const m = index.resolve(state, county);
  return m.ok ? m.fips : null;
};

// ---------------------------------------------------------------------------
// The ordinary case
// ---------------------------------------------------------------------------

assert(fips("Mississippi", "Hinds County") === "28049", "a plain county resolves");
assert(fips("MS", "Hinds County") === "28049", "the abbreviation works as a state label");
assert(fips("Mississippi", "Hinds") === "28049", "a missing designator still resolves");
assert(fips("Louisiana", "Acadia Parish") === "22001", "Parish is a designator");

// ---------------------------------------------------------------------------
// The collisions — both halves, both directions
// ---------------------------------------------------------------------------

assert(fips("Missouri", "St. Louis County") === "29189", "St. Louis County is the county");
assert(fips("Missouri", "St. Louis City") === "29510", "St. Louis City is the city");
assert(fips("Missouri", "Saint Louis City") === "29510", "Saint spells the same as St.");
assert(fips("Maryland", "Baltimore County") === "24005", "Baltimore County is the county");
assert(fips("Maryland", "Baltimore City") === "24510", "Baltimore City is the city");
assert(fips("Virginia", "Richmond County") === "51159", "Richmond County is the county");
assert(fips("Virginia", "Richmond City") === "51760", "Richmond City is the city");

/*
 * A bare "Richmond" cannot be resolved and must not be guessed. This is the
 * assertion that stops a future "just pick the county, it's more likely" patch:
 * more likely is not the same as correct, and the wrong pick is undetectable.
 */
const bare = index.resolve("Virginia", "Richmond");
assert(!bare.ok, "a bare colliding name does not resolve");
assert(!bare.ok && bare.reason.kind === "ambiguous", "and it reports why");
assert(
  !bare.ok && describeFailure(bare.reason).includes("51159"),
  "the report names both candidates so the operator can fix the label",
);

// ---------------------------------------------------------------------------
// Names that contain a designator
// ---------------------------------------------------------------------------

assert(
  fips("Virginia", "Charles City County") === "51036",
  "only one designator is stripped, so Charles City keeps its City",
);
assert(fips("Virginia", "James City County") === "51095", "same for James City");
assert(
  fips("Virginia", "Charles City") === "51036",
  "and the county resolves even when written without County",
);

// ---------------------------------------------------------------------------
// Alaska's designators, and spelling drift
// ---------------------------------------------------------------------------

assert(fips("Alaska", "Juneau City and Borough") === "02110", "city and borough is one designator");
assert(fips("Alaska", "Anchorage Municipality") === "02020", "Municipality is a designator");
assert(
  fips("Alaska", "Valdez Cordova Census Area") === "02261",
  "a hyphen in the table matches a space in the label",
);
assert(fips("Louisiana", "La Salle Parish") === "22059", "LaSalle matches La Salle");

// ---------------------------------------------------------------------------
// Failures are reported, not guessed
// ---------------------------------------------------------------------------

const nowhere = index.resolve("Mississippi", "Nonesuch County");
assert(!nowhere.ok && nowhere.reason.kind === "no_match", "an unknown county does not resolve");
const badState = index.resolve("Freedonia", "Hinds County");
assert(!badState.ok && badState.reason.kind === "unknown_state", "an unknown state does not resolve");

/*
 * Zavala's FIPS tail is 507, which trips the >= 500 independent-city rule. It
 * must still resolve, because that rule is only ever consulted to break a tie
 * and Zavala has no twin. Pins that the tie-break stays scoped to collisions.
 */
assert(fips("Texas", "Zavala County") === "48507", "a >=500 tail that is not a city still resolves");

// ---------------------------------------------------------------------------
// Municipal sales — the label names a town, with its county in brackets
//
// Whole states depend on these. New Jersey, Connecticut, Rhode Island and
// Vermont hold tax sales municipally and essentially never at county level, so
// a reader that gives up on a bracketed label drops those states entirely.
// ---------------------------------------------------------------------------

const muni = index.resolve("Georgia", "Dublin City (Laurens)");
assert(muni.ok && muni.fips === "13175", "a municipal sale files under its bracketed county");
assert(muni.ok && muni.via === "parent", "and reports that it did so");
assert(
  muni.ok && muni.municipality === "Dublin City",
  "carrying the municipality back, so a town sale is not mistaken for the county's own",
);

const township = index.resolve("New Jersey", "Lumberton Township (Burlington)");
assert(township.ok && township.fips === "34005", "Township is read the same way");

/*
 * Virginia's brackets usually repeat an independent city, which is itself a
 * county-equivalent with its own FIPS. The part outside the brackets is tried
 * first so the sale files under the city rather than under a county that is
 * not holding it.
 */
const indep = index.resolve("Virginia", "Portsmouth City (Portsmouth)");
assert(indep.ok && indep.fips === "51740", "an independent city resolves to itself");
assert(indep.ok && indep.via === "name", "and is not treated as a municipality of something else");

// ---------------------------------------------------------------------------
// Consolidated city-counties
// ---------------------------------------------------------------------------

assert(
  fips("Pennsylvania", "Philadelphia City-County") === "42101",
  "a hyphenated city-county sheds both halves of the designator",
);
assert(
  fips("Alaska", "Anchorage City-Borough") === "02020",
  "and so does a city-borough",
);
assert(
  fips("Georgia", "Athens-Clarke County") === "13059",
  "a consolidated name falls back to the county half",
);

/*
 * The regression this pair exists to prevent. Folding removes hyphens, so a
 * designator that strips "city county" cannot tell these apart, and Charles
 * City silently stops importing.
 */
assert(
  fips("Virginia", "Charles City County") === "51036",
  "Charles City County still keeps its City",
);

// ---------------------------------------------------------------------------
// Sainte
// ---------------------------------------------------------------------------

assert(
  fips("Missouri", "Sainte Genevieve County") === "29186",
  "Sainte folds to Ste. the way Saint folds to St.",
);

// ---------------------------------------------------------------------------
// Connecticut has no answer, and must say so
//
// The export brackets Connecticut's post-2022 planning regions ("Capitol"),
// while the reference table holds the historic counties. Mapping a region onto
// a county would be approximately true and precisely wrong, so it does not.
// ---------------------------------------------------------------------------

const ct = index.resolve("Connecticut", "Willington Town (Capitol)");
assert(!ct.ok, "a planning region is not silently mapped onto a county");

// ---------------------------------------------------------------------------
// Normalisation itself
// ---------------------------------------------------------------------------

assert(normalizeCountyName("Hinds County").base === "hinds", "designator stripped");
assert(normalizeCountyName("St. Louis City").designator === "city", "the city signal is preserved");
assert(normalizeCountyName("St. Louis County").designator === "county", "County reads as county");
assert(
  normalizeCountyName("Charles City County").designator === "county",
  "a name ending in City is not a city label",
);
assert(normalizeCountyName("Richmond").designator === null, "a bare name claims nothing");
assert(
  normalizeCountyName("Juneau City and Borough").designator === "county",
  "city and borough is a borough, not an independent city",
);

console.log(`counties.test.ts — ${passed} assertions passed`);
