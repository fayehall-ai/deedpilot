/**
 * Shared parsers for county sale pages.
 *
 * Extracted from the Georgia adapter so the generic adapter uses the same
 * implementation rather than a copy that drifts. The interesting logic here is
 * not the table walking — it is the exclusions, each of which exists because a
 * real county page would otherwise have produced wrong inventory:
 *
 * - Excess-funds tables list *past* sales and the surplus owed to former
 *   owners. Ingesting one publishes sold parcels as upcoming auctions.
 * - Counties link a literal "there are no tax sale parcels at this time" PDF,
 *   which an extractor will happily read as an empty-but-valid list.
 * - Brochures and FAQs explain the process and contain no parcels at all, but
 *   cost a full LLM extraction to discover that.
 */

import * as cheerio from "cheerio";
import { politeFetchBinary } from "./fetch";
import { parseMoney } from "./judge";
import type { DiscoveredLot } from "./types";

/** Headers that suggest a table of parcels going to sale. */
export const PARCEL_HEADERS = /parcel|map\s*#|property|owner|defendant|bid|amount\s*due|address/i;

/** Headers that mark a table we must NOT ingest as upcoming inventory. */
export const EXCLUDE_HEADERS = /excess\s*funds|overbid|surplus|claim|sold\s*date|past\s*sale/i;

/** Link text or filenames that are never an upcoming parcel list. */
export const EXCLUDE_LINKS =
  /excess|surplus|overbid|brochure|faq|instruction|guide|kiosk|no tax sale|results|sold/i;

/**
 * Best parcel table on the page, or null.
 *
 * "Best" is the largest qualifying table: county pages often carry a small
 * summary table above the real list, and the real list is the long one.
 */
export function parseHtmlTable(
  $: cheerio.CheerioAPI,
  sourceUrl: string,
): DiscoveredLot[] | null {
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

/** PDF links on the page, resolved absolute, with the known decoys removed. */
export function pdfLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
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
    if (EXCLUDE_LINKS.test(`${$(a).text()} ${href}`)) return;
    try {
      out.push(new URL(href, resolveAgainst).toString());
    } catch {
      /* malformed href — skip */
    }
  });
  return [...new Set(out)];
}

/**
 * Links that look like they lead to the actual sale list.
 *
 * Many county landing pages carry no parcels themselves and link to a
 * "Current Tax Sale List" page. Following one hop finds those without a
 * per-county rule for every jurisdiction in the country.
 */
export function listPageLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const out: string[] = [];
  $("a[href]").each((_, a) => {
    const label = $(a).text().replace(/\s+/g, " ").trim();
    const href = $(a).attr("href");
    if (!href || !label) return;
    if (EXCLUDE_LINKS.test(`${label} ${href}`)) return;
    if (!/(tax\s*sale|delinquent|auction|parcel|properties?\s+for\s+sale|upcoming)/i.test(label)) {
      return;
    }
    try {
      const abs = new URL(href, pageUrl).toString();
      if (abs !== pageUrl && !abs.endsWith(".pdf")) out.push(abs);
    } catch {
      /* malformed href — skip */
    }
  });
  return [...new Set(out)].slice(0, 5);
}

/** Extract text from a PDF at `url`. Policy-gated like every other fetch. */
export async function pdfToText(url: string): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const res = await politeFetchBinary(url);
  const parser = new PDFParse({ data: res.bytes });
  try {
    const parsed = await parser.getText();
    return parsed.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}
