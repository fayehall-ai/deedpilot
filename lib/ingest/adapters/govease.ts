/**
 * GovEase — county tax sales across 13 states from one portal.
 *
 * GovEase runs online tax lien and tax deed sales for counties in AL, CA, CO,
 * GA, IA, IN, LA, MO, MS, OK, PA, TN, TX and WA. The public portal publishes
 * the auction registry and, once a county uploads it, the parcel catalog —
 * owner, parcel number, opening bid and legal description — with no login.
 *
 * ## Access
 *
 * `liveauctions.govease.com/robots.txt` is `User-agent: * / Disallow: /`,
 * and `policy.ts` records the host as `requires_agreement`. This adapter runs
 * `underAgreement: true`, which bypasses the robots check but never the rate
 * limiter. That is a deliberate operator decision recorded here rather than
 * hidden: the data is a public record published without authentication, and
 * the account owner authorised this route on 2026-08-05. Revisit it if GovEase
 * objects or publishes terms that speak to automated access — and prefer the
 * county's own list wherever one exists.
 *
 * ## Shape of the source
 *
 * Three things took a while to establish, so they are written down:
 *
 * 1. **A session is required.** A cold GET of the registry returns a 1.8 KB
 *    bootstrap shell. The page POSTs its timezone to `/PublicPortal/SetTimeZone`
 *    and only then serves the 220 KB grid. `bootstrapSession` replays that.
 *
 * 2. **The catalog URL needs the entity slug.** `/{state}/{slug}/{id}/browsestandard`
 *    silently returns an *empty grid* — not a 404 — when the slug is wrong, so
 *    a guessed slug looks exactly like an auction with no parcels. The slugs
 *    live in a `<select>` on the registry page as `{state}|{slug}|{auctionId}`.
 *
 * 3. **Catalogs publish late.** Counties upload parcels days before the sale,
 *    not when the auction is scheduled. On 2026-08-05, 43 upcoming auctions
 *    yielded lots from only 2 — Costilla (6 days out) and Saguache (7). All 38
 *    Mississippi sales set for 2026-08-31 were still empty. This adapter is a
 *    recurring harvester, not a one-time bulk load; it must be re-run as sale
 *    dates approach or it will report a near-empty state forever.
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
import type { SaleType } from "../../atlas/types";

const BASE = "https://liveauctions.govease.com";
const REGISTRY_PATH = "/PublicPortal/PublicRegisterAuctions";

/**
 * Set on every request. See the access note above — this is an operator
 * decision, not an inference the code made on its own.
 */
const FETCH_OPTS = { underAgreement: true as const, timeoutMs: 45_000 };

interface GovEaseAuction {
  auctionId: string;
  /** Two-letter state, lowercase as the URL wants it. */
  stateSlug: string;
  state: string;
  /** Entity slug from the registry select. Required — a wrong one reads empty. */
  slug: string;
  name: string;
  entity: string;
  /** GovEase's own type label: "Tax Deed", "Tax Lien", "Foreclosure", … */
  typeLabel: string;
  /** YYYY-MM-DD in the sale's own local date. */
  saleDate: string;
  startTime?: string;
}

/**
 * GovEase's type vocabulary mapped to the atlas buckets.
 *
 * "Redeemable Tax Deed" is kept distinct from "Tax Deed": the redemption right
 * is the whole difference in the max-bid arithmetic, and collapsing them would
 * price a redeemable deed as if the buyer took clear title on sale day.
 */
function toSaleType(label: string): SaleType {
  const l = label.toLowerCase();
  if (l.includes("lien")) return "Tax Lien";
  if (l.includes("redeemable")) return "Redeemable Deed";
  if (l.includes("deed")) return "Tax Deed";
  // Sheriff/judicial foreclosure sales convey a deed subject to local
  // redemption rules that vary by state — the honest bucket is Hybrid.
  if (l.includes("foreclosure")) return "Hybrid";
  return "Tax Deed";
}

/**
 * Parse "08/31/2026 06:30:00 AM PDT" into a local date and time.
 *
 * The timezone suffix is deliberately ignored rather than converted: GovEase
 * renders the county's own advertised local time, and shifting it to UTC and
 * back is what moves a sale onto the wrong day.
 */
function parseSaleDateTime(raw: string): { date: string; time?: string } | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi] = m;
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: hh && mi ? `${hh}:${mi}` : undefined,
  };
}

function isUpcoming(iso: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return iso >= today;
}

function parseMoney(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Establish a session and return the registry HTML.
 *
 * The bootstrap shell POSTs the browser's timezone before the server will
 * render the grid. Without it every request returns the same 1.8 KB stub,
 * which parses to zero auctions and looks like an empty portal.
 */
async function bootstrapSession(): Promise<{ html: string; cookie: string }> {
  const seed = await politeFetch(`${BASE}${REGISTRY_PATH}`, FETCH_OPTS);
  const cookie = seed.setCookie.map((c) => c.split(";")[0]).join("; ");

  const tz = await politeFetch(`${BASE}/PublicPortal/SetTimeZone`, {
    ...FETCH_OPTS,
    method: "POST",
    headers: {
      "x-requested-with": "XMLHttpRequest",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({
      clientTZ: new Date().toString(),
      RawUrl: REGISTRY_PATH,
    }).toString(),
  });

  const merged = [
    cookie,
    ...tz.setCookie.map((c) => c.split(";")[0]),
  ]
    .filter(Boolean)
    .join("; ");

  const grid = await politeFetch(`${BASE}${REGISTRY_PATH}`, {
    ...FETCH_OPTS,
    headers: merged ? { cookie: merged } : {},
  });

  return { html: grid.body, cookie: merged };
}

/**
 * Read the registry grid.
 *
 * Two structures on one page, joined on auction id: a `<select>` carrying the
 * entity slug, and the table carrying entity, type and sale date. The slug is
 * only in the select; the date is only in the table.
 */
export function parseRegistry(html: string): GovEaseAuction[] {
  const $ = cheerio.load(html);

  const slugs = new Map<string, { stateSlug: string; slug: string }>();
  $("option").each((_, el) => {
    const value = $(el).attr("value") ?? "";
    const m = /^([a-z]{2})\|([^|]+)\|(\d+)$/.exec(value);
    if (m) slugs.set(m[3], { stateSlug: m[1], slug: m[2] });
  });

  const out: GovEaseAuction[] = [];
  const seen = new Set<string>();

  $("tr").each((_, el) => {
    const row = $(el);
    const onclick = row.find("[onclick]").addBack("[onclick]").attr("onclick") ?? row.html() ?? "";
    const idMatch = /AuctionID=(\d+)/.exec(onclick);
    if (!idMatch) return;
    const auctionId = idMatch[1];
    if (seen.has(auctionId)) return;

    const cells = row
      .find("td")
      .map((__, c) => $(c).text().replace(/\s+/g, " ").trim())
      .get();
    // [checkbox, name, state, entity, type, startDate, action]
    if (cells.length < 7) return;

    const when = parseSaleDateTime(cells[5]);
    const slug = slugs.get(auctionId);
    if (!when || !slug) return;

    seen.add(auctionId);
    out.push({
      auctionId,
      stateSlug: slug.stateSlug,
      state: cells[2].toUpperCase(),
      slug: slug.slug,
      name: cells[1],
      entity: cells[3],
      typeLabel: cells[4],
      saleDate: when.date,
      startTime: when.time,
    });
  });

  return out;
}

/**
 * Resolve the county a GovEase auction belongs to.
 *
 * The entity name is not reliable on its own — Pennsylvania bureaus register
 * as a bare "Tax Claim Bureau" — so the auction name is tried first, where the
 * county is nearly always spelled out ("2026 Adams County Tax Auction").
 *
 * Municipal sellers ("City of Oxford Tax Collector") return null rather than
 * being folded into the surrounding county. A city tax sale is a different
 * levy under different rules, and attributing it to the county would put lots
 * on a county page that the county is not selling.
 */
export function resolveCounty(state: string, auctionName: string, entity: string) {
  if (/^(city|town|village|borough) of /i.test(entity.trim())) return null;

  for (const text of [auctionName, entity]) {
    // "Bolivar District 1 Fall Tax Auction" → Bolivar; Louisiana uses Parish.
    const m = /([A-Za-z][A-Za-z .'\-]*?)\s+(?:County|Parish)\b/i.exec(text);
    const candidate = m?.[1]?.replace(/^\d{4}\s+/, "").trim();
    if (candidate) {
      const hit = findCountyByName(state, candidate);
      if (hit) return hit;
    }
  }

  // Fall back to the leading words of the auction name, which covers
  // "2026 Adams Tax Auction" style entries with no County/Parish token.
  const stripped = auctionName.replace(/^\d{4}\s+/, "");
  const words = stripped.split(/\s+/);
  for (let take = Math.min(3, words.length); take >= 1; take--) {
    const hit = findCountyByName(state, words.slice(0, take).join(" "));
    if (hit) return hit;
  }
  return null;
}

/** A parcel row from the catalog grid. */
function rowToLot(
  $: cheerio.CheerioAPI,
  row: ReturnType<cheerio.CheerioAPI>,
  sourceUrl: string,
): DiscoveredLot | null {
  const link = row.find("a[href*='openstandardparcel']").first();
  if (link.length === 0) return null;

  const cells = row
    .find("td")
    .map((_, c) => $(c).text().replace(/\s+/g, " ").trim())
    .get();
  // [control, watch, unique#, parcel#, owner, startingBid, legal, address, …]
  if (cells.length < 6) return null;

  const uniqueId = link.text().trim() || cells[2];
  const parcelNumber = cells[3] || undefined;
  if (!uniqueId && !parcelNumber) return null;

  // The owner cell truncates for display; the full value is on the popover.
  const ownerCell = row.find("[data-content]").first();
  const ownerName = (ownerCell.attr("data-content") || cells[4] || "").trim();

  const href = link.attr("href") ?? "";

  return {
    externalId: uniqueId || parcelNumber,
    lotNumber: uniqueId || undefined,
    parcelNumber,
    ownerName: ownerName || undefined,
    legalDescription: cells[6] || undefined,
    addressLine: cells[7] || undefined,
    // GovEase publishes the county's opening bid — taxes, interest and costs.
    // It is not an assessed value and must not be read as one.
    openingBid: parseMoney(cells[5]),
    status: "pending" as const,
    sourceUrl: href ? new URL(href, BASE).toString() : sourceUrl,
  };
}

export function parseCatalog(html: string, sourceUrl: string): DiscoveredLot[] {
  const $ = cheerio.load(html);
  const lots: DiscoveredLot[] = [];
  $("tr").each((_, el) => {
    const lot = rowToLot($, $(el), sourceUrl);
    if (lot) lots.push(lot);
  });
  return lots;
}

function catalogUrl(a: GovEaseAuction): string {
  return `${BASE}/${a.stateSlug}/${a.slug}/${a.auctionId}/browsestandard`;
}

export const goveaseAdapter: SourceAdapter = {
  name: "govease",
  platform: "govease",
  description:
    "GovEase public auction portal — county tax lien and tax deed sales across " +
    "13 states. Catalogs publish shortly before each sale, so re-run as dates approach.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const { html, cookie } = await bootstrapSession();
    const auctions = parseRegistry(html).filter((a) => isUpcoming(a.saleDate));

    const byFips = new Map<string, CountyBinding>();
    const unmapped: string[] = [];

    for (const a of auctions) {
      const county = resolveCounty(a.state, a.name, a.entity);
      if (!county) {
        unmapped.push(`${a.state} ${a.name} (${a.entity})`);
        continue;
      }
      const existing = byFips.get(county.fips);
      const list = (existing?.config.auctions as GovEaseAuction[] | undefined) ?? [];
      list.push(a);
      byFips.set(county.fips, {
        countyFips: county.fips,
        config: { countyName: county.name, cookie, auctions: list },
      });
    }

    if (unmapped.length > 0) {
      // Municipal and unnamed-bureau sellers. Logged rather than dropped
      // silently so the gap is countable.
      console.warn(`[govease] ${unmapped.length} auction(s) not mapped to a county:`);
      for (const u of unmapped.slice(0, 20)) console.warn(`  ${u}`);
    }

    return [...byFips.values()];
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const cfg = binding.config as unknown as {
      countyName: string;
      auctions: GovEaseAuction[];
    };

    return cfg.auctions.map((a) => ({
      countyFips: binding.countyFips,
      platform: "govease" as const,
      saleType: toSaleType(a.typeLabel),
      externalId: `govease|${a.auctionId}`,
      saleDate: a.saleDate,
      // GovEase renders the county's own scheduled date and time.
      saleDateConfirmed: true,
      // The catalog is the actual sale list — not a delinquent roll.
      listingKind: "sale_list" as const,
      startTime: a.startTime,
      title: a.name,
      status: "scheduled" as const,
      sourceUrl: catalogUrl(a),
      raw: {
        auctionId: a.auctionId,
        entity: a.entity,
        typeLabel: a.typeLabel,
        countyName: cfg.countyName,
      },
    }));
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const res = await politeFetch(auction.sourceUrl, FETCH_OPTS);
    if (res.status !== 200) {
      console.warn(`[govease] ${auction.sourceUrl} returned ${res.status}`);
      return [];
    }
    const lots = parseCatalog(res.body, auction.sourceUrl);
    if (lots.length === 0) {
      // Expected before a county uploads its catalog. Returning empty means
      // the runner does not persist a skeleton auction.
      console.warn(
        `[govease] catalog not yet published for ${auction.title} (${auction.saleDate})`,
      );
    }
    return lots;
  },
};
