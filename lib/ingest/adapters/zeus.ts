/**
 * Zeus Auction — the public sale pages at `zeusauction.com`.
 *
 * ## Why this exists, and what it fixes
 *
 * Zeus inventory used to arrive through the generic adapter, bound to a county
 * by `data/source-registry.json`. That binding was wrong and could only ever
 * have been wrong: the registry pinned `publicauctions.php` — Zeus's *national*
 * index of every sale it hosts — to St. Joseph County, Indiana, at confidence
 * 0.43. The generic adapter keys its auctions `${countyFips}|${saleDate}` and
 * files whatever it scrapes under the county it was told, so 8,611 Lake County
 * parcels were recorded against St. Joseph. See
 * `scripts/repair-lake-county-misassignment.ts`.
 *
 * The index names the county itself, in a column headed **Collector**, reading
 * "Lake County, IN". A platform that publishes its own county has no business
 * being told one by a registry, which is what `discoverCounties` is for and why
 * every other platform in this directory has one.
 *
 * The generic adapter also *projects* sale dates from the state's typical
 * schedule, which is why so many packages carry "Auction date is projected, not
 * county-published". Zeus prints the real window on both pages, so auctions
 * from here are `saleDateConfirmed`.
 *
 * ## Why this is not `sri.ts`, which is also `platform: "zeus"`
 *
 * SRI Services is the sale agent for counties in seven states and runs its
 * bidding through Zeus, so that adapter carries the same platform tag. It
 * deliberately never touches the network: SRI's listings come from an API that
 * rejects any request without the SPA's `x-api-key`, and lifting a key out of a
 * public bundle to authenticate against a server we do not own is a different
 * act from reading a public page.
 *
 * None of that applies here. `zeusauction.com/publicauctions.php` and
 * `publicsale.php` are server-rendered HTML, served unauthenticated, and the
 * host publishes no robots.txt at all — so nothing is disallowed. The two
 * adapters read different origins for different reasons and both are correct.
 *
 * ## Shape of the source
 *
 * The index is one table: Sale, Collector, Sale Type, Starts, Ends, Status,
 * Items, Total Face Amount, and a link to `publicsale.php?idSale=N`. The sale
 * page repeats that header and then lists every item inline — 4MB of HTML for
 * a seven-thousand-parcel sale, no pagination and no XHR. One fetch per sale.
 *
 * ## That description is out of date, and the adapter has never run
 *
 * Re-checked 2026-09-15, in a browser as well as from the server, because
 * `ingest_runs` holds not one row for this adapter:
 *
 *  - `publicauctions.php` still returns 200 and 80KB, but its `<tbody>` is
 *    empty. The rows are fetched by DataTables from
 *    `methods/salelistresults.php`, which does still serve them: 81 sales,
 *    with the county in the sale title — "2026 Dekalb County Indiana Tax Lien
 *    Sale", 10/6/2026, Items: 93. So `discoverCounties` can be rebuilt on that
 *    endpoint and would work.
 *  - `publicsale.php?idSale=N` no longer exists. It 302s to the index, which is
 *    why a server fetch of it returns exactly the index's 79,953 bytes. The
 *    link in each row now points at `auctionsale.php?idSale=N`.
 *  - `auctionsale.php?idSale=N` renders an empty shell. In a real browser the
 *    body is the words "Skip to main content", there is no `#AuctionItemsResults`
 *    container, no `dosearch` function, and — decisively — the page issues no
 *    request for items at all.
 *  - `methods/auctionitemsresults.php` answers 500 to every shape tried: with a
 *    PHP session, with the `timezone.php` handshake replayed, with a referer,
 *    with `x-requested-with`, and with all fourteen parameters the public
 *    `dosearch` used to send. The 500 body renders the item table's header and
 *    then dies.
 *
 * The other tell is in the row markup itself: beside "view" sits "manage
 * batches / load files", which is a collector's action, not a bidder's. The
 * list endpoint is serving an operator template to an unauthenticated caller.
 *
 * Read together: Zeus has withdrawn the public per-sale item view. The index is
 * still public and still useful — it is how a county, a confirmed sale date and
 * an item count can be had — but the parcels behind it are not reachable without
 * an account, and an account is a different question from a public page.
 *
 * What NOT to do, since it is the obvious next thought: the index rows are
 * already in the database from the operator's sale calendar, under different
 * external ids. Rebuilding `discoverCounties` on `salelistresults.php` without
 * reconciling those would duplicate every Indiana sale rather than enrich it.
 */

import { politeFetch } from "../fetch";
import { findCountyByName } from "../../atlas";
import { parseLotStatus } from "../lot-status";
import type { SaleType } from "../../atlas/types";
import type {
  CountyBinding,
  DiscoveredAuction,
  DiscoveredLot,
  SourceAdapter,
} from "../types";

const BASE = "https://www.zeusauction.com";
const INDEX = `${BASE}/publicauctions.php`;

/** One row of the index table. */
interface ZeusSale {
  idSale: string;
  title: string;
  /** The Collector cell, verbatim — "Lake County, IN". */
  collector: string;
  countyFips: string;
  saleTypeRaw: string;
  /** ISO dates parsed from "9/4/2026 5:30 PM CDT". */
  startsIso: string | null;
  endsIso: string | null;
  startTime: string | null;
  statusRaw: string;
  items: number;
}

const strip = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Cells of every `<tr>` in a document, already stripped to text. */
function rows(html: string): string[][] {
  const out: string[][] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => strip(c[1]));
    if (cells.length > 0) out.push(cells);
  }
  return out;
}

/**
 * "9/4/2026 5:30 PM CDT" -> { date: "2026-09-04", time: "5:30 PM CDT" }.
 *
 * The zone is kept as text rather than converted. Zeus prints the sale's own
 * local zone and a sale date is a local fact — shifting it to UTC is how a
 * Tuesday sale becomes a Monday one for a reader west of the auction.
 */
function parseWhen(raw: string): { date: string | null; time: string | null } {
  const m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?/);
  if (!m) return { date: null, time: null };
  const [, mo, d, y, rest] = m;
  const date = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return { date, time: rest?.trim() || null };
}

/** Zeus's sale-type wording to ours. Unknown wording stays a lien, not a guess. */
function saleTypeFor(raw: string, title: string): SaleType {
  const t = `${raw} ${title}`.toLowerCase();
  if (/certificate|lien/.test(t)) return "Tax Lien";
  if (/commissioner|surplus|deed/.test(t)) return "Tax Deed";
  return "Tax Lien";
}

function auctionStatusFor(raw: string): DiscoveredAuction["status"] {
  const s = raw.toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/postpon/.test(s)) return "postponed";
  if (/closed|ended|complete/.test(s)) return "closed";
  if (/open|live|bidding/.test(s)) return "live";
  return "scheduled";
}

/**
 * The index, fetched once per process.
 *
 * `discoverCounties` and `listAuctions` both need it, and it is one page
 * describing every sale on the platform. Fetching it per county binding would
 * ask the same question once for each answer it already contains.
 */
let indexCache: Promise<ZeusSale[]> | null = null;

async function loadIndex(): Promise<ZeusSale[]> {
  if (!indexCache) indexCache = fetchIndex();
  return indexCache;
}

/** Exposed so a long-running process can pick up a newly posted sale. */
export function resetZeusIndexCache(): void {
  indexCache = null;
}

async function fetchIndex(): Promise<ZeusSale[]> {
  const res = await politeFetch(INDEX);
  if (res.status !== 200) return [];

  const sales: ZeusSale[] = [];
  for (const m of res.body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tr = m[1];
    const link = tr.match(/publicsale\.php\?idSale=(\d+)/i);
    if (!link) continue;

    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1]));
    // Sale, Collector, Sale Type, Starts, Ends, Status, Items, Total, View
    if (cells.length < 7) continue;

    const [title, collector, saleTypeRaw, startsRaw, endsRaw, statusRaw, itemsRaw] = cells;

    /*
     * "Lake County, IN". A collector that does not name a state is not usable —
     * a bare "Lake County" matches eleven states, and guessing which is exactly
     * the error this adapter exists to stop making.
     */
    const parts = collector.match(/^(.*?),\s*([A-Za-z]{2})$/);
    if (!parts) continue;
    const county = findCountyByName(parts[2].toUpperCase(), parts[1]);
    if (!county) continue;

    const starts = parseWhen(startsRaw);
    const ends = parseWhen(endsRaw);

    sales.push({
      idSale: link[1],
      title,
      collector,
      countyFips: county.fips,
      saleTypeRaw,
      startsIso: starts.date,
      endsIso: ends.date,
      startTime: starts.time,
      statusRaw,
      items: Number(itemsRaw.replace(/[^\d]/g, "")) || 0,
    });
  }
  return sales;
}

export const zeusAdapter: SourceAdapter = {
  name: "zeus",
  platform: "zeus",
  description:
    "Zeus Auction public sale pages. The national index names each sale's collecting county, " +
    "so counties are discovered from the source rather than bound by the registry.",

  async discoverCounties(): Promise<CountyBinding[]> {
    const sales = await loadIndex();
    const byCounty = new Map<string, ZeusSale[]>();
    for (const s of sales) {
      const list = byCounty.get(s.countyFips) ?? [];
      list.push(s);
      byCounty.set(s.countyFips, list);
    }
    return [...byCounty].map(([countyFips, list]) => ({
      countyFips,
      config: { sales: list },
    }));
  },

  async listAuctions(binding: CountyBinding): Promise<DiscoveredAuction[]> {
    const sales = (binding.config.sales as ZeusSale[] | undefined) ?? [];

    return sales.flatMap((s) => {
      /*
       * The close date, not the open one.
       *
       * A Zeus sale is a bidding window — this one ran 4 to 8 September — and
       * every item on the sale page carries the same "Closes" stamp as the
       * window's end. That is the date a bidder must have acted by, and the
       * date the lots are actually decided on, so it is the one the calendar
       * should show. The opening is kept in `raw` rather than thrown away.
       */
      const saleDate = s.endsIso ?? s.startsIso;
      if (!saleDate) return [];

      return [
        {
          countyFips: binding.countyFips,
          platform: "zeus" as const,
          saleType: saleTypeFor(s.saleTypeRaw, s.title),
          externalId: `zeus|${s.idSale}`,
          saleDate,
          // Zeus prints the window; nothing here is projected from a calendar.
          saleDateConfirmed: true,
          // The sale page is the sale's own item list, not a delinquent roll.
          listingKind: "sale_list" as const,
          startTime: s.startTime ?? undefined,
          title: s.title,
          status: auctionStatusFor(s.statusRaw),
          sourceUrl: `${BASE}/publicsale.php?idSale=${s.idSale}`,
          raw: {
            idSale: s.idSale,
            collector: s.collector,
            saleTypeRaw: s.saleTypeRaw,
            opensOn: s.startsIso,
            closesOn: s.endsIso,
            announcedItems: s.items,
          },
        },
      ];
    });
  },

  async listLots(auction: DiscoveredAuction): Promise<DiscoveredLot[]> {
    const res = await politeFetch(auction.sourceUrl);
    if (res.status !== 200) return [];

    const lots: DiscoveredLot[] = [];
    for (const cells of rows(res.body)) {
      // Sale ID, Batch, Parcel, Owner, Address, Face Amount, Current Bid, Status, Closes, View
      if (cells.length < 8) continue;
      const [saleItemId, batch, parcel, owner, address, faceRaw, bidRaw, statusRaw] = cells;

      // The header row and any layout rows carry no numeric item id.
      if (!/^\d+$/.test(saleItemId) || !parcel) continue;

      const money = (v: string): number | undefined => {
        const n = Number(v.replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const soldAmount = money(bidRaw);

      lots.push({
        externalId: saleItemId,
        parcelNumber: parcel,
        ownerName: owner || undefined,
        addressLine: address || undefined,
        /*
         * Face amount is the delinquency being auctioned — taxes, penalties and
         * costs — which is what a bidder starts from. Recorded as both, because
         * `taxesOwed` is what it *is* and `openingBid` is what it *does*.
         */
        openingBid: money(faceRaw),
        taxesOwed: money(faceRaw),
        soldAmount,
        /*
         * One shared vocabulary, deliberately. Three adapters kept their own
         * copy of this mapping and drifted, one of them recording every sold
         * parcel as redeemed. See `lib/ingest/lot-status.ts`.
         */
        status: parseLotStatus(statusRaw),
        sourceUrl: auction.sourceUrl,
        raw: { batch, faceAmount: faceRaw, currentBid: bidRaw, statusRaw },
      });
    }
    return lots;
  },
};
