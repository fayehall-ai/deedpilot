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
import { politeFetch, politeFetchBinary } from "../fetch";
import { parseMoney } from "../judge";
import { extractLots, NoProviderAvailableError } from "../extract";
import { findCountyByName } from "../../atlas";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

interface GaCounty {
  /** County name as it appears in the Census/atlas. */
  name: string;
  /** Page that carries, or links to, the sale list. */
  url: string;
  /** Set when the list lives on a different page than the landing page. */
  note?: string;
}

/**
 * Verified county entries. 5 of 159 — this list is the unit of remaining work,
 * and the coverage page reports it honestly rather than implying statewide
 * Georgia support.
 *
 * To add a county: find its tax commissioner's tax-sale page, confirm it
 * actually publishes a parcel list (many link to a "no sale scheduled"
 * document), and add a row.
 */
export const GA_COUNTIES: GaCounty[] = [
  { name: "Cobb", url: "https://www.cobbtax.gov/property/tax_sale/index.php" },
  { name: "Forsyth", url: "https://forsythcountytax.com/tax-sales-excess-funds/" },
  { name: "Barrow", url: "https://www.barrowgatax.org/tax-sales.html" },
  { name: "Chatham", url: "https://tax.chathamcountyga.gov/TaxSaleList" },
  { name: "Clarke", url: "https://www.accgov.com/1719/Tax-Sales", note: "Athens-Clarke unified government" },
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
const PARCEL_HEADERS = /parcel|map\s*#|property|owner|defendant|bid|amount\s*due|address/i;
/** Headers that mark a table we must NOT ingest as upcoming inventory. */
const EXCLUDE_HEADERS = /excess\s*funds|overbid|surplus|claim|sold\s*date|past\s*sale/i;

/**
 * Parse an HTML table into lots when the page has one. Returns null when no
 * table on the page looks like a sale listing, so the caller can fall through
 * to the PDF/LLM route rather than treating an empty parse as "no sale".
 */
function parseHtmlTable($: cheerio.CheerioAPI, sourceUrl: string): DiscoveredLot[] | null {
  let best: DiscoveredLot[] | null = null;

  $("table").each((_, table) => {
    const headerText = $(table).find("th").text().replace(/\s+/g, " ");
    if (!PARCEL_HEADERS.test(headerText)) return;
    if (EXCLUDE_HEADERS.test(headerText)) return;

    const headers = $(table)
      .find("th")
      .map((__, th) => $(th).text().replace(/\s+/g, " ").trim().toLowerCase())
      .get();

    const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
    const iParcel = col(/parcel|map/);
    const iOwner = col(/owner|defendant|name/);
    const iAddr = col(/address|location|situs/);
    const iBid = col(/bid|amount|due|total/);

    if (iParcel === -1 && iOwner === -1) return;

    const rows: DiscoveredLot[] = [];
    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr)
          .find("td")
          .map((___, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();
        if (cells.length === 0) return;

        const parcelNumber = iParcel >= 0 ? cells[iParcel] : undefined;
        const ownerName = iOwner >= 0 ? cells[iOwner] : undefined;
        if (!parcelNumber && !ownerName) return;

        rows.push({
          parcelNumber: parcelNumber || undefined,
          ownerName: ownerName || undefined,
          addressLine: iAddr >= 0 ? cells[iAddr] || undefined : undefined,
          openingBid: iBid >= 0 ? parseMoney(cells[iBid]) : undefined,
          sourceUrl,
          raw: { source: "html-table", cells },
        });
      });

    if (rows.length && (!best || rows.length > best.length)) best = rows;
  });

  return best;
}

/**
 * Absolute URLs of PDFs linked from the page.
 *
 * Resolves against `<base href>` when the document declares one. Cobb does,
 * and ignoring it turns every relative link into a 404 against the wrong
 * directory — a silent "county has no list" that is actually a parsing bug.
 */
function pdfLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const base = $("base[href]").attr("href");
  let resolveAgainst = pageUrl;
  if (base) {
    try {
      resolveAgainst = new URL(base, pageUrl).toString();
    } catch {
      /* malformed base — fall back to the page URL */
    }
  }

  const out: string[] = [];
  $('a[href*=".pdf" i]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const label = `${$(a).text()} ${href}`;
    // Excess-funds lists are past sales; brochures explain procedure. Counties
    // also link a literal "there are no tax sale parcels at this time" PDF.
    if (/excess|surplus|overbid|brochure|faq|instruction|guide|kiosk|no tax sale/i.test(label)) {
      return;
    }
    try {
      out.push(new URL(href, resolveAgainst).toString());
    } catch {
      /* malformed href — skip */
    }
  });
  return [...new Set(out)];
}

async function pdfToText(url: string): Promise<string> {
  const res = await politeFetchBinary(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
  if (res.bytes.length === 0) throw new Error(`empty body for ${url}`);

  // pdf-parse v2 exports a PDFParse class, not a default function. Imported
  // lazily so its Node-only dependencies stay out of the Next client graph.
  const { PDFParse } = (await import("pdf-parse")) as unknown as {
    PDFParse: new (opts: { data: Uint8Array }) => {
      getText(): Promise<{ text?: string }>;
      destroy(): Promise<void>;
    };
  };

  const parser = new PDFParse({ data: res.bytes });
  try {
    const parsed = await parser.getText();
    return parsed.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

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
        config: { url: entry.url, name: entry.name, note: entry.note },
      });
    }
    return bindings;
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const { url, name } = binding.config as { url: string; name: string };
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
        title: `${name} County tax sale (courthouse steps)`,
        status: "scheduled",
        sourceUrl: url,
        raw: { registryUrl: url },
      },
    ];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
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
          throw new Error(
            `${pdf} needs LLM extraction but no provider is configured — county left unresolved`,
          );
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
