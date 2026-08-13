/**
 * The token comparison, kept apart from anything request-bound.
 *
 * `lib/admin/auth.ts` reads cookies and therefore carries `server-only`, which
 * throws the moment it is imported outside a React server context — including
 * from a test. The half that decides whether a secret is correct has no such
 * dependency, so it lives here and can be exercised directly.
 *
 * Two properties this file exists to guarantee:
 *
 *  - **Fail closed.** An unset `DEEDPILOT_ADMIN_TOKEN` denies every candidate.
 *    The tempting default — no token configured means no gate — turns a
 *    missing environment variable in production into an open console.
 *  - **Constant time.** Compared over SHA-256 digests, so both buffers are 32
 *    bytes whatever was supplied. `timingSafeEqual` throws on a length
 *    mismatch, and that throw is itself an early exit that leaks the secret's
 *    length; digesting first removes the signal.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Whether a gate is configured at all. Reported to the operator, never bypassed. */
export function adminConfigured(): boolean {
  return (process.env.DEEDPILOT_ADMIN_TOKEN ?? "").trim().length > 0;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Configured tokens, optionally named.
 *
 * `DEEDPILOT_ADMIN_TOKEN` may hold one secret, or several as
 * `name:secret` pairs separated by commas:
 *
 *     DEEDPILOT_ADMIN_TOKEN="faye:s3cret,ops-bot:t0ken"
 *
 * A bare secret with no name is still valid and resolves to the actor `admin`,
 * so nothing that exists today has to change.
 *
 * The reason to bother: every row in `admin_audit` said `actor: "admin"`, which
 * is adequate for a read-mostly console and stops being adequate the moment it
 * can withdraw parcels, correct sale dates and override access policy. A log
 * that cannot say who is a log that answers the wrong question.
 */
function configuredTokens(): { actor: string; secret: string }[] {
  const raw = (process.env.DEEDPILOT_ADMIN_TOKEN ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(":");
      // A secret containing no colon is the whole token, unnamed.
      if (at <= 0) return { actor: "admin", secret: part };
      return { actor: part.slice(0, at).trim() || "admin", secret: part.slice(at + 1).trim() };
    })
    .filter((t) => t.secret.length > 0);
}

/**
 * Which person a candidate token belongs to, or null.
 *
 * Every configured token is compared even after a match, so the work done does
 * not depend on which one matched or on how many are configured.
 */
export function actorFor(candidate: string | undefined | null): string | null {
  const given = (candidate ?? "").trim();
  if (!given) return null;
  const givenDigest = digest(given);

  let actor: string | null = null;
  for (const t of configuredTokens()) {
    if (timingSafeEqual(givenDigest, digest(t.secret))) actor ??= t.actor;
  }
  return actor;
}

/** Constant-time equality against any configured token. */
export function tokenMatches(candidate: string | undefined | null): boolean {
  return actorFor(candidate) !== null;
}
