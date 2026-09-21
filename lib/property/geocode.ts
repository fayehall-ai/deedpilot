/**
 * Address to coordinates, via the Census geocoder.
 *
 * Free, keyless, and the same service `scripts/geocode-lots.ts` has been using
 * to unlock address-keyed providers for Louisiana. This lifts it out of that
 * script so the lookup path and the bulk path cannot disagree about what counts
 * as a match — the script imports from here rather than keeping its own copy.
 *
 * ## Why this one
 *
 * It is the authoritative US address file, it costs nothing, it needs no key,
 * and its coverage is exactly the coverage we need: parcels, including rural
 * ones, rather than points of interest. Nominatim would need a self-imposed
 * rate limit and attribution; Google and Mapbox both need a billed key.
 *
 * ## Why a miss is not an error
 *
 * Roughly a third of what people type is not a deliverable address — a parcel
 * number, a street with no house number, a town and a state. Those are not
 * failures to be surfaced; they are simply addresses the file cannot place, and
 * every caller here treats null as "carry on without coordinates".
 */

const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface Located {
  lat: number;
  lon: number;
  city?: string;
  zip?: string;
  /** The address the geocoder believes it matched, which may differ from input. */
  matched: string;
}

/**
 * Place a one-line address.
 *
 * `state` is optional because the lookup box takes a full address and the bulk
 * script takes a street line plus a known state; appending a state the caller
 * did not supply would be inventing a fact about the query.
 */
export async function geocodeAddress(
  address: string,
  state?: string,
  timeoutMs = 8_000,
): Promise<Located | null> {
  const params = new URLSearchParams({
    address: state ? `${address}, ${state}` : address,
    benchmark: "Public_AR_Current",
    format: "json",
  });

  try {
    const res = await fetch(`${CENSUS}?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: {
        addressMatches?: {
          matchedAddress: string;
          coordinates: { x: number; y: number };
          addressComponents?: { city?: string; zip?: string };
        }[];
      };
    };

    const m = data.result?.addressMatches?.[0];
    if (!m) return null;

    return {
      // x is longitude, y is latitude — the opposite of how they are usually
      // written, and the source of a whole afternoon lost to parcels in China.
      lat: m.coordinates.y,
      lon: m.coordinates.x,
      city: m.addressComponents?.city,
      zip: m.addressComponents?.zip,
      matched: m.matchedAddress,
    };
  } catch {
    return null;
  }
}

/**
 * Forms of an address worth trying, in order of fidelity.
 *
 * A first pass located 1,139 of 1,206 Louisiana lots and left 66, which turned
 * out not to be unlocatable so much as unparseable:
 *
 *     "620 23RD ST (LAND ONLY)"   an annotation the index reads as street
 *     "1630-32 LAFAYETTE ST"      a range of house numbers, not one address
 *     "12TH ST"                   an ordinal street with no house number
 *
 * The first two are the same address wearing something extra. The third is not
 * an address at all and no variant rescues it — a street name alone matches the
 * whole road.
 *
 * Variants are tried most-faithful first and the first hit wins, so a cleaned
 * form is only used when the original found nothing.
 */
export function addressVariants(raw: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.replace(/\s+/g, " ").trim();
    if (t && /^[0-9]/.test(t) && !out.includes(t)) out.push(t);
  };

  push(raw);
  // "620 23RD ST (LAND ONLY)" -> "620 23RD ST"
  const noParens = raw.replace(/\([^)]*\)/g, "");
  push(noParens);
  // "1630-32 LAFAYETTE ST" -> "1630 LAFAYETTE ST". The first number is the one
  // the parcel is indexed under; the second is the far end of a double lot.
  push(noParens.replace(/^(\d+)\s*[-–]\s*\d+\b/, "$1"));

  return out;
}
