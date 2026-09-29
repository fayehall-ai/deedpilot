/**
 * GET /api/lots/:id/streetview
 *
 * The Street View photograph of a parcel's front, passed through so the Google
 * key never reaches the page. See lib/property/streetview.ts.
 *
 * Each request is a billed image call. The browser may keep it for a day; the
 * server keeps nothing, because Google's terms do not allow storing the images.
 */
import { getLot } from "@/lib/queries";
import { streetViewImageUrl, streetViewKey, streetViewLocation } from "@/lib/property/streetview";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = streetViewKey();
  const row = key ? await getLot(id) : null;
  const location = row
    ? streetViewLocation({ ...row.lot, state: row.county.state })
    : null;
  if (!key || !location) return new Response(null, { status: 404 });

  const res = await fetch(streetViewImageUrl(location, key), { signal: AbortSignal.timeout(10_000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return new Response(null, { status: 502 });

  return new Response(res.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=86400",
    },
  });
}
