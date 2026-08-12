/**
 * Access policy invariants.
 * Run: npx tsx lib/ingest/policy.test.ts
 *
 * This file exists because the policy list is the one place where a mistake is
 * not a bug but a decision to crawl a host the project decided not to. It had
 * two entries per host for govease.com and bid4assets.com, recording opposite
 * conclusions; `policyFor` returns the first match, so the second never
 * applied and the contradiction sat there unflagged.
 */
import { SOURCE_POLICIES, isGovernmentSource, policyFor } from "./policy";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- one decision per host ---------------------------------------------------

const hosts = SOURCE_POLICIES.map((p) => p.host);
const dupes = hosts.filter((h, i) => hosts.indexOf(h) !== i);
assert(
  dupes.length === 0,
  `a host may carry exactly one decision; duplicated: ${[...new Set(dupes)].join(", ")}`,
);

// Resolution must not depend on array order for any listed host.
for (const p of SOURCE_POLICIES) {
  assert(policyFor(p.host)?.decision === p.decision, `${p.host} resolves to its own decision`);
}

// --- every entry is actionable ----------------------------------------------

for (const p of SOURCE_POLICIES) {
  assert(
    ["allow", "deny", "requires_agreement"].includes(p.decision),
    `${p.host}: unknown decision ${p.decision}`,
  );
  // A blocked host without a stated reason is indistinguishable from an
  // oversight, and the reason is what the coverage page shows a subscriber.
  assert(p.reason.trim().length > 20, `${p.host}: needs a real reason`);
  assert(p.minDelayMs >= 1000, `${p.host}: delay ${p.minDelayMs}ms is not polite`);
}

// --- the RealAuction decision is load-bearing --------------------------------

// These host most of Florida's tax deed sales and publish `Disallow: /`.
// Flipping either to `allow` should be a deliberate act, not a merge artifact.
for (const host of ["realtaxdeed.com", "realforeclose.com"]) {
  assert(
    policyFor(host)?.decision === "requires_agreement",
    `${host} must stay behind an agreement`,
  );
}
assert(policyFor("www.realtaxdeed.com")?.decision === "requires_agreement", "subdomains inherit");
assert(
  policyFor("liveauctions.govease.com")?.decision === "requires_agreement",
  "the GovEase subdomain that serves Disallow: / is covered",
);

// --- hosts whose crawl posture cannot be read --------------------------------

// DataScout serves an Azure WAF JS challenge and Propwire a DataDome captcha;
// both return 403 on /robots.txt itself. A host that will not tell you its
// posture without defeating a bot control has to be treated as closed, the same
// way bid4assets is — flipping either to `allow` must be deliberate.
for (const host of ["datascoutpro.com", "propwire.com", "bid4assets.com"]) {
  assert(
    policyFor(host)?.decision === "requires_agreement",
    `${host} serves no readable robots.txt and must stay behind an agreement`,
  );
}
assert(
  policyFor("www.datascoutpro.com")?.decision === "requires_agreement",
  "the www subdomain the marketing site uses is covered too",
);

// --- record directories ------------------------------------------------------

// Both are allowed, and both are directories of links to county assessor and
// recorder sites — not publishers of sale lists. The delay is the assertion
// worth pinning: NETR declares `Crawl-delay: 10`, and honouring a stated delay
// is the whole difference between polite and not.
assert(
  policyFor("publicrecords.netronline.com")?.minDelayMs === 10_000,
  "NETR's declared Crawl-delay: 10 is honoured",
);
assert(
  (policyFor("publicrecords.onlinesearches.com")?.minDelayMs ?? 0) >= 5000,
  "a commercial aggregator with no declared delay still waits",
);
for (const host of ["publicrecords.netronline.com", "publicrecords.onlinesearches.com"]) {
  assert(!isGovernmentSource(host), `${host} is an aggregator, not a government source`);
}

// --- government sources ------------------------------------------------------

assert(isGovernmentSource("tax.newmexico.gov"), "state agency host is government");
assert(isGovernmentSource("www.co.hinds.ms.us"), ".us county host is government");
assert(!isGovernmentSource("taxsales.lgbs.com"), "a law firm is not a government source");
assert(!isGovernmentSource("govease.com"), "a platform is not a government source");
// Not a .gov: the string merely contains it.
assert(!isGovernmentSource("notreally-gov.com"), "suffix match, not substring");

// An unlisted host has no explicit policy and falls through to live robots.txt.
assert(policyFor("some-random-county.org") === null, "unlisted hosts defer to robots.txt");

console.log("policy: all assertions passed");

// --- operator overrides ------------------------------------------------------

// The console can change a decision without a deploy. Two properties matter:
// an override wins for its host, and a process that never loads them sees only
// the reviewed decisions in this file.
import { setPolicyOverrides, policyOverrideCount } from "./policy";

assert(policyOverrideCount() === 0, "no overrides are loaded by default");
assert(
  policyFor("ustla.com")?.decision === "requires_agreement",
  "baseline decision applies before any override is loaded",
);

setPolicyOverrides([
  { host: "example.gov", decision: "deny", minDelayMs: 9000, reason: "operator test" },
]);
assert(policyFor("example.gov")?.decision === "deny", "an override applies to its host");
assert(policyFor("data.example.gov")?.decision === "deny", "an override covers subdomains");
assert(
  policyFor("ustla.com")?.decision === "requires_agreement",
  "an unrelated override does not disturb the compiled-in decisions",
);

setPolicyOverrides([
  { host: "ustla.com", decision: "allow", minDelayMs: 5000, reason: "operator test" },
]);
assert(
  policyFor("ustla.com")?.decision === "allow",
  "an override takes precedence over the compiled-in decision for the same host",
);

setPolicyOverrides([]);
assert(
  policyFor("ustla.com")?.decision === "requires_agreement",
  "clearing overrides restores the reviewed decision",
);
