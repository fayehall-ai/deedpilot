/**
 * Results crawler — the only thing that widens the price model.
 *
 * The clearing-price model trains on 2 states because only Michigan and
 * California contribute rows whose recorded price is a competitive dollar
 * amount. Everything else in the corpus is either a bid-down tax figure
 * (Illinois), a premium bid (Maryland), or quarantined junk. Widening it is not
 * a modelling problem; it needs *more counties that publish what their auctions
 * cleared at*.
 *
 * This crawls the `results`-kind sources the Prospector found, extracts sold
 * prices, and emits candidate rows. It deliberately stops short of writing them:
 * the Archivist admits rows only from sources with a stated label rule, and the
 * whole reason that rule exists is that a price column means different things in
 * different states. A crawler that could self-certify its own output would walk
 * straight back into the bug this system was built to prevent.
 *
 * So the output is a JSONL batch plus a **label-rule report** naming every
 * source that needs a semantics decision before its rows can be fitted on.
 */

import * as cheerio from "cheerio";
import { getCounty, resolveCountyRule, toSaleType } from "../atlas";
import { politeFetch } from "../ingest/fetch";
import { parseMoney } from "../ingest/judge";
import { EXCLUDE_HEADERS, pdfLinks, pdfToText } from "../ingest/parse";
import type { SourceRegistry, VerifiedSource } from "../prospector/types";

/** A recorded past sale, shaped for the Python corpus. */
export interface OutcomeCandidate {
  id: string;
  state: string;
  fips: string;
  county_name: string;
  sale_type: string;
  sale_date: string | null;
  opening_bid: number | null;
  winning_bid: number | null;
  assessed_value: number | null;
  redeemed: boolean;
  ownership_taken: boolean;
  provenance: "recorded";
  source: string;
  notes: string;
}

export interface CrawlReport {
  sourcesTried: number;
  sourcesYielding: number;
  rows: OutcomeCandidate[];
  /** Hosts producing rows that `labels.py` has no rule for yet. */
  needsLabelRule: {
    host: string;
    state: string;
    sampleUrl: string;
    rows: number;
    medianWinningBid: number | null;
    medianOpeningRatio: number | null;
    /** What a reviewer must decide before these rows can be fitted on. */
    question: string;
  }[];
  skipped: { url: string; reason: string }[];
}

/** Columns whose header marks a sold price rather than an asking price. */
const SOLD_HEADERS = /sold|winning|purchase|bid\s*amount|sale\s*price|high\s*bid|struck/i;
const OPENING_HEADERS = /minimum|opening|upset|starting|due|owed|judgment/i;
const DATE_HEADERS = /date|sale\s*date|sold\s*on/i;
const PARCEL_HEADERS_R = /parcel|pin|apn|property\s*id|account|map/i;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function normDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/**
 * Parse a results table.
 *
 * Requires a *sold* price column specifically. A table of minimum bids is an
 * upcoming listing, not a result, and ingesting one as history would teach the
 * price model that auctions clear at their reserve.
 */
export function parseResultsTable(
  $: cheerio.CheerioAPI,
  sourceUrl: string,
): { winning: number; opening: number | null; date: string | null; parcel: string | null }[] {
  const out: { winning: number; opening: number | null; date: string | null; parcel: string | null }[] = [];

  $("table").each((_, table) => {
    const headerText = $(table).find("th").text().replace(/\s+/g, " ");
    if (!SOLD_HEADERS.test(headerText)) return;
    // "Excess funds" tables also carry sold prices but are about surplus owed to
    // the former owner, and their money column is not the clearing price.
    if (EXCLUDE_HEADERS.test(headerText) && !/sold/i.test(headerText)) return;

    const headers = $(table)
      .find("th")
      .map((__, th) => $(th).text().replace(/\s+/g, " ").trim().toLowerCase())
      .get();
    const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
    const iSold = col(SOLD_HEADERS);
    if (iSold === -1) return;
    const iOpen = col(OPENING_HEADERS);
    const iDate = col(DATE_HEADERS);
    const iParcel = col(PARCEL_HEADERS_R);

    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr)
          .find("td")
          .map((___, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();
        if (!cells.length) return;
        const winning = parseMoney(cells[iSold] ?? "");
        if (winning === undefined || winning <= 0) return;
        out.push({
          winning,
          opening: iOpen >= 0 ? (parseMoney(cells[iOpen] ?? "") ?? null) : null,
          date: iDate >= 0 ? normDate(cells[iDate]) : null,
          parcel: iParcel >= 0 ? cells[iParcel] || null : null,
        });
      });
  });

  return out;
}

function hashId(...parts: (string | number | null)[]): string {
  const s = parts.join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8, "0");
}

async function crawlSource(
  source: VerifiedSource,
  countyName: string,
): Promise<OutcomeCandidate[]> {
  const res = await politeFetch(source.url, { attempts: 2, timeoutMs: 25_000 });
  const $ = cheerio.load(res.body);
  let parsed = parseResultsTable($, source.url);

  // Many counties publish results only as a PDF "final report of sale".
  if (!parsed.length) {
    for (const pdf of pdfLinks($, source.url).slice(0, 2)) {
      try {
        const text = await pdfToText(pdf);
        // Cheap structural read: lines carrying a parcel token and a dollar
        // figure. Deliberately not an LLM call — a results PDF that needs one
        // is better handled by the Archivist path with a stated label rule.
        for (const line of text.split(/\r?\n/)) {
          const money = /\$\s?([\d,]+(?:\.\d{2})?)/.exec(line);
          const parcel = /\b[\dA-Z]{2,}[-.][\dA-Z-.]{4,}\b/.exec(line);
          if (!money || !parcel) continue;
          const v = Number(money[1].replace(/,/g, ""));
          if (Number.isFinite(v) && v > 0) {
            parsed.push({ winning: v, opening: null, date: null, parcel: parcel[0] });
          }
        }
        if (parsed.length) break;
      } catch {
        /* unreadable PDF — try the next */
      }
    }
  }

  const county = getCounty(source.fips);
  const rule = county ? resolveCountyRule(source.fips) : null;
  const saleType = rule ? toSaleType(rule.type) : "Tax Deed";
  const host = new URL(source.url).hostname;

  return parsed.map((p) => ({
    id: `crawl-${source.fips}-${hashId(host, p.parcel, p.winning, p.date)}`,
    state: source.state,
    fips: source.fips,
    county_name: countyName,
    sale_type: saleType,
    sale_date: p.date,
    opening_bid: p.opening,
    winning_bid: p.winning,
    assessed_value: null,
    // Neither flag is an observation here. The Archivist's label rule decides
    // what this source's disposition column means, if it has one at all —
    // defaulting either to true would repeat the original bug exactly.
    redeemed: false,
    ownership_taken: false,
    provenance: "recorded" as const,
    source: source.url,
    notes: `Results crawl of ${host}. Parcel=${p.parcel ?? "?"}. Semantics pending a labels.py rule.`,
  }));
}

/**
 * Crawl every `results` source in the registry.
 *
 * Returns candidate rows and, more importantly, the list of hosts that need a
 * semantics decision. Nothing here is admitted to the corpus.
 */
export async function crawlResults(
  registry: SourceRegistry,
  opts: { limit?: number; states?: string[] } = {},
): Promise<CrawlReport> {
  const report: CrawlReport = {
    sourcesTried: 0,
    sourcesYielding: 0,
    rows: [],
    needsLabelRule: [],
    skipped: [],
  };

  const targets: { source: VerifiedSource; county: string }[] = [];
  for (const entry of Object.values(registry.counties)) {
    if (entry.isGap) continue;
    if (opts.states?.length && !opts.states.includes(entry.state)) continue;
    const source =
      entry.sources.find((s) => s.kind === "results") ??
      entry.sources.find((s) => s.kind === "listing");
    if (source) targets.push({ source, county: entry.county });
  }

  const byHost = new Map<string, OutcomeCandidate[]>();

  for (const { source, county } of targets.slice(0, opts.limit ?? targets.length)) {
    report.sourcesTried++;
    try {
      const rows = await crawlSource(source, county);
      if (!rows.length) {
        report.skipped.push({ url: source.url, reason: "no sold-price table or PDF found" });
        continue;
      }
      report.sourcesYielding++;
      report.rows.push(...rows);
      const host = new URL(source.url).hostname;
      byHost.set(host, [...(byHost.get(host) ?? []), ...rows]);
    } catch (e) {
      report.skipped.push({
        url: source.url,
        reason: e instanceof Error ? e.message.slice(0, 120) : String(e),
      });
    }
  }

  for (const [host, rows] of byHost) {
    const wins = rows.map((r) => r.winning_bid!).filter(Boolean);
    const ratios = rows
      .filter((r) => r.opening_bid && r.winning_bid)
      .map((r) => r.winning_bid! / r.opening_bid!);
    report.needsLabelRule.push({
      host,
      state: rows[0].state,
      sampleUrl: rows[0].source,
      rows: rows.length,
      medianWinningBid: median(wins),
      medianOpeningRatio: median(ratios),
      question:
        "Is this money column a competitive clearing price, a bid-down tax amount, " +
        "or a premium bid? A median winning/opening ratio near 1.0 suggests a reserve " +
        "that barely moved; a very large ratio suggests the column is not a price at all.",
    });
  }
  report.needsLabelRule.sort((a, b) => b.rows - a.rows);

  return report;
}
