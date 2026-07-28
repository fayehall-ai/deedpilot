/**
 * Linebarger Goggan Blair & Sampson (taxsales.lgbs.com) — Texas.
 *
 * LGBS is the delinquent-tax collection counsel for a large share of Texas
 * counties, and publishes each county's sale list as a statutory public
 * notice. The site is an Angular SPA over a clean paginated JSON API, and
 * robots.txt permits crawling.
 *
 * Texas sells *redeemable* deeds: the purchaser gets a deed at the sale, but
 * the former owner may redeem within 180 days (2 years for homestead or
 * agricultural property) by paying the bid plus a 25% penalty. That penalty
 * is the return if redeemed, and the redemption right is the risk if not —
 * both are surfaced to the deal engine via the atlas, not hardcoded here.
 */

import { fetchJson } from "../fetch";
import { parseMoney } from "../judge";
import { findCountyByName } from "../../atlas";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  LotStatus,
  SourceAdapter,
} from "../types";

const API = "https://taxsales.lgbs.com/api";
const PAGE_SIZE = 100;

/** Only Texas — the API also carries Philadelphia, which is a different system. */
const STATE = "TX";

interface LgbsPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

interface LgbsSaleCounty {
  county: string;
  state: string;
}

interface LgbsFilterRow {
  county: string;
  state: string;
  sale_date_only: string | null;
  status: string;
  precinct: string;
}

interface LgbsProperty {
  uid: number;
  sale_id: number;
  state: string;
  county: string;
  cause_nbr: string | null;
  account_nbr: string | null;
  sale_date_only: string | null;
  sale_type: string | null;
  status: string | null;
  prop_address_one: string | null;
  prop_city: string | null;
  prop_zipcode: string | null;
  value: string | null;
  minimum_bid: string | null;
  sale_notes: string | null;
  precinct: string | null;
  geometry: { type: string; coordinates: [number, number] } | null;
}

/** Walk DRF pagination via explicit offsets. */
async function fetchAll<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;

  for (;;) {
    const qs = new URLSearchParams({ ...params, limit: String(PAGE_SIZE), offset: String(offset) });
    const page = await fetchJson<LgbsPage<T>>(`${API}/${path}/?${qs}`);
    out.push(...page.results);

    offset += PAGE_SIZE;
    if (!page.next || page.results.length === 0 || offset >= page.count) break;
    // Guard against a pagination bug turning into an unbounded loop.
    if (offset > 50_000) break;
  }
  return out;
}

/**
 * Map LGBS's free-text status onto our lot lifecycle.
 *
 * "Struck Off" is Texas-specific: the parcel drew no bid at the sale and is
 * now held by the taxing units, available for private resale. That is a real
 * and distinct buying opportunity, not a dead listing.
 */
function mapStatus(status: string | null): LotStatus {
  const s = (status ?? "").toLowerCase();
  if (s.includes("sold")) return "sold";
  if (s.includes("redeem")) return "redeemed";
  if (s.includes("cancel") || s.includes("stayed")) return "cancelled";
  if (s.includes("withdraw") || s.includes("pulled")) return "withdrawn";
  if (s.includes("struck")) return "struck";
  return "pending";
}

/** A sale is one (county, date) pair — that is how Texas runs them. */
function auctionExternalId(county: string, date: string, precinct: string): string {
  const p = precinct?.trim();
  return p ? `${county}|${date}|precinct-${p}` : `${county}|${date}`;
}

export const lgbsAdapter: SourceAdapter = {
  name: "tx-lgbs",
  platform: "lgbs",
  description:
    "Linebarger Goggan Blair & Sampson public sale notices for Texas counties (taxsales.lgbs.com JSON API).",

  async discoverCounties(): Promise<CountyBinding[]> {
    const rows = await fetchAll<LgbsSaleCounty>("sale_counties", {});
    const bindings: CountyBinding[] = [];

    for (const row of rows) {
      if (row.state !== STATE) continue;
      const county = findCountyByName(row.state, row.county);
      if (!county) {
        console.warn(`[tx-lgbs] unmatched county name: ${row.state} / ${row.county}`);
        continue;
      }
      bindings.push({
        countyFips: county.fips,
        config: { lgbsCounty: row.county, state: row.state },
      });
    }
    return bindings;
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const lgbsCounty = String(binding.config.lgbsCounty);

    // filter_bar enumerates the (county, date, status, precinct) combinations
    // that actually have listings — cheaper and more accurate than scanning
    // every date in sale_dates against every county.
    const rows = await fetchAll<LgbsFilterRow>("filter_bar", {
      county: lgbsCounty,
      state: STATE,
    });

    const seen = new Map<string, DiscoveredAuction>();
    for (const row of rows) {
      if (row.state !== STATE || row.county !== lgbsCounty) continue;
      if (!row.sale_date_only) continue; // struck-off inventory, no scheduled sale

      const externalId = auctionExternalId(row.county, row.sale_date_only, row.precinct);
      if (seen.has(externalId)) continue;

      const status = row.status?.toLowerCase() ?? "";
      seen.set(externalId, {
        countyFips: binding.countyFips,
        platform: "lgbs",
        // Texas conveys a deed subject to a statutory right of redemption.
        saleType: "Redeemable Deed",
        externalId,
        saleDate: row.sale_date_only,
        title: `${row.county} tax sale${row.precinct ? ` — precinct ${row.precinct}` : ""}`,
        status: status.includes("postpon")
          ? "postponed"
          : status.includes("cancel")
            ? "cancelled"
            : status.includes("result") || status.includes("sold")
              ? "closed"
              : "scheduled",
        sourceUrl: `https://taxsales.lgbs.com/search?county=${encodeURIComponent(
          row.county,
        )}&state=${STATE}&sale_date=${row.sale_date_only}`,
        raw: { ...row },
      });
    }

    return [...seen.values()];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const [county, saleDate, precinctPart] = auction.externalId.split("|");
    const params: Record<string, string> = {
      county,
      state: STATE,
      sale_date_only: saleDate,
    };
    if (precinctPart?.startsWith("precinct-")) {
      params.precinct = precinctPart.slice("precinct-".length);
    }

    const rows = await fetchAll<LgbsProperty>("property_sales", params);

    return rows.map((r): DiscoveredLot => {
      // GeoJSON order is [longitude, latitude]. Getting this backwards puts
      // every Texas parcel in the Indian Ocean, so it is worth being explicit.
      const [lon, lat] = r.geometry?.coordinates ?? [undefined, undefined];

      return {
        externalId: String(r.uid),
        parcelNumber: r.account_nbr?.trim() || undefined,
        caseNumber: r.cause_nbr?.trim() || undefined,
        addressLine: r.prop_address_one?.trim() || undefined,
        city: r.prop_city?.trim() || undefined,
        zip: r.prop_zipcode?.trim() || undefined,
        latitude: typeof lat === "number" ? lat : undefined,
        longitude: typeof lon === "number" ? lon : undefined,
        // `value` is the taxing unit's appraised value; `minimum_bid` is the
        // statutory opening bid (judgment + costs), which is frequently
        // *higher* than appraised value on low-value parcels.
        assessedValue: parseMoney(r.value),
        openingBid: parseMoney(r.minimum_bid),
        status: mapStatus(r.status),
        landUse: r.sale_type?.trim() || undefined,
        sourceUrl: auction.sourceUrl,
        raw: { ...r },
      };
    });
  },
};
