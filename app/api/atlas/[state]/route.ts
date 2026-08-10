/**
 * One state's county map, for the interactive atlas.
 *
 * The explorer starts with 51 national paths and fetches a state only when
 * someone opens it. That split is the whole reason the initial page stays
 * small: the county topology is 800KB and the researched county rules are
 * 2.7MB across the country, but a single state is a few tens of kilobytes —
 * Texas, the heaviest, is 191KB of rules.
 *
 * Geometry and rules are both static, version-controlled content, so the
 * response is cached rather than recomputed per request. Under Cache
 * Components the directive cannot go on the GET export itself, so the work
 * sits in a cached helper the handler calls.
 */
import { cacheLife } from "next/cache";
import { statePayload } from "@/lib/atlas/geo";
import { stateFromSlug } from "@/lib/atlas";

async function payloadFor(slug: string) {
  "use cache";
  cacheLife("max");
  const abbr = stateFromSlug(slug);
  return abbr ? statePayload(abbr) : null;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/atlas/[state]">) {
  const { state } = await ctx.params;
  const payload = await payloadFor(state);
  if (!payload) {
    return Response.json({ error: `No map for "${state}"` }, { status: 404 });
  }
  return Response.json(payload);
}
