/**
 * Title Check LLC (tax-sale.info) — Michigan.
 *
 * Michigan county treasurers foreclose on tax-delinquent property under MCL
 * 211.78 and sell it at annual auctions; Title Check runs those auctions for
 * most of the state's 83 counties. robots.txt permits crawling.
 *
 * Michigan is the cleanest title in the covered set: the foreclosure judgment
 * extinguishes the prior owner's interest and most prior liens *before* the
 * property reaches the auction, so there is no post-sale redemption and quiet
 * title is often unnecessary. The deal engine reflects that via statute.ts.
 *
 * Two things this adapter does not get, recorded here rather than hidden:
 *  - Parcel numbers are on each lot's detail page, not the catalog listing.
 *    Fetching 90+ detail pages per county across 100+ catalogs is thousands of
 *    requests against a site that has been generous about access, so lots are
 *    keyed by Title Check's own lot id and enriched later on demand.
 *  - "DNR" catalogs are Department of Natural Resources land sales — a
 *    different program from county tax foreclosure. They are skipped.
 */

import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import { parseMoney } from "../judge";
import { findCountyByName } from "../../atlas";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const BASE = "https://www.tax-sale.info";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "August 13, 2026" -> "2026-08-13" */
function parseLongDate(text: string): string | undefined {
  const m = text.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (!m) return undefined;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return undefined;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "10:00am EDT to 7:00pm EDT" — kept verbatim, not parsed into a timestamp. */
function parseTimeWindow(text: string): string | undefined {
  return text.match(/\d{1,2}:\d{2}\s*[ap]m[^,.]*?to\s*\d{1,2}:\d{2}\s*[ap]m\s*\w*/i)?.[0]?.trim();
}

interface CatalogRef {
  catalogId: string;
  countyLabel: string;
  saleDate: string;
  startTime?: string;
}

/**
 * Read the auction calendar: each `div.entry-c` is one auction event holding a
 * date, a time window, and links to the catalogs selling that day.
 */
async function fetchCatalogRefs(): Promise<CatalogRef[]> {
  const res = await politeFetch(`${BASE}/auctions`);
  const $ = cheerio.load(res.body);
  const refs: CatalogRef[] = [];
  const seen = new Set<string>();

  $("div.entry-c").each((_, block) => {
    const text = $(block).text().replace(/\s+/g, " ").trim();
    const saleDate = parseLongDate(text);
    if (!saleDate) return;
    const startTime = parseTimeWindow(text);

    $(block)
      .find('a[href^="/listings/catalog/"]')
      .each((__, a) => {
        const href = $(a).attr("href") ?? "";
        const catalogId = href.match(/\/listings\/catalog\/(\d+)/)?.[1];
        const label = $(a).text().replace(/\s+/g, " ").trim();
        if (!catalogId || !label) return;

        // DNR catalogs are state land sales, not county tax foreclosure.
        if (/\bDNR\b/i.test(label)) return;
        if (seen.has(catalogId)) return;

        seen.add(catalogId);
        refs.push({ catalogId, countyLabel: label, saleDate, startTime });
      });
  });

  return refs;
}

let catalogCache: CatalogRef[] | null = null;

async function getCatalogRefs(): Promise<CatalogRef[]> {
  if (!catalogCache) catalogCache = await fetchCatalogRefs();
  return catalogCache;
}

export const taxSaleInfoAdapter: SourceAdapter = {
  name: "mi-taxsaleinfo",
  platform: "taxsaleinfo",
  description:
    "Title Check LLC auction catalogs for Michigan county tax foreclosure sales (tax-sale.info).",

  async discoverCounties(): Promise<CountyBinding[]> {
    const refs = await getCatalogRefs();
    const bindings: CountyBinding[] = [];

    for (const ref of refs) {
      const county = findCountyByName("MI", ref.countyLabel);
      if (!county) {
        console.warn(`[mi-taxsaleinfo] unmatched county label: ${ref.countyLabel}`);
        continue;
      }
      bindings.push({
        countyFips: county.fips,
        config: {
          catalogId: ref.catalogId,
          countyLabel: ref.countyLabel,
          saleDate: ref.saleDate,
          startTime: ref.startTime,
        },
      });
    }
    return bindings;
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const { catalogId, countyLabel, saleDate, startTime } = binding.config as {
      catalogId: string;
      countyLabel: string;
      saleDate: string;
      startTime?: string;
    };

    return [
      {
        countyFips: binding.countyFips,
        platform: "taxsaleinfo",
        // Michigan's foreclosure judgment cuts off redemption before the sale,
        // so the buyer receives a deed outright.
        saleType: "Tax Deed",
        externalId: catalogId,
        saleDate,
        startTime,
        title: `${countyLabel} County tax foreclosure auction`,
        status: "scheduled",
        sourceUrl: `${BASE}/listings/catalog/${catalogId}`,
        raw: { catalogId, countyLabel },
      },
    ];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const res = await politeFetch(auction.sourceUrl);
    const $ = cheerio.load(res.body);
    const lots: DiscoveredLot[] = [];
    // A card links to its lot more than once (thumbnail and title), so the
    // same id appears repeatedly in the DOM.
    const seenLotIds = new Set<string>();

    // Each lot is a card headed "<County>: Lot <n>" with a description line
    // and a "Minimum Bid: $x" line. Anchor on the detail link, which is the
    // most stable element — headings and class names move around.
    $('a[href^="/lot/show/id/"]').each((_, a) => {
      const href = $(a).attr("href") ?? "";
      const lotId = href.match(/\/lot\/show\/id\/(\d+)/)?.[1];
      if (!lotId || seenLotIds.has(lotId)) return;
      seenLotIds.add(lotId);

      // Walk up to the card that contains both the heading and the bid line.
      let card = $(a).parent();
      for (let i = 0; i < 5; i++) {
        const t = card.text();
        if (/Minimum Bid/i.test(t) && /Lot\s+\d+/i.test(t)) break;
        const next = card.parent();
        if (!next.length) break;
        card = next;
      }

      const text = card.text().replace(/\s+/g, " ").trim();
      const lotNumber = text.match(/Lot\s+(\d+)/i)?.[1];
      const openingBid = parseMoney(text.match(/Minimum Bid:\s*\$?([\d,]+\.?\d*)/i)?.[1]);

      // Descriptions read like "~0.13 Acre Vacant Parcel On W Meyers Ave, Hazel Park".
      const desc = text
        .replace(/.*?Lot\s+\d+\s*/i, "")
        .replace(/Minimum Bid:.*$/i, "")
        .trim();

      const acreage = Number(desc.match(/~?([\d.]+)\s*Acre/i)?.[1]);
      const street = desc.match(/\bOn\s+([^,]{3,60})/i)?.[1]?.trim();
      const city = desc.match(/,\s*([A-Z][A-Za-z .'-]{2,40})\s*$/)?.[1]?.trim();

      lots.push({
        externalId: lotId,
        lotNumber,
        openingBid,
        acreage: Number.isFinite(acreage) ? acreage : undefined,
        addressLine: street,
        city,
        landUse: /vacant/i.test(desc) ? "Vacant" : undefined,
        legalDescription: desc || undefined,
        sourceUrl: `${BASE}${href}`,
        raw: { lotId, description: desc },
      });
    });

    return lots;
  },
};
