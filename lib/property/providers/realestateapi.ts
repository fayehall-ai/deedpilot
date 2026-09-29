/**
 * RealEstateAPI — nationwide assessor + AVM, keyed on APN or address, through
 * PropertyDetail: the full record, with mortgage, sale and foreclosure history,
 * tax and lot detail, schools and fair-market rents. The standard search's flat
 * record was tried and dropped; detail is what the parcel page shows.
 * Docs: https://developer.realestateapi.com/reference/property-detail-api-1
 *
 * Env: REALESTATEAPI_API_KEY
 *
 * Which parcels may be asked about is not this module's decision — see
 * `paidLookupRefusal` in `../spend-policy.ts`. Every lookup here is billed.
 *
 * Why this provider exists: ATTOM and BatchData were the two APN-first legs of
 * the pipeline and both are down — ATTOM on a 401, BatchData out of credits —
 * which left RentCast (needs a street number the notices don't publish) and a
 * web search that is forbidden from writing an assessment. This one takes
 * `apn` + `fips` directly, which is the shape a tax-sale list actually
 * publishes, and returns an assessment and an AVM in the same call.
 *
 * Three response shapes matter, and they are easy to confuse:
 *
 *   - HTTP 200, body `statusCode: 200`  → a match.
 *   - HTTP 200, body `statusCode: 404`  → a genuine no-match. The HTTP layer
 *     says OK; only the *body* says not-found.
 *   - HTTP 401/403                      → the key or plan is dead.
 *
 * That middle case is the trap this module exists to avoid. Reading the HTTP
 * status alone would score every miss as a success with empty data; reading it
 * as a failure would mark the provider dead on the first vacant lot that isn't
 * in their dataset. The 799-phantom-miss incident in `enrich.ts` was this
 * distinction collapsing in the other direction, so it is checked explicitly
 * here rather than inferred from `res.ok`.
 */

import type { EnrichInput, PropertyProvider, PropertyRecord } from "../types";
import { ProviderUnavailableError } from "../types";
import { fetchWithBackoff } from "../retry";
import { cleanAddressLine } from "../../ingest/clean-address";

const BASE = "https://api.realestateapi.com/v2";

/** Shape of the envelope every PropertyDetail response arrives in. */
interface DetailEnvelope {
  /** An object from PropertyDetail; an array of ids from an `ids_only` search. */
  data?: unknown;
  statusCode?: number;
  statusMessage?: string;
  error?: string;
  message?: string;
  errorCode?: string;
}

/**
 * Candidate APN strings, the clerk's value first.
 *
 * Kept short: every attempt is a request. RealEstateAPI stores both a formatted
 * (`29-21-30-3578-06-040`) and an unformatted (`292130357806040`) APN and
 * matches on either, so one normalization covers most of the gap between what
 * a clerk publishes and what the assessor indexes.
 *
 * The one gap it does not cover is padding. Pennsylvania tax claim bureaus
 * print `43-036-009-000-0000` for the parcel the assessor indexes as
 * `43-036-009`; four of the first five Dauphin lookups missed on exactly that.
 * So a value ending in all-zero groups gets the trimmed form as a second try —
 * never first, since a trailing `-000` is a real unit or split number in some
 * counties.
 */
export function apnCandidates(parcel: string): string[] {
  const p = parcel.trim();
  if (!p) return [];
  const out = [p];
  const trimmed = p.replace(/([-.\s]0+)+$/, "");
  if (trimmed && trimmed !== p) out.push(trimmed);
  const stripped = p.replace(/[-.\s/]/g, "");
  if (stripped && stripped !== p) out.push(stripped);
  return out;
}

/** Full-address string in the "123 Main St, Arlington VA 22205" form docs want. */
/**
 * Parcel numbers the list does not print as such, from county-specific shapes.
 *
 * - Klamath County, OR prints the map tax lot run together (`3610001D002600`);
 *   its assessor indexes `R-3610-001D0-02600-000`. 131 of 164 missed on it.
 * - Marion County, OR lists put the map tax lot (`073W27CD07200`) in the
 *   address column and an account number in the parcel column. 57 of 82 missed.
 */
export function extraApnCandidates(input: EnrichInput): string[] {
  const out: string[] = [];
  const parcel = input.parcelNumber?.trim() ?? "";
  const klamath = /^(\d{4})(\d{3}[A-Z0-9]{2})(\d{5})$/i.exec(parcel);
  if (input.fips === "41035" && klamath) {
    out.push(`R-${klamath[1]}-${klamath[2].toUpperCase()}-${klamath[3]}-000`);
  }
  const addr = input.addressLine?.trim() ?? "";
  if (input.state === "OR" && /^[0-9]{1,3}[NS]?[0-9]{0,2}[EW][0-9]{2}[A-Z0-9]{0,3}[0-9]{5}$/i.test(addr)) {
    out.push(addr.toUpperCase());
  }
  return out;
}

/**
 * House number and street, for a search scoped by county when the list gives
 * no city or ZIP — Burnett County, WI prints a short account number and
 * "7093 STATE RD 70" with nothing after it. Null when the line is not one
 * clean address ("125 BENSON AVE W ; 137 BENSON AVE W", or a bare "2025").
 */
export function addressParts(line: string | null | undefined): { house: string; street: string } | null {
  /*
   * Burnett's list also leaks the tax year into the address column: "2025
   * 27175 ENGEBRETSON RD" is 27175 Engebretson Rd. See clean-address.ts.
   */
  const cleaned = cleanAddressLine(line) ?? "";
  const m = /^(\d+[A-Z]?)\s+([A-Za-z0-9 .'-]*[A-Za-z][A-Za-z0-9 .'-]*)$/.exec(cleaned);
  return m ? { house: m[1], street: m[2].trim() } : null;
}

/**
 * City and ZIP as a lookup wants them, from what lists actually print.
 *
 * New York lists name the municipality — "Town of Edmeston", "City of
 * Gloversville", "Village of Laurens, Town of Laurens" — and the lookup wants
 * "Edmeston". Oregon lists put "SALEM OR 97302" in the city column.
 */
export function locality(input: EnrichInput): { city?: string; zip?: string } {
  let city = input.city?.trim() || undefined;
  let zip = input.zip?.trim() || undefined;
  if (city) {
    const tail = /^(.*?),?\s+[A-Z]{2}\s+(\d{5})(-\d{4})?$/.exec(city);
    if (tail) {
      city = tail[1].trim() || undefined;
      zip ??= tail[2];
    }
  }
  if (city) {
    city = city.split(",")[0].replace(/^(town|city|village|borough|township) of\s+/i, "").trim() || undefined;
  }
  return { city, zip };
}

export function buildAddress(input: EnrichInput): string | null {
  const street = input.addressLine?.trim();
  if (!street) return null;
  /*
   * A city or a ZIP, not just the state. "1 Irving Ave, NY" was sent for a
   * Binghamton parcel whose list printed no city, matched 1 Irving Ave in
   * Fulton, and wrote a stranger's owner and parcel number onto the lot —
   * 381 times in one Broome sale.
   */
  const { city, zip } = locality(input);
  if (!city && !zip) return null;
  const tail = [city, input.state, zip].filter((s): s is string => Boolean(s)).join(" ");
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
     * APN before address, for the same reason ATTOM is ordered before RentCast:
     * a tax-sale list publishes a parcel number and an opening bid, and the
     * address is the thing we are usually trying to *learn*. Asking by address
     * first would skip the lookup entirely on exactly the lots that need it.
     */
    const attempts: Record<string, unknown>[] = [];
    const parcel = input.parcelNumber?.trim();
    if (parcel && input.fips) {
      for (const apn of apnCandidates(parcel)) {
        attempts.push({ apn, fips: input.fips });
      }
    }
    for (const apn of extraApnCandidates(input)) attempts.push({ apn, fips: input.fips });
    const address = buildAddress(input);
    if (address) attempts.push({ address });
    const parts = addressParts(input.addressLine);

    if (attempts.length === 0 && !parts) return null;

    /*
     * `answered` separates "nobody matched" from "we never got to ask".
     * `lookup` returning null has to mean the dataset genuinely lacks the
     * parcel; if every attempt died on a transport error we must throw so the
     * batch aborts rather than recording the run as a wall of data misses.
     */
    let answered = false;
    const post = async (path: string, body: Record<string, unknown>): Promise<DetailEnvelope> => {
      const res = await fetchWithBackoff(
        `${BASE}/${path}`,
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
      let env: DetailEnvelope = {};
      try {
        env = JSON.parse(text) as DetailEnvelope;
      } catch {
        /* Non-JSON body — fall through to the status checks below. */
      }
      assertUsable(res.status, env, text);
      answered = true;
      // Body status is authoritative; see the header comment.
      return { ...env, statusCode: env.statusCode ?? res.status };
    };
    const detail = (env: DetailEnvelope) =>
      env.statusCode === 200 &&
      env.data &&
      typeof env.data === "object" &&
      !Array.isArray(env.data) &&
      Object.keys(env.data).length > 0
        ? (env.data as Record<string, unknown>)
        : null;

    for (const body of attempts) {
      const data = detail(await post("PropertyDetail", body));
      if (data && inCounty(data, input)) return mapRecord(data);
      // 404 (no match) or 400 (this identifier shape was rejected) — try the
      // next candidate rather than giving up on the lot.
    }

    /*
     * Last resort: house and street within the county, after every other form
     * has missed — the list gave no locality, or one the lookup did not know. An `ids_only` search, accepted
     * only when it names exactly one property — a street number repeated on
     * two roads of the same name is a guess, not a match — then the detail
     * record by id.
     */
    if (parts && input.countyName) {
      const found = await post("PropertySearch", {
        ...parts,
        county: input.countyName,
        state: input.state,
        ids_only: true,
      });
      const ids = Array.isArray(found.data) ? found.data : [];
      if (found.statusCode === 200 && ids.length === 1) {
        const data = detail(await post("PropertyDetail", { id: String(ids[0]) }));
        if (data && inCounty(data, input)) return mapRecord(data);
      }
    }

    if (!answered) {
      throw new ProviderUnavailableError(
        "realestateapi",
        0,
        "no attempt reached the API",
      );
    }
    return null;
  },
};

/**
 * Whether a detail record is for a parcel in the county we asked about.
 *
 * The APN lookup does not stay inside the fips it is given, and an address
 * can exist in fifty counties. A record from another county is someone else's
 * property, and `applyRecordToLot` would copy its owner, parcel number and
 * assessment onto ours, so it is refused rather than trusted. A record that
 * names no county is let through: the other checks are all that can be done.
 */
export function inCounty(d: Record<string, unknown>, input: EnrichInput): boolean {
  const addr = obj(obj(d.propertyInfo).address);
  const fips = str(addr.fips);
  if (fips && input.fips) return fips === input.fips;
  const county = str(addr.county)?.replace(/\s+(county|parish|borough)$/i, "").toLowerCase();
  return !county || !input.countyName || county === input.countyName.toLowerCase();
}

/**
 * The detail record for an address someone typed, for the home-page lookup.
 *
 * Returns the raw payload, or null when there is no match. A match is kept
 * only when its house number is the one typed: the lookup resolves a free-text
 * address and would otherwise answer "2201 Crossrail Dr" with a neighbour.
 * Throws `ProviderUnavailableError` when the key or wallet is dead, so the
 * caller can fall back rather than report a miss.
 */
export async function detailByAddress(address: string): Promise<Record<string, unknown> | null> {
  const key = (process.env.REALESTATEAPI_API_KEY ?? "").trim();
  if (!key) return null;

  const ask = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const res = await fetchWithBackoff(
      `${BASE}/PropertyDetail`,
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
    let env: DetailEnvelope = {};
    try {
      env = JSON.parse(text) as DetailEnvelope;
    } catch {
      /* Non-JSON body — the status checks below decide. */
    }
    assertUsable(res.status, env, text);
    const data = env.data;
    if ((env.statusCode ?? res.status) !== 200 || !data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    return Object.keys(data).length ? (data as Record<string, unknown>) : null;
  };

  /*
   * As typed first. Then, when that is refused, in parts. The free-text parser
   * needs a state to find the city and ZIP: "2930 Cowley Way Unit 211, San
   * Diego 92117" came back 400 "must contain at least one of [zip, city]" and
   * the search fell through to the web. House, street, unit and ZIP alone are
   * accepted — a city in parts demands a state too, so it is left out.
   */
  const parts = parseTypedAddress(address);
  const record =
    (await ask({ address })) ??
    (parts?.zip
      ? await ask({ house: parts.house, street: parts.street, zip: parts.zip, ...(parts.unit ? { unit: parts.unit } : {}) })
      : null);
  if (!record) return null;

  const typed = /^\s*(\d+)/.exec(address)?.[1];
  const house = str(obj(obj(record.propertyInfo).address).house);
  if (typed && house && typed !== house) return null;
  return record;
}

/**
 * House, street, unit and ZIP out of an address as someone types it:
 * "2930 Cowley Way Unit 211, San Diego 92117", "12 Elm St #4, 30349".
 * Null when the first segment does not start with a house number.
 */
export function parseTypedAddress(
  input: string,
): { house: string; street: string; unit?: string; zip?: string } | null {
  const [first] = input.split(",");
  const m = /^\s*(\d+[A-Z]?)\s+(.+?)(?:\s+(?:unit|apt\.?|apartment|suite|ste\.?|#)\s*#?\s*([\w-]+)|\s*#\s*([\w-]+))?\s*$/i.exec(
    first ?? "",
  );
  if (!m) return null;
  const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(input)?.[1];
  const unit = m[3] ?? m[4];
  return {
    house: m[1],
    street: m[2].trim(),
    ...(unit ? { unit } : {}),
    ...(zip ? { zip } : {}),
  };
}

/**
 * Throw when the *provider* is unusable, as opposed to the parcel being absent.
 *
 * 401/403 are terminal: a rejected key is rejected again in four seconds.
 * 402 and any 4xx whose message talks about credits, quota or the plan are the
 * failure that took BatchData out, and it must abort the batch — grinding on
 * would convert an exhausted balance into hundreds of recorded misses. Rate
 * limits and 5xx never reach here; `fetchWithBackoff` retries them and raises
 * its own `ProviderUnavailableError` once the retries are spent.
 */
function assertUsable(status: number, env: DetailEnvelope, raw: string): void {
  const detail = env.message ?? env.error ?? env.statusMessage ?? raw.slice(0, 200);

  if (status === 401 || status === 403) {
    throw new ProviderUnavailableError("realestateapi", status, `key rejected — ${detail}`);
  }
  // 402 is "Insufficient wallet balance" — the account needs topping up.
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

/** Map a PropertyDetail payload onto the shared record shape. */
export function mapRecord(d: Record<string, unknown>): PropertyRecord {
  const propertyInfo = obj(d.propertyInfo);
  const addr = obj(propertyInfo.address);
  const taxInfo = obj(d.taxInfo);
  const lotInfo = obj(d.lotInfo);
  const ownerInfo = obj(d.ownerInfo);
  const lastSale = obj(d.lastSale);

  /*
   * The assessment, and only the assessment.
   *
   * maxbid derives ARV as `assessedValue / assessmentRatio`, so an AVM landing
   * here gets divided by the ratio a second time. This provider makes that
   * mistake unusually tempting because it returns three plausible numbers on
   * the same parcel — a Maitland FL lot came back with assessedValue 180,577,
   * taxInfo.marketValue 585,520 and an AVM of 560,000, a 3.1x spread caused by
   * Florida's homestead assessment cap. Divide 560,000 by a 10% ratio and the
   * walk-away price is $5.6M on a house worth half a million. Only
   * `taxInfo.assessedValue` is a tax assessment, so only it is read here.
   */
  const assessedValue = num(taxInfo.assessedValue);

  /*
   * The AVM, which is the number this provider was added for.
   *
   * `estimatedValue` is the model estimate; `taxInfo.marketValue` is the
   * county's own full-market figure. Both are market-side and neither is safe
   * in `assessedValue`. The AVM leads because it is current and the county
   * figure lags a year, and the county figure backs it up because rural
   * parcels — which is most of a tax-deed list — often have no AVM at all.
   * `taxInfo.estimatedValue` exists in the schema and was null on every parcel
   * probed, so it is read last rather than trusted.
   *
   * Known caveat, and it limits how far the AVM can be trusted as an ARV: on 6
   * of the first 9 parcels enriched, `estimatedValue` came back *exactly* equal
   * to `taxInfo.assessedValue` — 982,818 on Wallisville Rd, 16,897,200 on
   * Mississippi Pkwy, and so on to the dollar. This provider appears to echo
   * the assessment when it has no independent model estimate, rather than
   * returning null. So an AVM equal to the assessment is not corroboration by
   * two sources; it is one number reported twice. Anything that comes to treat
   * the AVM as evidence should compare it against `assessedValue` first and
   * discount the match — the three that genuinely diverged (a Houston condo at
   * 4.117M against a 3.435M assessment, a Flint house at 52,000 against 18,800)
   * are the ones carrying real information.
   */
  const marketValue =
    num(d.estimatedValue) ?? num(taxInfo.estimatedValue) ?? num(taxInfo.marketValue);

  /*
   * Land and improvement come back as a literal 0 rather than null when the
   * county does not break the assessment out — the Maitland parcel reported
   * assessedValue 180,577 against assessedLandValue 0 and
   * assessedImprovementValue 0. Zero is a real answer everywhere else in this
   * pipeline (`merge.ts` treats it as present on purpose), so writing it would
   * publish "this land is worth nothing" next to a six-figure total. Dropped
   * when they are both zero and the total is not.
   */
  const landRaw = num(taxInfo.assessedLandValue);
  const imprRaw = num(taxInfo.assessedImprovementValue);
  const unbroken = !landRaw && !imprRaw && Boolean(assessedValue);
  const landValue = unbroken ? undefined : landRaw;
  const improvementValue = unbroken ? undefined : imprRaw;

  const lotSqft = num(lotInfo.lotSquareFeet) ?? num(propertyInfo.lotSquareFeet);

  return {
    source: "realestateapi",

    // Identity. Prefer their formatted APN — it is the one their own search
    // echoes back, so a re-lookup on a stored value hits the same record.
    parcelNumber: str(lotInfo.apn) ?? str(lotInfo.apnUnformatted),
    addressLine: str(addr.address) ?? str(addr.label),
    city: str(addr.city),
    state: str(addr.state),
    zip: str(addr.zip),
    // "Orange County" → "Orange"; the counties table stores the bare name.
    county: str(addr.county)?.replace(/\s+county$/i, ""),

    ownerName:
      str(ownerInfo.owner1FullName) ??
      str(ownerInfo.companyName) ??
      joinName(ownerInfo.owner1FirstName, ownerInfo.owner1LastName),

    assessedValue,
    marketValue,
    landValue,
    improvementValue,
    taxYear: num(taxInfo.assessmentYear) ?? num(taxInfo.year),

    /*
     * `lastSale.saleAmount` is a number; the top-level `lastSalePrice` is a
     * string, and is "0" on parcels that have never traded. A zero sale is not
     * a comp, so it is dropped rather than stored as a $0 last sale.
     */
    lastSaleAmount: positive(num(lastSale.saleAmount) ?? num(d.lastSalePrice)),
    lastSaleDate: dateStr(lastSale.saleDate) ?? dateStr(d.lastSaleDate),

    /*
     * `bathrooms` is documented as the total, with `partialBathrooms` reported
     * separately. Adding them would double-count if the docs are right, so the
     * total is taken as-is and `partialBathrooms` stays in `raw`, where it can
     * be reconciled without re-paying for the lookup.
     */
    beds: num(propertyInfo.bedrooms),
    baths: num(propertyInfo.bathrooms),
    // Living area leads, matching ATTOM: it is the figure a comp is drawn
    // against. `buildingSquareFeet` includes garage and porch on this provider
    // (2,813 vs 2,080 living on the same house), so it only backs it up.
    buildingSqft: num(propertyInfo.livingSquareFeet) ?? num(propertyInfo.buildingSquareFeet),
    lotSqft,
    acreage: num(lotInfo.lotAcres) ?? (lotSqft ? lotSqft / 43560 : undefined),
    yearBuilt: num(propertyInfo.yearBuilt),

    landUse: str(lotInfo.landUse),
    propertyType: str(d.propertyType) ?? str(lotInfo.propertyUse) ?? str(propertyInfo.propertyUse),
    zoning: str(lotInfo.zoning),
    homestead: bool(propertyInfo.taxExemptionHomeownerFlag),

    /*
     * `floodZone` is a boolean here but a text column downstream, so the
     * descriptive fields are what get stored. When the flag is false and there
     * is no description, this stays undefined: "not in a flood zone" and "we
     * have no flood data" are different claims and the column cannot tell them
     * apart, so inventing a "none" would be a fact we did not verify.
     */
    floodZone: str(d.floodZoneDescription) ?? str(d.floodZoneType),

    latitude: num(propertyInfo.latitude),
    longitude: num(propertyInfo.longitude),

    /*
     * Whole payload. Worth keeping beyond the usual repairability argument:
     * `taxInfo.taxDelinquentYear`, `vacant`, `taxLien`, `preForeclosure` and
     * `auctionInfo` are all directly relevant to a tax-deed list and have no
     * column yet. They are queryable from jsonb until they earn one.
     */
    raw: d,
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
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

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Drop non-positive money, which this API uses to mean "none on record". */
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
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
  return d.toISOString().slice(0, 10);
}
