/**
 * New Jersey municipal tax lien sales, from captures taken in the operator's
 * browser.
 *
 * ## Why New Jersey is its own adapter
 *
 * New Jersey has no county tax sales. Every one of them is run by a
 * municipality under N.J.S.A. 54:5, which is why `STATEWIDE_SOURCES.NJ` points
 * every county at one association page rather than at a county list, and why
 * 110 upcoming sales here belong to 110 towns across 21 counties.
 *
 * `govease.ts` refuses a municipal seller outright, and is right to: "a city
 * tax sale is a different levy under different rules, and attributing it to the
 * county would put lots on a county page that the county is not selling." That
 * reasoning does not transfer. In New Jersey the municipal sale is not an
 * exception to the county's sale — it is the only kind there is, so refusing it
 * would mean never carrying New Jersey at all. The compromise is in the title:
 * the row is filed under the county because the schema is county-keyed, and it
 * is *named* for the town, so nobody reads Randolph's thirty-eight liens as
 * Morris County's sale.
 *
 * ## The platform is RealAuction wearing a different name
 *
 * `randolph.newjerseytaxsale.com` serves "RealTaxLien" and is copyright
 * Realauction.com. Same engine as `realauction.ts` reads, same 403-in-118-bytes
 * to this project's user agent, same robots `Disallow: /`, same answer: the
 * pages are public in a browser and are read there. See
 * `docs/nj-taxsale-capture.md`.
 *
 * What differs is the page. The Florida deed sites publish a sale-day preview
 * at `zaction=AUCTION&Zmethod=PREVIEW`; the New Jersey lien sites publish
 * `index.cfm?folder=previewitems`, a flat table of fifty rows a page with
 * `?pageNum=N` for the rest. The columns are different too — a lien sale
 * advertises a charge, not an opening bid — so the two cannot share a parser
 * and this file does not pretend otherwise.
 *
 * ## What a row is
 *
 *     ADVNUM       0001          the advertisement number, the sale's own id
 *     Tax Year     2025          which year's delinquency is being sold
 *     Parcel ID    12 - 2.04     block and lot, the state's parcel key
 *     Owner Name   ...
 *     Charge Type  T W S         taxes / water / sewer, combinable
 *     Face Amount  $2,799.34     the lien's face value, NOT an opening bid
 *     Status       Active        or Unavailable, once it is paid or pulled
 *
 * **Face amount is not an opening bid.** A New Jersey lien is bid down on
 * interest rate from 18%, then up as a premium; the face amount is what the
 * certificate is worth on day one. Putting it in `openingBid` would make a
 * $458 sewer lien look like a $458 house. It goes in `taxesOwed`, which is what
 * it is.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getCounty } from "../../atlas";
import { parseLotStatus } from "../lot-status";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const CAPTURE_DIR = join(process.cwd(), "data", "nj-taxsale-capture");

/**
 * Lists the towns publish themselves, in `data/nj-town-lists.json`.
 *
 * Most of New Jersey's sales are not on newjerseytaxsale.com at all: the
 * tax collector posts the advertised list on the town's own site, as a PDF,
 * a scan or a notice page. 161 imported NJ sales had no parcels; 49 of their
 * towns turned out to publish the list, about 6,000 liens between them.
 *
 * Each entry is written onto that town's own imported sale, found by the
 * town's name, never by county and date alone: several towns in one county
 * sell on the same day, and matching on the day would hand one town's liens
 * to another.
 */
const TOWN_LISTS = join(process.cwd(), "data", "nj-town-lists.json");

interface TownList {
  municipality: string;
  countyFips: string;
  saleDate: string;
  url: string;
}

async function readTownLists(): Promise<TownList[]> {
  try {
    const doc = JSON.parse(await readFile(TOWN_LISTS, "utf8")) as { lists?: TownList[] };
    return (doc.lists ?? []).filter((l) => l.municipality && l.countyFips && l.saleDate && l.url);
  } catch {
    return [];
  }
}

/** The imported row for this town's sale, so the list lands on it rather than beside it. */
async function importedRowFor(
  l: TownList,
): Promise<{ externalId: string; platform: string; saleType: string; raw: Record<string, unknown> } | null> {
  const { db } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  const rows = (await db.execute(sql`
    SELECT external_id, platform::text AS platform, sale_type::text AS sale_type, raw FROM auctions
    WHERE county_fips = ${l.countyFips} AND sale_date = ${l.saleDate}::date AND delisted_at IS NULL
      AND lower(coalesce(title, '')) = lower(${l.municipality})
    ORDER BY first_seen_at LIMIT 2`)) as unknown as {
    external_id: string;
    platform: string;
    sale_type: string;
    raw: Record<string, unknown> | null;
  }[];
  /* Two rows with one town's name on one day is a duplicate for a person to settle, not a guess. */
  if (rows.length !== 1) return null;
  const [r] = rows;
  return { externalId: r.external_id, platform: r.platform, saleType: r.sale_type, raw: r.raw ?? {} };
}

/** A town's list read into liens: tables for free, text by the model, scans by its eyes. */
async function lotsFromTownList(
  url: string,
  context: { countyName: string; state: string; sourceUrl: string; saleDate?: string },
): Promise<DiscoveredLot[]> {
  const [{ documentToText, parseDelimitedText }, { extractLots, extractLotsFromImages }, render] = await Promise.all([
    import("../parse"),
    import("../extract"),
    import("../render"),
  ]);
  const text = await documentToText(url);
  const pages = Math.max(1, (text.match(/--\s*\d+\s+of\s+\d+\s*--/g) ?? []).length);
  if (pages > 1 || /\.pdf\b/i.test(url)) {
    if (render.textDensity(text, pages) < render.SCAN_TEXT_PER_PAGE) {
      const rendered = await render.renderPdfFromUrl(url, { maxPages: 24, scale: 2 });
      return (await extractLotsFromImages(rendered, context)).lots;
    }
  }
  const table = parseDelimitedText(text, url);
  if (table?.length) return table;
  const result = await extractLots(text, context);
  return result.containsParcelList ? result.lots : [];
}

interface NjRow {
  advNum?: string;
  taxYear?: string;
  parcelNumber?: string;
  ownerName?: string;
  chargeType?: string;
  faceAmount?: string;
  status?: string;
}

interface NjCapture {
  /** "randolph.newjerseytaxsale.com" — ties the file to one town's sale. */
  host: string;
  /** "Randolph Township", as the municipality names itself. */
  municipality: string;
  /** The county the town sits in. Taken from the row being filled, not guessed. */
  countyFips: string;
  saleDate: string;
  startTime?: string;
  capturedAt?: string;
  /** How many the town advertised, when known — see `listLots`. */
  announced?: number;
  rows: NjRow[];
}

/** "$2,799.34" -> 2799.34. Zero and blank are absent, not zero. */
function money(raw: string | undefined): number | undefined {
  const n = Number((raw ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * What the sale is selling, spelled out.
 *
 * `T W S` is three levies on one parcel, and a bidder reading "T" alone would
 * not know a sewer charge was in there. The letters are the town's own
 * shorthand; this expands them and leaves anything unfamiliar as it was found.
 */
const CHARGE: Record<string, string> = {
  T: "taxes",
  W: "water",
  S: "sewer",
  O: "other municipal charge",
};

function chargeDescription(raw: string | undefined): string | undefined {
  const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const named = parts.map((p) => CHARGE[p.toUpperCase()] ?? p);
  return `Lien for ${named.join(", ")}`;
}

/**
 * `Unavailable` is the town saying this one is no longer for sale.
 *
 * It is not a word `parseLotStatus` knows, and it should not be: outside this
 * page it means nothing. Here it means the charge was paid or pulled between
 * publication and now, which is `redeemed` in every sense that matters to
 * somebody planning to bid. `Active` is the ordinary case and stays `pending`.
 */
function statusOf(row: NjRow) {
  const s = (row.status ?? "").trim().toLowerCase();
  if (s === "unavailable") return "redeemed" as const;
  if (s === "active") return "pending" as const;
  return parseLotStatus(row.status);
}

async function readCaptures(): Promise<NjCapture[]> {
  let files: string[];
  try {
    files = (await readdir(CAPTURE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: NjCapture[] = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(CAPTURE_DIR, f), "utf8")) as NjCapture;
      if (c.host && c.countyFips && c.saleDate && Array.isArray(c.rows)) out.push(c);
      else console.warn(`[nj-taxsale] ${f} is missing host, county, date or rows — skipped`);
    } catch {
      console.warn(`[nj-taxsale] ${f} is not readable JSON — skipped`);
    }
  }
  return out;
}

export const njTaxSaleAdapter: SourceAdapter = {
  name: "nj-taxsale",
  /*
   * `county_site` rather than a platform of its own, and that is a deliberate
   * under-claim. The imported calendar rows these captures fill in are already
   * `county_site`, and matching lets `adoptPlaceholder` absorb them instead of
   * leaving two rows per sale. A `realtaxlien` platform would be more accurate
   * and would need an enum migration to buy that accuracy; when one happens,
   * this should move.
   */
  platform: "county_site",
  description:
    "New Jersey municipal tax lien sales on RealAuction's newjerseytaxsale.com, " +
    "read from captures taken in the operator's browser. See docs/nj-taxsale-capture.md.",
  /* Captures, not a calendar crawl — see the field's note in types.ts. */
  enumeratesCalendar: false,

  async discoverCounties(): Promise<CountyBinding[]> {
    const captures = await readCaptures();
    const towns = await readTownLists();
    if (captures.length === 0 && towns.length === 0) {
      console.log(`[nj-taxsale] no captures in ${CAPTURE_DIR} — see docs/nj-taxsale-capture.md`);
      return [];
    }
    const byFips = new Map<string, CountyBinding>();
    for (const t of towns) if (getCounty(t.countyFips)) byFips.set(t.countyFips, { countyFips: t.countyFips, config: {} });
    for (const c of captures) {
      if (!getCounty(c.countyFips)) {
        console.warn(`[nj-taxsale] ${c.host}: ${c.countyFips} is not a county — skipped`);
        continue;
      }
      byFips.set(c.countyFips, { countyFips: c.countyFips, config: {} });
    }
    console.log(
      `[nj-taxsale] ${captures.length} capture(s) across ${byFips.size} county/counties`,
    );
    return [...byFips.values()];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const mine = (await readCaptures()).filter((c) => c.countyFips === binding.countyFips);
    const county = getCounty(binding.countyFips);

    const fromTowns: DiscoveredAuction[] = [];
    for (const t of (await readTownLists()).filter((l) => l.countyFips === binding.countyFips)) {
      const row = await importedRowFor(t);
      if (!row) {
        console.warn(`[nj-taxsale] ${t.municipality} ${t.saleDate}: no single imported sale by that name — skipped`);
        continue;
      }
      fromTowns.push({
        countyFips: t.countyFips,
        platform: row.platform as DiscoveredAuction["platform"],
        saleType: row.saleType as DiscoveredAuction["saleType"],
        externalId: row.externalId,
        saleDate: t.saleDate,
        saleDateConfirmed: true,
        listingKind: "sale_list" as const,
        title: t.municipality,
        status: "scheduled" as const,
        sourceUrl: t.url,
        /* The upsert replaces `raw`, so the imported row's own fields ride along. */
        raw: { ...row.raw, townList: t.url, municipality: t.municipality },
      });
    }

    return [...fromTowns, ...mine.map((c) => ({
      countyFips: c.countyFips,
      platform: "county_site" as const,
      saleType: "Tax Lien" as const,
      externalId: `nj-taxsale|${c.host}|${c.saleDate}`,
      saleDate: c.saleDate,
      /* The date is the town's own, off its published notice. */
      saleDateConfirmed: true,
      listingKind: "sale_list" as const,
      /*
       * Named for the town, filed under the county. See the header — the
       * schema is county-keyed and the sale is not the county's.
       */
      title: `${c.municipality}${county ? `, ${county.name} County ${county.state}` : ""} — tax lien sale ${c.saleDate}`,
      startTime: c.startTime,
      status: "scheduled" as const,
      sourceUrl: `https://${c.host}/index.cfm?folder=previewitems`,
      raw: { host: c.host, saleDate: c.saleDate, municipality: c.municipality, capturedAt: c.capturedAt },
    }))];
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const town = auction.raw as { townList?: string; municipality?: string } | undefined;
    if (town?.townList) {
      const lots = await lotsFromTownList(town.townList, {
        countyName: `${town.municipality}, ${getCounty(auction.countyFips)?.name ?? ""} County`,
        state: "NJ",
        sourceUrl: town.townList,
        saleDate: auction.saleDate,
      });
      /* A lien's amount is its face value, not an opening bid; see the header. */
      return lots.map((l) => ({ ...l, taxesOwed: l.taxesOwed ?? l.openingBid, openingBid: undefined }));
    }
    const raw = auction.raw as { host?: string; saleDate?: string } | undefined;
    if (!raw?.host || !raw.saleDate) return [];

    const capture = (await readCaptures()).find(
      (c) => c.host === raw.host && c.saleDate === raw.saleDate,
    );
    if (!capture) {
      console.warn(`[nj-taxsale] no capture for ${raw.host} ${raw.saleDate}`);
      return [];
    }

    const lots: DiscoveredLot[] = [];
    for (const r of capture.rows) {
      const parcelNumber = (r.parcelNumber ?? "").trim();
      if (!parcelNumber) continue;
      lots.push({
        /*
         * The advertisement number is unique within a sale and is what the
         * town calls the item; the parcel can repeat when a town advertises
         * two years of charges against one lot.
         */
        externalId: (r.advNum ?? "").trim() || parcelNumber,
        lotNumber: (r.advNum ?? "").trim() || undefined,
        parcelNumber,
        ownerName: (r.ownerName ?? "").trim() || undefined,
        legalDescription: chargeDescription(r.chargeType),
        /* Face value of the certificate, not a bid. See the header. */
        taxesOwed: money(r.faceAmount),
        status: statusOf(r),
        sourceUrl: auction.sourceUrl,
        raw: { advNum: r.advNum, taxYear: r.taxYear, chargeType: r.chargeType, status: r.status },
      });
    }

    /*
     * A partial capture is worse than none, because a sale showing 50 of 764
     * reads as a small sale rather than as a page that was not finished. The
     * town's own advertised count is carried in the capture so the gap can be
     * said out loud rather than inferred from a number nobody questions.
     */
    if (capture.announced && lots.length < capture.announced * 0.9) {
      console.warn(
        `[nj-taxsale] ${capture.host} ${capture.saleDate}: captured ${lots.length} of ` +
          `${capture.announced} advertised — the capture is incomplete`,
      );
    }
    return lots;
  },
};
