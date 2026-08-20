/**
 * Source Prospector assertions. No network: candidate planning and the
 * deterministic scoring are the parts that must not drift.
 * Run: npx tsx lib/prospector/prospector.test.ts
 */
import { candidatesFor, countiesWithAtlasLinks } from "./discover";
import { buildRegistry, bestSource, prospectCounty, registryCoverage } from "./index";
import type { ProspectResult, VerifiedSource } from "./types";
import { inferKind, scoreContent } from "./verify";
import { countiesInState } from "../atlas";
import { COUNTY_DATA } from "../atlas/county-rules";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- candidate generation ----------------------------------------------------

const withLinks = countiesWithAtlasLinks();
assert(withLinks.length > 0, "some counties carry researched atlas links");

const sample = candidatesFor(withLinks[0]);
assert(sample.length > 0, "researched county yields candidates");
assert(
  sample.some((c) => c.origin === "atlas"),
  "atlas-sourced candidates come first-class",
);
assert(
  sample.every((c) => /^https?:\/\//.test(c.url)),
  "only http(s) candidates are emitted",
);

// Deduplication: the same URL appearing in two atlas fields yields one candidate.
for (const fips of withLinks.slice(0, 40)) {
  const urls = candidatesFor(fips).map((c) => c.url.replace(/\/+$/, "").toLowerCase());
  assert(new Set(urls).size === urls.length, `${fips}: duplicate candidate URLs`);
}

// Michigan sells through one statewide platform, so every county must reach
// tax-sale.info whether or not anyone has researched it.
//
// Which *origin* supplies it is the thing that moves: a researched county gets
// the URL from the atlas, an unresearched one from the state pattern. Pinning a
// named county to `platform_pattern` broke the moment 26049 was researched — a
// strict improvement in provenance failing as though it were a regression — so
// the unresearched example is chosen at runtime instead of hardcoded.
const miUnresearched = countiesInState("MI").find((c) => !(c.fips in COUNTY_DATA));
assert(miUnresearched, "MI should still have unresearched counties; if not, drop this assertion");
assert(
  candidatesFor(miUnresearched!.fips).some(
    (c) => c.origin === "platform_pattern" && c.url.includes("tax-sale.info"),
  ),
  `unresearched ${miUnresearched!.name} MI must fall back to the Title Check platform`,
);

const miResearched = countiesInState("MI").find((c) => c.fips in COUNTY_DATA);
assert(
  candidatesFor(miResearched!.fips).some((c) => c.url.includes("tax-sale.info")),
  `researched ${miResearched!.name} MI must still reach the platform, via the atlas`,
);

// Unknown FIPS is empty, not a throw.
assert(candidatesFor("99999").length === 0, "unknown FIPS yields no candidates");

// --- deterministic scoring ---------------------------------------------------

const listingPage = `
  <h1>Delinquent Tax Sale</h1>
  <p>The annual tax deed sale will be held. Minimum bid shown per parcel.</p>
  <table><tr><td>12-34-567-890</td><td>$1,200</td></tr>
  <tr><td>12-34-567-891</td><td>$3,400</td></tr>
  <tr><td>12-34-567-892</td><td>$900</td></tr>
  <tr><td>12-34-567-893</td><td>$2,100</td></tr></table>`;
const listing = scoreContent(listingPage);
assert(listing.score >= 4, `tax sale page must clear the bar, got ${listing.score}`);
assert(listing.hasListShape, "tabular parcel list detected");
assert(listing.signals.includes("tax deed sale"), "decisive vocabulary reported");

// A county homepage is a government host and still not a source.
const homepage = `<h1>Welcome to the County</h1><p>Pay your taxes, renew a licence,
  find a park. Office hours 9-5. Contact the assessor for parcel information.</p>`;
const home = scoreContent(homepage);
assert(home.score < 4, `county homepage must not qualify, got ${home.score}`);

// GIS pages are full of parcels and sell nothing.
const gis = scoreContent(`<h1>Parcel Viewer</h1><p>Search by parcel id or assessed value.</p>`);
assert(gis.score < 4, `GIS page must not qualify, got ${gis.score}`);

// Phrasing varies in the wild and a too-strict pattern silently drops real
// sources. New Castle County DE publishes "Sheriff Sales" — no apostrophe, no
// possessive — which an earlier `sheriff'?s\s+sale` pattern scored at 1 and
// rejected outright.
for (const phrasing of ["Sheriff Sales", "Sheriff's Sale", "Sheriffs Sale"]) {
  const s = scoreContent(`<h1>${phrasing}</h1><p>Foreclosure sale. Bidder registration required.</p>`);
  assert(s.score >= 4, `"${phrasing}" must be recognised, got ${s.score}`);
  assert(s.signals.includes("sheriff sale"), `"${phrasing}" must report the sheriff signal`);
}

// Delaware sells by monition — a term that appears nowhere else.
assert(scoreContent("<p>Monition sale of the property</p>").score >= 3, "monition sale");

/*
 * States that call it something else.
 *
 * The vocabulary was written in deed-and-lien language and silently failed
 * wherever the legislature chose different words. Kentucky exposed it: McCracken
 * County's own delinquent-tax page — "certificate of delinquency" three times,
 * "third party purchaser", "delinquent tax" fourteen times — scored 2 against a
 * threshold of 4 and was rejected as not being about tax sales. Every Kentucky
 * county failed identically, and KY is the fourth largest state in the imported
 * calendar. The text below is the shape of that real page.
 */
const kentucky = scoreContent(
  `<h1>Delinquent Tax Collection</h1><p>The County Clerk sells each certificate of
   delinquency. A third party purchaser may register to purchase certificates of
   delinquency. Delinquent tax bills are payable at the office.</p>`,
);
assert(kentucky.score >= 4, `Kentucky's statutory wording must qualify, got ${kentucky.score}`);
assert(
  kentucky.signals.includes("certificate of delinquency (KY)"),
  "and must report which term carried it",
);

for (const [label, html] of [
  ["Louisiana", "<p>Sale of adjudicated property by the parish.</p>"],
  ["Ohio", "<p>Forfeited land sale list for the county.</p>"],
  ["New Jersey", "<p>Tax sale certificates are sold at public auction.</p>"],
] as const) {
  assert(scoreContent(html).score >= 3, `${label}'s wording must register, got ${scoreContent(html).score}`);
}

/*
 * The control that makes the above a fix rather than a lowered bar. These terms
 * are terms of art: a county homepage does not say them in passing, so adding
 * them must not move a homepage's score at all.
 */
assert(
  scoreContent(homepage).score === home.score,
  "the new vocabulary must not raise a county homepage's score",
);

// Plurals must not change the verdict.
assert(scoreContent("<p>Annual tax sales are held yearly</p>").score >= 2, "plural tax sales");

// --- kind inference works without a model ------------------------------------

assert(inferKind("https://x.gov/results", "<p>Final report of sale, sold prices</p>") === "results", "results");
assert(inferKind("https://x.gov/dates", "<p>Sale calendar of upcoming auctions</p>") === "calendar", "calendar");
assert(inferKind("https://x.gov/terms", "<p>Bidder registration and terms</p>") === "rules", "rules");
assert(inferKind("https://x.gov/list", "<p>Notice of sale: parcel list, minimum bid</p>") === "listing", "listing");

// --- registry folding and ranking --------------------------------------------

const mk = (over: Partial<VerifiedSource>): VerifiedSource => ({
  fips: "26049",
  state: "MI",
  url: "https://example.com/a",
  host: "example.com",
  origin: "atlas",
  kind: "listing",
  isGovernment: false,
  confidence: 0.5,
  signals: [],
  verifiedOn: "2026-07-30",
  httpStatus: 200,
  ...over,
});

const results: ProspectResult[] = [
  {
    fips: "26049",
    state: "MI",
    county: "Genesee County",
    verified: [
      mk({ url: "https://vendor.com/x", host: "vendor.com", isGovernment: false, confidence: 0.9 }),
      mk({ url: "https://co.gov/x", host: "co.gov", isGovernment: true, confidence: 0.6 }),
    ],
    rejected: [],
    isGap: false,
    note: "",
  },
  { fips: "26163", state: "MI", county: "Wayne County", verified: [], rejected: [], isGap: true, note: "" },
];

const registry = buildRegistry(results);
assert(registry.nCounties === 2 && registry.nVerified === 2, "registry counts");
assert(registry.nGaps === 1, "gaps counted");

const best = bestSource(registry, "26049", "listing");
assert(best?.isGovernment === true, "government source outranks a higher-confidence vendor");
assert(bestSource(registry, "26163", "listing") === null, "gap county has no source");

const cov = registryCoverage(registry);
assert(cov.govShare === 0.5, `gov share, got ${cov.govShare}`);
assert(cov.byKind.listing === 2, "kind histogram");

// --- dry run touches no network ----------------------------------------------

async function asyncChecks() {
  const dry = await prospectCounty(withLinks[0], { dryRun: true });
  assert(dry.verified.length === 0 && dry.rejected.length === 0, "dry run verifies nothing");
  assert(dry.note.startsWith("Dry run"), "dry run says so");
  assert(dry.county.length > 0, "dry run still resolves the county");

  const dryUnknown = await prospectCounty("99999", { dryRun: true });
  assert(dryUnknown.isGap, "unknown FIPS is reported as a gap");
}

asyncChecks().then(() => {
  console.log("prospector tests ok", {
    countiesWithAtlasLinks: withLinks.length,
    sampleCandidates: sample.length,
    listingScore: listing.score,
    homepageScore: home.score,
    govShare: cov.govShare,
  });
});

// --- candidate generation (the fix for 2,647 zero-candidate counties) --------
{
  const { countyDomainPatterns, countySlugForHost, statewideCandidatesFor, statewideCoverage } =
    require("./candidates") as typeof import("./candidates");
  const { getCounty, ALL_COUNTIES } = require("../atlas") as typeof import("../atlas");
  const { newBudget, verifyCandidate } = require("./verify") as typeof import("./verify");

  // Slugs drop the governance suffix; Louisiana has parishes, Alaska boroughs.
  assert(countySlugForHost("St. Louis County") === "stlouis", "county suffix and punctuation dropped");
  assert(countySlugForHost("Orleans Parish") === "orleans", "parish dropped");
  assert(countySlugForHost("Juneau City and Borough") === "juneau", "borough dropped");

  const boulder = getCounty("08013")!;
  const pats = countyDomainPatterns(boulder);
  assert(pats.some((p) => p.includes("bouldercounty.gov")), "generates the real Boulder domain");
  assert(pats.some((p) => p.includes("co.boulder.co.us")), "generates the classic co.X.st.us form");
  assert(new Set(pats).size === pats.length, "patterns are deduplicated");

  // Every county must now have at least one candidate — that was the blocker.
  let zero = 0;
  for (const c of ALL_COUNTIES) if (!candidatesFor(c.fips, { includePatterns: true }).length) zero++;
  assert(zero === 0, `${zero} counties still have no candidate at all`);

  // Statewide publishers, and the scoping that stops NYC being offered to Buffalo.
  const arkansas = statewideCandidatesFor(getCounty("05001")!);
  assert(arkansas.some((c) => c.url.includes("cosl.org")), "Arkansas gets the statewide publisher");

  const bronx = statewideCandidatesFor(getCounty("36005")!);
  const erie = statewideCandidatesFor(getCounty("36029")!);
  assert(bronx.some((c) => c.url.includes("nyc.gov")), "a borough gets the NYC lien sale");
  assert(!erie.some((c) => c.url.includes("nyc.gov")), "Buffalo must not be sent to the NYC sale");

  assert(
    statewideCoverage().some((s) => s.state === "WV" && s.results),
    "West Virginia's statewide source is flagged as publishing results",
  );

  // The fetch budget is shared, not per-branch: depth multiplies, budget bounds.
  const budget = newBudget(1);
  assert(budget.remaining === 1, "budget starts full");
  verifyCandidate(
    { fips: "00000", state: "XX", url: "https://example.invalid/", origin: "atlas", label: "t" },
    { budget },
  ).then((r) => {
    assert("reason" in r, "an invalid host is rejected");
    assert(budget.remaining === 0, "the attempt was charged to the shared budget");
  });
}
