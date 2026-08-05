/**
 * Arkansas Commissioner of State Lands — the whole state from one source.
 *
 * Arkansas is unusual and unusually easy: tax-delinquent land statewide is
 * certified to the Commissioner of State Lands, who runs the sales. There is
 * no county-by-county scrape. `cosl.org` publishes:
 *
 *   /Home/ExportAuctionsToCalendar  an iCalendar feed of every scheduled
 *                                   auction — date, time, venue, and the
 *                                   counties grouped into that sale
 *   /Home/TodaysSale?strSaleDate=…  the parcel list for one sale date
 *
 * The calendar feed is why every auction here is `saleDateConfirmed: true`:
 * the date comes from the Commissioner, not from `nextSaleWindows` projecting
 * a typical schedule.
 *
 * One sale serves several counties, so a single `TodaysSale` page is split by
 * the County column into one auction per county — auctions are keyed on
 * county FIPS everywhere downstream.
 *
 * Parsing note: the sale page has no `<table>` element. It is a Bootstrap
 * grid of `.row` / `.col-sm` divs that renders as a table. Anything looking
 * for `<tr>` finds an empty document.
 */

import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import { findCountyByName } from "../../atlas";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const BASE = "https://cosl.org";
const CALENDAR_URL = `${BASE}/Home/ExportAuctionsToCalendar`;

/** One scheduled auction from the iCalendar feed. */
interface CoslSale {
  /** YYYY-MM-DD, from DTSTART. */
  saleDate: string;
  /** The `strSaleDate` query value the sale page expects: `YYYY-MM-DD HH:mm`. */
  saleDateParam: string;
  /** Local start time, HH:mm. */
  startTime: string;
  /** County names as COSL spells them, e.g. ["PRAIRIE", "LONOKE"]. */
  counties: string[];
  location?: string;
  uid?: string;
}

/**
 * COSL truncates county names to fit its own labels ("PULA", "ARKA") in some
 * views and spells them out in the calendar. Only the exceptions that do not
 * survive `findCountyByName` need to be listed here.
 */
const COUNTY_ALIASES: Record<string, string> = {
  "ST FRANCIS": "St. Francis",
  "ST. FRANCIS": "St. Francis",
  "HOT SPRING": "Hot Spring",
  "LITTLE RIVER": "Little River",
  "VAN BUREN": "Van Buren",
  "WOODRUFF": "Woodruff",
};

/** Unfold RFC 5545 line continuations (a leading space continues the prior line). */
function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/**
 * `DTSTART` arrives as UTC (`20260709T150000Z`) for a sale the Commissioner
 * advertises as 10:00 AM local. Convert to America/Chicago so the date can
 * never land on the wrong day, which for a one-day auction is the difference
 * between showing a live sale and showing one that has closed.
 */
function icsStampToCentral(stamp: string): { date: string; time: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(stamp.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;

  if (!z) {
    // Floating local time — already what the county means.
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }

  const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utc);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
}

export function parseCoslCalendar(ics: string): CoslSale[] {
  const lines = unfoldIcs(ics);
  const sales: CoslSale[] = [];
  let cur: Record<string, string> | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = {};
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (cur) {
        const stamp = cur.DTSTART;
        const when = stamp ? icsStampToCentral(stamp) : null;
        const source = cur.DESCRIPTION || cur.SUMMARY || "";
        // "…Public Auction for counties: PRAIRIE,LONOKE" / "Public Auction - PULASKI"
        const listPart = source.includes(":")
          ? source.slice(source.lastIndexOf(":") + 1)
          : source.replace(/^.*?-\s*/, "");
        const counties = listPart
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 1 && !/public auction/i.test(c));

        if (when && counties.length > 0) {
          sales.push({
            saleDate: when.date,
            saleDateParam: `${when.date} ${when.time}`,
            startTime: when.time,
            counties,
            location: cur.LOCATION?.replace(/\\,/g, ",").trim() || undefined,
            uid: cur.UID,
          });
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    // Strip any parameters: `DTSTART;TZID=…:2026…`
    const key = line.slice(0, idx).split(";")[0].trim().toUpperCase();
    cur[key] = line.slice(idx + 1);
  }
  return sales;
}

function isUpcoming(iso: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return iso >= today;
}

function parseMoney(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cleanCell(html: string): string {
  return cheerio
    .load(`<div>${html}</div>`)("div")
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

/** A parsed row of the COSL sale grid. */
interface CoslRow {
  county: string;
  saleNumber: string;
  name: string;
  legalDescription: string;
  interestedParties: string;
  parcelNumber: string;
  taxes: string;
}

/**
 * Read the `.row` / `.col-sm` grid on a `TodaysSale` page.
 *
 * The header row and the parcel rows use identical markup, so rows are
 * accepted on shape: seven columns whose first is a county on this sale.
 */
export function parseCoslSalePage(html: string, saleCounties: string[]): CoslRow[] {
  const $ = cheerio.load(html);
  const known = new Set(saleCounties.map((c) => c.toUpperCase()));
  const rows: CoslRow[] = [];

  $("div.row").each((_, el) => {
    const cells = $(el)
      .children("div[class*='col-sm']")
      .map((__, c) => cleanCell($(c).html() ?? ""))
      .get();
    if (cells.length < 7) return;

    const county = cells[0].toUpperCase();
    if (!known.has(county)) return; // header row and page furniture

    rows.push({
      county: cells[0],
      saleNumber: cells[1],
      name: cells[2],
      legalDescription: cells[3],
      interestedParties: cells[4],
      parcelNumber: cells[5],
      taxes: cells[6],
    });
  });

  return rows;
}

/**
 * Withdrawn parcels stay on the published list with the owner column replaced.
 * They are not inventory: there is nothing to bid on.
 */
function isCancelled(row: CoslRow): boolean {
  return /entry cancelled|cancelled|redeemed|withdrawn/i.test(row.name) && !row.parcelNumber;
}

function rowToLot(row: CoslRow, sourceUrl: string): DiscoveredLot | null {
  if (isCancelled(row)) return null;
  if (!row.parcelNumber && !row.saleNumber) return null;

  return {
    externalId: row.saleNumber || row.parcelNumber,
    lotNumber: row.saleNumber || undefined,
    parcelNumber: row.parcelNumber || undefined,
    legalDescription: row.legalDescription || undefined,
    ownerName: row.name || undefined,
    // COSL publishes taxes owed, which is the statutory minimum bid — not an
    // assessed value. Never treat it as one: A.C.A. §26-37-202 sets the
    // opening at taxes, penalties, interest and costs.
    taxesOwed: parseMoney(row.taxes),
    openingBid: parseMoney(row.taxes),
    status: "pending" as const,
    sourceUrl,
    raw: {
      county: row.county,
      interestedParties: row.interestedParties || undefined,
    },
  };
}

function resolveCounty(coslName: string) {
  const normalized = COUNTY_ALIASES[coslName.toUpperCase()] ?? coslName;
  return findCountyByName("AR", normalized);
}

async function loadSales(): Promise<CoslSale[]> {
  const res = await politeFetch(CALENDAR_URL, { timeoutMs: 30_000 });
  if (res.status !== 200 || !res.body.includes("BEGIN:VEVENT")) {
    console.warn(`[ar-cosl] calendar feed returned ${res.status}`);
    return [];
  }
  return parseCoslCalendar(res.body).filter((s) => isUpcoming(s.saleDate));
}

export const arkansasCoslAdapter: SourceAdapter = {
  name: "ar-cosl",
  platform: "county_site",
  description:
    "Arkansas Commissioner of State Lands statewide tax-delinquent auctions " +
    "(cosl.org). Sale dates from the published iCalendar feed; parcels from " +
    "the per-sale-date catalog page.",

  /**
   * Every county that appears on an upcoming sale. Arkansas certifies to the
   * state, so the county set is whatever the Commissioner has scheduled —
   * discovered, not hardcoded.
   */
  async discoverCounties(): Promise<CountyBinding[]> {
    const sales = await loadSales();
    const byFips = new Map<string, CountyBinding>();

    for (const sale of sales) {
      for (const name of sale.counties) {
        const county = resolveCounty(name);
        if (!county) {
          console.warn(`[ar-cosl] unmatched county: ${name}`);
          continue;
        }
        const existing = byFips.get(county.fips);
        const salesForCounty = (existing?.config.sales as CoslSale[] | undefined) ?? [];
        salesForCounty.push(sale);
        byFips.set(county.fips, {
          countyFips: county.fips,
          config: { countyName: county.name, coslName: name, sales: salesForCounty },
        });
      }
    }

    return [...byFips.values()];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const cfg = binding.config as unknown as {
      countyName: string;
      coslName: string;
      sales: CoslSale[];
    };

    return cfg.sales.map((sale) => ({
      countyFips: binding.countyFips,
      platform: "county_site" as const,
      // Arkansas sells the deed at public auction with a 90-day post-sale
      // period during which the owner may redeem via the Commissioner.
      saleType: "Redeemable Deed" as const,
      externalId: `${binding.countyFips}|cosl|${sale.saleDate}`,
      saleDate: sale.saleDate,
      // From the Commissioner's own calendar feed, not projected.
      saleDateConfirmed: true,
      listingKind: "sale_list" as const,
      startTime: sale.startTime,
      title: `${cfg.countyName} County AR — Commissioner of State Lands public auction`,
      status: "scheduled" as const,
      sourceUrl: `${BASE}/Home/TodaysSale?strSaleDate=${encodeURIComponent(sale.saleDateParam)}`,
      raw: {
        location: sale.location,
        coslName: cfg.coslName,
        // One venue serves several counties; recorded so the sale page can be
        // fetched once and split rather than re-fetched per county.
        countiesInSale: sale.counties,
        uid: sale.uid,
      },
    }));
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const raw = (auction.raw ?? {}) as { coslName?: string; countiesInSale?: string[] };
    const res = await politeFetch(auction.sourceUrl, { timeoutMs: 45_000 });
    if (res.status !== 200) {
      console.warn(`[ar-cosl] ${auction.sourceUrl} returned ${res.status}`);
      return [];
    }

    const rows = parseCoslSalePage(res.body, raw.countiesInSale ?? []);
    const mine = raw.coslName?.toUpperCase();

    return rows
      // A sale page covers every county in the group; keep only this auction's.
      .filter((r) => !mine || r.county.toUpperCase() === mine)
      .map((r) => rowToLot(r, auction.sourceUrl))
      .filter((l): l is DiscoveredLot => l !== null);
  },
};
