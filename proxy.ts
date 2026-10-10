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
import { isPublicHost } from "@/lib/site-gate/public-host";
import { CALENDAR_PARAMS } from "@/lib/calendar/grid";

export function proxy(request: NextRequest) {
  // Unarmed: no password configured, so the site behaves exactly as before.
  if (!siteGateConfigured()) return pass(request);

  // The public domain is open; its paid features carry daily limits instead.
  if (isPublicHost(request.headers.get("host"))) return pass(request);

  if (sitePasswordMatches(request.cookies.get(SITE_COOKIE)?.value)) {
    return pass(request);
  }

  const url = request.nextUrl.clone();
  const target = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = UNLOCK_PATH;
  url.search = "";
  if (target !== "/") url.searchParams.set("next", target);
  return NextResponse.redirect(url);
}

/**
 * Let the request through, sending a filtered home page to its dynamic copy.
 *
 * `/` is prerendered so the CDN can answer crawlers without a render. Its
 * calendar filters live in the query string, which a prerendered page cannot
 * read, so a home URL carrying one is rewritten to `/home-filtered`. The
 * reader's URL is unchanged. Only the calendar's own parameters count: a
 * `?utm_source=` or `?fbclid=` on a shared link still gets the cached page.
 */
function pass(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/" && CALENDAR_PARAMS.some((k) => searchParams.has(k))) {
    const url = request.nextUrl.clone();
    url.pathname = "/home-filtered";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
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
