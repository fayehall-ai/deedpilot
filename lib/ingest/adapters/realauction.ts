/**
 * RealAuction tax sales, read from captures taken in the operator's browser.
 *
 * ## Access — this adapter never touches the network
 *
 * Measured twice on 2026-09-15: `robots.txt` on every RealAuction host is
 * `Disallow: /`, and the sale pages answer **403 in 118 bytes** to this
 * project's user agent while rendering fully in a browser with no login.
 * `underAgreement` does not change that — it skips robots, not the agent check.
 *
 * The operator holds a data agreement. That is a reason to be *given* access,
 * not a reason to present a user agent that is not ours; `bid4assets.ts` takes
 * the same position for the same reason. So the pages are opened in the
 * operator's own browser and posted to `/api/admin/realauction-capture`, and
 * this adapter reads only what that wrote. See `docs/realauction-capture.md`.
 *
 * An allow-listed agent or an API would replace all of it, and the request for
 * one is drafted at `artifacts/realauction-access-request.md`.
 *
 * ## The county is in the hostname, and that is the risky part
 *
 * A capture carries a host and a date, nothing else — `duval.realtaxdeed.com`
 * is the only thing that says "Duval". So `countyForHost` resolves it in four
 * steps, each narrower than a guess:
 *
 *   1. `data/county-directory.json`, which already binds portal URLs to FIPS,
 *      and only when exactly one county claims the host.
 *   2. an explicit alias table for the hosts no rule reaches — `miami` is
 *      Miami-Dade, `myorangeclerk` is Orange, `elpasoco.treasurersdeedsale`
 *      is El Paso *Colorado* and not the larger El Paso in Texas.
 *   3. Florida by name, because 85 of the 86 scheduled sales are Florida.
 *   4. every state by name, and only if the match is unique.
 *
 * Step 4 insists on uniqueness because `washington.realtaxdeed.com` is a name
 * thirty-odd states share, and filing a sale under the wrong Washington is the
 * failure `zeus.ts` records — a misassigned index put 8,611 parcels under a
 * county that never held them. An unresolvable host is reported, not guessed.
 *
 * ## Tax deed or mortgage foreclosure
 *
 * Several counties run both on one realforeclose host, separated only by the
 * sale date, so the platform's own `Auction Type` decides: `TAXDEED` and
 * `TAXLIEN` are inventory, `FORECLOSURE` is not and is dropped. Captures taken
 * before that field was recorded fall back to the county's statutory sale type
 * — which is what the `realtaxdeed.com` hosts sell by definition.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ALL_COUNTIES,
  countyLabel,
  findCountyByName,
  getCounty,
  resolveCountyRule,
} from "../../atlas";
import type { SaleType } from "../../atlas/types";
import { parseLotStatus } from "../lot-status";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const CAPTURE_DIR = join(process.cwd(), "data", "realauction-capture");
const DIRECTORY = join(process.cwd(), "data", "county-directory.json");

interface CaptureRow {
  parcelNumber?: string;
  openingBid?: string;
  addressLine?: string;
  certificate?: string;
  caseNumber?: string;
  status?: string;
  assessedValue?: string;
  /** The page's own "Auction Type" — TAXDEED, TAXLIEN, FORECLOSURE. */
  auctionType?: string;
  /** The sale's own start hour, e.g. "10/14/2026 09:00 AM ET". */
  startsAt?: string;
  /**
   * Which of the page's three lists the parcel sat in — W, C or R.
   *
   * Not decoration. A parcel under "Auctions Closed or Canceled" with no status
   * text is still an assertion by the county, made structurally rather than in
   * words, and without this the capture flattens it into an ordinary scheduled
   * parcel. See `statusOf`.
   */
  area?: string;
}

interface Capture {
  host: string;
  saleDate: string;
  capturedAt?: string;
  rows: CaptureRow[];
}

/** Hosts whose subdomain is not the county's name. */
const HOST_ALIASES: Record<string, string> = {
  /* Miami-Dade shortens itself; the clerk's own brand is the Orange host. */
  "miami.realtaxdeed.com": "12086",
  "miamidade.realforeclose.com": "12086",
  "myorangeclerk.realforeclose.com": "12095",
  "myorangeclerk.realtaxdeed.com": "12095",
  /* Colorado's El Paso, not the far larger one in Texas. */
  "elpasoco.treasurersdeedsale.realtaxdeed.com": "08041",
};

/** "$12,434.01" -> 12434.01. An empty or zero field is absent, not zero. */
function money(raw: string | undefined): number | undefined {
  const n = Number((raw ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Split what the platform prints into the fields that exist for it.
 *
 * The line is `1982 W 16TH ST JACKSONVILLE, FL- 32209` — street, city, then
 * the platform's own hyphen before the ZIP. The comma separates city from
 * state reliably, so state and ZIP come off cleanly; street from city does not,
 * because `PORT CHARLOTTE` and `PUNTA GORDA` have no delimiter before them.
 * Street and city therefore stay together in `addressLine`, which is the honest
 * division rather than a guess that would cut `PUNTA` from `GORDA`.
 *
 * Two counties print a marker where the street would be, for a parcel with no
 * situs address — Marion writes `NO SITUS OCALA, FL- 34482` and Putnam writes
 * `00 UNASSIGNED LOCATION RE`. That is the one case where the split IS
 * unambiguous: with no street, everything before the comma is the city. So the
 * marker yields a city and no address line, rather than a sentence in the field
 * a map pin reads from. Twenty-two of Putnam's sixty-seven parcels and most of
 * Marion's are this shape — vacant subdivision lots, which is much of what a
 * deed buyer is actually looking at.
 */
const NO_SITUS = /^(?:no\s*situs|0+\s+unassigned\s+location(?:\s+re)?)\b[\s,-]*/i;

function splitAddress(raw: string | undefined): {
  addressLine?: string;
  city?: string;
  zip?: string;
} {
  let s = (raw ?? "").trim();
  if (!s || /^0+$/.test(s)) return {};

  const noSitus = NO_SITUS.test(s);
  s = s.replace(NO_SITUS, "").trim();

  /*
   * `, FL- 32209`, `, FL 32209`, and Citrus's `, 34453` with no state at all.
   *
   * The state is optional because Citrus omits it, but a comma or a state
   * abbreviation must precede the digits: five trailing digits on their own
   * are as likely to be a unit or a lot number as a ZIP, and turning `LOT
   * 34453` into a ZIP would be worse than leaving the line whole.
   */
  let zip: string | undefined;
  const tail = /(?:,\s*(?:[A-Z]{2}\s*-?\s*)?|\s+[A-Z]{2}\s*-?\s*)(\d{5})(?:-\d{4})?\s*$/.exec(s);
  if (tail) {
    zip = tail[1];
    s = s.slice(0, tail.index).replace(/[\s,]+$/, "");
  }

  /* With no street, what is left before the comma is the city and nothing else. */
  if (noSitus) return { city: s || undefined, zip };
  return { addressLine: s || undefined, zip };
}

/** host -> fips, from the directory, and only where exactly one county claims it. */
let directoryIndex: Map<string, string> | null = null;
async function hostDirectory(): Promise<Map<string, string>> {
  if (directoryIndex) return directoryIndex;
  const claims = new Map<string, Set<string>>();
  try {
    const dir = JSON.parse(await readFile(DIRECTORY, "utf8")) as Record<
      string,
      { fips: string; links?: { url?: string }[] }
    >;
    for (const entry of Object.values(dir)) {
      for (const link of entry.links ?? []) {
        const m = /^https?:\/\/(?:www\.)?([a-z0-9.-]+\.real(?:taxdeed|foreclose|taxlien)\.com)/i.exec(
          link.url ?? "",
        );
        if (!m) continue;
        const host = m[1].toLowerCase();
        (claims.get(host) ?? claims.set(host, new Set()).get(host)!).add(entry.fips);
      }
    }
  } catch {
    /* No directory is survivable — the name rules below still resolve most hosts. */
  }
  directoryIndex = new Map(
    [...claims].filter(([, f]) => f.size === 1).map(([h, f]) => [h, [...f][0]]),
  );
  return directoryIndex;
}

/**
 * The county a capture belongs to, or null.
 *
 * Exported because this is the one place the adapter can silently file a sale
 * under the wrong county, and that deserves a test reaching it directly rather
 * than only through the filesystem.
 */
export async function countyForHost(rawHost: string) {
  const host = rawHost.replace(/^www\./, "").toLowerCase();

  const known = HOST_ALIASES[host] ?? (await hostDirectory()).get(host);
  if (known) return getCounty(known);

  const sub = host.split(".")[0];
  if (!sub) return null;
  const key = normalize(sub);
  if (key.length < 3) return null;

  /* Florida first: 85 of the 86 scheduled RealAuction sales are Florida. */
  const fl = findCountyByName("FL", sub.replace(/-/g, " "));
  if (fl) return fl;
  const flByKey = ALL_COUNTIES.find((c) => c.state === "FL" && normalize(c.name) === key);
  if (flByKey) return flByKey;

  /* Elsewhere, only a unique name. A capture cannot say which Washington. */
  const hits = ALL_COUNTIES.filter((c) => normalize(c.name) === key);
  return hits.length === 1 ? hits[0] : null;
}

async function readCaptures(): Promise<Capture[]> {
  let files: string[];
  try {
    files = (await readdir(CAPTURE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Capture[] = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(CAPTURE_DIR, f), "utf8")) as Capture;
      if (c.host && c.saleDate && Array.isArray(c.rows)) out.push(c);
    } catch {
      console.warn(`[realauction] ${f} is not readable JSON — skipped`);
    }
  }
  return out;
}

/**
 * What the sale actually sells.
 *
 * The page's own label wins where a capture recorded it, because one
 * realforeclose host serves both tax deeds and mortgage foreclosures and only
 * the label separates them. Otherwise the county's statute decides, which is
 * what a `realtaxdeed.com` host sells by definition.
 */
function saleTypeOf(capture: Capture, fips: string): SaleType | null {
  const labels = new Set(
    capture.rows.map((r) => normalize(r.auctionType ?? "")).filter(Boolean),
  );
  if (labels.size > 0) {
    if (labels.has("taxdeed")) return "Tax Deed";
    if (labels.has("taxlien")) return "Tax Lien";
    /* Mortgage foreclosure. Real, published, and not our inventory. */
    return null;
  }
  return resolveCountyRule(fips)?.saleType ?? "Tax Deed";
}

/**
 * What happened to a parcel, reading the page's grouping as well as its words.
 *
 * `parseLotStatus` is right to return `pending` for empty text: an unreadable
 * status means the parcel is still listed as far as anyone can tell. But on a
 * RealAuction page the county says something without words — it files the
 * parcel under "Auctions Waiting" or under "Auctions Closed or Canceled", and
 * Charlotte's 29 September sale has thirteen parcels in the closed list with no
 * status text at all.
 *
 * Reading only the words would publish those thirteen as inventory for a sale
 * that will not offer them. The sale has not happened yet, so nothing in that
 * list can have closed; what is left is cancelled.
 */
function statusOf(row: CaptureRow) {
  const said = parseLotStatus(row.status);
  if (said !== "pending") return said;
  return row.area === "C" ? ("cancelled" as const) : said;
}

/**
 * The hour the sale opens, as the county states it.
 *
 * Every parcel in a sale carries the same "10/14/2026 09:00 AM ET", so the
 * first one that has it speaks for the sale. Kept verbatim rather than parsed
 * into a timestamp: the zone abbreviation is the county's own wording, and
 * `AuctionLogistics` reads better with the county's words in it than with a
 * time we converted and might have converted wrongly.
 */
function startTimeOf(capture: Capture): string | undefined {
  for (const r of capture.rows) {
    const s = (r.startsAt ?? "").trim();
    if (s) return s.replace(/^\d{1,2}\/\d{1,2}\/\d{4}\s*/, "").trim() || undefined;
  }
  return undefined;
}

/**
 * The sale's own preview URL.
 *
 * No `www.`, and that is measured rather than stylistic: the certificate on
 * `www.putnam.realtaxdeed.com` and `www.bay.realtaxdeed.com` does not cover the
 * name, so a browser refuses the page outright with a privacy error. The bare
 * host serves TLS on every RealAuction host tried — realtaxdeed, realforeclose
 * and the El Paso treasurer's — and answers our own agent with the familiar
 * 403, which is proof it resolved. `data/county-directory.json` writes the
 * `www.` form throughout, so this is the one place not to copy it.
 */
const saleUrl = (host: string, saleDate: string) => {
  const [y, m, d] = saleDate.split("-");
  return `https://${host}/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&AUCTIONDATE=${m}/${d}/${y}`;
};

export const realauctionAdapter: SourceAdapter = {
  name: "realauction",
  platform: "realtaxdeed",
  description:
    "RealAuction tax deed and tax lien sales (realtaxdeed / realforeclose), read from " +
    "captures taken in the operator's browser. See docs/realauction-capture.md.",
  /* Captures, not a calendar crawl — see the field's note in types.ts. */
  enumeratesCalendar: false,

  async discoverCounties(): Promise<CountyBinding[]> {
    const captures = await readCaptures();
    if (captures.length === 0) {
      console.log(`[realauction] no captures in ${CAPTURE_DIR} — see docs/realauction-capture.md`);
      return [];
    }

    const byFips = new Map<string, CountyBinding>();
    const unmapped = new Set<string>();

    for (const c of captures) {
      const county = await countyForHost(c.host);
      if (!county) {
        unmapped.add(c.host);
        continue;
      }
      byFips.set(county.fips, {
        countyFips: county.fips,
        config: { host: c.host, countyName: county.name, state: county.state },
      });
    }

    if (unmapped.size > 0) {
      /* Loud: a capture nobody can file is work the operator already paid for. */
      console.warn(
        `[realauction] ${unmapped.size} capture host(s) match no county — ` +
          `add them to HOST_ALIASES: ${[...unmapped].join(", ")}`,
      );
    }
    console.log(`[realauction] ${captures.length} capture(s) across ${byFips.size} county/counties`);
    return [...byFips.values()];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const { host } = binding.config as unknown as { host: string };
    const county = getCounty(binding.countyFips);
    const mine = (await readCaptures()).filter((c) => c.host === host);

    const out: DiscoveredAuction[] = [];
    for (const c of mine) {
      const saleType = saleTypeOf(c, binding.countyFips);
      if (!saleType) {
        console.log(`[realauction] ${host} ${c.saleDate} is a mortgage foreclosure — skipped`);
        continue;
      }
      out.push({
        countyFips: binding.countyFips,
        platform: host.includes("realforeclose") ? "realforeclose" : "realtaxdeed",
        saleType,
        /*
         * Keyed on host and date, not on anything inside the capture.
         *
         * The same sale re-captured next week must land on the same row, and
         * the platform's case numbers belong to parcels rather than to sales.
         */
        externalId: `realauction|${host}|${c.saleDate}`,
        saleDate: c.saleDate,
        /* The date came off the county's own auction calendar, in the URL. */
        saleDateConfirmed: true,
        listingKind: "sale_list",
        startTime: startTimeOf(c),
        /*
         * `countyLabel` rather than "County", because RealAuction also runs
         * Newark and Hardyston in New Jersey, which are a city and a township.
         */
        title: county
          ? `${countyLabel(county.state, county.name)}, ${county.state} — ${saleType} sale ${c.saleDate}`
          : `${host} — ${saleType} sale ${c.saleDate}`,
        status: "scheduled",
        sourceUrl: saleUrl(host, c.saleDate),
        raw: { host, saleDate: c.saleDate, capturedAt: c.capturedAt, rows: c.rows.length },
      });
    }
    return out;
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const raw = auction.raw as { host?: string; saleDate?: string } | undefined;
    if (!raw?.host || !raw.saleDate) return [];

    const capture = (await readCaptures()).find(
      (c) => c.host === raw.host && c.saleDate === raw.saleDate,
    );
    if (!capture) {
      console.warn(`[realauction] no capture for ${raw.host} ${raw.saleDate}`);
      return [];
    }

    const lots: DiscoveredLot[] = [];
    for (const r of capture.rows) {
      const parcelNumber = (r.parcelNumber ?? "").trim();
      if (!parcelNumber) continue;

      /*
       * A redeemed parcel is recorded, not dropped.
       *
       * The owner has paid and it will not be sold, but quietly omitting it
       * would make a sale of ten parcels indistinguishable from a sale of
       * twenty where half redeemed — and the second is the more useful thing
       * for a bidder to know. `parseLotStatus` owns that judgement; this hands
       * it what the page said and nothing more.
       */
      lots.push({
        externalId: parcelNumber,
        parcelNumber,
        caseNumber: r.caseNumber?.trim() || undefined,
        ...splitAddress(r.addressLine),
        openingBid: money(r.openingBid),
        assessedValue: money(r.assessedValue),
        status: statusOf(r),
        sourceUrl: auction.sourceUrl,
        raw: { certificate: r.certificate, auctionType: r.auctionType, status: r.status, area: r.area },
      });
    }

    if (lots.length === 0) {
      console.warn(`[realauction] capture for ${raw.host} ${raw.saleDate} holds no parcels`);
    }
    return lots;
  },
};
