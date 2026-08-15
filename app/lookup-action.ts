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
  /**
   * Where the address is, when the geocoder could place it.
   *
   * Carried separately from `data` because it is not something a source said —
   * it is a coordinate we resolved — and because the cached result predates it.
   * Absent whenever the query was a parcel number, a street with no house
   * number, or anything else the address file cannot place.
   */
  location?: { lat: number; lon: number; matched: string };
  error?: string;
}

/**
 * Longer than a search takes and shorter than the function may run.
 *
 * A cold lookup is around 27 seconds and has been seen past 45. When the
 * platform kills the function instead, the browser gets a dead response and
 * renders "This page couldn't load" — a full-page error, with nothing in the
 * runtime log to explain it, for what is really just a slow search.
 *
 * Failing on our own terms turns that into a sentence the reader can act on.
 */
const BUDGET_MS = 55_000;

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "That search took longer than a minute and was stopped. Sources were slow to " +
                "respond — try again, or add the city and ZIP to narrow it.",
            ),
          ),
        ms,
      ),
    ),
  ]);
}

export async function lookupProperty(
  _prev: LookupState | null,
  formData: FormData,
): Promise<LookupState> {
  const query = String(formData.get("q") ?? "").trim();
  if (query.length < 5) {
    return { query, error: "Enter a street address, including the city or ZIP." };
  }

  /*
   * Started first and awaited last, so it overlaps everything below.
   *
   * The geocoder answers in about 200ms and the search takes twenty seconds or
   * more, so run in parallel this is free. Run in sequence it would be 200ms
   * added to every lookup including cache hits, which are otherwise instant.
   *
   * Deliberately not part of the `timeout` race: a slow geocoder should cost
   * the reader an aerial photo, never the valuation they actually asked for.
   */
  const locating = import("@/lib/property/geocode")
    .then((m) => m.geocodeAddress(query))
    .catch(() => null);

  const located = async () => {
    const hit = await locating;
    return hit ? { lat: hit.lat, lon: hit.lon, matched: hit.matched } : undefined;
  };

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
        location: await located(),
      };
    }

    const started = Date.now();
    const retrieval = await timeout(retrievePhase(query), BUDGET_MS);
    const { data, citations } = await timeout(
      extractPhase(query, retrieval),
      Math.max(5_000, BUDGET_MS - (Date.now() - started)),
    );
    await cache.putCached(query, data, citations);
    return { query, data, citations, ageHours: 0, location: await located() };
  } catch (e) {
    return { query, error: e instanceof Error ? e.message : String(e) };
  }
}
