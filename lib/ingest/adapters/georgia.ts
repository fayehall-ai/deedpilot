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
import { extractLots, extractLotsFromImages, NoProviderAvailableError } from "../extract";
import { renderPdfFromUrl, textDensity, SCAN_TEXT_PER_PAGE } from "../render";
import {
  documentLinks,
  parseHtmlTable,
  parseStructuredPdfText,
  pdfToText,
} from "../parse";
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
  {
    name: "Clayton",
    url: "https://publicaccess.claytoncountyga.gov/content/home_commissioner.htm",
    note: "Posts next month's and the month after's lists side by side, named by month.",
  },
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

  /*
   * Added 2026-08-12. Every one was probed first and publishes a parcel list
   * that this pipeline can actually read — verified by parsing it, not by the
   * page looking plausible. Eleven other crawled Georgia counties were
   * rejected in the same pass: Camden's "table" is a calendar widget, Chatham
   * annotates its list links "(No Tax Sale)", and Bibb, Catoosa, Cherokee,
   * Muscogee, Newton, Richmond, Rockdale, Walker and Walton publish neither a
   * list nor a date.
   */
  {
    name: "Hall",
    url: "https://hallcountytax.org/property/tax-sale/",
    note: "Sale date appears only in the list filename, not the page text.",
  },
  {
    name: "Douglas",
    url: "https://www.douglastax.org/property-tax-sales",
    note: "Publishes the fi-fa list as an HTML table — 172 parcels at last probe.",
  },
  {
    name: "Columbia",
    url: "https://www.columbiacountyga.gov/186/Delinquent-Taxes",
    note: "Header row is <td>, not <th>; columns are the CRH/DIF abbreviations.",
  },
  {
    name: "Carroll",
    url: "https://carrollcountygatax.com/tax-sales-2/",
    note: "Posts the newspaper legal advertisement as a text PDF.",
  },
];

/**
 * O.C.G.A. § 9-13-161 puts sheriff's sales on the first Tuesday of the month.
 *
 * Used as a filter rather than a formatter. A county page names many dates —
 * registration deadlines, advertisement runs, payment due dates, past sales —
 * and the statutory sale day is the one property that separates the sale from
 * all of them. A date that is not a first Tuesday is not a Georgia tax sale.
 */
export function isFirstTuesday(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 2 && d.getUTCDate() <= 7;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_ALT = MONTHS.join("|");

function iso(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The first Tuesday of a month — Georgia's statutory sale day. */
function firstTuesdayOf(year: number, monthIndex: number): string {
  const first = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return iso(year, monthIndex, 1 + ((2 - first + 7) % 7));
}

/**
 * Sale dates a county has actually published, newest-first.
 *
 * Two sources, because counties use both. Most name the date in the page text
 * ("the November 3, 2026 tax sale"); Hall County names it only in the filename
 * of the list itself — `September-1-Website-Tax-Sale-List-1.pdf` — with no
 * year at all.
 *
 * A bare month and day is resolved against this year and next, and kept only
 * if exactly one candidate is a future first Tuesday. That is a narrow enough
 * gate to be safe: it cannot invent a date the statute does not allow, and it
 * cannot resurrect a past one.
 */
export function parseSaleDates(
  pageText: string,
  filenames: string[],
  today: string,
): {
  upcoming: string[];
  past: string[];
  /** The filename that named each date, when a filename did — so each sale reads its own list. */
  byDate: Map<string, string>;
} {
  const found = new Set<string>();
  const byDate = new Map<string, string>();
  const named = new Set<string>();

  const withYear = new RegExp(`\\b(${MONTH_ALT})[\\s\\-_,]+(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-_,]+(20\\d\\d)\\b`, "gi");
  for (const src of [pageText, ...filenames]) {
    for (const m of src.matchAll(withYear)) {
      const d = iso(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]));
      found.add(d);
      if (src !== pageText) {
        byDate.set(d, src);
        named.add(src);
      }
    }
  }

  /*
   * Year-less, filenames only. Page prose says "the first Tuesday in March"
   * far too often for this to be safe there; a filename that carries a month
   * and a day is naming a specific document.
   *
   * The negative lookahead stops `Carroll-July-2026-Legals.pdf` from reading
   * 2026 as the twentieth of July.
   */
  const noYear = new RegExp(`\\b(${MONTH_ALT})[\\s\\-_]?(\\d{1,2})\\b(?![\\s\\-_]?\\d)`, "gi");
  const thisYear = Number(today.slice(0, 4));
  for (const name of filenames) {
    for (const m of name.matchAll(noYear)) {
      const mo = MONTHS.indexOf(m[1].toLowerCase());
      const day = Number(m[2]);
      const candidates = [thisYear, thisYear + 1]
        .map((y) => iso(y, mo, day))
        .filter((d) => isFirstTuesday(d) && d >= today);
      if (candidates.length === 1) {
        found.add(candidates[0]);
        byDate.set(candidates[0], name);
        named.add(name);
      }
    }
  }

  /*
   * A list named for its month and nothing else: Clayton posts "OCTOBER TAX
   * SALE LISTING 9-8-26.pdf" and "NOVEMBER TAX SALE LISTING 9-8-26.pdf" side by
   * side, the trailing date being when the list was posted, not the sale. The
   * statute fixes the day — the first Tuesday — so the month is the sale.
   * Filenames only, and only when the name says it is a sale list; only months
   * within six months ahead, so a list left up after its sale is never pushed
   * into next year. One that has just passed is recorded as past, like any
   * other named sale day.
   */
  const monthOnly = new RegExp(`\\b(${MONTH_ALT})\\b(?![\\s\\-_]?\\d)`, "i");
  for (const name of filenames) {
    if (named.has(name) || !/\bsale\b|\blist(?:ing)?\b/i.test(name)) continue;
    const m = monthOnly.exec(name);
    if (!m) continue;
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    const thisOne = firstTuesdayOf(thisYear, mo);
    const days = (d: string) => (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (thisOne >= today || days(firstTuesdayOf(thisYear + 1, mo)) <= 183) {
      const d = thisOne >= today ? thisOne : firstTuesdayOf(thisYear + 1, mo);
      if (days(d) <= 183) {
        found.add(d);
        byDate.set(d, name);
      }
    } else if (days(thisOne) >= -90) {
      found.add(thisOne);
    }
  }

  const saleDays = [...found].filter(isFirstTuesday).sort();
  return {
    byDate,
    upcoming: saleDays.filter((d) => d >= today),
    /*
     * Kept rather than discarded. A county whose only named sale day has
     * already happened is not a county with an unknown schedule — it has told
     * us its schedule, and the sale is over. Douglas still displays the June 2
     * list and Columbia the August 4 one, weeks after each sale; projecting a
     * fresh window over those would hang 191 sold parcels off a date nobody
     * announced, which is the Cobb failure wearing a different hat.
     */
    past: saleDays.filter((d) => d < today),
  };
}

/**
 * The county saying, in its own words, that the listing is empty.
 *
 * Chatham publishes a permanent set of links and annotates them in place —
 * "Tax Sale List (No Tax Sale)", "Judicial Tax Sale List (No Sale Scheduled)"
 * — while other dates elsewhere on the page still parse as first Tuesdays.
 * Matched only inside parentheses so that prose about what happens when there
 * is no sale does not silence a county that has one.
 */
export const NO_SALE_MARKER = /\((?:\s*no\s+(?:tax\s+)?sale[^)]*|\s*no\s+sale\s+scheduled\s*)\)/i;

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




/**
 * Read one PDF, cheapest route first.
 *
 *   deterministic parse -> free and exact when the layout is known
 *   LLM over text       -> costs a call, needs a text layer
 *   LLM over pixels     -> costs a call per page, needs nothing
 *
 * The last rung exists because Fulton County publishes its levy sale list as
 * 8 pages of scanned images: `pdfToText` returns 128 characters, all of them
 * page markers, so every earlier rung correctly concludes there is no list and
 * a real September sale in Georgia's largest county reads as empty. Roughly
 * one reachable county list in thirteen is a scan.
 *
 * Rendering is only attempted when the text layer is genuinely absent, not
 * merely thin — a document we can read is never re-read as pictures.
 */
async function lotsFromPdf(
  url: string,
  context: { countyName: string; state: string; sourceUrl: string },
): Promise<DiscoveredLot[]> {
  let text: string;
  try {
    text = await pdfToText(url);
  } catch (e) {
    /*
     * A list that will not read is not a county with no list. Returning [] here
     * recorded every Georgia PDF as empty while PDF parsing was broken in
     * production; failing lets the run retry and the console show it.
     */
    throw new Error(`could not read ${url}: ${e instanceof Error ? e.message : e}`);
  }

  const structured = parseStructuredPdfText(text, url);
  if (structured?.length) {
    console.log(`[ga-counties] ${url}: structured PDF parse → ${structured.length} lot(s)`);
    return structured;
  }

  const pageMarkers = (text.match(/--\s*\d+\s+of\s+\d+\s*--/g) ?? []).length;
  const pages = Math.max(1, pageMarkers);
  const scanned = textDensity(text, pages) < SCAN_TEXT_PER_PAGE;

  try {
    if (!scanned) {
      const result = await extractLots(text, context);
      if (result.containsParcelList && result.lots.length) return result.lots;
      console.log(`[ga-counties] ${url}: no parcel list — ${result.note ?? "unspecified"}`);
      return [];
    }

    console.log(`[ga-counties] ${url}: no text layer over ${pages} page(s) — rendering for vision`);
    const rendered = await renderPdfFromUrl(url, { maxPages: 20, scale: 2 });
    const result = await extractLotsFromImages(rendered, context);
    if (result.containsParcelList && result.lots.length) {
      console.log(`[ga-counties] ${url}: vision → ${result.lots.length} lot(s) from ${rendered.length} page(s)`);
      return result.lots;
    }
    console.log(`[ga-counties] ${url}: vision found no parcel list — ${result.note ?? "unspecified"}`);
    return [];
  } catch (e) {
    if (e instanceof NoProviderAvailableError) {
      // Distinguish "we couldn't look" from "there is no sale". Returning []
      // here would mark the county as having no inventory.
      throw new Error(`${url} needs LLM extraction — ${e.message}`);
    }
    throw e;
  }
}

/** The month a list's own name gives, 1-12, or null when it names none. */
function monthNamed(url: string | undefined): number | null {
  const name = decodeURIComponent(url ?? "").toLowerCase();
  const i = MONTHS.findIndex((m) => name.includes(m));
  return i === -1 ? null : i + 1;
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
    /*
     * Georgia's statute sets first-Tuesday as the sale *day*, but says nothing
     * about which months a county chooses to sell in — Cobb runs two a year.
     * Projecting the next first Tuesday therefore invents a sale: it put Cobb
     * under 2026-09-01 when Cobb's own page named May 5 and November 3, and
     * only `saleDateConfirmed: false` kept 2,825 delinquent taxpayers out of
     * inventory. So read the county's dates first and project only as a last
     * resort, with the flag that says nobody should bid on it.
     */
    const today = new Date().toISOString().slice(0, 10);
    let dates: string[] = [];
    let stale: string[] = [];
    /* Each sale's own list, where the filenames say which is which. */
    const listFor = new Map<string, string>();
    let saysNoSale = false;
    let discovered: { url: string; kind: ListingKind } | undefined;

    try {
      const res = await politeFetch(url);
      const $ = cheerio.load(res.body);
      const text = res.body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ");

      const candidates = documentLinks($, url);
      discovered = candidates.find((c) => c.kind === "sale_list");

      saysNoSale = NO_SALE_MARKER.test(text);
      if (!saysNoSale) {
        const parsed = parseSaleDates(
          text,
          candidates.map((c) => decodeURIComponent(c.url.split("/").pop() ?? "")),
          today,
        );
        dates = parsed.upcoming;
        stale = parsed.past;
        for (const [d, name] of parsed.byDate) {
          const hit = candidates.find((c) => decodeURIComponent(c.url.split("/").pop() ?? "") === name);
          if (hit) listFor.set(d, hit.url);
        }
      }
    } catch (e) {
      // A page we cannot read is not a county without a sale. Fall through to
      // the projected window so the county still gets crawled.
      console.warn(`[ga-counties] ${name}: ${e instanceof Error ? e.message : e}`);
    }

    const confirmed = dates.length > 0;

    /*
     * The county said so itself. Chatham labels its own links "(No Tax Sale)"
     * and "(No Sale Scheduled)" while leaving a permanent set of handouts on
     * the page, so a projected window here does not just invent a date — it
     * sends a new-homeowner leaflet and a tax-bill glossary to the LLM for
     * transcription on every single run.
     */
    if (saysNoSale) {
      console.log(`[ga-counties] ${name}: page states there is no sale — skipping`);
      return [];
    }

    /*
     * The county named its sale days and every one of them has passed. Emit
     * nothing: the list still on the page belongs to a sale that is over, and
     * a projected window would give those parcels a future date the county
     * never announced. Bindings drive the crawl, not auction rows, so the
     * county is re-read on the next run and picks up its next sale then.
     */
    if (!confirmed && stale.length) {
      console.log(
        `[ga-counties] ${name}: last published sale was ${stale[stale.length - 1]} — no upcoming sale, skipping`,
      );
      return [];
    }

    const saleDates = confirmed ? dates : [nextFirstTuesday()];
    // A declared registry kind is a human judgement about a specific document
    // and outranks anything read off the page.
    const kind: ListingKind = listKind ?? (confirmed ? (discovered ? "sale_list" : "unknown") : "unknown");
    const source = listPdf || (confirmed && discovered ? discovered.url : url);

    return saleDates.map((saleDate) => ({
      /*
       * A page listing two months' sales used to hand both the same document —
       * the first list it found — so November's sale carried October's parcels.
       * A sale whose own list is named reads that list.
       */
      ...(listFor.has(saleDate) && !listPdf
        ? { sourceUrl: listFor.get(saleDate)!, listingKind: listKind ?? ("sale_list" as ListingKind) }
        : (listFor.size || monthNamed(discovered?.url) !== null) && !listPdf && monthNamed(discovered?.url) !== Number(saleDate.slice(5, 7))
          ? /*
             * The page names lists for other months only. The fallback used
             * to be the first list found, so Gwinnett's December 1 sale was
             * handed the October list. This sale reads the page, and the
             * other months' lists are ruled out in `listLots`.
             */
            { sourceUrl: url, listingKind: "unknown" as ListingKind }
          : { sourceUrl: source, listingKind: kind }),
      countyFips: binding.countyFips,
      platform: "county_site" as const,
      // Georgia conveys a redeemable deed: 12 months at a 20% flat penalty,
      // and the right persists until barred by statutory notice.
      saleType: "Redeemable Deed" as const,
      externalId: `${binding.countyFips}|${saleDate}`,
      saleDate,
      saleDateConfirmed: confirmed,
      title: `${name} County tax sale (courthouse steps)`,
      status: "scheduled" as const,
      raw: {
        registryUrl: url,
        listPdf,
        discoveredList: discovered?.url,
        datesFromPage: dates,
        otherSalesLists: [
          ...[...listFor].filter(([d]) => d !== saleDate).map(([, u]) => u),
          ...(discovered && monthNamed(discovered.url) !== null && monthNamed(discovered.url) !== Number(saleDate.slice(5, 7))
            ? [discovered.url]
            : []),
        ],
      },
    }));
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const context = {
      countyName: auction.title ?? auction.countyFips,
      state: "GA",
      sourceUrl: auction.sourceUrl,
    };

    // Direct PDF auction source (e.g. Cobb delinquent roll, Fulton levy list).
    if (/\.pdf(\?|$)/i.test(auction.sourceUrl)) {
      return lotsFromPdf(auction.sourceUrl, context);
    }

    const res = await politeFetch(auction.sourceUrl);
    /*
     * A document by content, not by extension: Gwinnett's list is at
     * `/documents/d/egov/october-2026-tax-sale-web-list`, which was fetched as
     * a web page, found to hold no links, and read as 0 parcels.
     */
    if (/application\/pdf|spreadsheet|officedocument|msword|text\/csv/i.test(res.contentType)) {
      return lotsFromPdf(auction.sourceUrl, context);
    }
    const $ = cheerio.load(res.body);

    // 1. Free and exact, when the county publishes a real table.
    const fromTable = parseHtmlTable($, auction.sourceUrl);
    if (fromTable?.length) return fromTable;

    /*
     * 2. Otherwise try the linked PDFs, most-likely first.
     *
     * Prefer documents the county's own wording claims are a listing. Reading
     * the top three by score regardless of kind sent Chatham's "New Homeowner
     * Information" and "Understanding Your Property Tax Bill" to the LLM on
     * every run — two paid transcriptions of a glossary, on a page whose sale
     * links say "(No Tax Sale)". Only when nothing classifies does it fall
     * back to the unclassified ranking, so a county with an unhelpful filename
     * is still reached.
     */
    /*
     * `documentLinks`, not `.pdf` links only: Gwinnett's October list is at
     * `/documents/d/egov/october-2026-tax-sale-web-list`, with no extension,
     * and an extension-only search never saw it.
     */
    const classified = documentLinks($, auction.sourceUrl);
    const plausible = classified.filter((c) => c.kind !== "unknown");
    const candidates = plausible.length ? plausible : classified;

    /*
     * Every candidate is tried even when one will not read: a handout that
     * fails must not stop the real list behind it being reached. Only a
     * document the county's own wording calls the sale list, failing, makes
     * the run a failure rather than an empty county.
     */
    const unread: string[] = [];
    const othersales = new Set((auction.raw as { otherSalesLists?: string[] } | undefined)?.otherSalesLists ?? []);
    for (const { url: pdf, kind } of candidates.filter((c) => !othersales.has(c.url)).slice(0, 3)) {
      try {
        const lots = await lotsFromPdf(pdf, { ...context, sourceUrl: pdf });
        if (lots.length) return lots;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.warn(`[ga-counties] ${why}`);
        if (kind === "sale_list" || /needs LLM extraction/.test(why)) unread.push(why);
      }
    }
    if (unread.length) throw new Error(unread.join("; "));

    // 3. Nothing published. In Georgia this is common and legitimate: not
    // every county holds a sale every month, and the binding notice is the
    // newspaper legal ad, not the website.
    return [];
  },
};
