/**
 * MVBA — Texas delinquent-tax sale notices, roughly ten counties a month.
 *
 * Texas is the largest tax-deed market in the country and sells on the first
 * Tuesday of every month. `taxsales.lgbs.com` (the `tx-lgbs` adapter) is one
 * law firm; MVBA is another, publishing sale notices for a different set of
 * counties as the same public-notice function.
 *
 * `mvbalaw.com/robots.txt` disallows only `/wp-admin/` and sets
 * `Crawl-delay: 10`, which `politeFetch` honours — a full month's run is
 * therefore slow by design, not broken.
 *
 * The notices are text PDFs, so `pdfToText` alone is enough and no LLM is
 * involved. That matters: `extractLots` needs a working model, and this path
 * keeps Texas ingesting when credits are exhausted.
 *
 * ## Why the generic PDF parser is not used
 *
 * `parseStructuredPdfText` on a Bastrop notice returned 9 rows against a true
 * 17, took the *Instrument number* out of a legal description as the parcel id,
 * and read the *minimum bid* as an assessed value — which would hand the
 * max-bid engine an ARV equal to the opening bid and make every lot look like
 * a break-even. See `docs/tx-mvba-sprint.md`.
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

const BASE = "https://mvbalaw.com";
const INDEX_URL = `${BASE}/tax-sales/month-sales/`;

/** `PROPERTIES TO BE SOLD ON AUGUST 4, 2026:` — month case varies by county. */
const HEADER = /PROPERTIES TO BE SOLD ON\s+([A-Z][A-Za-z]+\s+\d{1,2},\s*\d{4})/i;
const MONEY = /\$\s?([\d,.]+)/g;

/**
 * Read a money figure, tolerating a thousands separator extracted as a period.
 *
 * Jasper's notice yields the literal text `$20.285.28` for a $20,285.28 bid —
 * the comma comes out of the PDF as a dot. A naive `\$([\d,]+(\.\d{2})?)`
 * matches `$20.28` and understates the minimum bid by a factor of a thousand,
 * which is exactly the kind of number that costs a bidder money.
 *
 * Rule: strip commas, then treat every dot except the last as a separator when
 * more than one is present. A single trailing `.dd` stays a decimal.
 */
export function parseMoney(raw: string): number | undefined {
  let s = raw.replace(/,/g, "").replace(/\.$/, "");
  const dots = (s.match(/\./g) ?? []).length;
  if (dots > 1) {
    const last = s.lastIndexOf(".");
    s = s.slice(0, last).replace(/\./g, "") + s.slice(last);
  }
  // A lone trailing group of other than two digits is not a cents field.
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  const n = m[2] && m[2].length !== 2 ? Number(m[1]) : Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

export function toIsoDate(human: string): string | undefined {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(human.trim());
  if (!m) return undefined;
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return undefined;
  return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
}

/** One sale entry: a numbered tract on the notice, keyed by suit number. */
export interface MvbaEntry {
  seq: number;
  suitNumber?: string;
  /** Assessor account numbers. A single suit can cover several tracts. */
  accounts: string[];
  /** Undefined for withdrawn lots and for "bid in trust" lots printed as TBD. */
  minBid?: number;
  withdrawn: boolean;
  /** True when the notice prints TBD rather than a figure. */
  bidToBeDetermined: boolean;
  legalDescription: string;
  defendant?: string;
}

/**
 * Isolate the property table and read the published sale date.
 *
 * Everything before `PROPERTIES TO BE SOLD ON` is boilerplate about bidder
 * registration and redemption, and it contains dollar figures and numbered
 * paragraphs that would otherwise be read as entries.
 */
export function propertyRegion(text: string): { saleDate?: string; body: string } {
  const m = HEADER.exec(text);
  if (!m) return { body: "" };
  let body = text.slice(m.index + m[0].length);
  // Drop the remainder of the header line and the column-title line.
  body = body.replace(/^[^\n]*\n/, "");
  body = body.replace(/^\s*TRACT\s+SUIT[^\n]*\n(?:[^\n]*ACCT[^\n]*\n)?/i, "");
  return { saleDate: m[1], body };
}

/**
 * Split the table into entries on the leading sequence number.
 *
 * The number must *continue the run* — 1, then 2, then 3. Position alone is
 * not enough, because legal descriptions are full of bare numbers at line
 * start ("137OF THE PLAT RECORDS", "280 OF THE DEED RECORDS"), and page
 * furniture (`-- 6 of 10 --`, a repeated column header) is interleaved
 * throughout. Requiring continuity ignores all of it.
 */
export function splitEntries(body: string): { seq: number; text: string }[] {
  const lines = body.split("\n");
  const starts: { seq: number; line: number }[] = [];
  let expect = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(\d{1,3})(?:\s+(\S.*))?$/.exec(lines[i]);
    if (!m) continue;
    if (Number(m[1]) !== expect) continue;
    starts.push({ seq: expect, line: i });
    expect++;
  }
  return starts.map((s, i) => ({
    seq: s.seq,
    text: lines.slice(s.line, starts[i + 1]?.line ?? lines.length).join("\n"),
  }));
}

export function parseEntry(seq: number, text: string): MvbaEntry {
  // "Account #215480001000000000000000001 / 52840" — some counties print an
  // internal id and the short account, slash-separated.
  const accounts = [...text.matchAll(/Account\s*#\s*([^\n$]+)/g)]
    .flatMap((m) => m[1].split("/"))
    .map((a) => a.trim().replace(/[.,;]+$/, ""))
    .filter(Boolean);

  const withdrawn = /\bwithdrawn\b/i.test(text);
  // "Bid in Trust 4/1/2025 … TBD" — struck to the taxing units, no published
  // minimum. Real inventory, so the lot is kept without a price.
  const bidToBeDetermined = /\bTBD\b/.test(text);

  let minBid: number | undefined;
  if (!withdrawn && !bidToBeDetermined) {
    // The bid terminates the entry, and legal descriptions occasionally carry
    // their own dollar figures — take the last one.
    const raw = [...text.matchAll(MONEY)].at(-1)?.[1];
    if (raw) minBid = parseMoney(raw);
  }

  const lines = text.split("\n").map((l) => l.trim());
  const suitNumber =
    /^\s*\d{1,3}\s+(\S+)/.exec(text)?.[1] ??
    (lines[1] && /^[\w./-]+$/.test(lines[1]) ? lines[1] : undefined);

  // Style reads "<Plaintiff> v\n<Defendant>"; the defendant is the owner.
  const vIdx = lines.findIndex((l) => /\bv\.?$/.test(l));
  const defendant = vIdx >= 0 ? lines[vIdx + 1]?.trim() : undefined;

  const legalDescription = text
    .replace(/^\s*\d{1,3}\s+/, "")
    .replace(/Account\s*#[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    seq,
    suitNumber,
    accounts,
    minBid,
    withdrawn,
    bidToBeDetermined,
    legalDescription,
    defendant,
  };
}

export function parseNotice(text: string): { saleDate?: string; entries: MvbaEntry[] } {
  const { saleDate, body } = propertyRegion(text);
  if (!body) return { saleDate, entries: [] };
  return { saleDate, entries: splitEntries(body).map((e) => parseEntry(e.seq, e.text)) };
}

/** Royalty and working interests are not real property the ratio applies to. */
function isMineralInterest(legal: string): boolean {
  return /\b(RI|ORRI|WI)\b|\bROYALTY\b|\bMINERAL\b|\bWELL\s+\d/i.test(legal);
}

export function entryToLot(e: MvbaEntry, sourceUrl: string): DiscoveredLot | null {
  // Withdrawn tracts are not for sale.
  if (e.withdrawn) return null;
  if (e.accounts.length === 0) return null;

  return {
    externalId: e.suitNumber ? `${e.suitNumber}|${e.accounts[0]}` : e.accounts[0],
    lotNumber: String(e.seq),
    // One lot per suit, not per tract. The sale unit in Texas is the cause:
    // a bidder buys the whole bundle for one minimum bid, so emitting a lot
    // per tract would multiply apparent inventory and misstate every price.
    parcelNumber: e.accounts[0],
    caseNumber: e.suitNumber,
    legalDescription: e.legalDescription || undefined,
    ownerName: e.defendant,
    openingBid: e.minBid,
    landUse: isMineralInterest(e.legalDescription) ? "mineral interest" : undefined,
    status: "pending" as const,
    sourceUrl,
    raw: {
      // Never dropped: the extra tracts are part of what is being sold.
      additionalAccounts: e.accounts.length > 1 ? e.accounts.slice(1) : undefined,
      bidStatus: e.bidToBeDetermined ? "TBD — bid in trust, no published minimum" : undefined,
    },
  };
}

/** A county link on the monthly index. */
interface MvbaCountyLink {
  countyName: string;
  url: string;
  saleDateIso: string;
  /** PDF notices only; online-sale links go to other platforms. */
  kind: "pdf" | "mvba-online" | "govease";
}

/**
 * Read the monthly index.
 *
 * Headings carry the published sale date — `September Tax Sales (Tuesday,
 * September 1, 2026)` — so dates come from MVBA rather than from projecting
 * Texas's first-Tuesday rule.
 */
export function parseMonthIndex(html: string): MvbaCountyLink[] {
  const $ = cheerio.load(html);
  const out: MvbaCountyLink[] = [];
  let currentDate: string | undefined;

  // Walk the document in order so each county link inherits the heading above it.
  $("*").each((_, el) => {
    const node = $(el);
    if (node.children().length === 0 || node.is("h1,h2,h3,h4,h5,p,strong,b")) {
      const t = node.text().replace(/\s+/g, " ").trim();
      const m = /Tax Sales\s*\(\s*\w+day,\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})\s*\)/i.exec(t);
      if (m) {
        const iso = toIsoDate(m[1]);
        if (iso) currentDate = iso;
      }
    }
  });

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!/County/i.test(label)) return;

    const countyName = label
      .replace(/\(.*?\)/g, "")
      .replace(/\bCounty\b.*$/i, "")
      .trim();
    if (!countyName) return;

    let kind: MvbaCountyLink["kind"] | null = null;
    if (/\/TaxUploads\/.*\.pdf$/i.test(href)) kind = "pdf";
    else if (/mvbataxsales\.com/i.test(href)) kind = "mvba-online";
    else if (/govease\.com/i.test(href)) kind = "govease";
    if (!kind) return;

    // The PDF name encodes the sale month: 0926_Eastland.pdf → 2026-09.
    const fromName = /\/(\d{2})(\d{2})_/.exec(href);
    const iso =
      fromName && currentDate
        ? `${currentDate.slice(0, 4).replace(/\d{2}$/, fromName[2])}-${fromName[1]}-${currentDate.slice(8)}`
        : currentDate;
    if (!iso) return;

    out.push({ countyName, url: new URL(href, BASE).toString(), saleDateIso: iso, kind });
  });

  return out;
}

export const mvbaAdapter: SourceAdapter = {
  name: "tx-mvba",
  platform: "mvba",
  description:
    "MVBA Law delinquent-tax sale notices for Texas counties (first Tuesday " +
    "monthly). Text PDFs parsed without an LLM.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const res = await politeFetch(INDEX_URL, { timeoutMs: 45_000 });
    if (res.status !== 200) {
      console.warn(`[tx-mvba] index returned ${res.status}`);
      return [];
    }

    const today = new Date().toISOString().slice(0, 10);
    const links = parseMonthIndex(res.body).filter((l) => l.saleDateIso >= today);

    const byFips = new Map<string, CountyBinding>();
    for (const l of links) {
      if (l.kind !== "pdf") {
        // Online sales live on platforms with their own adapters. McLennan
        // routes to GovEase; ingesting it here would double-count it.
        console.warn(`[tx-mvba] ${l.countyName}: ${l.kind} sale, skipped (other adapter)`);
        continue;
      }
      const county = findCountyByName("TX", l.countyName);
      if (!county) {
        console.warn(`[tx-mvba] unmatched county: ${l.countyName}`);
        continue;
      }
      const existing = byFips.get(county.fips);
      const list = (existing?.config.links as MvbaCountyLink[] | undefined) ?? [];
      list.push(l);
      byFips.set(county.fips, {
        countyFips: county.fips,
        config: { countyName: county.name, links: list },
      });
    }
    return [...byFips.values()];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const cfg = binding.config as unknown as {
      countyName: string;
      links: MvbaCountyLink[];
    };
    return cfg.links.map((l) => ({
      countyFips: binding.countyFips,
      platform: "mvba" as const,
      // Texas conveys a sheriff's deed subject to a statutory redemption right.
      saleType: "Redeemable Deed" as const,
      externalId: `mvba|${binding.countyFips}|${l.saleDateIso}`,
      saleDate: l.saleDateIso,
      // The index heading states the date; it is not projected.
      saleDateConfirmed: true,
      listingKind: "sale_list" as const,
      title: `${cfg.countyName} County TX — delinquent tax sale`,
      status: "scheduled" as const,
      sourceUrl: l.url,
      raw: { countyName: cfg.countyName, kind: l.kind },
    }));
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const text = await pdfToText(auction.sourceUrl);
    const { saleDate, entries } = parseNotice(text);
    if (entries.length === 0) {
      console.warn(`[tx-mvba] no entries parsed from ${auction.sourceUrl}`);
      return [];
    }

    // The notice states its own sale date. Disagreeing with the index means
    // one of them is stale, and shipping the wrong auction date is worse than
    // shipping none — a bidder who turns up on the wrong day has lost.
    const noticeIso = saleDate ? toIsoDate(saleDate) : undefined;
    if (noticeIso && noticeIso !== auction.saleDate) {
      console.warn(
        `[tx-mvba] ${auction.sourceUrl}: notice says ${noticeIso}, index said ${auction.saleDate} — using the notice`,
      );
      auction.saleDate = noticeIso;
    }

    const lots = entries
      .map((e) => entryToLot(e, auction.sourceUrl))
      .filter((l): l is DiscoveredLot => l !== null);

    const withdrawn = entries.filter((e) => e.withdrawn).length;
    const tbd = entries.filter((e) => e.bidToBeDetermined && !e.withdrawn).length;
    if (withdrawn || tbd) {
      console.warn(
        `[tx-mvba] ${auction.title}: ${lots.length} lot(s), ${withdrawn} withdrawn, ${tbd} bid-in-trust (TBD)`,
      );
    }
    return lots;
  },
};
