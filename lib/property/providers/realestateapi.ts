/**
 * RealEstateAPI — nationwide assessor record, AVM, equity and open mortgage,
 * keyed on APN or address, through the standard Property Search.
 * Docs: https://developer.realestateapi.com/reference/property-search-api
 *
 * Env: REALESTATEAPI_API_KEY
 *
 * Why Property Search rather than PropertyDetail: the flat search record
 * already carries what a bidder decides on — `estimatedValue`,
 * `estimatedEquity`, `openMortgageBalance`, owner, specs, use code — so the
 * separate detail call buys nothing a tax-sale list needs. Liens and comps are
 * separate products, asked for on demand, not here.
 *
 * Which parcels may be asked about at all is not this module's decision — see
 * `paidLookupAllowed` in `../enrich.ts`. Every lookup here is billed.
 *
 * Three response shapes matter, and they are easy to confuse:
 *
 *   - HTTP 200, body `statusCode: 200`, `data` non-empty → a match.
 *   - HTTP 200 with empty `data`, or body `statusCode: 404` → a genuine
 *     no-match. The HTTP layer says OK; only the *body* says not-found.
 *   - HTTP 401/403/402, or a credit-shaped 4xx → the key or wallet is dead.
 *
 * Reading `res.ok` alone would score every miss as a success with empty data;
 * reading a miss as a failure would mark the provider dead on the first parcel
 * not in their dataset. Both have happened on this project with other
 * providers, so the body is read explicitly.
 */

import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";
import { ProviderUnavailableError } from "../types";
import { fetchWithBackoff } from "../retry";

const SEARCH_URL = "https://api.realestateapi.com/v2/PropertySearch";

interface SearchEnvelope {
  data?: unknown;
  statusCode?: number;
  statusMessage?: string;
  error?: string;
  message?: string;
  errorCode?: string;
}

/**
 * Candidate APN strings, as published first.
 *
 * At most two: every attempt is billed. RealEstateAPI stores both a formatted
 * (`29-21-30-3578-06-040`) and an unformatted (`292130357806040`) APN, so one
 * normalization covers the realistic gap between what a clerk publishes and
 * what an assessor indexes.
 */
export function apnCandidates(parcel: string): string[] {
  const p = parcel.trim();
  if (!p) return [];
  const out = [p];
  const stripped = normalizeApn(p);
  if (stripped && stripped !== p) out.push(stripped);
  return out;
}

function normalizeApn(apn: string): string {
  return apn.replace(/[-.\s/]/g, "").toUpperCase();
}

/** Full-address string in the "123 Main St, Arlington VA 22205" form the docs want. */
export function buildAddress(input: EnrichInput): string | null {
  const street = input.addressLine?.trim();
  if (!street) return null;
  const tail = [input.city?.trim(), input.state, input.zip?.trim()]
    .filter((s): s is string => Boolean(s))
    .join(" ");
  // Street alone matches half of America. Require a locality of some kind.
  if (!tail) return null;
  return `${street}, ${tail}`;
}

export const realestateapiProvider: PropertyProvider = {
  name: "realestateapi",

  configured() {
    return (process.env.REALESTATEAPI_API_KEY ?? "").trim().length > 0;
  },

  async lookup(input: EnrichInput): Promise<PropertyRecord | null> {
    const key = (process.env.REALESTATEAPI_API_KEY ?? "").trim();
    if (!key) return null;

    /*
     * APN before address: a tax-sale list publishes a parcel number, and the
     * address is often what we are trying to learn. `size: 1` because search
     * bills per record returned, and an APN within one county names one parcel.
     */
    const attempts: { body: Record<string, unknown>; apn?: string }[] = [];
    const parcel = input.parcelNumber?.trim();
    if (parcel && input.fips) {
      for (const apn of apnCandidates(parcel)) {
        attempts.push({ body: { apn, fips: input.fips, size: 1 }, apn });
      }
    }
    const address = buildAddress(input);
    if (address) attempts.push({ body: { address, size: 1 } });

    if (attempts.length === 0) return null;

    /*
     * `answered` separates "nobody matched" from "we never got to ask". If
     * every attempt died on transport, throw so the batch aborts instead of
     * recording a wall of data misses.
     */
    let answered = false;
    for (const { body, apn } of attempts) {
      const res = await fetchWithBackoff(
        SEARCH_URL,
        {
          method: "POST",
          headers: {
            "x-api-key": key,
            "x-user-id": "deedpilot",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
        { provider: "realestateapi" },
      );

      const text = await res.text();
      let env: SearchEnvelope = {};
      try {
        env = JSON.parse(text) as SearchEnvelope;
      } catch {
        /* Non-JSON body — fall through to the status checks below. */
      }

      assertUsable(res.status, env, text);
      answered = true;

      const bodyStatus = env.statusCode ?? res.status;
      const first = Array.isArray(env.data) ? obj(env.data[0]) : {};
      if (bodyStatus !== 200 || Object.keys(first).length === 0) continue;

      /*
       * The APN field is an autocomplete match, so a near-miss could come back
       * as someone else's parcel. Accept it only when it is the same number
       * once punctuation is ignored.
       */
      if (apn) {
        const got = str(first.apn);
        if (!got || normalizeApn(got) !== normalizeApn(apn)) continue;
      }
      return mapRecord(first);
    }

    if (!answered) {
      throw new ProviderUnavailableError("realestateapi", 0, "no attempt reached the API");
    }
    return null;
  },
};

/**
 * Throw when the *provider* is unusable, as opposed to the parcel being absent.
 *
 * 401/403 are terminal. 402 — "Insufficient wallet balance" — and any 4xx
 * whose message talks about credits, quota or billing must abort the batch:
 * grinding on would convert an empty wallet into hundreds of recorded misses.
 * Rate limits and 5xx never reach here; `fetchWithBackoff` retries them.
 */
function assertUsable(status: number, env: SearchEnvelope, raw: string): void {
  const detail = env.message ?? env.error ?? env.statusMessage ?? raw.slice(0, 200);

  if (status === 401 || status === 403) {
    throw new ProviderUnavailableError("realestateapi", status, `key rejected — ${detail}`);
  }
  if (status === 402) {
    throw new ProviderUnavailableError("realestateapi", status, `payment required — ${detail}`);
  }
  if (
    status >= 400 &&
    /credit|quota|billing|wallet|balance|subscription|plan limit|limit exceeded|exhaust/i.test(
      `${detail} ${env.errorCode ?? ""}`,
    )
  ) {
    throw new ProviderUnavailableError("realestateapi", status, `quota — ${detail}`);
  }
}

/** Map one Property Search record onto the shared record shape. */
export function mapRecord(d: Record<string, unknown>): PropertyRecord {
  const addr = obj(d.address);

  /*
   * The assessment, and only the assessment.
   *
   * maxbid derives ARV as `assessedValue / assessmentRatio`, so an AVM landing
   * here gets divided by the ratio a second time — a Maitland FL parcel with a
   * 180,577 assessment and a 560,000 AVM would imply a $5.6M walk-away price at
   * a 10% ratio. Only `assessedValue` is a tax assessment.
   */
  const assessedValue = num(d.assessedValue);

  /*
   * The AVM. Caveat from the first 2,000 lookups on this provider: it often
   * echoes the assessment to the dollar when it has no model estimate of its
   * own. An AVM equal to the assessment is one number reported twice, not two
   * sources agreeing, and anything that weighs it should check that first.
   */
  const marketValue = positive(num(d.estimatedValue));

  /*
   * Land and improvement arrive as a literal 0 when the county does not break
   * the assessment out. Zero is a real answer downstream (`merge.ts`), so both
   * are dropped when both are zero and the total is not.
   */
  const landRaw = num(d.assessedLandValue);
  const imprRaw = num(d.assessedImprovementValue);
  const unbroken = !landRaw && !imprRaw && Boolean(assessedValue);

  const lotSqft = positive(num(d.lotSquareFeet));

  return {
    source: "realestateapi",

    parcelNumber: str(d.apn),
    addressLine: str(addr.street) ?? str(addr.address),
    city: str(addr.city),
    state: str(addr.state),
    zip: str(addr.zip),
    // "Orange County" → "Orange"; the counties table stores the bare name.
    county: str(addr.county)?.replace(/\s+county$/i, ""),

    ownerName: str(d.companyName) ?? joinName(d.owner1FirstName, d.owner1LastName),

    assessedValue,
    marketValue,
    landValue: unbroken ? undefined : landRaw,
    improvementValue: unbroken ? undefined : imprRaw,

    // `lastSaleAmount` is a string here, and "0" on parcels that never traded.
    lastSaleAmount: positive(num(d.lastSaleAmount)),
    lastSaleDate: dateStr(d.lastSaleDate),

    beds: positive(num(d.bedrooms)),
    baths: positive(num(d.bathrooms)),
    // Zero square feet is how this API says "no building", not a tiny house.
    buildingSqft: positive(num(d.squareFeet)),
    lotSqft,
    acreage: lotSqft ? lotSqft / 43560 : undefined,
    yearBuilt: positive(num(d.yearBuilt)),

    landUse: str(d.landUse),
    propertyType: str(d.propertyUse) ?? str(d.propertyType),

    /*
     * `floodZone` is a boolean on this API but a text column downstream, so the
     * zone letter is what gets stored. A false flag with no letter stays
     * undefined: "not in a flood zone" and "no flood data" are different claims.
     */
    floodZone: str(d.floodZoneType),

    latitude: num(d.latitude),
    longitude: num(d.longitude),

    /*
     * Whole record. `estimatedEquity`, `equityPercent`, `openMortgageBalance`,
     * `ownerOccupied`, `corporateOwned`, `vacant` and `taxDelinquentYear` have no
     * column yet and are queryable from jsonb until they earn one.
     */
    raw: d,
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,$]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Drop non-positive values, which this API uses to mean "none on record". */
function positive(n: number | undefined): number | undefined {
  return n !== undefined && n > 0 ? n : undefined;
}

function joinName(first: unknown, last: unknown): string | undefined {
  const parts = [str(first), str(last)].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/** ISO datetime or plain date → YYYY-MM-DD. */
function dateStr(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}
