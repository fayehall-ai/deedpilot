/**
 * Bid4Assets — county tax and foreclosure sales across CA, FL, LA, NV, PA, WA.
 *
 * ## Access — this adapter never touches the network
 *
 * It imports `node:fs`, not `politeFetch`. There is no code path from here to
 * the host, which is a structural guarantee rather than an intention — the same
 * stance `govease.ts` and `sri.ts` take, reached here for two reasons.
 *
 * The first is that the catalog is not in the storefront pages. Five were
 * checked — including `AlamedaMar26`, a sale that closed six months ago, and
 * `FayetteCoTaxUpset2026`, one still to come — and every one served zero lot
 * rows and zero auction links. Two page loads watched in a real browser
 * produced only tracking pixels.
 *
 * **That is true of storefronts and not of the host.** `/philataxsales`, the
 * Philadelphia sheriff's list, renders a full Kendo grid to anyone, with a
 * `?salesdate=YYYYMMDD` selector covering every scheduled sale and a
 * dataSource carrying parcel, address, minimum bid, debt, sale type and status
 * per row — richer than the visible table. `pageSize(1000)` on that dataSource
 * returns the whole sale in one go. So the shape of a Bid4Assets capture
 * depends on which kind of page a county publishes, and "no catalog in the
 * page" is a fact about storefronts rather than a property of the platform.
 *
 * The second is an active edge control, and it is worth recording precisely
 * because the obvious reading of it is wrong. `robots.txt` returns 404 — no
 * robots file, which conventionally permits crawling — and on that basis the
 * host looks open. It is not. The same index URL returns **200 to a browser
 * user agent and 403 to this project's**, so the block is on who is asking
 * rather than on what robots says. Getting past it would mean sending a user
 * agent that is not ours, which is defeating the control rather than reading
 * the posture. `policy.ts` records the host as `requires_agreement`, and the
 * operator's agreement is real, but an agreement is a reason to be given access
 * — not a reason to take it by looking like someone else.
 *
 * So the pages are opened in the operator's own browser and saved to
 * `data/bid4assets-capture/`. See `docs/bid4assets-capture.md`.
 *
 * ## One file per sale, and no separate index
 *
 * Each capture carries its own county, state, sale date and rows, so auctions
 * are derived from the captures themselves. That is `sri.ts`'s arrangement and
 * for its reason: a registry file listing which sales exist is a second thing
 * to keep in sync, and it goes stale in a different direction from the data.
 *
 * ## The row shape is deliberately tolerant
 *
 * The grid's column names could not be observed — it never renders without a
 * session — so `rows` is whatever the operator's snippet produced and the
 * mapping below works by alias. A file that yields rows but no parcel numbers
 * is reported loudly rather than returning nothing: a silent empty list is
 * indistinguishable from a sale with no lots, and only one of those is a bug.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { findCountyByName } from "../../atlas";
import { parseLotStatus } from "../lot-status";
import type { SaleType } from "../../atlas/types";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const BASE = "https://www.bid4assets.com";
const CAPTURE_DIR = join(process.cwd(), "data", "bid4assets-capture");

/** What the operator's snippet writes. `rows` is untyped on purpose. */
interface B4aCapture {
  /** Storefront slug — "ColumbiaPATaxSaleSep26". Ties the file to its sale. */
  slug: string;
  /** "Columbia County" / "PA", read off the sale's own heading. */
  county: string;
  state: string;
  /** ISO date the sale runs. Without one there is no auction; see below. */
  saleDate?: string;
  title?: string;
  capturedAt?: string;
  rows: Record<string, unknown>[];
}

interface Resolved extends B4aCapture {
  countyFips: string;
  saleType: SaleType;
}

/** Sale wording to ours. Unknown wording stays a deed rather than a guess. */
function saleTypeFor(title: string): SaleType {
  const t = title.toLowerCase();
  if (/lien|certificate/.test(t)) return "Tax Lien";
  if (/redeemable/.test(t)) return "Redeemable Deed";
  return "Tax Deed";
}

/**
 * First value among a set of aliases, ignoring case, spaces and punctuation.
 *
 * The grid's column names are unknown, so every field is looked up by the names
 * such a grid plausibly uses rather than by one guessed key.
 */
function pick(row: Record<string, unknown>, ...aliases: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  const lower = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  for (const a of aliases) {
    const v = lower.get(norm(a));
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

const money = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Captures on disk, resolved to a county, keyed by slug. */
async function loadCaptures(): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  let files: string[];
  try {
    files = (await readdir(CAPTURE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }

  for (const file of files) {
    let capture: B4aCapture;
    try {
      capture = JSON.parse(await readFile(join(CAPTURE_DIR, file), "utf8")) as B4aCapture;
    } catch {
      console.warn(`[bid4assets] ${file} is not readable JSON — skipped`);
      continue;
    }

    if (!Array.isArray(capture?.rows) || !capture?.county || !capture?.state) {
      console.warn(`[bid4assets] ${file} needs county, state and rows — skipped`);
      continue;
    }

    const county = findCountyByName(capture.state.toUpperCase(), capture.county);
    if (!county) {
      console.warn(
        `[bid4assets] ${file}: no county matches "${capture.county}, ${capture.state}" — skipped`,
      );
      continue;
    }

    const slug = capture.slug ?? file.replace(/\.json$/, "");
    out.set(slug, {
      ...capture,
      slug,
      countyFips: county.fips,
      saleType: saleTypeFor(capture.title ?? ""),
    });
  }
  return out;
}

export const bid4assetsAdapter: SourceAdapter = {
  name: "bid4assets",
  platform: "bid4assets",
  description:
    "Bid4Assets county tax and foreclosure sales, read from browser captures in " +
    "data/bid4assets-capture/. The listings do not appear in the pages and the host answers this " +
    "project's user agent with 403, so nothing here fetches.",
  /* Captures, not a calendar crawl — see the field's note in types.ts. */
  enumeratesCalendar: false,

  async discoverCounties(): Promise<CountyBinding[]> {
    const captures = await loadCaptures();
    if (captures.size === 0) {
      console.log(
        `[bid4assets] no captures in ${CAPTURE_DIR} — see docs/bid4assets-capture.md`,
      );
      return [];
    }

    const byCounty = new Map<string, Resolved[]>();
    for (const c of captures.values()) {
      const list = byCounty.get(c.countyFips) ?? [];
      list.push(c);
      byCounty.set(c.countyFips, list);
    }
    console.log(
      `[bid4assets] ${captures.size} capture(s) across ${byCounty.size} county/counties`,
    );
    return [...byCounty].map(([countyFips, list]) => ({ countyFips, config: { sales: list } }));
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const sales = (binding.config.sales as Resolved[] | undefined) ?? [];

    return sales.flatMap((s) => {
      /*
       * No date, no auction. The index carries none, so it comes off the sale's
       * own page in the operator's browser — and an auction dated by anything
       * else is the failure the rest of this work has been unpicking. A
       * projected date would make `saleDateConfirmed` a lie and CAPE would
       * inherit it as "Auction date is projected, not county-published".
       */
      if (!s.saleDate) {
        console.warn(`[bid4assets] ${s.slug}: capture has no saleDate — skipped`);
        return [];
      }

      return [
        {
          countyFips: binding.countyFips,
          platform: "bid4assets" as const,
          saleType: s.saleType,
          externalId: `b4a|${s.slug}`,
          saleDate: s.saleDate,
          // Read off the sale's own page, not projected from a calendar.
          saleDateConfirmed: true,
          listingKind: "sale_list" as const,
          title: s.title ?? `${s.county}, ${s.state}`,
          sourceUrl: `${BASE}/storefront/${s.slug}`,
          raw: { slug: s.slug, capturedAt: s.capturedAt, capturedRows: s.rows.length },
        },
      ];
    });
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const slug = (auction.raw?.slug as string) ?? auction.externalId.replace(/^b4a\|/, "");
    const capture = (await loadCaptures()).get(slug);
    if (!capture) return [];

    const lots: DiscoveredLot[] = [];
    for (const row of capture.rows) {
      const parcelNumber = pick(row, "apn", "parcelNumber", "parcel", "parcelId", "pin", "taxId");
      if (!parcelNumber) continue;

      lots.push({
        externalId: pick(row, "auctionId", "itemId", "lotId", "id"),
        lotNumber: pick(row, "lotNumber", "itemNumber", "lot"),
        parcelNumber,
        addressLine: pick(row, "address", "situsAddress", "propertyAddress", "streetAddress"),
        city: pick(row, "city", "situsCity"),
        zip: pick(row, "zip", "zipCode", "postalCode"),
        legalDescription: pick(row, "legalDescription", "legal", "description"),
        openingBid: money(pick(row, "minimumBid", "openingBid", "startingBid", "minBid")),
        assessedValue: money(pick(row, "assessedValue", "assessment")),
        taxesOwed: money(pick(row, "taxesOwed", "amountDue", "taxDue")),
        soldAmount: money(pick(row, "winningBid", "soldAmount", "highBid", "currentBid")),
        /*
         * One shared vocabulary. Three adapters kept their own copy of this
         * mapping and drifted, one recording every sold parcel as redeemed.
         */
        status: parseLotStatus(pick(row, "status", "auctionStatus", "saleStatus")),
        sourceUrl: auction.sourceUrl,
        raw: row,
      });
    }

    if (lots.length === 0 && capture.rows.length > 0) {
      console.warn(
        `[bid4assets] ${slug}: ${capture.rows.length} captured row(s) but no parcel number matched. ` +
          `Columns seen: ${Object.keys(capture.rows[0] ?? {}).slice(0, 12).join(", ")}. ` +
          `Add the right alias to \`pick\` in lib/ingest/adapters/bid4assets.ts.`,
      );
    }
    return lots;
  },
};
