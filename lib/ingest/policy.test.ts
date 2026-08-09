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
