/**
 * Florida clerk tax-deed lists — government sources only.
 *
 * RealAuction hosts most FL live bidding and is policy-blocked. Paths we use:
 * - Brevard-style sale PDFs (Files.Serve)
 * - Static government PDFs (Volusia lands available, Marion LAT amounts)
 * - WordPress `:taxdeeds="[…]"` embedded JSON (Sumter, Columbia, Okaloosa, …)
 *
 * Scope grows one clerk at a time. Never add RealAuction subdomains.
 */

import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import { extractLots, NoProviderAvailableError } from "../extract";
import { parseStructuredPdfText, pdfToText } from "../parse";
import { findCountyByName, getCounty } from "../../atlas";
import { parseLotStatus } from "../lot-status";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

interface FlClerk {
  /** Census/atlas county name. */
  name: string;
  /** Index page listing sale dates (or a single sale / lands page). */
  indexUrl: string;
  /**
   * - `brevard`: tax-deed-sales?ID=… → Files.Serve TAX DEED SALE PDFs
   * - `staticPdf`: fixed government PDF URL(s)
   * - `wpTaxdeeds`: WordPress page with `:taxdeeds="[{parcel, opening_bid, …}]"`
   * - `marionLat`: Marion County lands-available purchase-amount PDF(s)
   * - `taxSmartWeb`: TaxSmartWeb jqGrid (Levy Lands Available, etc.)
   */
  pattern: "brevard" | "staticPdf" | "wpTaxdeeds" | "marionLat" | "taxSmartWeb";
  /** For staticPdf / marionLat: direct list PDF URLs. */
  pdfUrls?: string[];
  /**
   * Calendar sale date when the source is inventory without a single auction
   * day (lands available). Near-horizon so lots appear in upcoming queries.
   */
  inventorySaleDate?: string;
  /**
   * For wpTaxdeeds lands-available pages: treat all items as inventory under
   * inventorySaleDate even when iso_sale_date is historical.
   */
  inventoryMode?: boolean;
  /**
   * taxSmartWeb grid SearchType query param (default "Lands Available").
   */
  taxSmartSearchType?: string;
  saleType?: "Tax Deed" | "Redeemable Deed";
  title?: string;
}

/**
 * Verified clerk sources with public lists.
 *
 * "Do not add RealAuction-only counties here" stood at the top of this list, and
 * testing it produced a more useful answer than either accepting or rejecting it.
 *
 * Palm Beach and Duval do run public Clerk portals — `taxdeed.mypalmbeachclerk.com`
 * and `taxdeed.duvalclerk.com`, unauthenticated, on the same TaxSmartWeb software
 * this adapter already parses for Levy. `GridSearchData` answers with a thousand
 * rows apiece carrying real parcel ids, sale dates and amounts, which reads at
 * first glance like the RealAuction block being routed around entirely.
 *
 * It is not. Measured 2026-09-15: of those thousand rows, sorted by sale date
 * descending, **none has a future date**. The Clerk publishes what has already
 * been sold and what was struck off — lands available — and the list of parcels
 * coming up for sale is not there. Palm Beach's 2026-09-16 and 2026-10-14 sales
 * return two lands-available parcels between them and nothing scheduled.
 *
 * So the original instruction was right about what matters, and for a reason it
 * did not state: the auction list genuinely lives only on RealAuction. What the
 * Clerk gives is the public record either side of it. Both counties are kept
 * here because that record is real and worth having — struck-off inventory is
 * buyable — but nobody should read their presence as coverage of the sale.
 *
 * `lib/ingest/policy.ts` says "Florida tax deed lists are public records
 * available directly from each county Clerk of Court — ingest those instead."
 * That holds for completed sales and lands available. It does not deliver the
 * forthcoming sale list, and the difference is the whole question.
 */
export const FL_CLERKS: FlClerk[] = [
  {
    name: "Brevard",
    indexUrl: "https://www.brevardclerk.us/tax-deed-sales",
    pattern: "brevard",
  },
  {
    name: "Volusia",
    indexUrl: "https://www.clerk.org/lands_available.aspx",
    pattern: "staticPdf",
    // Clerk form posts to this PDF after disclaimer; direct URL is public.
    pdfUrls: ["https://app02.clerk.org/cm_rpt/lands/LandsAvailableForTaxes.pdf"],
    inventorySaleDate: "2026-09-15",
    title: "Volusia County FL lands available for taxes",
  },
  {
    name: "Sumter",
    indexUrl: "https://www.sumterclerk.com/public-records/tax-deeds/tax-deed-sales/",
    pattern: "wpTaxdeeds",
    title: "Sumter County FL tax deed sales",
  },
  /*
   * Added 2026-09-21: each publishes its upcoming sales as the same
   * `:taxdeeds` JSON Sumter does, found by hand while chasing sales that had
   * no parcels. None was in this list, so none was ever read.
   */
  {
    name: "DeSoto",
    indexUrl: "https://www.desotoclerk.com/clerk-services/tax-deeds/",
    pattern: "wpTaxdeeds",
    title: "DeSoto County FL tax deed sales",
  },
  {
    name: "Dixie",
    indexUrl: "https://dixieclerk.com/departments-services/court-services/tax-deed-sales/",
    pattern: "wpTaxdeeds",
    title: "Dixie County FL tax deed sales",
  },
  {
    name: "Lafayette",
    indexUrl: "https://www.lafayetteclerk.com/departments-services/clerk-services/tax-deeds/",
    pattern: "wpTaxdeeds",
    title: "Lafayette County FL tax deed sales",
  },
  {
    name: "Hardee",
    indexUrl: "https://www.hardeeclerk.com/departments/tax-deeds/tax-deed-sales/",
    pattern: "wpTaxdeeds",
    title: "Hardee County FL tax deed sales",
  },
  {
    name: "Madison",
    indexUrl: "https://www.madisonclerk.com/departments-services/property-sales/tax-deed-sales/",
    pattern: "wpTaxdeeds",
    title: "Madison County FL tax deed sales",
  },
  {
    name: "Columbia",
    indexUrl:
      "https://columbiaclerk.com/clerk-services/tax-deeds/upcoming-tax-deed-sales/",
    pattern: "wpTaxdeeds",
    title: "Columbia County FL upcoming tax deed sales",
  },
  {
    name: "Marion",
    indexUrl:
      "https://www.marioncountyclerk.org/departments/records-recording/tax-deeds-and-lands-available-for-taxes/land-available-for-taxes-information/",
    pattern: "marionLat",
    // Monthly purchase-amount sheets (lands available / struck inventory).
    pdfUrls: [
      "https://www.marioncountyclerk.org/uploads/2026/07/2026-July-LAT-Purchase-Amounts-1.pdf",
    ],
    inventorySaleDate: "2026-09-15",
    title: "Marion County FL lands available for taxes",
  },
  {
    name: "Okaloosa",
    indexUrl:
      "https://okaloosaclerk.com/board-services/tax-deed-sales/lands-available-for-taxes/",
    pattern: "wpTaxdeeds",
    inventoryMode: true,
    inventorySaleDate: "2026-09-15",
    title: "Okaloosa County FL lands available for taxes",
  },
  {
    name: "Calhoun",
    indexUrl: "https://calhounclerk.com/court-services/property-sales/tax-deed-sales/",
    pattern: "wpTaxdeeds",
    title: "Calhoun County FL tax deed sales",
  },
  {
    name: "Palm Beach",
    // RealAuction runs the auction; the Clerk publishes the record. Verified
    // 2026-09-15: GridSearchData returns 1,000 tax-deed rows with parcel ids.
    indexUrl: "https://taxdeed.mypalmbeachclerk.com/",
    pattern: "taxSmartWeb",
    taxSmartSearchType: "Lands Available",
    inventorySaleDate: "2026-09-16",
    title: "Palm Beach County FL lands available for taxes",
  },
  {
    name: "Duval",
    // Same shape as Palm Beach, found by probing the Clerk rather than the
    // auction host. Verified 2026-09-15.
    indexUrl: "https://taxdeed.duvalclerk.com/",
    pattern: "taxSmartWeb",
    taxSmartSearchType: "Lands Available",
    inventorySaleDate: "2026-09-16",
    title: "Duval County FL lands available for taxes",
  },
  {
    name: "Levy",
    // Public TaxSmartWeb — Lands Available grid returns real Parcel IDs + base bid.
    indexUrl: "https://online.levyclerk.com/TaxSmartWeb/",
    pattern: "taxSmartWeb",
    taxSmartSearchType: "Lands Available",
    inventorySaleDate: "2026-09-15",
    title: "Levy County FL lands available for taxes",
  },
];

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** "September 17, 2026" -> "2026-09-17" */
function parseLongDate(text: string): string | undefined {
  const m = text.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (!m) return undefined;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return undefined;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Prefer future sales; fall back to all if none remain. */
function isUpcoming(iso: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return iso >= today;
}

interface SaleRef {
  saleDate: string;
  pageUrl: string;
  pdfUrl: string;
  label: string;
}

async function discoverBrevardSales(indexUrl: string): Promise<SaleRef[]> {
  const res = await politeFetch(indexUrl);
  const $ = cheerio.load(res.body);
  const pages: { label: string; url: string }[] = [];

  $("a[href*='tax-deed-sales?ID=']").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (href.includes("#")) return;
    const label = $(a).text().replace(/\s+/g, " ").trim();
    if (!label || !/\d{4}/.test(label)) return;
    try {
      const url = new URL(href, indexUrl).toString();
      if (!pages.some((p) => p.url === url)) pages.push({ label, url });
    } catch {
      /* skip */
    }
  });

  const sales: SaleRef[] = [];
  for (const page of pages) {
    const saleDate = parseLongDate(page.label);
    if (!saleDate) continue;
    try {
      const r = await politeFetch(page.url);
      const $$ = cheerio.load(r.body);
      $$("a[href]").each((_, a) => {
        const href = $$(a).attr("href") ?? "";
        const text = $$(a).text().replace(/\s+/g, " ").trim();
        if (!/Files\.Serve|File_id/i.test(href)) return;
        if (!/TAX\s*DEED\s*SALE|\.pdf/i.test(text + href)) return;
        try {
          const pdfUrl = new URL(href, page.url).toString();
          if (!sales.some((s) => s.pdfUrl === pdfUrl)) {
            sales.push({
              saleDate,
              pageUrl: page.url,
              pdfUrl,
              label: text || page.label,
            });
          }
        } catch {
          /* skip */
        }
      });
    } catch (e) {
      console.warn(`[fl-clerks] Brevard page ${page.url}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return sales;
}

async function lotsFromPdf(
  pdfUrl: string,
  countyName: string,
): Promise<DiscoveredLot[]> {
  const text = await pdfToText(pdfUrl);
  const structured = parseStructuredPdfText(text, pdfUrl);
  // Prefer structured only when opening bids came through — Brevard PDFs
  // list cases first and bids on later pages; partial structured parses
  // are worse than a single Claude pass.
  const structuredWithBids = structured?.filter((l) => l.openingBid != null) ?? [];
  if (structured && structuredWithBids.length >= Math.min(3, structured.length * 0.5)) {
    console.log(
      `[fl-clerks] ${pdfUrl}: structured → ${structured.length} lot(s) (${structuredWithBids.length} with bids)`,
    );
    return structured;
  }
  try {
    const result = await extractLots(text, {
      countyName,
      state: "FL",
      sourceUrl: pdfUrl,
    });
    if (result.containsParcelList && result.lots.length) {
      console.log(
        `[fl-clerks] ${pdfUrl}: LLM → ${result.lots.length} lot(s) (${result.model})`,
      );
      return result.lots;
    }
    console.log(`[fl-clerks] ${pdfUrl}: no parcel list — ${result.note ?? "unspecified"}`);
  } catch (e) {
    if (e instanceof NoProviderAvailableError) {
      throw new Error(`${pdfUrl} needs LLM extraction — ${e.message}`);
    }
    throw e;
  }
  return [];
}

/** WordPress clerk theme embeds the full sale list as `:taxdeeds="[…]"`. */
interface WpTaxdeedRow {
  parcel?: string;
  opening_bid?: string | number;
  iso_sale_date?: string;
  sale_date?: string;
  file?: string;
  cert?: string;
  owner?: string;
  cert_holder?: string;
  status?: string;
  notes?: string;
  link?: string;
  ID?: number | string;
  legal?: string;
  description?: string;
}

function parseWpTaxdeedsHtml(html: string): WpTaxdeedRow[] {
  const m = html.match(/:taxdeeds="(\[[\s\S]*?\])"/);
  if (!m) return [];
  const unescaped = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'");
  try {
    const arr = JSON.parse(unescaped) as WpTaxdeedRow[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function wpRowToLot(row: WpTaxdeedRow, pageUrl: string): DiscoveredLot | null {
  const parcel = (row.parcel ?? "").trim();
  const file = (row.file ?? "").trim();
  const cert = (row.cert ?? "").trim();
  if (!parcel && !file && !cert) return null;

  const bidRaw = row.opening_bid;
  let openingBid: number | undefined;
  if (typeof bidRaw === "number" && Number.isFinite(bidRaw)) {
    openingBid = bidRaw;
  } else if (typeof bidRaw === "string" && bidRaw.trim()) {
    const n = Number(bidRaw.replace(/[$,\s]/g, ""));
    if (Number.isFinite(n) && n > 0) openingBid = n;
  }

  // Shared vocabulary — see lib/ingest/lot-status.ts. This adapter had its own
  // copy, missing "struck" and "stayed", and a second path below that read every
  // sold and cancelled parcel as redeemed.
  const status: DiscoveredLot["status"] = parseLotStatus(row.status);

  return {
    externalId: file || cert || parcel || String(row.ID ?? ""),
    parcelNumber: parcel || undefined,
    caseNumber: file || cert || undefined,
    ownerName: (row.owner ?? row.cert_holder ?? "").trim() || undefined,
    openingBid,
    legalDescription: (row.notes ?? row.description ?? row.legal ?? "").trim() || undefined,
    status,
    sourceUrl: row.link || pageUrl,
    raw: row as Record<string, unknown>,
  };
}

function saleDateFromWpRow(row: WpTaxdeedRow): string | undefined {
  const iso = (row.iso_sale_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  return parseLongDate(row.sale_date ?? "") ?? undefined;
}

async function listWpTaxdeedAuctions(
  binding: CountyBinding,
  cfg: FlClerk & { countyName: string },
): Promise<DiscoveredAuction[]> {
  const res = await politeFetch(cfg.indexUrl);
  const rows = parseWpTaxdeedsHtml(res.body);
  if (!rows.length) {
    console.warn(`[fl-clerks] ${cfg.name}: no :taxdeeds= JSON on ${cfg.indexUrl}`);
    return [];
  }

  if (cfg.inventoryMode) {
    const saleDate =
      cfg.inventorySaleDate ?? new Date().toISOString().slice(0, 10);
    const lots = rows
      .map((r) => wpRowToLot(r, cfg.indexUrl))
      .filter((l): l is DiscoveredLot => l != null && l.status === "pending");
    if (!lots.length) return [];
    return [
      {
        countyFips: binding.countyFips,
        platform: "county_site",
        saleType: (cfg.saleType ?? "Tax Deed") as "Tax Deed",
        externalId: `${binding.countyFips}|wp-inventory|${saleDate}`,
        saleDate,
        // Struck inventory has no auction day; `inventorySaleDate` is a shelf
        // position that keeps it visible, not a date anyone bids on.
        saleDateConfirmed: false,
        listingKind: "lands_available",
        title: cfg.title ?? `${cfg.countyName} County FL lands available`,
        status: "scheduled",
        sourceUrl: cfg.indexUrl,
        raw: {
          pattern: "wpTaxdeeds",
          inventoryMode: true,
          countyName: cfg.countyName,
          lots,
        },
      },
    ];
  }

  // Group active/scheduled rows by sale date; prefer upcoming.
  const byDate = new Map<string, DiscoveredLot[]>();
  for (const row of rows) {
    const lot = wpRowToLot(row, cfg.indexUrl);
    if (!lot || lot.status !== "pending") continue;
    const d = saleDateFromWpRow(row);
    if (!d) continue;
    const list = byDate.get(d) ?? [];
    list.push(lot);
    byDate.set(d, list);
  }

  const dates = [...byDate.keys()].sort();
  const upcoming = dates.filter((d) => isUpcoming(d));
  const use = upcoming.length ? upcoming : dates.slice(-2);

  return use.map((saleDate) => ({
    countyFips: binding.countyFips,
    platform: "county_site" as const,
    saleType: (cfg.saleType ?? "Tax Deed") as "Tax Deed",
    externalId: `${binding.countyFips}|wp|${saleDate}`,
    saleDate,
    // Grouped from each row's own `iso_sale_date` — the clerk's published day.
    saleDateConfirmed: true,
    listingKind: "sale_list" as const,
    title:
      cfg.title ??
      `${cfg.countyName} County FL tax deed sale ${saleDate}`,
    status: "scheduled" as const,
    sourceUrl: cfg.indexUrl,
    raw: {
      pattern: "wpTaxdeeds",
      countyName: cfg.countyName,
      lots: byDate.get(saleDate) ?? [],
    },
  }));
}

/**
 * Marion LAT purchase sheets:
 *   SALE # 296268
 *   PARCEL # 4033-003-029
 *   PURCHASE AMOUNT $23,976.01
 */
function parseMarionLatText(text: string, sourceUrl: string): DiscoveredLot[] {
  const chunks = text.split(/SALE\s*#\s*/i).slice(1);
  const lots: DiscoveredLot[] = [];
  for (const chunk of chunks) {
    const saleNum = chunk.match(/^(\d+)/)?.[1];
    const parcel = chunk.match(/PARCEL\s*#\s*([A-Z0-9-]+)/i)?.[1];
    const cert = chunk.match(/CERTIFICATE\s*NUMBER\s*#?\s*([A-Z0-9/-]+)/i)?.[1];
    const amount = chunk.match(/PURCHASE\s*AMOUNT\s*\$?\s*([\d,]+(?:\.\d{2})?)/i)?.[1];
    const saleDateRaw = chunk.match(/SALE\s*DATE\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
    const descMatch = chunk.match(/Description:\s*([\s\S]*?)(?:PURCHASE\s*AMOUNT|Make Certified)/i);
    if (!parcel && !saleNum) continue;
    let openingBid: number | undefined;
    if (amount) {
      const n = Number(amount.replace(/,/g, ""));
      if (Number.isFinite(n)) openingBid = n;
    }
    let legalDescription: string | undefined;
    if (descMatch) {
      legalDescription = descMatch[1].replace(/\s+/g, " ").trim().slice(0, 500);
    }
    lots.push({
      externalId: saleNum ?? parcel ?? cert,
      parcelNumber: parcel,
      caseNumber: saleNum ?? cert,
      openingBid,
      legalDescription,
      status: "pending",
      sourceUrl,
      raw: {
        saleNumber: saleNum,
        certificate: cert,
        originalSaleDate: saleDateRaw,
        pattern: "marionLat",
      },
    });
  }
  return lots;
}

async function lotsFromMarionLat(
  pdfUrl: string,
): Promise<DiscoveredLot[]> {
  const text = await pdfToText(pdfUrl);
  const lots = parseMarionLatText(text, pdfUrl);
  console.log(`[fl-clerks] ${pdfUrl}: marionLat → ${lots.length} lot(s)`);
  return lots;
}

/**
 * TaxSmartWeb (e.g. Levy) — public jqGrid JSON:
 *   GET /TaxSmartWeb/Home/GridSearchData?SearchType=Lands%20Available&rows=100
 * cell: [Applicant, Case#, Cert#, ParcelID, SaleDate, Status, BaseBid, HighBid, Surplus, Owners]
 */
async function listTaxSmartWebAuctions(
  binding: CountyBinding,
  cfg: FlClerk & { countyName: string },
): Promise<DiscoveredAuction[]> {
  const saleDate =
    cfg.inventorySaleDate ?? new Date().toISOString().slice(0, 10);
  const searchType = cfg.taxSmartSearchType ?? "Lands Available";
  const base = cfg.indexUrl.replace(/\/?$/, "/");
  const gridUrl = new URL("Home/GridSearchData", base);
  gridUrl.searchParams.set("SearchType", searchType);
  gridUrl.searchParams.set("page", "1");
  gridUrl.searchParams.set("rows", "200");
  gridUrl.searchParams.set("sidx", "SaleDate");
  gridUrl.searchParams.set("sord", "desc");
  gridUrl.searchParams.set("_search", "false");

  const res = await politeFetch(gridUrl.toString());
  let data: { records?: number; rows?: Array<{ id?: number | string; cell?: string[] }> };
  try {
    data = JSON.parse(res.body) as typeof data;
  } catch {
    console.warn(`[fl-clerks] ${cfg.name}: TaxSmartWeb grid not JSON`);
    return [];
  }
  const lots: DiscoveredLot[] = [];
  for (const row of data.rows ?? []) {
    const cell = row.cell ?? [];
    // Lands Available column order
    const applicant = cell[0]?.trim();
    const caseNumber = cell[1]?.trim();
    const cert = cell[2]?.trim();
    const parcel = cell[3]?.trim();
    const origSale = cell[4]?.trim();
    const statusRaw = (cell[5] ?? "").toLowerCase();
    const baseBid = parseMoney(cell[6]);
    const owners = cell[9]?.trim();
    if (!parcel && !caseNumber) continue;
    lots.push({
      externalId: String(row.id ?? caseNumber ?? parcel),
      parcelNumber: parcel || undefined,
      caseNumber: caseNumber || cert || undefined,
      ownerName: owners || undefined,
      openingBid: baseBid,
      /*
       * Was `/redeem|cancel|sold/.test(raw) ? "redeemed" : "pending"`, which
       * recorded every sold and every cancelled parcel as redeemed — a cause
       * nobody published, written into the column a redemption analysis reads.
       */
      status: parseLotStatus(statusRaw),
      sourceUrl: cfg.indexUrl,
      raw: {
        pattern: "taxSmartWeb",
        applicant,
        certificate: cert,
        originalSaleDate: origSale,
        status: cell[5],
        highBid: cell[7],
        surplus: cell[8],
      },
    });
  }

  if (!lots.length) {
    console.warn(`[fl-clerks] ${cfg.name}: TaxSmartWeb 0 lots (${searchType})`);
    return [];
  }

  return [
    {
      countyFips: binding.countyFips,
      platform: "county_site",
      saleType: (cfg.saleType ?? "Tax Deed") as "Tax Deed",
      externalId: `${binding.countyFips}|taxsmart|${searchType}|${saleDate}`,
      saleDate,
      // The grid's own SearchType says what this is; "Lands Available" is
      // standing inventory, so the date is a shelf position, not a sale day.
      saleDateConfirmed: false,
      listingKind: /lands\s*available/i.test(searchType) ? "lands_available" : "unknown",
      title: cfg.title ?? `${cfg.countyName} County FL ${searchType.toLowerCase()}`,
      status: "scheduled",
      sourceUrl: cfg.indexUrl,
      raw: {
        pattern: "taxSmartWeb",
        countyName: cfg.countyName,
        searchType,
        lots,
      },
    },
  ];
}

function parseMoney(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const floridaClerksAdapter: SourceAdapter = {
  name: "fl-clerks",
  platform: "county_site",
  description:
    "Florida clerk-published tax deed sale list PDFs (Brevard pattern). RealAuction is not used.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const bindings: CountyBinding[] = [];
    for (const clerk of FL_CLERKS) {
      const county = findCountyByName("FL", clerk.name);
      if (!county) {
        console.warn(`[fl-clerks] unmatched county: ${clerk.name}`);
        continue;
      }
      bindings.push({
        countyFips: county.fips,
        config: { ...clerk, countyName: county.name },
      });
    }
    return bindings;
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const cfg = binding.config as unknown as FlClerk & { countyName: string };

    if (cfg.pattern === "wpTaxdeeds") {
      return listWpTaxdeedAuctions(binding, cfg);
    }

    if (cfg.pattern === "taxSmartWeb") {
      return listTaxSmartWebAuctions(binding, cfg);
    }

    if (cfg.pattern === "staticPdf" || cfg.pattern === "marionLat") {
      const saleDate =
        cfg.inventorySaleDate ?? new Date().toISOString().slice(0, 10);
      return (cfg.pdfUrls ?? []).map((pdfUrl, i) => ({
        countyFips: binding.countyFips,
        platform: "county_site" as const,
        saleType: (cfg.saleType ?? "Tax Deed") as "Tax Deed",
        externalId: `${binding.countyFips}|static|${i}|${saleDate}`,
        saleDate,
        // Both patterns publish standing lands-available / struck inventory
        // rather than a dated sale.
        saleDateConfirmed: false,
        listingKind: "lands_available" as const,
        title: cfg.title ?? `${cfg.countyName} County FL tax deed inventory`,
        status: "scheduled" as const,
        sourceUrl: pdfUrl,
        raw: { pattern: cfg.pattern, countyName: cfg.countyName },
      }));
    }

    let sales: SaleRef[] = [];
    if (cfg.pattern === "brevard") {
      sales = await discoverBrevardSales(cfg.indexUrl);
    }

    const upcoming = sales.filter((s) => isUpcoming(s.saleDate));
    const use = upcoming.length ? upcoming : sales.slice(0, 2);

    return use.map((s) => ({
      countyFips: binding.countyFips,
      platform: "county_site" as const,
      saleType: "Tax Deed" as const,
      externalId: `${binding.countyFips}|${s.saleDate}`,
      saleDate: s.saleDate,
      // Parsed from the clerk's own "TAX DEED SALE MM-DD-YYYY" list heading.
      saleDateConfirmed: true,
      listingKind: "sale_list" as const,
      title: `${cfg.countyName} County FL tax deed sale ${s.saleDate}`,
      status: "scheduled" as const,
      sourceUrl: s.pdfUrl,
      raw: {
        pageUrl: s.pageUrl,
        label: s.label,
        pattern: cfg.pattern,
        countyName: cfg.countyName,
      },
    }));
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const raw = auction.raw as
      | { countyName?: string; pattern?: string; lots?: DiscoveredLot[] }
      | undefined;
    const name =
      raw?.countyName ?? getCounty(auction.countyFips)?.name ?? "Florida";

    // Pre-parsed WordPress / TaxSmartWeb rows.
    if (
      (raw?.pattern === "wpTaxdeeds" || raw?.pattern === "taxSmartWeb") &&
      Array.isArray(raw.lots)
    ) {
      console.log(
        `[fl-clerks] ${auction.sourceUrl}: ${raw.pattern} → ${raw.lots.length} lot(s)`,
      );
      return raw.lots;
    }

    if (raw?.pattern === "marionLat") {
      return lotsFromMarionLat(auction.sourceUrl);
    }

    if (!/\.pdf|Files\.Serve|File_id|LandsAvailable/i.test(auction.sourceUrl)) {
      return [];
    }
    return lotsFromPdf(auction.sourceUrl, name);
  },
};
