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
import type { DiscoveredLot, ListingKind } from "./types";

/** Headers that suggest a table of parcels going to sale. */
export const PARCEL_HEADERS = /parcel|map\s*#|property|owner|defendant|bid|amount\s*due|address/i;

/** Headers that mark a table we must NOT ingest as upcoming inventory. */
export const EXCLUDE_HEADERS = /excess\s*funds|overbid|surplus|claim|sold\s*date|past\s*sale/i;

/** Link text or filenames that are never an upcoming parcel list. */
export const EXCLUDE_LINKS =
  /excess|surplus|overbid|brochure|faq|instruction|guide|kiosk|no tax sale|results|sold|water.?quality|ccr|annual.?report|budget|minutes|agenda|form\b|application|bid.?package|how.?to.?bid|terms.?and.?conditions/i;

/**
 * Pennsylvania names its three sales rather than calling any of them a tax
 * sale: upset, judicial and repository. Fayette County's list is filed as
 * "Upset-2026-Final-list", which matched none of the sale words below, so the
 * crawler ranked it as an unknown document. When it would not read, that was
 * not recorded as a failure, only as a county with no parcels.
 */
const PA_SALE = String.raw`upset.?sale|upset\b.{0,30}\blist|judicial.?sale|repository.?(?:sale|list)`;

/**
 * A list published *for a specific sale* — the only thing that is inventory.
 */
const SALE_LIST_LINK = new RegExp(
  String.raw`tax.?sale.?list|sale.?list|auction.?advert|properties.?for.?sale|sheriff.?sale|levy.?sale|lien.?sale|deed.?sale|tax.?sale|foreclos|` +
    PA_SALE,
  "i",
);

/**
 * Everyone behind on taxes. Counties publish this beside the sale list and it
 * looks identical to a parser: parcel, owner, address, amount.
 *
 * It is a superset of any eventual sale and usually 10-50x its size — most
 * owners pay before the levy. Cobb County GA publishes both on one page, and
 * scoring them alike put 2,825 delinquent taxpayers into inventory as lots
 * under a sale date that did not exist. Ranked below sale lists, and tagged
 * when it is all a county offers, rather than excluded — it is a real lead
 * list, just not one anyone should bid from.
 */
const DELINQUENT_LIST_LINK = /delinquent|tax.?roll|levy.?list|execution.?docket/i;

/** Struck-off / forfeited inventory available after a sale, not at one. */
const LANDS_AVAILABLE_LINK =
  /lands?.?available|struck.?off|forfeited.?land|county.?held|surplus.?land|flc\b/i;

/** Generic parcel-shaped documents — worth opening, kind unknown. */
const PARCEL_ISH_LINK = /parcel|booklet|list\b/i;

/**
 * The how-to, not the what.
 *
 * A county's "Tax Sale Booklet" or "Tax Sale Flyer" carries exactly the
 * vocabulary a real list does, so it scored identically and sorted first:
 * Cobb GA and Douglas GA both offered their procedure booklet ahead of every
 * other document on the page, and the adapter opens only the top three.
 *
 * Demoted to `unknown` rather than excluded — that leaves it in the queue,
 * just last, so a county that calls its only parcel list a booklet is still
 * read. A label naming a list as well ("Sale List Booklet") keeps its claim.
 */
const PROCEDURE_DOC = /booklet|flyer|pamphlet|handbook/i;

/**
 * What a link's text and filename claim the document is.
 *
 * Deliberately name-based: the county tells you in the anchor text, and reading
 * that is cheaper and far more reliable than inferring it from parsed rows,
 * where a delinquent list and a sale list are genuinely indistinguishable.
 */
export function classifyListingLink(label: string): ListingKind {
  // Before anything else: a booklet or flyer is procedure, not inventory,
  // unless it also calls itself a list.
  if (PROCEDURE_DOC.test(label) && !/\blists?\b/i.test(label)) return "unknown";
  // Order matters — "Delinquent Tax Sale List" is a sale list; "Delinquent Tax
  // List" is not. The more specific sale vocabulary wins where both appear.
  if (/sale.?list|tax.?sale.?list|auction.?advert|properties.?for.?sale/i.test(label)) {
    return "sale_list";
  }
  if (LANDS_AVAILABLE_LINK.test(label)) return "lands_available";
  if (DELINQUENT_LIST_LINK.test(label)) return "delinquent_list";
  if (SALE_LIST_LINK.test(label)) return "sale_list";
  return "unknown";
}

/** Ranking score for a candidate document link. Higher is opened first. */
function linkScore(label: string): number {
  switch (classifyListingLink(label)) {
    case "sale_list":
      return 3;
    case "lands_available":
      return 2;
    case "delinquent_list":
      // Below anything sale-shaped, above an unrecognised PDF: it is real
      // parcel data, it is simply not the sale.
      return 1;
    default:
      return PARCEL_ISH_LINK.test(label) ? 1 : 0;
  }
}

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
    /*
     * Plenty of county tables mark up their header row with `<td>` and no
     * `<th>` at all — Columbia County GA publishes twenty parcels that way and
     * a `th`-only reader saw nothing. Fall back to the first row's cells, and
     * remember its index so it is not also ingested as a parcel.
     */
    const thCells = $(table)
      .find("th")
      .map((__, th) => $(th).text().replace(/\s+/g, " ").trim())
      .get();
    const firstRow = $(table).find("tr").first();
    const headerCells = thCells.length
      ? thCells
      : firstRow
          .find("td")
          .map((__, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();
    const headerRowEl = thCells.length ? null : firstRow.get(0);

    const headerText = headerCells.join(" ");
    if (!PARCEL_HEADERS.test(headerText)) return;
    if (EXCLUDE_HEADERS.test(headerText)) return;

    const headers = headerCells.map((h) => h.toLowerCase());

    const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
    const iParcel = col(/parcel|map/);
    /*
     * CRH and DIF are Georgia's abbreviations for Current Record Holder and
     * Defendant in Fi-Fa. Both name a person, but only the record holder owns
     * the parcel — Douglas County's defendant column reads "SAME AS CRH(S)"
     * on most rows, so matching `defendant` first put that string in the owner
     * field for 172 parcels. Record holder is listed first here and appears
     * first in the table, and `findIndex` takes the earlier column.
     */
    const iOwner = col(/record.?holder|\bcrh\b|owner|defendant|\bdif\b|name/);
    const iAddr = col(/address|location|situs/);
    const iBid = col(/bid|amount|due|total/);

    if (iParcel === -1 && iOwner === -1) return;

    const rows: DiscoveredLot[] = [];
    $(table)
      .find("tr")
      .each((__, tr) => {
        if (headerRowEl && tr === headerRowEl) return;
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
 * A spreadsheet, CSV or HTML document read as the table it already is.
 *
 * `documentToText` turns a workbook into tab-separated rows and an HTML page
 * into " | "-separated ones. A list in that shape needs no model: it has a
 * header row, and `parseHtmlTable` already maps headers to fields. That is
 * free and exact, and a 5,000-row sheet sent to the model would be thirty
 * paid calls that could each drop or mistype a row.
 *
 * Sheets are read separately (a workbook's `# name` lines divide them), and
 * the header is the first row that names parcel columns, because county
 * sheets open with a title row or two. Null when nothing looks like a table.
 */
export function parseDelimitedText(text: string, sourceUrl: string): DiscoveredLot[] | null {
  let best: DiscoveredLot[] | null = null;
  for (const block of text.split(/^# .*$/m)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const sep = separatorOf(lines);
    if (!sep) continue;
    const rows = lines.map((l) => splitRow(l, sep));
    const h = rows.findIndex((r) => r.filter(Boolean).length >= 2 && PARCEL_HEADERS.test(r.join(" ")));
    if (h === -1) continue;
    const esc = (c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html =
      `<table><tr>${rows[h].map((c) => `<th>${esc(c)}</th>`).join("")}</tr>` +
      rows
        .slice(h + 1)
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
        .join("") +
      `</table>`;
    const lots = parseHtmlTable(cheerio.load(html), sourceUrl);
    if (lots?.length && (!best || lots.length > best.length)) best = lots;
  }
  return best;
}

/** Tab, " | " or comma, whichever most of the rows are split by. */
function separatorOf(lines: string[]): "\t" | " | " | "," | null {
  if (lines.length < 3) return null;
  const share = (test: (l: string) => boolean) => lines.filter(test).length / lines.length;
  if (share((l) => l.includes("\t")) >= 0.6) return "\t";
  if (share((l) => l.includes(" | ")) >= 0.6) return " | ";
  if (share((l) => (l.match(/,/g) ?? []).length >= 2) >= 0.8) return ",";
  return null;
}

/** One row's cells. Commas inside quotes stay in their cell. */
function splitRow(line: string, sep: "\t" | " | " | ","): string[] {
  if (sep !== ",") return line.split(sep).map((c) => c.trim());
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** A candidate document link, with what the county's own wording says it is. */
export interface ClassifiedPdfLink {
  url: string;
  kind: ListingKind;
}

/**
 * PDF links on the page, resolved absolute, decoys removed, ranked so a sale
 * list is always opened before a delinquent roll.
 *
 * Ranking is the whole point. Cobb County GA links both from one page; opening
 * whichever came first put the delinquent roll into inventory. The returned
 * `kind` then travels with the parsed lots so that if a county only ever
 * publishes a delinquent list, that fact survives into the database instead of
 * being flattened into "an auction".
 */
/**
 * Document routes that serve a PDF without saying so in the URL.
 *
 * `a[href*=".pdf"]` is how this file found documents, and it is why Bryan
 * County, Georgia reads as publishing nothing. Its sale list is at
 * `/home/showpublisheddocument/15816/639245484317730000` — a CivicPlus route
 * with no extension anywhere in it. CivicPlus, Granicus and Revize between
 * them run a large share of US county sites and all three serve documents by
 * id, so the extension test was not a narrow miss; it was blind to a whole
 * class of county website.
 *
 * These are candidates, not conclusions. A URL matching one of these is
 * fetched and believed only if it comes back as a PDF — see `isPdfResponse`.
 */
const DOC_ROUTE =
  /(showpublisheddocument|documentcenter\/view|\/download\b|[?&](file|doc|document)(id|_id)?=|\/media\/|attachment|viewdocument|getdocument|\/documents\/d\/|\/getmedia\/)/i;

/**
 * Documents by extension. Not only PDFs: plenty of counties post the sale list
 * as a spreadsheet or a Word file, and a crawler that followed `.pdf` links
 * alone never opened them. `documentToText` reads all of these.
 */
const DOC_EXT = /\.pdf\b|\.(xlsx|xls|csv|docx|doc)($|[?#&])/i;

/** A response is a PDF if it says so, or if its first bytes say so. */
export function isPdfResponse(contentType: string | null, head: string): boolean {
  if (/application\/pdf/i.test(contentType ?? "")) return true;
  return head.startsWith("%PDF-");
}

/**
 * Links that might be a document, whether or not the URL admits it.
 *
 * Returned in the same ranked order as `classifiedPdfLinks`, with the ones
 * that name a `.pdf` first — those need no verification, and trying them
 * before the id-routes means the common case costs no extra requests.
 */
export function documentLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): ClassifiedPdfLink[] {
  const named = classifiedPdfLinks($, pageUrl);
  const seen = new Set(named.map((l) => l.url));
  const extra: { url: string; score: number; kind: ListingKind }[] = [];

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || DOC_EXT.test(href)) return;
    if (!DOC_ROUTE.test(href)) return;
    const label = `${$(a).text()} ${href}`;
    if (EXCLUDE_LINKS.test(label)) return;
    try {
      const url = new URL(href, pageUrl).toString();
      if (seen.has(url)) return;
      seen.add(url);
      extra.push({ url, score: linkScore(label), kind: classifyListingLink(label) });
    } catch {
      /* malformed href — skip */
    }
  });

  /*
   * A document shown in a frame rather than linked: Newton County, Georgia
   * embeds its list PDF in a Google viewer, `docs.google.com/viewer?url=…`,
   * and has no link to it at all. The document's own URL is in the frame's
   * address, as `url=` or `file=`, or the frame points straight at it.
   */
  $("iframe[src], embed[src], object[data]").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data");
    if (!src) return;
    try {
      const frame = new URL(src, pageUrl);
      const inner = frame.searchParams.get("url") ?? frame.searchParams.get("file");
      const url = inner ? new URL(inner, pageUrl).toString() : frame.toString();
      if (seen.has(url) || !(DOC_EXT.test(url) || DOC_ROUTE.test(url))) return;
      seen.add(url);
      const label = `${$(el).attr("title") ?? ""} ${url}`;
      if (EXCLUDE_LINKS.test(label)) return;
      extra.push({ url, score: linkScore(label), kind: classifyListingLink(label) });
    } catch {
      /* malformed frame address — skip */
    }
  });

  extra.sort((a, b) => b.score - a.score);
  return [...named, ...extra.map((e) => ({ url: e.url, kind: e.kind }))];
}

export function classifiedPdfLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): ClassifiedPdfLink[] {
  const base = $("base[href]").attr("href");
  let resolveAgainst = pageUrl;
  if (base) {
    try {
      resolveAgainst = new URL(base, pageUrl).toString();
    } catch {
      /* malformed base — fall back to the page URL */
    }
  }

  const scored: { url: string; score: number; kind: ListingKind }[] = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || !DOC_EXT.test(href)) return;
    const label = `${$(a).text()} ${href}`;
    if (EXCLUDE_LINKS.test(label)) return;
    try {
      const url = new URL(href, resolveAgainst).toString();
      scored.push({ url, score: linkScore(label), kind: classifyListingLink(label) });
    } catch {
      /* malformed href — skip */
    }
  });

  // Same URL can appear under several anchors; keep its strongest claim.
  const best = new Map<string, { score: number; kind: ListingKind }>();
  for (const s of scored) {
    const prev = best.get(s.url);
    if (!prev || s.score > prev.score) best.set(s.url, { score: s.score, kind: s.kind });
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([url, v]) => ({ url, kind: v.kind }));
}

/** URLs only — for callers that do not care which document they got. */
export function pdfLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  return classifiedPdfLinks($, pageUrl).map((l) => l.url);
}

/** Link text that points straight at a sale list. */
const DIRECT_LINKS =
  /(tax\s*sale|delinquent|foreclos|tax\s*certificate|tax\s*lien|tax\s*deed|sheriff'?s?\s+sale|properties?\s+for\s+sale|upcoming\s+auction|land\s+sale)/i;

/**
 * Departments that might lead to the sale, ranked by who actually runs it.
 *
 * Ranking rather than document order matters more than it looks. Boulder
 * County's homepage offers five assessor links before it offers the treasurer,
 * and taking the first three found nothing — the **assessor values property,
 * the treasurer sells it**. A crawl that follows page order spends its whole
 * budget in the wrong office.
 */
const DEPARTMENT_RANKS: { term: RegExp; rank: number }[] = [
  { term: /treasurer/i, rank: 10 },
  { term: /tax\s*collector/i, rank: 10 },
  { term: /tax\s*commissioner/i, rank: 10 },
  { term: /revenue\s*commissi/i, rank: 9 },
  { term: /trustee/i, rank: 8 }, // Tennessee's collector
  { term: /property\s*(and|&)?\s*(land|tax)/i, rank: 7 },
  { term: /\btaxes?\b/i, rank: 6 },
  { term: /auditor/i, rank: 5 },
  { term: /sheriff/i, rank: 4 },
  { term: /clerk/i, rank: 3 },
  { term: /assessor/i, rank: 1 },
];

function departmentRank(hay: string): number {
  for (const { term, rank } of DEPARTMENT_RANKS) if (term.test(hay)) return rank;
  return 0;
}

/**
 * Approximate registrable domain, enough to tell "same county" from "off-site".
 *
 * Government hosts use multi-label public suffixes (`co.boulder.co.us`,
 * `dallascounty.tx.us`), so a naive last-two-labels rule collapses every county
 * in a state to `co.us` and would let a crawl wander between them. Treating
 * `.us` as needing three labels handles that without shipping a full public
 * suffix list for a same-site check.
 */
export function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const keep = parts.at(-1) === "us" ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export type LinkTier = "direct" | "department";

/**
 * Links worth following, split by how close they are to the sale list.
 *
 * Callers follow `direct` first and only spend a second hop on `department`,
 * which keeps a national crawl to a few fetches per county rather than a full
 * site walk.
 */
export function discoveryLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): { direct: string[]; department: string[] } {
  const direct: string[] = [];
  const ranked: { url: string; rank: number }[] = [];

  $("a[href]").each((_, a) => {
    const label = $(a).text().replace(/\s+/g, " ").trim();
    const href = $(a).attr("href");
    if (!href || !label || label.length > 80) return;
    const hay = `${label} ${href}`;
    if (EXCLUDE_LINKS.test(hay)) return;

    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      return;
    }
    if (abs === pageUrl || abs.endsWith(".pdf")) return;
    // Stay on the county's own estate, but by registrable domain rather than
    // exact hostname. County departments routinely live on their own subdomain —
    // Los Angeles publishes its tax sale at ttc.lacounty.gov and links there
    // from lacounty.gov — so an exact-hostname rule discards precisely the link
    // that leads to the sale while still doing its real job of keeping out
    // vendors and social media.
    try {
      if (registrableDomain(new URL(abs).hostname) !== registrableDomain(new URL(pageUrl).hostname)) {
        return;
      }
    } catch {
      return;
    }

    if (DIRECT_LINKS.test(hay)) {
      direct.push(abs);
      return;
    }
    const rank = departmentRank(hay);
    if (rank > 0) ranked.push({ url: abs, rank });
  });

  const department: string[] = [];
  const seen = new Set<string>();
  for (const { url } of ranked.sort((a, b) => b.rank - a.rank)) {
    if (seen.has(url)) continue;
    seen.add(url);
    department.push(url);
  }

  return {
    direct: [...new Set(direct)].slice(0, 5),
    department: department.slice(0, 5),
  };
}

/** Backwards-compatible single list — direct links first. */
export function listPageLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const { direct, department } = discoveryLinks($, pageUrl);
  return [...direct, ...department].slice(0, 5);
}

/**
 * The text of a county document, whatever the document turns out to be.
 * Policy-gated like every other fetch.
 *
 * This was PDF-only and never looked at the HTTP status. A dead link came back
 * as a 404 page, went to the PDF parser, and was reported as "Invalid PDF
 * structure", which reads as a broken county file rather than a moved one.
 * A list a county posts as a spreadsheet or a Word file, or serves through a
 * CMS document route that does not say what it is, failed the same way and
 * was never read. Now the response decides: a PDF is parsed as one, a
 * workbook becomes one line per row, a Word file one line per paragraph, and
 * an HTML page one line per table row. Anything else is refused by name.
 */
export async function documentToText(url: string): Promise<string> {
  const res = await politeFetchBinary(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${res.url}`);
  const type = res.contentType.toLowerCase();
  const head = new TextDecoder("latin1").decode(res.bytes.slice(0, 1024));
  const path = new URL(res.url).pathname.toLowerCase();

  if (isPdfResponse(type, head) || head.includes("%PDF-")) return pdfBytesToText(res.bytes);
  if (head.startsWith("PK")) return officeToText(res.bytes, res.url);
  if (head.startsWith("\xD0\xCF\x11\xE0")) {
    throw new Error(`${res.url} is a legacy Office file (.xls/.doc), which this does not read`);
  }
  const body = new TextDecoder("utf-8").decode(res.bytes);
  if (/html|xml/.test(type) || /^\s*</.test(body)) return htmlToText(body);
  if (/text\/|csv/.test(type) || /\.(csv|txt)$/.test(path)) return body;
  throw new Error(`${res.url} is ${type || "of no stated type"}, not a document this reads`);
}

/** The historical name. Every caller wants the text, not the format. */
export const pdfToText = documentToText;

async function pdfBytesToText(bytes: Uint8Array): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const parsed = await parser.getText();
    return parsed.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** A workbook as one tab-separated line per row, or a Word file as one line per paragraph. */
async function officeToText(bytes: Uint8Array, url: string): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  if (zip.file("xl/workbook.xml")) {
    const { readWorkbook } = await import("../import/scout-workbook");
    const lines: string[] = [];
    for (const [sheet, grid] of await readWorkbook(bytes)) {
      lines.push(`# ${sheet}`);
      for (const row of grid) {
        const cells = row.map((c) => (c ?? "").trim());
        if (cells.some(Boolean)) lines.push(cells.join("\t"));
      }
    }
    return lines.join("\n");
  }
  const doc = zip.file("word/document.xml");
  if (doc) {
    const xml = await doc.async("string");
    return cheerio
      .load(
        xml
          .replace(/<\/w:tc>/g, " | ")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:tab\/>/g, "\t"),
        { xml: true },
      )
      .root()
      .text();
  }
  throw new Error(`${url} is a zip archive that is neither a workbook nor a Word file`);
}

/** An HTML page as text, one line per table row and per block, cells split by " | ". */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer").remove();
  $("td, th").append(" | ");
  $("tr, p, div, li, br, h1, h2, h3, h4, h5, h6").append("\n");
  return $.root()
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/**
 * Deterministic parse of common sealed-bid / tax-sale PDF text layouts.
 *
 * Used *before* LLM extraction so a structured list (Charleston County SC
 * sealed-bid is the template) does not depend on API credits. Returns null
 * when the text does not look like a parcel table — callers then try the LLM
 * or record "no list".
 *
 * Charleston shape (header then rows):
 *   PIN OWNER(S) SITUSADDRESS CITY APPRAISAL ACREAGE DESCRIPTION MINIMUM BID
 *   4660800256 BUSH … NORTH CHARLESTON 12,000.00$ 0.19 905 - VAC-RES-LOT $500.00
 */
export function parseStructuredPdfText(
  text: string,
  sourceUrl: string,
): DiscoveredLot[] | null {
  const flat = text.replace(/\r/g, "\n");
  // Need a header that looks like a sale list, not a statute or FAQ.
  // "Amount" / "Opening Bid" cover GA delinquent rolls and FL clerk sale PDFs.
  const hasHeader =
    /PIN|PARCEL|MAP\s*#|ACCOUNT|Delinquent\s+Tax\s+List|Case\s*Number/i.test(flat) &&
    /(MINIMUM\s*BID|MIN\.?\s*BID|OPENING\s*BID|AMOUNT\s*DUE|TOTAL\s*DUE|APPRAISAL|ASSESSED|\bAMOUNT\b)/i.test(
      flat,
    );
  if (!hasHeader) return null;

  const lots: DiscoveredLot[] = [];

  // Collapse multi-line owner/address blocks onto the prior PIN line.
  const rawLines = flat
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const collapsed: string[] = [];
  for (const line of rawLines) {
    if (/^(?:MH)?\d{7,14}\b/i.test(line) || /PIN|OWNER|TAX SALE|AS OF|-- \d/i.test(line)) {
      collapsed.push(line);
    } else if (collapsed.length) {
      collapsed[collapsed.length - 1] += " " + line;
    }
  }

  // Also split glued single lines on PIN boundaries.
  const expanded: string[] = [];
  for (const line of collapsed) {
    const parts = line.split(/(?=\b(?:MH)?\d{7,14}\b)/);
    for (const p of parts) {
      const t = p.trim();
      if (t) expanded.push(t);
    }
  }

  const seen = new Set<string>();
  for (const line of expanded) {
    const m = line.match(/^((?:MH)?\d{7,14})\b(.*)$/i);
    if (!m) continue;
    const pin = m[1];
    const rest = m[2];
    if (/^PIN\b/i.test(line)) continue;

    // Money tokens: 12,000.00$ or $500.00
    const monies = [...rest.matchAll(/\$?\s*([\d,]+\.\d{2})\s*\$?/g)].map((x) =>
      Number(x[1].replace(/,/g, "")),
    );
    if (monies.length === 0) continue;

    // Convention: last money is minimum/opening bid; first (if distinct) is appraisal
    const openingBid = monies[monies.length - 1];
    const assessedValue =
      monies.length >= 2 && monies[0] > openingBid ? monies[0] : undefined;

    if (!Number.isFinite(openingBid) || openingBid <= 0) continue;
    if (seen.has(pin)) continue;
    seen.add(pin);

    // Owner: text after pin until first street number or money region
    const ownerMatch = rest.match(
      /^\s*([A-Z0-9][A-Z0-9 &.',/\-]{2,60}?)(?=\s+\d{1,5}\s+[A-Z]|\s+0\s+[A-Z]|\s+\$|[\d,]+\.\d{2})/i,
    );

    lots.push({
      parcelNumber: pin,
      ownerName: ownerMatch?.[1]?.trim(),
      openingBid,
      assessedValue,
      sourceUrl,
      raw: { source: "structured-pdf", line: line.slice(0, 240) },
    });
  }

  // Require a few rows so a statute PDF that mentions one account number does
  // not become fake inventory.
  if (lots.length >= 3) return lots;

  // --- Volusia FL lands available PDF ----------------------------------------
  // 9219-20 533952000070 APRIL 18, 2023 AUGUST 17, 2023 $19,493.98
  if (/LANDS\s+AVAILABLE\s+FOR\s+TAXES/i.test(flat) && /OPENING\s*BID|CERTIFICATE/i.test(flat)) {
    const volusia: DiscoveredLot[] = [];
    const re =
      /\b(\d{1,6}-\d{2})\s+(\d{10,14})\s+[A-Z]+\s+\d{1,2},\s*\d{4}\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\s+\$?\s*([\d,]+\.\d{2})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat.replace(/\s+/g, " ")))) {
      const bid = Number(m[3].replace(/,/g, ""));
      if (!Number.isFinite(bid) || bid <= 0) continue;
      volusia.push({
        lotNumber: m[1],
        parcelNumber: m[2],
        openingBid: bid,
        sourceUrl,
        raw: { source: "structured-pdf-volusia-lat" },
      });
    }
    if (volusia.length >= 3) return volusia;
  }

  // --- Brevard FL tax deed sale PDF ----------------------------------------
  // Pages 1–2: ACTIVE case# date app# parcel saleDate deposit…
  // Later pages: "Opening Bid" then a stream of bare numbers (no $) in order.
  if (/Case\s*Number|Application\s*Number/i.test(flat) && /Parcel\s*Number|Sale\s*Date/i.test(flat)) {
    const active = [
      ...flat.matchAll(
        /\bACTIVE\s+(\d{5,6})\s+\d{1,2}\/\d{1,2}\/\d{4}\s+\d{5,6}\s+(\d{5,10})\s+(\d{1,2}\/\d{1,2}\/\d{4})/gi,
      ),
    ];
    const bidSection = flat.split(/Opening\s*Bid/i)[1] ?? "";
    const bids = [...bidSection.matchAll(/\b(\d+(?:\.\d{1,2})?)\b/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n >= 100); // drop page numbers / noise
    if (active.length >= 3) {
      const brevard: DiscoveredLot[] = [];
      active.forEach((m, i) => {
        const openingBid = Number.isFinite(bids[i]) ? bids[i] : undefined;
        brevard.push({
          lotNumber: m[1],
          parcelNumber: m[2],
          openingBid,
          sourceUrl,
          raw: {
            source: "structured-pdf-brevard",
            saleDateRaw: m[3],
            bidIndex: i,
          },
        });
      });
      if (brevard.length >= 3) return brevard;
    }
  }

  // --- Cobb / GA-style delinquent list (glued single stream) ---------------
  // "Parcel ID Owner Name Address Amount … 01000100290 SCHERER … 4512 COLUMNS DR $50.57 2025"
  if (/Parcel\s*ID|Delinquent\s+Tax\s+List/i.test(flat) && /Amount/i.test(flat)) {
    const cobb: DiscoveredLot[] = [];
    const seenCobb = new Set<string>();
    // Split on 10–14 digit parcel tokens that start a record.
    const segs = flat.replace(/\s+/g, " ").split(/(?=\b\d{10,14}\b)/);
    for (const seg of segs) {
      const m = seg
        .trim()
        .match(
          /^(\d{10,14})\s+([A-Z0-9][A-Z0-9 &.',\-\/]{1,80}?)\s+(\d{1,5}\s+[^$]{2,80}?)\s+\$\s*([\d,]+\.\d{2})\b/i,
        );
      if (!m) continue;
      const parcelNumber = m[1];
      if (seenCobb.has(parcelNumber)) continue;
      const amount = Number(m[4].replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      seenCobb.add(parcelNumber);
      cobb.push({
        parcelNumber,
        ownerName: m[2].trim(),
        addressLine: m[3].replace(/\s+/g, " ").trim(),
        // Delinquent lists publish tax due; that is the usual floor for a sale.
        openingBid: amount,
        taxesOwed: amount,
        sourceUrl,
        raw: { source: "structured-pdf-delinquent", segment: seg.slice(0, 200) },
      });
    }
    if (cobb.length >= 3) return cobb;
  }

  return null;
}
