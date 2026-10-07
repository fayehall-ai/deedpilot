"use server";

import type { SearchedProperty } from "@/lib/property/providers/websearch";
import type { ReapiExtras } from "@/lib/property/address-lookup";
import { buildPropertyView, type PropertyView } from "@/lib/property/reapi-view";
import type { HistoryBucket } from "@/lib/history/comparables";
import type { SaleType } from "@/lib/atlas/types";

/**
 * Look up a property for the home-page search box.
 *
 * A server action rather than a page navigation, so the result appears beside
 * the box that asked for it and the address stays in the field. The previous
 * design sent the reader to `/property?q=…`, which lost the query from the input
 * and made a twenty-second search feel like a page that had gone somewhere else.
 *
 * Answered from RealEstateAPI only: the county record and a valuation in about
 * a second. There is no web-search fallback — it read figures off listing
 * pages and got them wrong.
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
  /** Which source answered — the card words its caveats to match. */
  source?: "realestateapi" | "web";
  /** Record-only figures, when RealEstateAPI answered. */
  extras?: ReapiExtras;
  /** The same street address in more than one place — the reader picks one. */
  choices?: string[];
  /** Google's photograph of the front, when it has one near the address. */
  streetView?: { location: string; date: string | null };
  /**
   * The parcel page's PropStream-style card, built on the server from the full
   * record. Absent for answers cached before the record was kept, which draw
   * the older summary card instead of paying for the lookup again.
   */
  view?: PropertyView;
  /** County rules, records links, deal inputs and sale matches — the parcel page's other half. */
  context?: LookupContext;
  error?: string;
}

/**
 * What the parcel page shows beside the record, worked out on the server for a
 * looked-up address. Plain data, because the lookup renders in the browser.
 */
export interface LookupContext {
  state: string;
  fips: string;
  countyName: string;
  /** The county's atlas page, or the state's when the county is not in it. */
  atlasHref: string;
  rule: {
    type: string;
    saleType: SaleType;
    redemption: string;
    returns: string;
    statute: string;
    survivingLiens?: string;
    quietTitle?: string;
    isStateDefault: boolean;
    taxCollector?: { url: string; label: string };
  } | null;
  links: { url: string; label: string; searchOnly?: boolean }[];
  /** The max-bid engine's inputs. No opening bid: an address is not a sale lot. */
  deal: { assessedValue?: number; marketValue?: number };
  history: { bucket: HistoryBucket | null; key: string } | null;
  /** This same property as a lot in one of our upcoming sales. */
  saleLots: {
    lotId: string;
    parcelNumber: string | null;
    openingBid: string | null;
    status: string;
    saleDate: string;
    saleType: string;
  }[];
}

const objOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const numOf = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const strOf = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;

async function contextOf(raw: Record<string, unknown> | undefined): Promise<LookupContext | undefined> {
  if (!raw) return undefined;
  const addr = objOf(objOf(raw.propertyInfo).address);
  const lotInfo = objOf(raw.lotInfo);
  const tax = objOf(raw.taxInfo);
  const fips = strOf(addr.fips)?.padStart(5, "0");
  const state = strOf(addr.state);
  if (!fips || !state) return undefined;

  const [{ resolveCountyRule, stateSlug, countySlug }, { assessorLinks }, { getComparables }] = await Promise.all([
    import("@/lib/atlas"),
    import("@/lib/property/assessor-links"),
    import("@/lib/history/comparables"),
  ]);
  const resolved = resolveCountyRule(fips);
  const countyName =
    resolved?.county.name ?? strOf(addr.county)?.replace(/\s+county$/i, "") ?? "";
  const apn = strOf(lotInfo.apn) ?? null;

  /*
   * The same split as the provider mapping: assessment in `assessedValue`, the
   * AVM (or the county's market figure) in `marketValue`. An AVM in the
   * assessed slot gets divided by the assessment ratio a second time.
   */
  const assessedValue = numOf(tax.assessedValue);
  const marketValue = numOf(raw.estimatedValue) ?? numOf(tax.estimatedValue) ?? numOf(tax.marketValue);

  const history = resolved
    ? getComparables({ state, saleType: resolved.saleType, assessedValue, fips, limit: 1 })
    : null;

  /* A failed match must not cost the reader the lookup they asked for. */
  const saleLots = await import("@/lib/queries")
    .then((q) =>
      q.findUpcomingLotsForProperty({
        fips,
        apns: [apn, strOf(lotInfo.apnUnformatted)].filter((a): a is string => Boolean(a)),
        reapiId: strOf(raw.id) ?? null,
      }),
    )
    .catch(() => []);

  return {
    state,
    fips,
    countyName,
    atlasHref: resolved
      ? `/atlas/${stateSlug(state)}/${countySlug(countyName)}`
      : `/atlas/${stateSlug(state)}`,
    rule: resolved
      ? {
          type: resolved.type,
          saleType: resolved.saleType,
          redemption: resolved.redemption,
          returns: resolved.returns,
          statute: resolved.statute,
          survivingLiens: resolved.survivingLiens,
          quietTitle: resolved.quietTitle,
          isStateDefault: resolved.isStateDefault,
          taxCollector: resolved.taxCollector?.url
            ? { url: resolved.taxCollector.url, label: resolved.taxCollector.label }
            : undefined,
        }
      : null,
    links: assessorLinks({ state, fips, countyName, parcelNumber: apn }),
    deal: { assessedValue, marketValue },
    history: history ? { bucket: history.bucket, key: history.key } : null,
    saleLots: saleLots.map((l) => ({
      lotId: l.lotId,
      parcelNumber: l.parcelNumber,
      openingBid: l.openingBid,
      status: l.status,
      saleDate: l.saleDate,
      saleType: l.saleType,
    })),
  };
}

/** The same shaping the parcel page uses; a looked-up address has no sale list behind it. */
function viewOf(raw: Record<string, unknown> | undefined, extras: ReapiExtras): PropertyView | undefined {
  return raw ? buildPropertyView(raw, { countyName: extras.county ?? "" }) : undefined;
}

/**
 * Fail on our own terms if the record service hangs, rather than let the
 * platform kill the function and show "This page couldn't load".
 */
function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} seconds`)), ms),
    ),
  ]);
}

export async function lookupProperty(
  prev: LookupState | null,
  formData: FormData,
): Promise<LookupState> {
  const state = await lookupInner(prev, formData);
  if (!state.data) return state;
  /*
   * The front of the house, the only photograph the lookup shows. Aimed at the
   * record's own label when there is one — it carries the state the typed
   * address may lack — and asked of the free metadata endpoint, so the card
   * shows nothing where Google never drove.
   */
  const where = state.location?.matched ?? state.query;
  const { streetViewMetadata } = await import("@/lib/property/streetview");
  const meta = await streetViewMetadata(where).catch(() => null);
  return meta ? { ...state, streetView: { location: where, date: meta.date } } : state;
}

async function lookupInner(
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
   * the reader a located address, never the valuation they actually asked for.
   */
  const locating = import("@/lib/property/geocode")
    .then((m) => m.geocodeAddress(query))
    .catch(() => null);

  const located = async () => {
    const hit = await locating;
    return hit ? { lat: hit.lat, lon: hit.lon, matched: hit.matched } : undefined;
  };

  /*
   * RealEstateAPI only. The web search that used to answer when it had no
   * record read figures off listing pages — 7 beds for a 4-bed house at 7714
   * Mocorito Ave — so a miss now says so instead. Cached under its own key, so
   * a repeated search is not billed twice.
   */
  try {
    const cache = await import("@/lib/property/lookup-cache");
    const recordKey = `realestateapi: ${query}`;
    type Stored = {
      found: boolean;
      data: SearchedProperty;
      extras: ReapiExtras;
      location?: LookupState["location"];
      raw?: Record<string, unknown>;
    };
    const hit = await cache.getCached<Stored>(recordKey);
    if (hit?.result.found) {
      const { data, extras, location, raw } = hit.result;
      return {
        query,
        data,
        extras,
        location,
        view: viewOf(raw, extras),
        context: await contextOf(raw),
        citations: [],
        ageHours: hit.ageHours,
        source: "realestateapi",
      };
    }
    /* Past the cache, a lookup is billed: the public domain's daily limit applies. */
    const [{ headers }, { spendDailyAllowance }] = await Promise.all([
      import("next/headers"),
      import("@/lib/site-gate/daily-limit"),
    ]);
    const allowed = await spendDailyAllowance("lookup", await headers());
    if (!allowed.ok) return { query, error: allowed.message };
    const { reapiLookup } = await import("@/lib/property/address-lookup");
    const found = await timeout(reapiLookup(query), 15_000);
    if (!found) {
      return {
        query,
        error:
          "No property record matches that address. Check the house number and street, and include the city and state or the ZIP.",
      };
    }
    const { recordUsage } = await import("@/lib/ai/usage");
    void recordUsage({ provider: "realestateapi", operation: "property-lookup", requests: 1 });
    const location = found.location ?? (await located());
    const stored: Stored = { found: true, data: found.data, extras: found.extras, location, raw: found.raw };
    await cache.putCached(recordKey, stored, []);
    return {
      query,
      data: found.data,
      extras: found.extras,
      view: viewOf(found.raw, found.extras),
      context: await contextOf(found.raw),
      citations: [],
      ageHours: 0,
      location,
      source: "realestateapi",
    };
  } catch (e) {
    const { AmbiguousAddressError } = await import("@/lib/property/address-lookup");
    if (e instanceof AmbiguousAddressError) return { query, choices: e.choices };
    return {
      query,
      error: `The property record service did not answer (${e instanceof Error ? e.message : String(e)}). Try again in a moment.`,
    };
  }
}
