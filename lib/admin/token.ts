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

/** Constant-time equality against the configured token. */
export function tokenMatches(candidate: string | undefined | null): boolean {
  const expected = (process.env.DEEDPILOT_ADMIN_TOKEN ?? "").trim();
  if (!expected) return false;
  const given = (candidate ?? "").trim();
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}
