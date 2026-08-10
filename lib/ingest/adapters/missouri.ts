/**
 * Missouri county collectors — the statutory tax certificate notice.
 *
 * Missouri sells tax *certificates*, not deeds: RSMo Chapter 140 requires the
 * collector to publish a notice of the lands to be offered, and that notice is
 * the sale list. It carries the one thing the generic crawler could not get.
 *
 * Franklin County is the county this was written against, and it is worth
 * recording exactly what the generic path got wrong there, because both errors
 * are the kind that look like success:
 *
 *   The date was invented. `nextSaleWindows` projected 2026-08-16 from
 *   Missouri's typical schedule. The notice says "Beginning Monday August 24,
 *   2026" — eight days out. A bidder trusting the projection would have
 *   travelled to Union, Missouri on the wrong Monday. This adapter reads the
 *   date off the notice and only then sets `saleDateConfirmed`.
 *
 *   The list was 89% short. The generic table scrape found 57 parcels; the
 *   notice contains 501, totalling $1,125,797 in taxes owed. Each parcel is a
 *   block of lines rather than a table row, so anything looking for <tr> or
 *   for a fixed column layout sees a fraction of it and reports success.
 *
 * The parcel block is regular:
 *
 *   03-1-02.0-3-001-023.000     parcel number
 *   BARTON,NATHAN E             owner
 *   Sec 02 Twn 45 Rng 4W        legal description, one or more lines
 *   LOT:1&10 ZEILMANN ADDITION
 *   Year Amount                 the per-year table
 *   2023 1856.72
 *   2024 1508.89
 *   2025 1324.14
 *   Total 4689.75               the statutory minimum bid
 *
 * Segmentation anchors on `Year Amount` … `Total`, not on the parcel-number
 * format, because parcel numbering is a county-by-county convention in Missouri
 * and the money table is not.
 */

import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import { pdfToText } from "../parse";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

/**
 * Counties known to publish this notice format.
 *
 * Deliberately a list rather than a pattern. Missouri has 114 counties and
 * this is one vendor's layout; adding a county means reading its notice first,
 * not guessing that it matches.
 */
const COUNTIES: { countyFips: string; name: string; page: string }[] = [
  { countyFips: "29071", name: "Franklin", page: "https://www.franklinmo.org/collector" },
];

/** Link text that means "this year's sale list", not last year's or a form. */
const SALE_LIST_LINK = /tax\s*sale\s*list/i;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "August 24, 2026" → "2026-08-24". */
export function parseNoticeDate(input: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(input);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  const day = Number(m[2]);
  if (month === 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface NoticeHeader {
  /** YYYY-MM-DD, read off the notice. Null when it does not say. */
  saleDate: string | null;
  startTime?: string;
  location?: string;
}

/**
 * The sale date, from the notice's own sentence.
 *
 * Two phrasings carry it — the "Beginning <weekday> <date>" opening and the
 * collector's "Dated this <n> day of <month>, <year>" attestation. The opening
 * is preferred; the attestation is the fallback and has been seen to agree.
 */
export function parseNoticeHeader(text: string): NoticeHeader {
  const beginning = /Beginning\s+\w+day\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i.exec(text);
  const dated = /Dated this\s+(\d{1,2})\s+day of\s+([A-Za-z]+),\s*(\d{4})/i.exec(text);

  let saleDate: string | null = null;
  if (beginning) saleDate = parseNoticeDate(beginning[1]);
  else if (dated) saleDate = parseNoticeDate(`${dated[2]} ${dated[1]}, ${dated[3]}`);

  const time = /at\s+(\d{1,2}:\d{2}(?::\d{2})?)/.exec(text);
  const loc = /offered for sale in\s+([^.]{10,160}?)\.\s/i.exec(text);

  return {
    saleDate,
    startTime: time?.[1],
    location: loc?.[1].replace(/\s+/g, " ").trim(),
  };
}

/** Lines that are page furniture, never part of a parcel. */
const FURNITURE =
  /^(Task#|\d{2}-\d{2}-\d{4}$|\d{2}:\d{2}:\d{2}$|NOTICE OF TAX|I,\s|foregoing is a true|Dated this|The following is|are to be offered|Union Mo|indicated by the|The lands|due for each year|the certificates|discharge the total|and mining rights to be offered)/i;

/**
 * Parcels in one notice.
 *
 * Walks `Total` lines backwards to their `Year Amount` header, and takes the
 * lines above that — skipping page furniture — as parcel number, owner and
 * legal description.
 */
export function parseNotice(text: string, sourceUrl: string): DiscoveredLot[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const lots: DiscoveredLot[] = [];

  for (const [i, line] of lines.entries()) {
    const total = /^Total\s+([\d,]+\.\d{2})$/.exec(line);
    if (!total) continue;

    // Back up to the money table's header.
    let head = -1;
    for (let j = i - 1; j >= 0 && i - j < 30; j--) {
      if (/^Year\s+Amount$/i.test(lines[j])) {
        head = j;
        break;
      }
    }
    if (head < 0) continue;

    // Above the header: parcel number, owner, then legal description lines.
    const block: string[] = [];
    for (let j = head - 1; j >= 0 && head - j < 12; j--) {
      const l = lines[j];
      if (!l) break;
      if (FURNITURE.test(l)) break;
      if (/^Total\s+[\d,]+\.\d{2}$/.test(l)) break; // ran into the previous parcel
      block.unshift(l);
    }
    if (block.length < 2) continue;

    const [parcelNumber, ownerName, ...legal] = block;
    const openingBid = Number(total[1].replace(/,/g, ""));

    const years: Record<string, number> = {};
    for (let j = head + 1; j < i; j++) {
      const y = /^(\d{4})\s+([\d,]+\.\d{2})$/.exec(lines[j]);
      if (y) years[y[1]] = Number(y[2].replace(/,/g, ""));
    }

    lots.push({
      externalId: parcelNumber,
      parcelNumber,
      ownerName,
      legalDescription: legal.filter((l) => l !== "NONE").join(" ") || undefined,
      /*
       * RSMo 140: the published figure is taxes, interest and the cost of sale
       * — the statutory minimum bid. It is not an assessed or market value,
       * and must never be read as one.
       */
      openingBid: Number.isFinite(openingBid) ? openingBid : undefined,
      taxesOwed: Number.isFinite(openingBid) ? openingBid : undefined,
      status: "pending" as const,
      sourceUrl,
      raw: { yearsOwed: years },
    });
  }

  return lots;
}

/** The current sale-list PDF linked from a collector's page. */
export function findSaleListPdf(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $("a[href]").each((_, el) => {
    if (found) return;
    const href = $(el).attr("href");
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || !/\.pdf(\?|$)/i.test(href)) return;
    if (!SALE_LIST_LINK.test(text) && !SALE_LIST_LINK.test(href)) return;
    found = new URL(href, pageUrl).toString();
  });
  return found;
}

/** Notice text is read twice — header then parcels — so share the fetch. */
const cache = new Map<string, Promise<string>>();
function noticeText(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = pdfToText(url);
  cache.set(url, p);
  return p;
}

export const missouriCollectorAdapter: SourceAdapter = {
  name: "mo-collector",
  platform: "county_site",
  description:
    "Missouri county collectors' statutory notice of tax certificate sale (RSMo Ch. 140). " +
    "The notice carries the sale date and every parcel offered.",

  async discoverCounties(): Promise<CountyBinding[]> {
    return COUNTIES.map((c) => ({ countyFips: c.countyFips, config: { ...c } }));
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const cfg = binding.config as { name: string; page: string };
    const res = await politeFetch(cfg.page);
    const pdf = findSaleListPdf(res.body, cfg.page);
    if (!pdf) return [];

    const header = parseNoticeHeader(await noticeText(pdf));
    // No date on the notice means no auction. Projecting one is what put this
    // county eight days wrong in the first place.
    if (!header.saleDate) return [];

    return [
      {
        countyFips: binding.countyFips,
        platform: "county_site",
        // Missouri sells certificates with a one-year redemption (RSMo 140),
        // not deeds. The buyer petitions for a collector's deed afterwards.
        saleType: "Tax Lien",
        externalId: `mo-collector:${binding.countyFips}:${header.saleDate}`,
        saleDate: header.saleDate,
        saleDateConfirmed: true,
        listingKind: "sale_list",
        startTime: header.startTime,
        title: `${cfg.name} County tax certificate sale`,
        status: "scheduled",
        sourceUrl: pdf,
        raw: { collectorPage: cfg.page, location: header.location },
      },
    ];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    return parseNotice(await noticeText(auction.sourceUrl), auction.sourceUrl);
  },
};
