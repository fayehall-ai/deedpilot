/**
 * Property lookup by web search, for when every parcel API is unavailable.
 *
 * ## Why this exists
 *
 * Both parcel-capable providers are down at once, for unrelated reasons: ATTOM
 * returns 401 and BatchData reports an insufficient balance. RentCast is healthy
 * but needs a real street address, and the notices that most need enriching —
 * New Mexico's, for one — publish prose like "IN LOS RANCHOS DE ALBUQUERQUE ON
 * ALMA ENCANTADA CT NW" with no house number at all.
 *
 * A searched lookup is strictly worse than a parcel API and is written to be a
 * last resort: it sorts last in `lookupProperty`, and it only runs when the
 * providers above it have returned nothing.
 *
 * ## The field this may never write
 *
 * `assessedValue` is the assessor's figure, and `compute_maxbid` divides it by
 * `assessmentRatio` to derive an ARV. Writing a searched estimate there would be
 * read as an assessment and multiplied by three to five — a $180,000 estimate
 * entering as an assessed value becomes a $540,000 ARV in a one-third state, and
 * the engine would recommend bidding against it.
 *
 * That is the Cook County failure in a new costume: 70,109 rows of a
 * schema-default `redeemed=False` pinned Illinois at a 2% redemption rate
 * because a placeholder was read as an observation.
 *
 * So this provider populates **`marketValue` only**, never `assessedValue`.
 * `compute_maxbid` already treats a market figure as an as-is valuation and
 * prices from it directly without applying a ratio, which is exactly the correct
 * handling for a number that came from a listing site. The rule is enforced by
 * `stripAssessed` below rather than left to prompt discipline, and tested.
 *
 * ## Retrieval, and why there are two paths
 *
 * This originally handed the whole job to `runSearched`, letting the model
 * browse. Measured on one address that was **114.6 seconds, 15 searches and 49
 * citations** — nothing told it when to stop looking.
 *
 * One Tavily call for the same address took **4.8 seconds** and both paths
 * arrived at the same figure, so the browsing pass bought nothing but its own
 * thoroughness. `retrieve()` now searches once and extracts with
 * `runStructured`, which does not browse and therefore only has to read.
 *
 * The browsing path remains as the fallback, because Tavily returns snippets
 * from pages it has already indexed: a question needing a county portal walked
 * or a form filled still wants the model that can do it. Fast path for the
 * common case, general path when the fast one comes back empty.
 */

import { z } from "zod";
import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";

const PropertySchema = z.object({
  found: z
    .boolean()
    .describe(
      "True only when a page was read describing THIS specific parcel or address. " +
        "A neighbourhood average, a county median or a similar listing is not this property.",
    ),
  marketValue: z
    .number()
    .nullable()
    .describe(
      "Best estimate of current market value in whole dollars, as stated by a source. " +
        "Null when no source states a figure for this property. Never a guess.",
    ),
  addressLine: z.string().nullable().describe("Street address as published"),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  ownerName: z.string().nullable().describe("Only if a public record states it"),
  beds: z.number().nullable(),
  baths: z.number().nullable(),
  buildingSqft: z.number().nullable(),
  lotSqft: z.number().nullable(),
  yearBuilt: z.number().nullable(),
  propertyType: z.string().nullable().describe("e.g. single family, vacant land, mobile home"),
  lastSaleAmount: z.number().nullable(),
  lastSaleDate: z.string().nullable().describe("YYYY-MM-DD, or null"),
  confidence: z
    .enum(["stated", "derived", "none"])
    .describe(
      "'stated' when a source gives a dollar figure for this property; " +
        "'derived' when reasoning from comparables on the same street; " +
        "'none' when nothing usable was found",
    ),
  basis: z.string().describe("What was read and where — one or two sentences"),
  sources: z.array(z.string()).describe("URLs actually read. A figure with no URL is not a figure."),
});

export type SearchedProperty = z.infer<typeof PropertySchema>;

const SYSTEM = `You look up one specific US property and report only what a page you
read actually says about it.

You are being read by a desk that bids real money at tax auctions. An invented
figure causes a loss; "not found" costs nothing. Prefer "not found".

A value for a *different* property — a neighbour, a county median, a similar
listing nearby — is not this property's value. Report found=false rather than
substituting one.

Attach a URL to every figure. If you cannot, set confidence 'none'.`;

/**
 * The retrieval step, factored out so a second search backend can be compared
 * against this one without touching the extraction contract above.
 */
async function retrieve<T extends z.ZodType>(
  prompt: string,
  schema: T,
  operation: "enrich" | "property-lookup",
  /** Free-text identity for the search engine. Omitted for the browsing path. */
  searchFor?: string,
) {
  const { tavilyConfigured } = await import("../tavily");

  /*
   * Fast path: retrieve once, then extract.
   *
   * Measured on 350 5th Ave — the browsing model took 114.6s across 15 searches
   * and 49 citations; Tavily returned the pages in 4.8s and both arrived at the
   * same figure. `runStructured` does not browse, so the extraction step only
   * has to read what came back.
   */
  if (searchFor && tavilyConfigured()) {
    try {
      const { retrieveForAddress, asContext } = await import("../tavily");
      const { runStructured } = await import("../../ai/providers");
      const r = await retrieveForAddress(searchFor);
      if (r.sources.length > 0) {
        const result = await runStructured({
          system: SYSTEM,
          prompt: `${prompt}\n\nRead ONLY the sources below. Cite the URLs you actually used.\n\n${asContext(r)}`,
          schema,
          schemaName: "property_lookup",
          operation,
          maxTokens: 8000,
        });
        return {
          ...result,
          citations: r.sources.map((s) => ({ url: s.url, title: s.title })),
          searchCount: 1,
        };
      }
    } catch {
      /*
       * Retrieval failing is not the question failing. Tavily being down, rate
       * limited or empty falls through to the browsing model, which is slower
       * and more thorough — the right trade when the fast path has nothing.
       */
    }
  }

  const { runSearched } = await import("../../ai/providers");
  return runSearched({
    system: SYSTEM,
    prompt,
    schema,
    schemaName: "property_lookup",
    operation,
    maxTokens: 8000,
  });
}

/**
 * Drop any assessor-shaped field before it can reach the database.
 *
 * A guard rather than a prompt instruction, because the cost of the model
 * ignoring an instruction once is a mispriced bid, and the cost of this function
 * is nothing.
 */
function stripAssessed(rec: PropertyRecord): PropertyRecord {
  const { assessedValue: _drop, landValue: _l, improvementValue: _i, ...safe } = rec;
  return safe;
}

function toRecord(data: SearchedProperty, source: string): PropertyRecord | null {
  if (!data.found || data.confidence === "none") return null;
  return stripAssessed({
    source,
    // marketValue ONLY — see the module header.
    marketValue: data.marketValue ?? undefined,
    addressLine: data.addressLine ?? undefined,
    city: data.city ?? undefined,
    zip: data.zip ?? undefined,
    ownerName: data.ownerName ?? undefined,
    beds: data.beds ?? undefined,
    baths: data.baths ?? undefined,
    buildingSqft: data.buildingSqft ?? undefined,
    lotSqft: data.lotSqft ?? undefined,
    yearBuilt: data.yearBuilt ?? undefined,
    propertyType: data.propertyType ?? undefined,
    lastSaleAmount: data.lastSaleAmount ?? undefined,
    lastSaleDate: data.lastSaleDate ?? undefined,
  });
}

export const websearchProvider: PropertyProvider = {
  name: "websearch",

  configured() {
    // Searched calls have no fallback leg by design — a model that cannot browse
    // would answer from memory, which is the failure this provider must not have.
    return !!(process.env.XAI_API_KEY ?? "").trim();
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    const identity = [
      input.addressLine?.trim(),
      input.city?.trim(),
      input.countyName ? `${input.countyName} County` : null,
      input.state,
      input.zip?.trim(),
    ]
      .filter(Boolean)
      .join(", ");

    // A bare parcel number with no place is not a searchable identity.
    if (!identity && !input.parcelNumber) return null;

    const prompt = `Find the current market value of this specific US property.

${identity ? `ADDRESS: ${identity}` : ""}
${input.parcelNumber ? `PARCEL / APN: ${input.parcelNumber}` : ""}
${input.fips ? `COUNTY FIPS: ${input.fips}` : ""}

Look at the county assessor or property appraiser site for this county first —
it is the source of record and usually free to read. Then real-estate listing
sites for a current estimate.

Report the property's characteristics only where a page states them. If the
address above is a description rather than a street address (some tax notices
publish "ON MAPLE ST NW" with no number), say found=false unless the parcel
number resolves it on the assessor site.`;

    const { data } = await retrieve(prompt, PropertySchema, "enrich", identity || (input.parcelNumber ?? undefined));
    return toRecord(data, "websearch");
  },
};

/**
 * Look up an address typed by a person, for the home-page search.
 *
 * Separate from `lookup` because the inputs and the audience differ: this takes
 * free text rather than a `CountyBinding`-derived identity, and its result is
 * shown to a reader with its sources rather than written to a row. It returns
 * the raw searched answer so the page can show `basis` and `sources` — a number
 * on its own would be exactly the unsourced figure this project refuses
 * everywhere else.
 */
export async function lookupAddress(address: string): Promise<{
  data: SearchedProperty;
  citations: { url: string; title: string | null }[];
}> {
  const query = address.trim();
  if (query.length < 5) {
    throw new Error("Enter a street address, including the city or ZIP.");
  }

  const prompt = `Find this US property and report what public sources say about it.

ADDRESS: ${query}

Read the county assessor or property appraiser record first — it is the source
of record. Then a listing site for a current market estimate.

If the address is ambiguous or you cannot find this exact property, set
found=false and explain in basis. Do not report a nearby or similar property.`;

  const result = await retrieve(prompt, PropertySchema, "property-lookup", query);
  return { data: result.data, citations: result.citations };
}
