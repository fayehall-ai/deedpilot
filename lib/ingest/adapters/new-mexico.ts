/**
 * New Mexico Property Tax Division — the whole state from one government page.
 *
 * New Mexico centralises the way Arkansas does, but at the state rather than
 * the county: after three years of delinquency a property is transferred to
 * the Taxation and Revenue Department, and the Property Tax Division sells it
 * at public auction under NMSA 1978 § 7-38-65. Counties do not run these
 * sales, so one page covers all 33:
 *
 *   /businesses/property-tax-overview/delinquent-property-tax-auctions/
 *       a County | Date of Sale | PDF table of upcoming auctions
 *   AuctionAdvertisement-<County>.pdf
 *       the statutory notice — venue, time, and every parcel offered
 *
 * `www.tax.newmexico.gov/robots.txt` is `User-agent: * / Disallow:` — an empty
 * Disallow, which permits everything — and the host is the state government's
 * own. This is the source of record, not a platform reprinting it.
 *
 * Two properties of the source cost real time to establish and are worth
 * recording so the next person does not rediscover them.
 *
 * The index is not a table. It renders as one, but it is a sequence of <p>
 * elements inside a Divi text module, so anything looking for <tr> finds an
 * empty document — the same trap as the Arkansas sale page.
 *
 * The PDF's item numbering cannot be used to segment parcels. The notice lays
 * out in columns, so `Item #4 … Item #7` are emitted as four consecutive
 * header stubs and only then are their four parcel blocks emitted. Segmenting
 * on `Item #` therefore attributes parcel data to the wrong item and drops
 * three of every four in that run. The `Case:` line is the reliable unit, and
 * across all seven live notices `Case:` count equals `Item #` count equals
 * `UPC:` count equals `Minimum Bid:` count exactly (510 of each).
 */

import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import { pdfToText } from "../parse";
import { findCountyByName } from "../../atlas";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const INDEX_URL =
  "https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/";

/** One row of the index: a county, a date, and the notice that governs it. */
interface NmSale {
  countyFips: string;
  countyName: string;
  /** YYYY-MM-DD as advertised on the index page. */
  saleDate: string;
  /** e.g. "10:00AM", as printed. Absent when the row omits it. */
  startTime?: string;
  pdfUrl: string;
}

/**
 * Notice text is read twice — once for the header, once for the parcels — and
 * these are 300KB-plus documents behind a rate-limited government host, so the
 * fetch is shared. Cleared per process; a fresh ingest run re-reads everything.
 */
const pdfCache = new Map<string, Promise<string>>();

function noticeText(url: string): Promise<string> {
  const hit = pdfCache.get(url);
  if (hit) return hit;
  const p = pdfToText(url);
  pdfCache.set(url, p);
  return p;
}

/** "08/13/2026" → "2026-08-13". Returns null on anything else. */
export function parseUsDate(input: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!m) return null;
  const [, mo, d, y] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * "Thursday, August 13, 2026" → "2026-08-13".
 *
 * The notice spells the date out; the index prints it numerically. Parsing
 * both lets one check the other, which is the point — see `listAuctions`.
 */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

export function parseLongDate(input: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(input.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  if (month === 0) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Rows of the upcoming-auction index.
 *
 * Anchored on the PDF links rather than on the text, because the county name
 * and date live in the same <p> as the link but the markup around them varies
 * — some rows wrap the whole line in a <span>, some do not.
 */
export function parseIndex(html: string, pageUrl: string): NmSale[] {
  const $ = cheerio.load(html);
  const sales: NmSale[] = [];
  const seen = new Set<string>();

  $("a[href$='.pdf']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = new URL(href, pageUrl).toString();
    // Terms of sale and the letter-of-guarantee example live on the same page.
    if (!/AuctionAdvertisement/i.test(url)) return;

    const line = $(el).closest("p").text().replace(/\s+/g, " ").trim();
    const dateMatch = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(line);
    if (!dateMatch) return;
    const saleDate = parseUsDate(dateMatch[1]);
    if (!saleDate) return;

    // The county is whatever precedes the date, minus the "County" noun.
    const namePart = line.slice(0, dateMatch.index).replace(/county\s*$/i, "").trim();
    if (!namePart) return;
    const county = findCountyByName("NM", namePart);
    if (!county) return;

    const timeMatch = /@\s*([\d:]+\s*[AP]\.?M\.?)/i.exec(line);

    // Sandoval sells on consecutive days from two separate notices, so the
    // key has to be county *and* date — a county alone would drop one.
    const key = `${county.fips}:${saleDate}`;
    if (seen.has(key)) return;
    seen.add(key);

    sales.push({
      countyFips: county.fips,
      countyName: county.name,
      saleDate,
      startTime: timeMatch?.[1].replace(/\s+/g, ""),
      pdfUrl: url,
    });
  });

  return sales;
}

export interface NmNoticeHeader {
  saleDate: string | null;
  startTime?: string;
  location?: string;
  county?: string;
}

/** DATE / TIME / LOCATION off the front of the statutory notice. */
export function parseNoticeHeader(text: string): NmNoticeHeader {
  const date = /^\s*DATE:\s*(.+)$/m.exec(text);
  const time = /^\s*TIME:\s*(.+)$/m.exec(text);
  const loc = /^\s*LOCATION:\s*(.+)$/m.exec(text);
  const county = /public auction,?\s+in\s+(.+?)\s+County/i.exec(text);
  return {
    saleDate: date ? parseLongDate(date[1]) : null,
    startTime: time?.[1].trim(),
    location: loc?.[1].trim(),
    county: county?.[1].trim(),
  };
}

/**
 * Parcels in one notice.
 *
 * Segments on `Case:` for the column-layout reason in the module header. A
 * parcel whose case line carries a trailing marker — `Case: 17201 REMOVED` —
 * has been pulled from the sale and is returned with a non-pending status;
 * `listLots` drops those so they cannot be counted as inventory.
 */
export interface NmParcel extends DiscoveredLot {
  /** Verbatim marker after the case number, when the notice carries one. */
  removalMarker?: string;
}

const FIELD = (label: string) => new RegExp(`^\\s*${label}:\\s*(.*)$`, "i");
const CASE_LINE = /^\s*Case:\s*(\S+)\s*(.*)$/i;
/** Layout furniture and page rules that interrupt a parcel block. */
const NOT_DESCRIPTION = /^\s*(Item\s*#|Bidder\s*#|Amount\s*\$|--\s*\d+\s*of\s*\d+\s*--|Case:)/i;

export function parseNotice(text: string, sourceUrl: string): NmParcel[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  for (const [i, line] of lines.entries()) if (CASE_LINE.test(line)) starts.push(i);

  const parcels: NmParcel[] = [];
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? lines.length;
    const block = lines.slice(start, end);

    const caseMatch = CASE_LINE.exec(block[0])!;
    const caseNumber = caseMatch[1].trim();
    const removalMarker = caseMatch[2].trim() || undefined;

    const field = (label: string): string | undefined => {
      const re = FIELD(label);
      for (const l of block) {
        const m = re.exec(l);
        if (m) return m[1].trim() || undefined;
      }
      return undefined;
    };

    // The legal description wraps, so it runs from its label to the next piece
    // of layout furniture rather than to the end of its own line.
    let legal: string | undefined;
    const descIdx = block.findIndex((l) => FIELD("Property Description").test(l));
    if (descIdx >= 0) {
      const parts = [FIELD("Property Description").exec(block[descIdx])![1].trim()];
      for (const l of block.slice(descIdx + 1)) {
        if (!l.trim() || NOT_DESCRIPTION.test(l)) break;
        parts.push(l.trim());
      }
      legal = parts.join(" ").replace(/\s+/g, " ").trim() || undefined;
    }

    const bidRaw = field("Minimum Bid");
    const bid = bidRaw ? Number(bidRaw.replace(/[$,]/g, "")) : undefined;

    parcels.push({
      // Case numbers are the notice's own identifier and survive a UPC the
      // county mangled, so identity never depends on the parcel number alone.
      externalId: `case-${caseNumber}`,
      caseNumber,
      parcelNumber: field("UPC"),
      ownerName: field("Delinquent Owner"),
      legalDescription: legal,
      openingBid: Number.isFinite(bid) ? bid : undefined,
      status: removalMarker ? ("withdrawn" as const) : ("pending" as const),
      removalMarker,
      sourceUrl,
      raw: {
        account: field("Account"),
        // Deliberately not `addressLine`. "OFF COUNTRY CLUB DR IN RUIDOSO" is
        // a way to find the parcel on the ground, not a postal address, and
        // handing it to a geocoder returns either nothing or the wrong house.
        // The UPC is the join key; this is for a human reading the listing.
        simpleDescription: field("Simple Description"),
        removalMarker,
      },
    });
  }

  return parcels;
}

export const newMexicoPtdAdapter: SourceAdapter = {
  name: "nm-ptd",
  // The notice gives a physical venue and bidders register with an auctioneer
  // on the day; there is no online bidding to point a subscriber at.
  platform: "in_person",
  description:
    "New Mexico Taxation and Revenue Department, Property Tax Division — statewide delinquent " +
    "property tax auctions (NMSA 1978 § 7-38-65). One state page lists every upcoming county " +
    "sale with its statutory notice PDF.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const res = await politeFetch(INDEX_URL);
    const sales = parseIndex(res.body, INDEX_URL);

    // A county can hold more than one sale (Sandoval runs back-to-back days),
    // so bindings are per county and carry every sale that county has.
    const byCounty = new Map<string, NmSale[]>();
    for (const s of sales) {
      const list = byCounty.get(s.countyFips);
      if (list) list.push(s);
      else byCounty.set(s.countyFips, [s]);
    }

    return [...byCounty.entries()].map(([countyFips, countySales]) => ({
      countyFips,
      config: { sales: countySales },
    }));
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const sales = (binding.config.sales ?? []) as NmSale[];
    const out: DiscoveredAuction[] = [];

    for (const sale of sales) {
      // The notice is the legal publication; the index is a summary of it. On
      // the rare occasion they disagree the notice wins, and the disagreement
      // is recorded rather than smoothed over — a date that moved is exactly
      // what a bidder needs to know, and a silent correction hides a source
      // that has started drifting.
      let header: NmNoticeHeader | null = null;
      try {
        header = parseNoticeHeader(await noticeText(sale.pdfUrl));
      } catch {
        // Notice unreadable: fall back to the index, which is still a date the
        // state published — not a projection.
      }

      const saleDate = header?.saleDate ?? sale.saleDate;
      const mismatch =
        header?.saleDate && header.saleDate !== sale.saleDate
          ? { indexDate: sale.saleDate, noticeDate: header.saleDate }
          : undefined;

      /*
       * The same rule, applied to the county — which is where it was actually
       * needed.
       *
       * The index infers a county from the anchor text beside each link. That
       * holds while the link names one (`AuctionAdvertisement-Lincoln.pdf` under
       * "Lincoln County") and fails silently when it does not. The 2026 notice
       * published as `AuctionAdvertisement-22-2.pdf` names no county at all, was
       * listed under two, and so had its 93 Albuquerque parcels ingested twice:
       * once as Bernalillo, which is right, and once as Catron, which is a
       * different corner of the state. 186 rows for 93 parcels, and nothing in
       * the data said which copy to believe.
       *
       * The notice states its own county in the statutory phrase "public auction,
       * in X County". That string was already parsed and already stored in
       * `raw.noticeCounty` — it was simply never read. Reading it collapses the
       * duplicate at the source rather than de-duplicating downstream, because
       * `externalId` is keyed on FIPS: both bindings now resolve to the same id
       * and upsert onto one auction.
       */
      const noticeCounty = header?.county ? findCountyByName("NM", header.county) : null;
      const countyFips = noticeCounty?.fips ?? sale.countyFips;
      const countyName = noticeCounty?.name ?? sale.countyName;
      const countyMismatch =
        noticeCounty && noticeCounty.fips !== sale.countyFips
          ? { indexCounty: sale.countyName, noticeCounty: noticeCounty.name, pdf: sale.pdfUrl }
          : undefined;

      out.push({
        countyFips,
        platform: "in_person",
        // NMSA 1978 § 7-38-67: a properly made sale extinguishes the tax lien
        // and conveys by deed. There is no post-sale redemption to price, so
        // this is a deed sale, not a redeemable one.
        saleType: "Tax Deed",
        externalId: `nm-ptd:${countyFips}:${saleDate}`,
        saleDate,
        // The state published this date on both the index and the notice.
        // Nothing here comes from projecting a typical schedule.
        saleDateConfirmed: true,
        listingKind: "sale_list",
        startTime: header?.startTime ?? sale.startTime,
        title: `${countyName} County delinquent property tax auction`,
        status: "scheduled",
        sourceUrl: sale.pdfUrl,
        raw: {
          indexUrl: INDEX_URL,
          location: header?.location,
          noticeCounty: header?.county,
          ...(mismatch ? { saleDateMismatch: mismatch } : {}),
          ...(countyMismatch ? { countyMismatch } : {}),
        },
      });
    }

    return out;
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const parcels = parseNotice(await noticeText(auction.sourceUrl), auction.sourceUrl);

    // Withdrawn parcels are published but not biddable, and 13% of the current
    // notices carry the marker. Persisting them would inflate `lot_count`,
    // which is the figure the calendar and the coverage scoreboard both treat
    // as inventory a subscriber can act on. Dropped here, the same way the
    // Florida clerk adapter drops non-pending rows.
    // `pending` implies no removal marker by construction in `parseNotice`,
    // so the surviving records carry nothing extra to strip.
    return parcels.filter((p) => p.status === "pending");
  },
};
