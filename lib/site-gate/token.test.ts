/**
 * The site gate.
 * Run: npx tsx lib/site-gate/token.test.ts
 *
 * Two assertions carry this file. The first is that the site gate and the
 * admin gate do not share a secret — the whole reason the site password exists
 * is to let someone read the site without also being able to withdraw parcels.
 * The second is `safeNext`: the unlock form carries a redirect target supplied
 * by whoever crafted the link, and a gate that will forward to any URL is an
 * open redirect wearing this domain's name.
 */
import { siteGateConfigured, sitePasswordMatches } from "./token";
import { safeNext } from "../safe-next";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

const SITE = "a-different-password-entirely";
const ADMIN = "correct-horse-battery-staple";

// --- armed --------------------------------------------------------------------

process.env.DEEDPILOT_SITE_PASSWORD = SITE;
process.env.DEEDPILOT_ADMIN_TOKEN = ADMIN;

assert(siteGateConfigured(), "a configured password arms the gate");
assert(sitePasswordMatches(SITE), "the configured password is accepted");
assert(sitePasswordMatches(` ${SITE} `), "surrounding whitespace is trimmed");
assert(!sitePasswordMatches("wrong"), "a wrong password is refused");
assert(!sitePasswordMatches(""), "an empty password is refused");
assert(!sitePasswordMatches(undefined), "a missing cookie is refused");
assert(!sitePasswordMatches(null), "a null cookie is refused");

/*
 * The separation the whole design rests on. If this ever passes, handing
 * someone the site password has handed them the operations console.
 */
assert(!sitePasswordMatches(ADMIN), "the admin token does NOT open the site gate");

// --- unarmed ------------------------------------------------------------------

delete process.env.DEEDPILOT_SITE_PASSWORD;

assert(!siteGateConfigured(), "no password means no gate");
/*
 * Unarmed, the proxy never consults this — it short-circuits on
 * `siteGateConfigured`. It still refuses every candidate, so that a caller who
 * skips that check cannot be waved through by an empty secret.
 */
assert(!sitePasswordMatches(""), "unarmed, an empty candidate is still refused");
assert(!sitePasswordMatches("anything"), "unarmed, no candidate is accepted");

process.env.DEEDPILOT_SITE_PASSWORD = "   ";
assert(!siteGateConfigured(), "whitespace alone does not arm the gate");

// --- redirect targets ---------------------------------------------------------

assert(safeNext("/calendar") === "/calendar", "a site-relative path is kept");
assert(safeNext("/lots/abc?x=1") === "/lots/abc?x=1", "a query string is kept");
assert(safeNext("//evil.example.com") === "/", "a protocol-relative URL is refused");
assert(safeNext("https://evil.example.com") === "/", "an absolute URL is refused");
assert(safeNext("/\\evil.example.com") === "/", "a backslash-smuggled host is refused");
assert(safeNext("javascript:alert(1)") === "/", "a javascript: URL is refused");
assert(safeNext(undefined) === "/", "a missing target falls back to the homepage");
assert(safeNext("") === "/", "an empty target falls back to the homepage");

console.log(`site-gate/token: ${passed} assertions passed`);
