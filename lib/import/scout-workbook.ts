/**
 * The Auction Scout workbook, read back in.
 *
 * The desk's Auction Scout report goes out as an xlsx (see
 * `app/admin/scout-report/route.ts`), comes back expanded by hand, and is worth
 * reading into the calendar: a venue and a named contact for each sale, the
 * parcel count, the platform the sale actually runs on, and — for a few dozen
 * rows — a sale this system does not hold at all. This module is the pure half
 * of that: bytes in, normalised rows out. Matching them against the database
 * is `scripts/ingest-auction-scout.ts`.
 *
 * ## Two tabs, one row shape
 *
 * "Auction Scout" is the report itself, one row per upcoming sale. "Sep-Oct
 * Source Import" is the sale calendar the report was built from, re-projected
 * with its own column names and a flag, "Included in Upcoming Scout?", that
 * marks the rows the report carried forward. Everything else in that tab is
 * labelled "Past / audit only" by its author and is read as exactly that.
 * Both are translated into one `ScoutRow` so the matching rules are written
 * once.
 *
 * ## Why not exceljs
 *
 * This workbook is written with `x:`-prefixed OOXML, which exceljs cannot open
 * at all — the same wall `scout-report/route.ts` records hitting. It is read
 * here as what it is, a zip of XML parts, with the namespace prefixes dropped
 * before parsing.
 */

import JSZip from "jszip";
import * as cheerio from "cheerio";
import type { SaleType } from "../atlas/types";

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

/** One sheet as a grid of strings; blank cells stay blank, in position. */
export type Grid = string[][];

/** `x:row` → `row`, so one set of selectors reads either spelling. */
function unprefix(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z][\w.-]*:/g, "<$1");
}

/** "AB12" → 27. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/**
 * Every sheet in the workbook, by name.
 *
 * Values are the cells' stored text: shared and inline strings resolved, and
 * numbers — dates included — left exactly as stored. Interpretation belongs to
 * the caller, which knows which column is a date.
 */
export async function readWorkbook(bytes: Uint8Array): Promise<Map<string, Grid>> {
  const zip = await JSZip.loadAsync(bytes);
  const part = async (path: string) => {
    const f = zip.file(path);
    return f ? cheerio.load(unprefix(await f.async("string")), { xml: true }) : null;
  };

  const shared: string[] = [];
  const ss = await part("xl/sharedStrings.xml");
  ss?.("si").each((_, si) => {
    shared.push(ss(si).find("t").map((__, t) => ss(t).text()).get().join(""));
  });

  const rels = new Map<string, string>();
  const relDoc = await part("xl/_rels/workbook.xml.rels");
  relDoc?.("Relationship").each((_, r) => {
    rels.set(relDoc(r).attr("Id") ?? "", relDoc(r).attr("Target") ?? "");
  });

  const book = await part("xl/workbook.xml");
  if (!book) throw new Error("not an xlsx workbook — no xl/workbook.xml");

  const sheets = new Map<string, Grid>();
  for (const el of book("sheets > sheet").toArray()) {
    const name = book(el).attr("name") ?? "";
    // The relationship id attribute keeps its prefix; only element names were stripped.
    const target = rels.get(book(el).attr("r:id") ?? "") ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^xl\//, "")}`;
    const doc = await part(path);
    if (!doc) continue;

    const grid: Grid = [];
    doc("sheetData > row").each((_, row) => {
      const cells: string[] = [];
      doc(row)
        .children("c")
        .each((__, c) => {
          const cell = doc(c);
          const at = columnIndex(cell.attr("r") ?? "");
          const type = cell.attr("t");
          let value: string;
          if (type === "inlineStr") value = cell.find("t").text();
          else {
            value = cell.children("v").text();
            if (type === "s" && value !== "") value = shared[Number(value)] ?? "";
          }
          if (at >= 0) cells[at] = value;
        });
      grid.push(Array.from(cells, (v) => v ?? ""));
    });
    sheets.set(name, grid);
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * A cell as a value, or null.
 *
 * These were pasted out of county web pages, so some carry `&nbsp;` as literal
 * text and trail a run of empty comma-separated fields — "Online auction,
 * &nbsp;, &nbsp;". The same cleaning `import-auction-csv.ts` applies to the
 * sale calendar these rows descend from.
 */
export function clean(v: string | undefined): string | null {
  const s = (v ?? "")
    .replace(/&(amp;)?nbsp;?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*,\s*)+$/, "")
    .trim();
  return s || null;
}

/**
 * A sale date as ISO.
 *
 * The report tab stores a real date cell, which arrives as an Excel serial
 * (days since 1899-12-30); the source tab stores the text `YYYY-MM-DD`. Either
 * is read, anything else is null — a date that cannot be read must not become
 * one that is guessed.
 */
export function saleDateOf(v: string): string | null {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return null;
}

function countOf(v: string): number | null {
  const s = v.replace(/[,\s]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** Money stays a numeric string — see `parseMoney` in `auction-rows.ts`. */
function moneyOf(v: string): string | null {
  const s = v.replace(/[$,\s]/g, "");
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

/** A site written bare ("www.publicsurplus.com") made into a URL; prose → null. */
export function urlOf(v: string): string | null {
  const s = v.trim();
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return `https://${s}`;
  return null;
}

// ---------------------------------------------------------------------------
// Sale type
// ---------------------------------------------------------------------------

/**
 * The report's sale-type labels, mapped to the schema's.
 *
 * Exact labels rather than a keyword match, for the reason `SALE_TYPES` in
 * `auction-rows.ts` gives: sale type drives the maximum-bid maths and the
 * redemption model, so a label nobody has read must be rejected, not defaulted.
 *
 * Every label naming a redeemable deed maps to one. The labels naming no type
 * at all are each a deed sale under their own state's law — Michigan and New
 * York foreclosures, California and Washington tax-defaulted sales,
 * Pennsylvania's repository, Minnesota's forfeited land — and are the same
 * values the crawled sales in those states already carry. Georgia's judicial
 * in-rem sale is redeemable like every other Georgia tax sale, which is how
 * the other 90 upcoming Georgia sales are held.
 */
const SALE_TYPES: Record<string, SaleType> = {
  deed: "Tax Deed",
  "tax deed sale": "Tax Deed",
  "tax-delinquent property auction / deed": "Tax Deed",
  "tax-foreclosed property no-reserve auction": "Tax Deed",
  "tax-foreclosed property minimum-bid re-offer": "Tax Deed",
  "tax foreclosure real estate auction": "Tax Deed",
  "tax foreclosure sale": "Tax Deed",
  "tax-defaulted properties auction": "Tax Deed",
  "tax-defaulted property auction": "Tax Deed",
  "repository tax sale": "Tax Deed",
  "tax-forfeited / market value auction": "Tax Deed",
  "tax title properties auction": "Tax Deed",
  "redeemable deed": "Redeemable Deed",
  "delinquent property tax foreclosure / redeemable deed": "Redeemable Deed",
  "municipal tax sale / redeemable deed": "Redeemable Deed",
  "delinquent tax sale — redeemable tax deed": "Redeemable Deed",
  "tax commissioner sale — redeemable tax deed": "Redeemable Deed",
  "tax commissioner / municipal tax sale — redeemable tax deed": "Redeemable Deed",
  "tax deed / delinquent tax sale — redeemable tax deed": "Redeemable Deed",
  "sheriff tax / levy sale — redeemable tax deed": "Redeemable Deed",
  "tax sale / judicial in rem — georgia tax deed": "Redeemable Deed",
};

export function saleTypeOf(label: string): SaleType | null {
  return SALE_TYPES[label.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

// ---------------------------------------------------------------------------
// Jurisdiction
// ---------------------------------------------------------------------------

/**
 * Municipalities the report names without their county.
 *
 * Connecticut sells by town and the reference table holds its eight counties;
 * a label like "Town of Berlin" carries nothing `CountyIndex` can resolve. This
 * is the geography for the towns this report has actually named, and nothing
 * more — a town not listed is a rejected row with a reason, never a guess.
 */
const TOWN_COUNTY: Record<string, Record<string, string>> = {
  CT: {
    berlin: "Hartford",
    cromwell: "Middlesex",
    "east windsor": "Hartford",
    hartford: "Hartford",
    killingly: "Windham",
    manchester: "Hartford",
    stratford: "Fairfield",
    thompson: "Windham",
    weston: "Fairfield",
  },
  NY: { poughkeepsie: "Dutchess" },
};

export type Jurisdiction =
  | {
      ok: true;
      /** A label `CountyIndex.resolve` can read. */
      county: string;
      /**
       * The body holding the sale when it is not the county itself — a town, a
       * school district, a city's in-rem docket. Null for the county's own sale.
       * Two rows naming different bodies are different sales.
       */
      sale: string | null;
      /** Michigan's second-round sale, which the calendar titles "Re-Offer Sale". */
      reoffer: boolean;
    }
  | { ok: false; problem: string };

function town(state: string, name: string): string | null {
  return TOWN_COUNTY[state]?.[name.trim().toLowerCase()] ?? null;
}

/**
 * Read the report's jurisdiction label into a county and the body selling.
 *
 * The shapes, all taken from the workbook rather than imagined:
 *
 *   Arenac County Re-Offer                        Michigan's second-round sale
 *   Chatham County / City of Savannah Judicial …  county first, sale after
 *   Gladewater ISD – Smith County                 sale first, county after
 *   City of Sardis (Burke County)                 municipality, county in brackets
 *   Town of Berlin, City of Poughkeepsie          municipality, no county at all
 *   Killingly Town (Northeastern Connecticut)     bracket holds a planning region
 *   Oronoque Village Tax District (Stratford)     bracket holds a town
 *
 * Anything else is passed through untouched, because `CountyIndex` already
 * reads "Carver County", "Newport News City (Newport News)" and the rest.
 */
export function readJurisdiction(state: string, label: string): Jurisdiction {
  const s = label.trim().replace(/\s+/g, " ");
  const county = (c: string, sale: string | null = null, reoffer = false): Jurisdiction => ({
    ok: true,
    county: c,
    sale,
    reoffer,
  });

  const reoffer = /^(.*\bCounty)\s+Re-?Offer$/i.exec(s);
  if (reoffer) return county(reoffer[1], null, true);

  const slash = /^(.*\bCounty)\s+\/\s+(.+)$/i.exec(s);
  if (slash) return county(slash[1], slash[2]);

  const dash = /^(.+?)\s+[–—]\s+(.*\bCounty)$/i.exec(s);
  if (dash) return county(dash[2], dash[1]);

  const bracketed = /^(.*?)\s*\(([^)]+\bCounty)\)$/i.exec(s);
  if (bracketed && /^(?:Town|City|Village) of /i.test(bracketed[1])) {
    return county(bracketed[2], bracketed[1]);
  }

  const of = /^(?:Town|City|Village) of (.+)$/i.exec(s);
  if (of) {
    const c = town(state, of[1]);
    return c
      ? county(c, s)
      : { ok: false, problem: `"${s}" names a municipality with no county in the town table` };
  }

  const bracket = /^(.*?)\s*\(([^)]+)\)$/.exec(s);
  if (bracket && TOWN_COUNTY[state]) {
    const [, outer, inner] = bracket;
    const byInner = town(state, inner);
    if (byInner) return county(byInner, s);
    const byOuter = town(state, outer.replace(/\s+(Town|City|Village)$/i, ""));
    if (byOuter) return county(byOuter, outer);
  }

  return county(s);
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export const SCOUT_TABS = ["Auction Scout", "Sep-Oct Source Import"] as const;
export type ScoutTab = (typeof SCOUT_TABS)[number];

/** Each tab's own column names for the fields both carry. */
const COLUMNS: Record<ScoutTab, Record<string, string>> = {
  "Auction Scout": {
    state: "State",
    county: "County / Jurisdiction",
    date: "Sale Date",
    type: "Auction Type",
    method: "Sale Method / Location",
    address: "Sale Address",
    parcels: "Parcels",
    amount: "Aggregate Sale Amount",
    contact: "Contact",
    phone: "Phone",
    email: "Email",
    site: "Primary Source / Web Address",
  },
  "Sep-Oct Source Import": {
    state: "State Abbrev",
    county: "County",
    date: "Sale Date",
    type: "Auction Type",
    address: "Sale Address",
    parcels: "Parcels",
    amount: "Aggregate Sale Amount",
    contact: "Contact",
    phone: "Phone",
    email: "Email",
    site: "Web Address",
    included: "Included in Upcoming Scout?",
  },
};

/** The property-list column, read when the tab has one. Optional: older workbooks lack it. */
const LIST_COLUMN: Record<ScoutTab, string> = {
  "Auction Scout": "Auction Property List / Download Link",
  "Sep-Oct Source Import": "Original Property List Link",
};

export interface ScoutRow {
  /** The channel this row arrived on: a workbook tab, or "Auction Scout research". */
  tab: string;
  /** Spreadsheet row number, header = 1. */
  line: number;
  state: string;
  /** The jurisdiction exactly as the report wrote it. */
  label: string;
  saleDate: string;
  saleType: SaleType;
  /** "Online auction", "Live public sale", … */
  method: string | null;
  /** A street address, or the method repeated for an online sale. */
  address: string | null;
  parcels: number | null;
  amount: string | null;
  contact: { name?: string; phone?: string; email?: string };
  /** The page the report cites for this sale, as a URL. */
  site: string | null;
  /** The county's own property list, catalog or PDF, when the row links one. */
  listUrl?: string | null;
  /** Local start time as published — the AI research carries one; the workbook does not. */
  startTime?: string | null;
  /**
   * False where the tab's author marked the row "Past / audit only". The
   * report tab has no such column: every row in it is a sale going forward.
   */
  forward: boolean;
  /** Every column of the row, verbatim. */
  raw: Record<string, string>;
}

export type ScoutRowOutcome =
  | { ok: true; row: ScoutRow }
  | { ok: false; line: number; label: string; problem: string };

/** Translate one tab. Header row first; blank rows are skipped silently. */
export function readScoutTab(tab: ScoutTab, grid: Grid): ScoutRowOutcome[] {
  const [header, ...rows] = grid;
  const cols = COLUMNS[tab];
  const at = new Map(header.map((h, i) => [h.trim(), i]));
  const missing = Object.values(cols).filter((c) => !at.has(c));
  if (missing.length) throw new Error(`"${tab}" tab is missing ${missing.join(", ")}`);

  const out: ScoutRowOutcome[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    const line = i + 2;
    const get = (key: string) => (cols[key] ? (cells[at.get(cols[key])!] ?? "") : "");
    const state = get("state").trim().toUpperCase();
    const label = clean(get("county")) ?? "";
    const where = `${label || "(no county)"}, ${state || "(no state)"}`;
    const fail = (problem: string) => out.push({ ok: false, line, label: where, problem });

    if (!/^[A-Z]{2}$/.test(state)) return fail(`unreadable state "${get("state")}"`);
    if (!label) return fail("no county");
    const saleDate = saleDateOf(get("date"));
    if (!saleDate) return fail(`unreadable Sale Date "${get("date")}"`);
    const saleType = saleTypeOf(get("type"));
    if (!saleType) return fail(`unknown Auction Type "${get("type")}"`);

    const contact = {
      name: clean(get("contact")) ?? undefined,
      phone: clean(get("phone")) ?? undefined,
      email: clean(get("email")) ?? undefined,
    };

    out.push({
      ok: true,
      row: {
        tab,
        line,
        state,
        label,
        saleDate,
        saleType,
        method: clean(get("method")),
        address: clean(get("address")),
        parcels: countOf(get("parcels")),
        amount: moneyOf(get("amount")),
        contact,
        site: urlOf(get("site")),
        listUrl: at.has(LIST_COLUMN[tab]) ? urlOf(cells[at.get(LIST_COLUMN[tab])!] ?? "") : null,
        forward: !cols.included || get("included").trim().toLowerCase() === "yes",
        raw: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ""])),
      },
    });
  });
  return out;
}

/** A cell describing how a sale is run rather than where. */
const FORMAT = /^(online|live|in[- ]person|public (sale|auction|outcry))\b/i;

/**
 * Where the sale is held, as the logistics column stores it — or null.
 *
 * An online sale is the category claim "Online auction", which is either right
 * or absurd. An in-person sale is written only with a place: the report often
 * has nothing better than "Live public outcry", and a venue reading that goes
 * to the CAPE narrator as "the sale is held at Live public outcry" and into the
 * framework document as the place a bidder should stand, displacing the
 * courthouse address it would otherwise have found in the county's notes. The
 * method is still kept, in `raw`, where it reads as what it is.
 */
export function venueOf(row: ScoutRow): { text: string; kind: "online" | "in_person" } | null {
  if (/^online\b/i.test(row.method ?? row.address ?? "")) {
    const text = row.method ?? row.address;
    return text ? { text, kind: "online" } : null;
  }
  return row.address && !FORMAT.test(row.address) ? { text: row.address, kind: "in_person" } : null;
}
