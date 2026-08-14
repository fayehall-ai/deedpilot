"use server";

import type { SearchedProperty } from "@/lib/property/providers/websearch";

/**
 * Look up a property for the home-page search box.
 *
 * A server action rather than a page navigation, so the result appears beside
 * the box that asked for it and the address stays in the field. The previous
 * design sent the reader to `/property?q=…`, which lost the query from the input
 * and made a twenty-second search feel like a page that had gone somewhere else.
 */

export interface LookupState {
  /** Echoed back so the input can be restored exactly as typed. */
  query: string;
  data?: SearchedProperty;
  citations?: { url: string; title: string | null }[];
  ageHours?: number;
  error?: string;
}

export async function lookupProperty(
  _prev: LookupState | null,
  formData: FormData,
): Promise<LookupState> {
  const query = String(formData.get("q") ?? "").trim();
  if (query.length < 5) {
    return { query, error: "Enter a street address, including the city or ZIP." };
  }

  try {
    const [{ retrievePhase, extractPhase }, cache] = await Promise.all([
      import("@/lib/property/providers/websearch"),
      import("@/lib/property/lookup-cache"),
    ]);

    const cached = await cache.getCached<SearchedProperty>(query);
    if (cached) {
      return {
        query,
        data: cached.result,
        citations: cached.citations,
        ageHours: cached.ageHours,
      };
    }

    const retrieval = await retrievePhase(query);
    const { data, citations } = await extractPhase(query, retrieval);
    await cache.putCached(query, data, citations);
    return { query, data, citations, ageHours: 0 };
  } catch (e) {
    return { query, error: e instanceof Error ? e.message : String(e) };
  }
}
