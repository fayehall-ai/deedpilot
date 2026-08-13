/**
 * The operations gate.
 * Run: npx tsx lib/admin/token.test.ts
 *
 * This file exists for one assertion in particular: an unset
 * DEEDPILOT_ADMIN_TOKEN must deny everything. The natural-feeling default —
 * treat "no token configured" as "no gate required" — turns a missing
 * environment variable in production into a console that publishes every
 * source, every error string and every blocked package to anyone who guesses
 * the URL. The rest of these cases pin the comparison itself.
 */
import { actorFor, adminConfigured, tokenMatches } from "./token";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

const SECRET = "correct-horse-battery-staple";

// --- with a token configured --------------------------------------------------

process.env.DEEDPILOT_ADMIN_TOKEN = SECRET;

assert(adminConfigured(), "reports configured when a token is set");
assert(tokenMatches(SECRET), "accepts the configured token");

// A prefix and an extension both have to fail. Digesting before comparison is
// what makes this safe: timingSafeEqual throws on differing lengths, and the
// throw would itself be an early exit that reveals how long the secret is.
assert(!tokenMatches(SECRET.slice(0, -1)), "rejects a prefix of the token");
assert(!tokenMatches(SECRET + "x"), "rejects the token with a suffix");
assert(!tokenMatches("correct-horse-battery-stapl3"), "rejects a near-miss of equal length");
assert(!tokenMatches("wrong"), "rejects an unrelated value");

assert(!tokenMatches(""), "rejects the empty string");
assert(!tokenMatches(undefined), "rejects undefined");
assert(!tokenMatches(null), "rejects null");

// Pasting a secret out of a password manager routinely brings whitespace.
assert(tokenMatches(`  ${SECRET}\n`), "trims surrounding whitespace on the candidate");

// --- with no token configured -------------------------------------------------

process.env.DEEDPILOT_ADMIN_TOKEN = "";
assert(!adminConfigured(), "reports unconfigured when the variable is empty");
assert(!tokenMatches(SECRET), "FAILS CLOSED: denies the real token when none is configured");
assert(!tokenMatches(""), "FAILS CLOSED: empty candidate against empty config is not a match");

delete process.env.DEEDPILOT_ADMIN_TOKEN;
assert(!adminConfigured(), "reports unconfigured when the variable is absent");
assert(!tokenMatches("anything"), "FAILS CLOSED: denies when the variable is absent entirely");

// Whitespace-only is not a configured token — it would otherwise pass the
// truthiness check and gate on a value nobody could type.
process.env.DEEDPILOT_ADMIN_TOKEN = "   ";
assert(!adminConfigured(), "whitespace-only config is not configured");
assert(!tokenMatches("   "), "FAILS CLOSED: whitespace-only config matches nothing");

console.log(`token.test.ts — ${passed} assertions passed`);

// --- named tokens ------------------------------------------------------------

/*
 * Multiple people share one console. Until these existed every audit row said
 * `actor: "admin"`, which was fine while the console only read and stopped
 * being fine once it could withdraw parcels and correct sale dates.
 */
process.env.DEEDPILOT_ADMIN_TOKEN = "faye:alpha-secret,ops-bot:beta-secret";

assert(actorFor("alpha-secret") === "faye", "a named token resolves to its person");
assert(actorFor("beta-secret") === "ops-bot", "a second named token resolves separately");
assert(actorFor("wrong") === null, "an unknown secret has no actor");
assert(tokenMatches("beta-secret"), "tokenMatches still answers for named tokens");
assert(!tokenMatches("faye"), "the name is not the secret");

/* A bare secret keeps working, so nothing deployed today breaks. */
process.env.DEEDPILOT_ADMIN_TOKEN = "plain-secret";
assert(actorFor("plain-secret") === "admin", "an unnamed token is the anonymous admin");
assert(tokenMatches("plain-secret"), "unnamed tokens still match");

/* Fail closed stays failing closed. */
process.env.DEEDPILOT_ADMIN_TOKEN = "";
assert(actorFor("anything") === null, "no configured token means no actor");
assert(!tokenMatches("anything"), "no configured token denies everyone");

console.log("token.test.ts — named-token assertions passed");
