/**
 * Georgia — 159 county tax commissioners, one registry entry at a time.
 *
 * Georgia has no shared auction platform and no shared data format. Each
 * county tax commissioner publishes (or doesn't) its own sale list on its own
 * domain, in HTML, in a PDF, or not at all. GovtWindow, which several counties
 * use, is a CMS template rather than a data platform — it standardises the
 * navigation, not the listing.
 *
 * The statutory source of record is not the website at all: O.C.G.A. requires
 * the sale be advertised for four consecutive weeks in the county newspaper's
 * legal section. County pages are a courtesy, which is why they are
 * inconsistent and why a county can legitimately show nothing.
 *
 * So this adapter is deliberately registry-driven: adding a county is a
 * `GA_COUNTIES` entry, not a new adapter. For each entry it fetches the page,
 * then takes the cheapest route that works —
 *
 *   HTML table  -> parsed in code (free, exact)
 *   linked PDF  -> text extracted, then LLM transcription (lib/ingest/extract)
 *   neither     -> recorded as "no list published", which is a real outcome
 *
 * Sales are first-Tuesday, monthly, on the courthouse steps. There is no live
 * bid feed anywhere in Georgia — we can publish what is selling and what it is
 * worth, never follow the bidding.
 */

import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import { extractLots, NoProviderAvailableError } from "../extract";
import { parseHtmlTable, parseStructuredPdfText, pdfLinks, pdfToText } from "../parse";
import { findCountyByName } from "../../atlas";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  ListingKind,
  SourceAdapter,
} from "../types";

interface GaCounty {
  /** County name as it appears in the Census/atlas. */
  name: string;
  /** Page that carries, or links to, the sale list. */
  url: string;
  /**
   * Direct list PDF when the landing page only has a booklet / "no parcels"
   * notice. Prefer the live list when known.
   */
  listPdf?: string;
  /**
   * What `listPdf` actually is. Several Georgia counties publish only the
   * delinquent roll between sales, and it parses exactly like a sale list —
   * parcel, owner, address, amount. Declaring it here is the only thing that
   * keeps a lead list from being served as bidding inventory.
   */
  listKind?: ListingKind;
  /** Set when the list lives on a different page than the landing page. */
  note?: string;
}

/**
 * Verified county entries. The coverage page reports this honestly rather than
 * implying statewide Georgia support.
 *
 * To add a county: find its tax commissioner's tax-sale page, confirm it
 * actually publishes a parcel list (many link to a "no sale scheduled"
 * document), and add a row.
 */
export const GA_COUNTIES: GaCounty[] = [
  {
    name: "Cobb",
    url: "https://www.cobbtax.gov/property/tax_sale/index.php",
    // The published delinquent roll, not the sale list. Cobb posts the sale
    // list roughly four weeks before each sale and holds only a few sales a
    // year (2026: May 5 and Nov 3) — not first-Tuesday-monthly. Everyone on
    // this roll owes money; only a fraction is ever levied and sold.
    listPdf:
      "https://www.cobbtax.gov/Cobb%20County%20Tax%20Commissioner%20Delinquent%20Tax%20List%2007.01.2026.pdf",
    listKind: "delinquent_list",
    note: "Sale list is published ~4 weeks before each sale; this is the delinquent roll.",
  },
  { name: "Forsyth", url: "https://forsythcountytax.com/tax-sales-excess-funds/" },
  { name: "Barrow", url: "https://www.barrowgatax.org/tax-sales.html" },
  { name: "Chatham", url: "https://tax.chathamcountyga.gov/TaxSaleList" },
  { name: "Clarke", url: "https://www.accgov.com/1719/Tax-Sales", note: "Athens-Clarke unified government" },
  {
    name: "Fulton",
    url: "https://www.fultoncountyga.gov/inside-fulton-county/fulton-county-departments/sheriff/tax-sales",
    note: "Sheriff levy PDFs are often scanned images (no text layer).",
  },
  {
    name: "Gwinnett",
    url: "https://www.gwinnetttaxcommissioner.com/property-tax/delinquent_tax/tax-liens-tax-sales",
  },
];

/** Georgia sales are the first Tuesday of the month. */
export function nextFirstTuesday(from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const advance = (1 + ((2 - d.getUTCDay() + 7) % 7)) - 1; // Tuesday = 2
  d.setUTCDate(1 + advance);
  if (d < from) {
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    const a = (1 + ((2 - d.getUTCDay() + 7) % 7)) - 1;
    d.setUTCDate(1 + a);
  }
  return d.toISOString().slice(0, 10);
}

/** Header keywords that mark a table as an actual sale listing. */




export const georgiaAdapter: SourceAdapter = {
  name: "ga-counties",
  platform: "county_site",
  description:
    "Georgia county tax commissioner sale listings — registry-driven, HTML tables parsed in code and PDF booklets transcribed by LLM.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const bindings: CountyBinding[] = [];
    for (const entry of GA_COUNTIES) {
      const county = findCountyByName("GA", entry.name);
      if (!county) {
        console.warn(`[ga-counties] unmatched county name: ${entry.name}`);
        continue;
      }
      bindings.push({
        countyFips: county.fips,
        config: {
          url: entry.url,
          name: entry.name,
          note: entry.note,
          listPdf: entry.listPdf,
          listKind: entry.listKind,
        },
      });
    }
    return bindings;
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const { url, name, listPdf, listKind } = binding.config as {
      url: string;
      name: string;
      listPdf?: string;
      listKind?: ListingKind;
    };
    // Georgia's statute sets first-Tuesday *as the sale day*, but says nothing
    // about which months a county chooses to sell in — Cobb runs two a year.
    // So this is a crawl window, never a published date.
    const saleDate = nextFirstTuesday();

    return [
      {
        countyFips: binding.countyFips,
        platform: "county_site",
        // Georgia conveys a redeemable deed: 12 months at a 20% flat penalty,
        // and the right persists until barred by statutory notice.
        saleType: "Redeemable Deed",
        externalId: `${binding.countyFips}|${saleDate}`,
        saleDate,
        // Projected from the statutory sale day, never read off the county.
        saleDateConfirmed: false,
        listingKind: listKind ?? "unknown",
        title: `${name} County tax sale (courthouse steps)`,
        status: "scheduled",
        // Prefer the direct list PDF when known — landing pages often only
        // carry the procedure booklet.
        sourceUrl: listPdf || url,
        raw: { registryUrl: url, listPdf },
      },
    ];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    // Direct PDF auction source (e.g. Cobb delinquent roll).
    if (/\.pdf(\?|$)/i.test(auction.sourceUrl)) {
      const text = await pdfToText(auction.sourceUrl);
      const structured = parseStructuredPdfText(text, auction.sourceUrl);
      if (structured?.length) {
        console.log(
          `[ga-counties] ${auction.sourceUrl}: structured PDF parse → ${structured.length} lot(s)`,
        );
        return structured;
      }
      try {
        const result = await extractLots(text, {
          countyName: auction.title ?? auction.countyFips,
          state: "GA",
          sourceUrl: auction.sourceUrl,
        });
        if (result.containsParcelList && result.lots.length) return result.lots;
      } catch (e) {
        if (e instanceof NoProviderAvailableError) {
          throw new Error(`${auction.sourceUrl} needs LLM extraction — ${e.message}`);
        }
        throw e;
      }
      return [];
    }

    const res = await politeFetch(auction.sourceUrl);
    const $ = cheerio.load(res.body);

    // 1. Free and exact, when the county publishes a real table.
    const fromTable = parseHtmlTable($, auction.sourceUrl);
    if (fromTable?.length) return fromTable;

    // 2. Otherwise try the linked PDFs, most-likely first.
    for (const pdf of pdfLinks($, auction.sourceUrl).slice(0, 3)) {
      let text: string;
      try {
        text = await pdfToText(pdf);
      } catch (e) {
        console.warn(`[ga-counties] ${pdf}: ${e instanceof Error ? e.message : e}`);
        continue;
      }

      const structured = parseStructuredPdfText(text, pdf);
      if (structured?.length) {
        console.log(`[ga-counties] ${pdf}: structured PDF parse → ${structured.length} lot(s)`);
        return structured;
      }

      try {
        const result = await extractLots(text, {
          countyName: auction.title ?? auction.countyFips,
          state: "GA",
          sourceUrl: pdf,
        });
        if (result.containsParcelList && result.lots.length) return result.lots;
        console.log(`[ga-counties] ${pdf}: no parcel list — ${result.note ?? "unspecified"}`);
      } catch (e) {
        if (e instanceof NoProviderAvailableError) {
          // Distinguish "we couldn't look" from "there is no sale". Silently
          // returning [] here would mark the county as having no inventory.
          // Surface the real failure (credits, bad key, model name) — not a
          // misleading "no provider configured" when keys are set but failing.
          throw new Error(`${pdf} needs LLM extraction — ${e.message}`);
        }
        throw e;
      }
    }

    // 3. Nothing published. In Georgia this is common and legitimate: not
    // every county holds a sale every month, and the binding notice is the
    // newspaper legal ad, not the website.
    return [];
  },
};
