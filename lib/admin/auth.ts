/**
 * Token gate for the operations console.
 *
 * One shared secret, not a user system. `/admin` shows which sources ran, what
 * they returned, and where every CAPE package is blocked — operational detail
 * that should not be public, but that also does not warrant accounts and
 * sessions for a single operator.
 *
 * The comparison itself lives in `./token`, which carries no `server-only`
 * guard and is therefore testable; this module owns only the request-bound
 * half. The token reaches us through a POST body and is exchanged for an
 * httpOnly cookie, so it never lands in browser history, a Referer header, or
 * an edge access log.
 */
import "server-only";
import { cookies } from "next/headers";
import { actorFor, tokenMatches } from "./token";

export { actorFor, adminConfigured, tokenMatches } from "./token";

export const ADMIN_COOKIE = "dp_admin";

/** Whether the current request carries a valid admin cookie. */
export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return tokenMatches(jar.get(ADMIN_COOKIE)?.value);
}

/**
 * Who is making this request, for the audit log.
 *
 * Derived from the cookie on every call rather than stored at sign-in, so a
 * revoked or rotated token stops attributing actions immediately instead of
 * until the cookie expires. Falls back to `admin` for an unnamed token, which
 * is what a single-secret deployment has always been.
 */
export async function currentActor(): Promise<string> {
  const jar = await cookies();
  return actorFor(jar.get(ADMIN_COOKIE)?.value) ?? "admin";
}

/**
 * Cookie settings for the gate.
 *
 * `httpOnly` so page scripts cannot read it, `sameSite: "lax"` so a
 * cross-site form post cannot carry it, `secure` outside development because
 * the token is the whole credential. Eight hours is a working day: long enough
 * not to re-enter it constantly, short enough that a forgotten open tab on a
 * shared machine expires on its own.
 */
export const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 8,
} as const;
