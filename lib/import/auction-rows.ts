/**
 * One exported CSV row → one auction, in this system's vocabulary.
 *
 * The export describes a sale the way an aggregator publishes it: a state and
 * county in prose, a sale type of "Lien", a venue of "Live" or "Online", a
 * parcel *count*, and the address of whichever platform hosts the sale. None of
 * those are the values the schema stores, so this module is where the
 * translation is written down and where every assumption in it is visible.
 *
 * ## What it deliberately does not do
 *
 * It never invents a value to fill a column. A sale with no published start
 * time gets `null`, not "9:00 AM"; a sale whose platform cannot be identified
 * from its URL gets the venue-derived fallback, not a guess at the vendor. The
 * blanks are the enrichment pass's worklist, and a plausible fabricated value
 * would remove the row from that worklist while making it look complete.
 *
 * ## The parcel count is not a lot count
 *
 * `Parcel Count` is how many parcels the county says it is offering. It is
 * emphatically not how many parcel rows we hold — we hold none until something
 * crawls the county's list. It lands in `announced_parcel_count`, and
 * `lot_count` stays 0. The two columns disagreeing is the honest state of an
 * imported sale and is what the enrichment worklist is computed from.
 */

import type { Platform } from "../ingest/types";
import type { SaleType } from "../atlas/types";
import { IMPORT_ID_PREFIX } from "./provenance";

/**
 * Columns without which a row cannot become an auction.
 *
 * Everything else is optional and may arrive blank. `Auction ID` is here
 * because it is the dedupe key: a file without it cannot be re-imported without
 * duplicating every row it contains.
 */
export const REQUIRED_COLUMNS = [
  "State",
  "County",
  "Sale Date",
  "Auction Type",
  "Auction ID",
] as const;

/**
 * Longest note still usable as a title.
 *
 * Sized to what fits a calendar entry rather than to any property of the data:
 * "District 1" and "precinct 3" are the shapes this is for.
 */
const TITLE_MAX = 60;

export interface ImportedAuction {
  /** The exporter's own id, unprefixed. */
  sourceId: string;
  /** `import:<id>` — namespaced so it cannot collide with an adapter's id. */
  externalId: string;
  stateLabel: string;
  countyLabel: string;
  /** ISO, YYYY-MM-DD: the day the sale opens. */
  saleDate: string;
  /** The last day, when the export gives a later one; null for a one-day sale. */
  saleEndDate: string | null;
  saleType: SaleType;
  platform: Platform;
  /** The venue as published: Live, Online, Simulcast, Sealed Bid. */
  venue: string | null;
  startTime: string | null;
  title: string | null;
  /** Parcels the county says it is offering. Never written to `lot_count`. */
  announcedParcelCount: number | null;
  /** Numeric string, kept as text so no float ever touches money. */
  aggregateSaleAmount: string | null;
  /*
   * No `sourceUrl`. The export's `Auction URL` column is the exporter's own
   * per-row research page — a citation of the middleman, not of the county
   * that published the sale, and on a subscription host a bidder cannot read.
   * The citation is chosen in `resolveCounties`, which is the first point that
   * knows the county's FIPS and can therefore reach the county's own pages.
   * See `source-url.ts` for the waterfall and `ResolvedAuction` for the field.
   */
  /** Every column of the source row, for re-parsing without the file. */
  raw: Record<string, string>;
}

export type RowOutcome =
  | { ok: true; value: ImportedAuction }
  /** `line` is the line number in the file, counting the header as line 1. */
  | { ok: false; line: number; problem: string };

// ---------------------------------------------------------------------------
// Sale type
// ---------------------------------------------------------------------------

/**
 * The export's type vocabulary, mapped to the schema's.
 *
 * A sale type that is not in this table is rejected rather than defaulted.
 * `saleType` drives the maximum-bid maths and the statutory redemption model,
 * so an unrecognised value silently becoming "Tax Deed" would produce confident
 * numbers computed under the wrong body of law — the Arkansas failure the
 * upsert comment in `runner.ts` records, arriving by a different route.
 */
const SALE_TYPES: Record<string, SaleType> = {
  lien: "Tax Lien",
  "tax lien": "Tax Lien",
  deed: "Tax Deed",
  "tax deed": "Tax Deed",
  "redeemable deed": "Redeemable Deed",
  "redeemable tax deed": "Redeemable Deed",
  hybrid: "Hybrid",
};

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/**
 * Host fragment → platform, checked against the sale's published site.
 *
 * Matched on a substring of the hostname rather than an exact host because the
 * export writes these inconsistently: bare (`www.govease.com`), with a scheme,
 * and occasionally as a county-specific subdomain. Ordered longest-first only
 * matters for `realforeclose` vs `realtaxdeed`, which are separate RealAuction
 * products and separate platform values here.
 */
const PLATFORM_HOSTS: [string, Platform][] = [
  ["realforeclose", "realforeclose"],
  ["realtaxdeed", "realtaxdeed"],
  ["realauction", "realtaxdeed"],
  ["govease", "govease"],
  ["bid4assets", "bid4assets"],
  ["zeusauction", "zeus"],
  ["lienhub", "lienhub"],
  ["grantstreet", "grantstreet"],
  ["taxsaleinfo", "taxsaleinfo"],
  ["titlecheck", "taxsaleinfo"],
  ["mvbalaw", "mvba"],
  ["lgbs", "lgbs"],
  ["publicsurplus", "county_site"],
];

/**
 * Which platform hosts this sale.
 *
 * Read from the published sale-site URL where one is recognisable, and
 * otherwise inferred from the venue: an online sale on an unrecognised site is
 * a county's own portal (`county_site`), and a live sale is `in_person`.
 *
 * The inference is the honest floor rather than a guess at a vendor. It also
 * keeps `platform` meaning what the column says it means — where the sale is
 * *hosted* — instead of quietly becoming "where we got the data", which is what
 * a dedicated aggregator platform value would have turned it into. Provenance
 * lives in `external_id` and `raw`, where it belongs.
 */
export function derivePlatform(site: string | null, venue: string | null): Platform {
  const host = (site ?? "").toLowerCase();
  if (host) {
    for (const [fragment, platform] of PLATFORM_HOSTS) {
      if (host.includes(fragment)) return platform;
    }
  }
  const v = (venue ?? "").toLowerCase();
  if (v.includes("online") || v.includes("simulcast") || v.includes("sealed")) return "county_site";
  return "in_person";
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * A sale date as ISO, from either the export's own format or a spreadsheet's.
 *
 * The export writes `YYYY-MM-DD`. A file that has been opened and re-saved in
 * Excel comes back as `M/D/YYYY`, which is the single most likely way a
 * re-upload differs from the original, so both are read. Anything else is
 * rejected — a date this system cannot parse must not become a date it guesses.
 */
export function parseSaleDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealDate(s) ? s : null;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const [, m, d, y] = us;
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return isRealDate(iso) ? iso : null;
  }
  return null;
}

/** Rejects 2026-02-30 and friends, which `new Date` silently rolls forward. */
function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A non-negative integer, or null. Thousands separators tolerated. */
function parseCount(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A money amount as a numeric *string*.
 *
 * Never parsed to a float. The schema stores money as `numeric(14,2)` for the
 * reason its own comment gives — these are summed and shown to people deciding
 * how to spend real money — and round-tripping through a double to get here
 * would discard that guarantee before the value ever reached the column.
 */
function parseMoney(raw: string): string | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (!s) return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/** Empty string → null, so a blank cell and a missing column read alike. */
function orNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** Column names this reads, so callers can describe the format. */
export interface RowSource {
  cell(name: string): string;
  /** Every column of the row, for `raw`. */
  all(): Record<string, string>;
}

/**
 * Translate one row, or explain why it cannot be translated.
 *
 * Returns a problem rather than throwing so that one malformed row out of 644
 * is reported alongside the 643 that imported, instead of aborting the file.
 */
export function readRow(src: RowSource, line: number): RowOutcome {
  const fail = (problem: string): RowOutcome => ({ ok: false, line, problem });

  const sourceId = src.cell("Auction ID");
  if (!sourceId) return fail("no Auction ID — the row cannot be de-duplicated");

  const stateLabel = src.cell("State");
  const countyLabel = src.cell("County");
  if (!stateLabel) return fail("no State");
  if (!countyLabel) return fail("no County");

  /*
   * The opening day, preferring an explicit start column where an export has
   * one. USTLA's own records put a multi-day sale under its closing date —
   * Santa Clara, Oct 30 to Nov 2, is listed on Nov 2 — so a "Sale Start Date"
   * is the better source for the day a bidder has to be there.
   */
  const saleDate =
    parseSaleDate(src.cell("Sale Start Date")) ?? parseSaleDate(src.cell("Sale Date"));
  if (!saleDate) return fail(`unreadable Sale Date "${src.cell("Sale Date")}"`);
  const endDate = parseSaleDate(src.cell("Sale End Date"));
  const saleEndDate = endDate && endDate > saleDate ? endDate : null;

  const typeLabel = src.cell("Auction Type").toLowerCase().trim();
  const saleType = SALE_TYPES[typeLabel];
  if (!saleType) return fail(`unknown Auction Type "${src.cell("Auction Type")}"`);

  const venue = orNull(src.cell("Online or Onsite"));

  /*
   * The sale site is published per sale type — a county running both a lien and
   * a deed sale lists a different host for each — so the column matching this
   * row's type is read first, and the others only as a fallback.
   */
  const siteByType =
    saleType === "Tax Lien"
      ? src.cell("Online Site (Lien)")
      : saleType === "Tax Deed" || saleType === "Redeemable Deed"
        ? src.cell("Online Site (Deed)")
        : "";
  const site =
    orNull(siteByType) ??
    orNull(src.cell("Online Site (Lien)")) ??
    orNull(src.cell("Online Site (Deed)")) ??
    orNull(src.cell("Online Site (Foreclosure)"));

  /*
   * The county's note becomes the title, when the note is short enough to be
   * one. Its job in the schema is separating several sales held by one county
   * on one day — Mississippi publishes "District 1" and "District 2" for the
   * same county and date, and without this they are two rows differing only by
   * an opaque id.
   *
   * The length cap is there because some publishers put a form dump in this
   * column rather than a label. New Jersey's reads "Sale Type: Standard Year
   * Type: Calendar YEP: Yes Additional Comments:" on every row — sixty-nine
   * characters that distinguish nothing, repeated down the calendar and pushing
   * the municipality out of a cell 200px wide. A title has to work as a label;
   * prose is a note, and the note is not lost — it is kept in `raw` and shown in
   * full on the auction page.
   */
  const note = orNull(src.cell("Additional Sale Notes"));
  const title = note && note.length <= TITLE_MAX ? note : null;

  return {
    ok: true,
    value: {
      sourceId,
      externalId: `${IMPORT_ID_PREFIX}${sourceId}`,
      stateLabel,
      countyLabel,
      saleDate,
      saleEndDate,
      saleType,
      platform: derivePlatform(site, venue),
      venue,
      startTime: orNull(src.cell("Sale Time")),
      title,
      announcedParcelCount: parseCount(src.cell("Parcel Count")),
      aggregateSaleAmount: parseMoney(src.cell("Aggregate Sale Amount (USD)")),

      raw: src.all(),
    },
  };
}
