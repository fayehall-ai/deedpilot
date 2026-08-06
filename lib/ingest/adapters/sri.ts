/**
 * SRI Services — tax and foreclosure sales across seven states.
 *
 * SRI is the contracted sale agent for counties in AL, CO, FL, IN, LA, MI and
 * TN, and runs the online bidding through Zeus (`zeusauction.com`). Its
 * property listings carry something most sources do not: a **street address**
 * per parcel, not just a legal description. That matters downstream — the
 * RentCast enrichment path keys on address, so SRI lots can reach an ARV
 * without an APN match, which is exactly what stalls the Brevard FL lots.
 *
 * ## Access — this adapter never touches the network
 *
 * `sriservices.com/robots.txt` permits crawling, but the listings are not on
 * that origin: they come from a JSON API at
 * `sriservicesusermgmtprod.azurewebsites.net/api`, which rejects every request
 * that does not carry the SPA's `x-api-key` header
 * (`401 Unauthorized access - API key mismatch`, verified 2026-08-05).
 *
 * That key is an access control. Lifting it out of the public bundle to
 * authenticate a server we do not own is a different act from reading a public
 * page, so this adapter does not do it. Pages are opened in the operator's own
 * browser — where the app supplies its own key, as intended — and the extracted
 * listings are saved to `data/sri-capture/`. This file imports `node:fs`, not
 * `politeFetch`; there is no code path from it to SRI.
 *
 * See `docs/sri-capture.md` for the capture workflow.
 *
 * ## Capture shape
 *
 * One JSON file per county and sale type, named `<STATE>-<County>-<type>.json`.
 * Each carries the sale date, time and type on every property, so auctions are
 * derived from the listings themselves — there is no separate registry file to
 * keep in sync.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { countyLabel, findCountyByName } from "../../atlas";
import type { SaleType } from "../../atlas/types";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const CAPTURE_DIR = join(process.cwd(), "data", "sri-capture");
const BASE = "https://sriservices.com/properties";

/** One property row as rendered on the SRI listings page. */
export interface SriProperty {
  addr: string;
  /** Present on mortgage-foreclosure listings only; see isMortgageForeclosure. */
  causeNumber?: string;
  /** "ADRIAN, Michigan" — city and state in one cell, as the page renders it. */
  city: string;
  /** SRI's own sale identifier. Stable, and the dedupe key. */
  saleId: string;
  parcel: string;
  /** MM/DD/YYYY. */
  date: string;
  time: string;
  /** "DELINQUENT", "REDEEMED", … */
  status: string;
  /** "Deed Sale", "Tax Sale", "Foreclosure", … */
  saleType: string;
  /** "Online" or "In-person". */
  method: string;

  // The site's own Excel export carries more than the rendered cards do.
  // See docs/sri-capture.md — prefer it wherever a county offers one.
  /** Minimum bid. Absent from the web cards, present in the Excel export. */
  minBid?: number;
  owner?: string;
  legal?: string;
}

export interface SriCapture {
  source?: string;
  capturedFor: { state: string; county: string; saleTypeParam?: string };
  properties: SriProperty[];
}

/**
 * SRI's sale-type vocabulary mapped to the atlas buckets.
 *
 * Indiana sells liens and Michigan sells deeds through the same platform, so
 * the label cannot be inferred from the state — it is read per listing.
 */
function toSaleType(label: string): SaleType {
  const l = label.toLowerCase();
  if (l.includes("lien")) return "Tax Lien";
  if (l.includes("redeemable")) return "Redeemable Deed";
  if (l.includes("deed")) return "Tax Deed";
  return "Tax Deed";
}

/**
 * SRI runs mortgage foreclosure sheriff's sales alongside tax sales, and they
 * are out of scope.
 *
 * A mortgage foreclosure is a different instrument: the debt is a defaulted
 * note, not delinquent taxes. None of `STATUTE_PARAMS` applies — no tax
 * redemption tier, no assessment ratio path to ARV — so pricing one with the
 * tax-sale engine would produce a confident, meaningless number.
 *
 * They are recognisable without guessing. The listing carries a `Cause #`
 * bearing the Indiana `-MF-` mortgage-foreclosure code and a named defendant
 * where a tax listing carries a `Sale ID` and a `Parcel #`, and it has no
 * parcel number at all. On 2026-08-05 every one of SRI's 20 upcoming Indiana
 * auctions was this type, as was Plaquemines Parish LA — while Jefferson and
 * Livingston LA were genuine tax lien sales.
 *
 * Excluded here rather than left to fail silently: the capture regex needs a
 * `Parcel #` and so already yields nothing for these, which reads as "no
 * inventory" instead of "wrong instrument".
 */
export function isMortgageForeclosure(p: {
  saleType?: string;
  parcel?: string;
  causeNumber?: string;
}): boolean {
  if (/-MF-/i.test(p.causeNumber ?? "")) return true;
  return /foreclosure/i.test(p.saleType ?? "") && !p.parcel?.trim();
}

function toIsoDate(mdy: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function to24h(raw: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(raw.trim());
  if (!m) return undefined;
  let h = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function isUpcoming(iso: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return iso >= today;
}

/** "ADRIAN, Michigan" → "ADRIAN". Blank when the page had no city. */
function cityOnly(raw: string): string | undefined {
  const city = raw.split(",")[0]?.trim();
  return city ? city : undefined;
}

/**
 * Some addresses carry an operational note appended with a triple dash:
 * "4067 HOADLEY ST --- Township requires immediate blight clean-up".
 *
 * The note is real and worth keeping — a required blight cleanup is a cost the
 * bidder eats — but it must not end up in the address field, where it would
 * break every geocode and property lookup.
 */
export function splitAddressNote(raw: string): { address: string; note?: string } {
  const idx = raw.indexOf("---");
  if (idx < 0) return { address: raw.trim() };
  return {
    address: raw.slice(0, idx).trim(),
    note: raw.slice(idx + 3).trim() || undefined,
  };
}

export function propertyToLot(p: SriProperty): DiscoveredLot | null {
  if (!p.saleId && !p.parcel) return null;
  // A defaulted mortgage is not a tax sale — see isMortgageForeclosure.
  if (isMortgageForeclosure(p)) return null;
  const { address, note } = splitAddressNote(p.addr ?? "");

  return {
    externalId: p.saleId || p.parcel,
    lotNumber: p.saleId || undefined,
    parcelNumber: p.parcel || undefined,
    addressLine: address || undefined,
    city: cityOnly(p.city ?? ""),
    ownerName: p.owner || undefined,
    legalDescription: p.legal || undefined,
    // Present only from the Excel export; the rendered cards omit it. Assessed
    // value is never published either way, so max bid stays dark until
    // enrichment supplies an ARV — inventing one would be worse than nothing.
    openingBid: p.minBid,
    status: "pending" as const,
    sourceUrl: BASE,
    raw: {
      sriStatus: p.status || undefined,
      method: p.method || undefined,
      addressNote: note,
    },
  };
}

async function readCaptures(): Promise<{ file: string; capture: SriCapture }[]> {
  let files: string[];
  try {
    files = (await readdir(CAPTURE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const out: { file: string; capture: SriCapture }[] = [];
  for (const file of files) {
    try {
      const capture = JSON.parse(
        await readFile(join(CAPTURE_DIR, file), "utf8"),
      ) as SriCapture;
      if (capture?.capturedFor?.state && Array.isArray(capture.properties)) {
        out.push({ file, capture });
      } else {
        console.warn(`[sri] ${file} is not a capture file — skipped`);
      }
    } catch (e) {
      console.warn(`[sri] ${file} failed to parse: ${String(e)}`);
    }
  }
  return out;
}

/**
 * Group a county's properties into auctions.
 *
 * A capture may span more than one sale — a county with an August deed sale and
 * a September re-offer appears in one file — so properties are keyed on
 * (date, saleType) rather than assumed to belong to a single auction.
 */
function groupIntoSales(props: SriProperty[]): Map<string, SriProperty[]> {
  const bySale = new Map<string, SriProperty[]>();
  for (const p of props) {
    const iso = toIsoDate(p.date ?? "");
    if (!iso || !isUpcoming(iso)) continue;
    const key = `${iso}|${p.saleType || "Unknown"}`;
    const list = bySale.get(key) ?? [];
    list.push(p);
    bySale.set(key, list);
  }
  return bySale;
}

export const sriAdapter: SourceAdapter = {
  name: "sri",
  platform: "zeus",
  description:
    "SRI Services county tax and foreclosure sales (AL, CO, FL, IN, LA, MI, TN), " +
    "read from browser captures in data/sri-capture/. Listings carry street " +
    "addresses, which enables address-based ARV enrichment.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const captures = await readCaptures();
    if (captures.length === 0) {
      console.warn(
        "[sri] no captures in data/sri-capture/. SRI is not crawled — its API " +
          "requires the app's own key. Capture from your browser first; see " +
          "docs/sri-capture.md.",
      );
      return [];
    }

    const byFips = new Map<string, CountyBinding>();
    for (const { file, capture } of captures) {
      const { state, county: countyName } = capture.capturedFor;
      const county = findCountyByName(state, countyName);
      if (!county) {
        console.warn(`[sri] ${file}: no county match for ${countyName}, ${state}`);
        continue;
      }
      const existing = byFips.get(county.fips);
      const props = (existing?.config.properties as SriProperty[] | undefined) ?? [];
      props.push(...capture.properties);
      byFips.set(county.fips, {
        countyFips: county.fips,
        config: { countyName: county.name, state, properties: props },
      });
    }

    return [...byFips.values()];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const cfg = binding.config as unknown as {
      countyName: string;
      state: string;
      properties: SriProperty[];
    };

    const out: DiscoveredAuction[] = [];
    for (const [key, props] of groupIntoSales(cfg.properties)) {
      const [iso, saleTypeLabel] = key.split("|");
      const first = props[0];
      out.push({
        countyFips: binding.countyFips,
        platform: "zeus" as const,
        saleType: toSaleType(saleTypeLabel),
        externalId: `sri|${binding.countyFips}|${iso}|${saleTypeLabel}`,
        saleDate: iso,
        // SRI publishes the county's scheduled date on every listing.
        saleDateConfirmed: true,
        listingKind: "sale_list" as const,
        startTime: to24h(first?.time ?? ""),
        title: `${countyLabel(cfg.state, cfg.countyName)} ${cfg.state} — SRI ${saleTypeLabel}`,
        status: "scheduled" as const,
        sourceUrl: BASE,
        raw: {
          saleKey: key,
          method: first?.method,
          countyName: cfg.countyName,
        },
      });
    }
    return out;
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const saleKey = (auction.raw as { saleKey?: string } | undefined)?.saleKey;
    if (!saleKey) return [];

    // Re-read rather than thread the full property list through the auction:
    // the runner persists auctions between the two calls, and duplicating the
    // parcel array into every auction's `raw` would bloat what gets stored.
    const captures = await readCaptures();
    const [wantIso, wantType] = saleKey.split("|");

    const seen = new Set<string>();
    const lots: DiscoveredLot[] = [];

    for (const { capture } of captures) {
      const county = findCountyByName(
        capture.capturedFor.state,
        capture.capturedFor.county,
      );
      if (county?.fips !== auction.countyFips) continue;

      for (const p of capture.properties) {
        if (toIsoDate(p.date ?? "") !== wantIso) continue;
        if ((p.saleType || "Unknown") !== wantType) continue;
        const id = p.saleId || p.parcel;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const lot = propertyToLot(p);
        if (lot) lots.push(lot);
      }
    }

    return lots;
  },
};
