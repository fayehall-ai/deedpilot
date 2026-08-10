/**
 * Directory parsing + classification assertions.
 * Run: npx tsx lib/directory/onlinesearches.test.ts
 *
 * No network. The fixture is trimmed from the real Washington County AR page
 * fetched 2026-08-10 — the labels and hosts are verbatim, because the whole
 * risk in this module is mis-filing a real label, not parsing invented HTML.
 */
import { classifyLabel, countyPageUrl, parseCountyPage, pickLink } from "./onlinesearches";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- URL shape ---------------------------------------------------------------

assert(
  countyPageUrl("AR", "Washington County") ===
    "https://www.publicrecords.onlinesearches.com/AR_Washington.htm",
  "county noun is dropped",
);
assert(
  countyPageUrl("LA", "Jefferson Parish").endsWith("/LA_Jefferson.htm"),
  "parish is a noun too",
);
// Spaces are removed, not replaced. Reading this as "underscore" 404'd every
// two-word county — 76 of 755 across eight states, all of them a Van Buren or
// a Ste. Genevieve, while single-word names sailed through and made the crawl
// look clean.
assert(
  countyPageUrl("AR", "St. Francis County").endsWith("/AR_St.Francis.htm"),
  `spaces are removed, got ${countyPageUrl("AR", "St. Francis County")}`,
);
assert(
  countyPageUrl("AR", "Hot Spring County").endsWith("/AR_HotSpring.htm"),
  `two words join, got ${countyPageUrl("AR", "Hot Spring County")}`,
);
assert(
  countyPageUrl("LA", "East Baton Rouge Parish").endsWith("/LA_EastBatonRouge.htm"),
  `three words join, got ${countyPageUrl("LA", "East Baton Rouge Parish")}`,
);
assert(
  countyPageUrl("NM", "Doña Ana County").endsWith("/NM_DonaAna.htm"),
  `diacritics fold, got ${countyPageUrl("NM", "Doña Ana County")}`,
);
// The alphabetical /XX-A.htm indexes are the ones robots.txt disallows. Nothing
// here may ever produce one.
assert(
  !/-[A-Z]\.htm$/.test(countyPageUrl("AR", "Arkansas County")),
  "never builds a disallowed alphabetical index URL",
);

// --- classification ----------------------------------------------------------

// The ordering case that matters. This label contains both "recorder" and
// "foreclosures" and is an office, not a list of sales — filing it as
// foreclosure would point the prospector at every Arkansas circuit clerk.
assert(
  classifyLabel("Recorder, Circuit Clerk and Judicial Foreclosures") === "recorder",
  "office beats the word foreclosure in its title",
);
assert(classifyLabel("Property Foreclosures") === "foreclosure", "a sale list is a sale list");
assert(classifyLabel("Delinquent Taxes") === "delinquent", "delinquent roll");
assert(classifyLabel("Assessor") === "assessor", "assessor");
assert(classifyLabel("Property Appraiser") === "assessor", "Florida's name for it");
assert(classifyLabel("Appraisal District") === "assessor", "Texas's name for it");
assert(classifyLabel("Inmate Records") === "other", "not our concern");
assert(classifyLabel("Most Wanted Persons") === "other", "nor this");

// --- parsing -----------------------------------------------------------------

const FIXTURE = `
<a href="https://www.co.washington.ar.us/government/departments-a-e/assessor">Assessor</a>
<a href="https://www.co.washington.ar.us/government/departments-a-e/circuit-clerk">Recorder, Circuit Clerk and Judicial Foreclosures</a>
<a href="https://www.co.washington.ar.us/government/departments-a-e/circuit-clerk/property-foreclosures">Property Foreclosures</a>
<a href="https://www.co.washington.ar.us/government/departments-a-e/collector">Delinquent Taxes</a>
<a href="https://propertytax.ark.org/washington/index.php">Property Tax Search and Pay Property Taxes</a>
<a href="https://washcogis.co.washington.ar.us/flex/public/index.html">Precinct Map</a>
<a href="https://www.co.washington.ar.us/government/departments-f-z/sheriff">Sheriff and Detention Center</a>
<a href="https://www.intelius.com/">Assessor Records Search</a>
<a href="https://www.census.gov/quickfacts/fact/table/x">Census Information Summary</a>
<a href="/AR_Benton.htm">Benton County</a>
`;

const parsed = parseCountyPage({
  html: FIXTURE,
  fips: "05143",
  state: "AR",
  county: "Washington",
  sourceUrl: "https://www.publicrecords.onlinesearches.com/AR_Washington.htm",
});

assert(pickLink(parsed, "assessor")?.url.endsWith("/assessor") === true, "assessor captured");
assert(
  pickLink(parsed, "foreclosure")?.url.endsWith("/property-foreclosures") === true,
  "the sale-list page is captured — this is the one the prospector wants",
);
assert(pickLink(parsed, "delinquent")?.label === "Delinquent Taxes", "delinquent captured");
assert(pickLink(parsed, "recorder") !== null, "recorder captured");
assert(pickLink(parsed, "tax_portal")?.url.includes("ark.org") === true, "state portal kept");

// A county office on a .com is still a county office. Arkansas County AR runs
// its circuit clerk on arcocircuitclerk.com; a .gov keep-list dropped it and
// reported the county as having no offices at all.
const dotcom = parseCountyPage({
  html: `<a href="https://www.arcocircuitclerk.com/">Recorder, Circuit Clerk and Judicial Foreclosures</a>`,
  fips: "05001", state: "AR", county: "Arkansas", sourceUrl: "s",
});
assert(pickLink(dotcom, "recorder")?.url.includes("arcocircuitclerk") === true,
  "a .com county office survives");
assert(dotcom.links[0].gov === false, "and is flagged as not a government host");

// Where a county offers both, the government one is the source of record.
const both = parseCountyPage({
  html: `<a href="https://vendor.com/a">Assessor</a><a href="https://www.co.x.ar.us/assessor">Assessor</a>`,
  fips: "05001", state: "AR", county: "X", sourceUrl: "s",
});
assert(pickLink(both, "assessor")?.url.includes(".ar.us") === true,
  `gov host preferred, got ${pickLink(both, "assessor")?.url}`);

// The affiliate is the one with the persuasive label. Host decides, not text.
assert(
  !parsed.links.some((l) => /intelius/.test(l.url)),
  "an affiliate link labelled 'Assessor Records Search' is still an affiliate",
);
assert(!parsed.links.some((l) => /census\.gov/.test(l.url)), "census quickfacts is not an office");
assert(!parsed.links.some((l) => /sheriff/.test(l.url)), "'other' kinds are dropped, not stored");
assert(
  !parsed.links.some((l) => l.url.startsWith("/")),
  "relative links to sibling counties are not offices",
);

// Deduping keeps the first, most specific label.
const dupes = parseCountyPage({
  html: `<a href="https://x.co.ar.us/a">Assessor</a><a href="https://x.co.ar.us/a">Assessor Office</a>`,
  fips: "05143",
  state: "AR",
  county: "Washington",
  sourceUrl: "s",
});
assert(dupes.links.length === 1, `deduped by url, got ${dupes.links.length}`);
assert(dupes.links[0].label === "Assessor", "first label wins");

assert(
  parseCountyPage({ html: "", fips: "1", state: "AR", county: "X", sourceUrl: "s" }).links
    .length === 0,
  "empty page → no links, not a throw",
);

console.log("directory: all assertions passed");
