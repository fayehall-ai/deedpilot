/**
 * The site gate's secret, kept apart from anything request-bound.
 *
 * Mirrors `lib/admin/token.ts` on purpose — same digest-first, constant-time
 * comparison — so the two gates cannot drift into having different security
 * properties. Two things differ, and both are deliberate.
 *
 * ## A different secret
 *
 * `DEEDPILOT_SITE_PASSWORD`, never `DEEDPILOT_ADMIN_TOKEN`. Handing someone
 * the site password must not also hand them the operations console, which can
 * withdraw parcels, correct sale dates and override access policy. The site
 * gate says "you may read this"; the admin gate says "you may change it".
 * They are stacked, not alternatives: reaching `/admin` means clearing both.
 *
 * ## It fails open, where the admin gate fails closed
 *
 * An unset admin token denies everyone, because the console publishes
 * operational detail and a missing variable would silently publish it. An
 * unset site password does the opposite: no gate. The asymmetry is not an
 * oversight.
 *
 * Failing closed here would make the entire site unreachable — including to
 * the only person who could fix it — so a forgotten environment variable
 * becomes a total outage with no way back in through the front door. The
 * failure mode of failing open is milder and louder: the site is exactly as
 * public as it was yesterday.
 *
 * The cost is real, though: a gate nobody armed protects nothing and does not
 * announce itself. Arming it is a deploy step, not a code change — set the
 * variable, then confirm an unauthenticated request gets redirected.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Where an unauthenticated request is sent. Shared by the proxy and the page. */
export const UNLOCK_PATH = "/unlock";

export const SITE_COOKIE = "dp_site";

/**
 * Thirty days, where the admin cookie is eight hours.
 *
 * The two gates guard different things. The admin cookie guards write access
 * on a possibly shared machine, and a working day is the right ceiling. This
 * one guards *reading the site*; re-typing a password every eight hours to
 * look at a page is the kind of friction that ends with the gate switched off.
 */
export const SITE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
} as const;

/** Whether the gate is armed at all. See the module note on failing open. */
export function siteGateConfigured(): boolean {
  return (process.env.DEEDPILOT_SITE_PASSWORD ?? "").trim().length > 0;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Constant-time equality against the configured site password.
 *
 * Digested first for the reason `lib/admin/token.ts` gives: `timingSafeEqual`
 * throws on a length mismatch, and that throw is itself an early exit that
 * leaks the secret's length. Over SHA-256 both buffers are 32 bytes whatever
 * was supplied.
 */
export function sitePasswordMatches(candidate: string | undefined | null): boolean {
  const given = (candidate ?? "").trim();
  if (!given) return false;
  const configured = (process.env.DEEDPILOT_SITE_PASSWORD ?? "").trim();
  if (!configured) return false;
  return timingSafeEqual(digest(given), digest(configured));
}

/**
 * A redirect target that cannot leave the site.
 *
 * The unlock form carries where the reader was heading so the gate does not
 * dump everyone on the homepage. That parameter is attacker-controlled, so it
 * is validated rather than trusted: a value starting `//` or `https://` would
 * otherwise turn the gate into an open redirect that borrows this domain's
 * credibility to send people elsewhere.
 */
export function safeNext(next: string | undefined | null): string {
  const v = (next ?? "").trim();
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "/";
  return v;
}
