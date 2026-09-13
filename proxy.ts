/**
 * The site gate.
 *
 * Next 16 renamed this file convention from `middleware` to `proxy`; the
 * behaviour is unchanged and the runtime is Node.js, which is why a module
 * importing `node:crypto` can be used from here.
 *
 * ## Why a proxy rather than a check in the root layout
 *
 * A layout check runs *after* the route has been matched and its data
 * fetched — which on this site means the homepage has already queried Neon
 * for the auction list before anything decides the reader is not allowed to
 * see it. The whole point of this gate is to refuse before that work happens.
 *
 * ## What this does and does not buy
 *
 * A blocked request still costs one function invocation: the proxy is our
 * compute, not Vercel's edge, so it is not the same thing as Deployment
 * Protection. What it does remove is everything expensive behind it — no page
 * render, no database round trip, no large HTML on the way out. Against a
 * scraper walking every lot page, that is the difference between a redirect
 * and a full parcel payload per request.
 *
 * If the site never needs to be publicly reachable, Vercel Authentication is
 * still the stronger answer, because it rejects at the edge and costs nothing.
 * This exists for the case where some of the site must stay reachable by
 * people who do not have a Vercel account.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SITE_COOKIE, UNLOCK_PATH, siteGateConfigured, sitePasswordMatches } from "@/lib/site-gate/token";

export function proxy(request: NextRequest) {
  // Unarmed: no password configured, so the site behaves exactly as before.
  if (!siteGateConfigured()) return NextResponse.next();

  if (sitePasswordMatches(request.cookies.get(SITE_COOKIE)?.value)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  const target = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = UNLOCK_PATH;
  url.search = "";
  if (target !== "/") url.searchParams.set("next", target);
  return NextResponse.redirect(url);
}

/**
 * What the gate does not cover, and why each exception is safe.
 *
 *  - `unlock` — the gate itself, and the Server Function that clears it. A
 *    matcher excluding a path also excludes Server Function POSTs to it, so
 *    `app/unlock/actions.ts` re-checks the password itself rather than
 *    trusting that it was reached legitimately.
 *  - `api/cron` — Vercel's scheduler cannot present a cookie. Those routes
 *    already authenticate every request against `CRON_SECRET` or an admin
 *    token, so gating them here would break the nightly ingest to no benefit.
 *  - static assets — redirecting CSS, JS, fonts or images produces an unlock
 *    page that cannot style itself.
 *
 * Everything else — every page, every other route handler, and the Server
 * Functions that POST to them — is gated.
 */
export const config = {
  matcher: [
    "/((?!unlock|api/cron|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|woff2?)$).*)",
  ],
};
