/**
 * GET /api/streetview?location=<address>
 *
 * The Street View photograph for an address typed into the home-page lookup,
 * passed through so the Google key never reaches the page. The parcel page has
 * its own route keyed by lot, /api/lots/[id]/streetview. Behind the site gate
 * like every other route; each request is a billed image call, which the
 * browser may keep for a day.
 */
import { spendDailyAllowance } from "@/lib/site-gate/daily-limit";
import { streetViewImageUrl, streetViewKey } from "@/lib/property/streetview";

export async function GET(req: Request) {
  const location = new URL(req.url).searchParams.get("location")?.trim() ?? "";
  const key = streetViewKey();
  // An address, not an arbitrary string: a house number and something after it.
  if (!key || location.length > 200 || !/^\d+[A-Z]?\s+\S/i.test(location)) {
    return new Response(null, { status: 404 });
  }

  /* Each image is billed; on the public domain it counts against the daily limit. */
  const allowed = await spendDailyAllowance("streetview", req.headers);
  if (!allowed.ok) return new Response(allowed.message, { status: 429 });

  const res = await fetch(streetViewImageUrl(location, key), { signal: AbortSignal.timeout(10_000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return new Response(null, { status: 502 });

  return new Response(res.body, {
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" },
  });
}
