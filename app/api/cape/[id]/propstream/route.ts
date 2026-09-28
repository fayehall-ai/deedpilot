/**
 * The PropStream auction list, as a download.
 *
 * Replaces steps (b), (b.i) and (c) of the TDC AI Automations PropStream
 * process — downloading the county's spreadsheet, converting its PDF when there
 * is not one, and reshaping the result into the template. The parcels are
 * already here, so there is nothing to download or convert.
 *
 * Step (a)'s population rule is enforced rather than assumed: an auction under
 * the threshold returns 422 with the county's figure, so a caller cannot
 * quietly build a list the workflow says should not exist. `?force=1` overrides
 * it for the case where you know why you want a smaller county.
 */
import { NextResponse, type NextRequest } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { landOnlySql } from "@/lib/lots/land-only";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/admin/auth";
import { tokenMatches } from "@/lib/admin/token";
import { auctions, counties, lots } from "@/lib/db/schema";
import { getCounty } from "@/lib/atlas";
import { computeMaxBid } from "@/lib/deal/maxbid";
import { mergeValuations } from "@/lib/property/merge";
import { getLotValuations } from "@/lib/queries";
import type { SaleType } from "@/lib/atlas/types";
import {
  exportFilename,
  qualifies,
  toPropStreamCsv,
  type PropStreamRow,
} from "@/lib/cape/propstream";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  /*
   * The same operations token as `/cape` and `/admin`, checked before anything
   * else runs.
   *
   * This endpoint shipped with no authentication at all, which made the whole
   * PropStream sheet — owner names, addresses, assessed values and the
   * computed max bid for every parcel in a sale — available to anyone holding
   * an auction id. The board that links it is now token-gated, and a gate on
   * the page with none on the download is not a gate.
   *
   * Both credentials are accepted because both callers are real: the cookie
   * for the operator clicking the link on the board, the bearer token for a
   * script pulling the sheet, matching `/api/cron/dispatch`. The check runs
   * first so an unauthorised request costs a comparison rather than a scan of
   * 10,000 parcels and a valuation read on each.
   */
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(bearer) && !(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const [row] = await db
    .select({ auction: auctions, county: counties })
    .from(auctions)
    .innerJoin(counties, eq(counties.fips, auctions.countyFips))
    .where(eq(auctions.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Auction not found" }, { status: 404 });
  }

  const population = getCounty(row.county.fips)?.population ?? null;
  const q = qualifies(population);
  const force = req.nextUrl.searchParams.get("force") === "1";

  if (!q.qualifies && !force) {
    return NextResponse.json(
      {
        error: "Below the CAPE population threshold",
        county: `${row.county.name}, ${row.county.state}`,
        reason: q.reason,
        hint: "Append ?force=1 to export anyway",
      },
      { status: 422 },
    );
  }

  const parcels = await db
    .select({
      id: lots.id,
      parcelNumber: lots.parcelNumber,
      addressLine: lots.addressLine,
      city: lots.city,
      zip: lots.zip,
      ownerName: lots.ownerName,
      openingBid: lots.openingBid,
      assessedValue: lots.assessedValue,
      taxesOwed: lots.taxesOwed,
      acreage: lots.acreage,
      buildingSqft: lots.buildingSqft,
      yearBuilt: lots.yearBuilt,
      landUse: lots.landUse,
    })
    .from(lots)
    /* Land-only parcels are left out unless `?land=show` — see lib/lots/land-only.ts. */
    .where(
      req.nextUrl.searchParams.get("land") === "show"
        ? eq(lots.auctionId, id)
        : and(eq(lots.auctionId, id), sql`not ${landOnlySql}`),
    )
    .orderBy(asc(lots.parcelNumber))
    .limit(10_000);

  /*
   * One valuation read per parcel, for the beds/baths and lot-size the sheet
   * asks for and for the market estimate the max-bid engine ranks above
   * assessed ÷ ratio. Bounded by the 10,000 limit above; the largest live sale
   * is 1,638 parcels.
   */
  const merged = await Promise.all(
    parcels.map(async (p) => mergeValuations(await getLotValuations(p.id))),
  );

  const cityStateZip = (p: (typeof parcels)[number]) =>
    [p.city, row.county.state, p.zip].filter(Boolean).join(", ") || null;

  const rows: PropStreamRow[] = parcels.map((p, idx) => {
    const v = merged[idx];
    const deal = computeMaxBid({
      state: row.county.state,
      saleType: row.auction.saleType as SaleType,
      fips: row.county.fips,
      openingBid: p.openingBid === null ? undefined : Number(p.openingBid),
      assessedValue: p.assessedValue === null ? undefined : Number(p.assessedValue),
      marketValue:
        v?.marketValue === null || v?.marketValue === undefined ? undefined : Number(v.marketValue),
    });

    const beds = v?.beds ?? null;
    const baths = v?.baths ?? null;
    const bedsBaths =
      beds !== null || baths !== null ? [beds ?? "?", baths ?? "?"].join("/") : null;

    const lotSqft = v?.lotSqft ?? null;
    const lotSize = p.acreage
      ? `${p.acreage} acres`
      : lotSqft
        ? `${lotSqft} sqft`
        : null;

    return {
      subjectProperty: p.addressLine ?? p.parcelNumber,
      countyName: row.county.name,
      auctionType: row.auction.saleType,
      saleDate: row.auction.saleDate,
      openingBid: p.openingBid,
      parcelNumber: p.parcelNumber,
      addressLine: p.addressLine,
      cityStateZip: cityStateZip(p),
      taxesOwed: p.taxesOwed,
      assessedValue: p.assessedValue,
      ownerName: p.ownerName,
      buildingSqft: p.buildingSqft ?? v?.buildingSqft ?? null,
      landUse: p.landUse ?? v?.propertyType ?? null,
      yearBuilt: p.yearBuilt ?? v?.yearBuilt ?? null,
      bedsBaths,
      lotSize,
      lastSaleDate: v?.lastSaleDate ?? null,
      arv: deal.arv.value === null ? null : Math.round(deal.arv.value),
      maxBid: deal.maxBid === null ? null : Math.round(deal.maxBid),
      /*
       * Shipped beside the numbers because an ARV from an assumed floor and one
       * from a provider estimate are different claims, and a spreadsheet strips
       * every caveat the page carries.
       */
      arvBasis: deal.arv.assumed
        ? "ASSUMED FLOOR — not a valuation of this parcel"
        : deal.arv.fromMarket
          ? "Provider market estimate"
          : deal.arv.derived
            ? "Derived from assessed value"
            : deal.arv.value === null
              ? "No valuation available"
              : "Comparable sales",
    };
  });

  /* BOM so Excel reads it as UTF-8. See the Content-Type note below. */
  const csv = "\uFEFF" + toPropStreamCsv(rows);
  const filename = exportFilename(row.county.name, row.county.state, row.auction.saleDate);

  return new NextResponse(csv, {
    headers: {
      /*
       * `text/csv` with an explicit UTF-8 charset and a BOM. Owner names in this
       * data carry accents, and Excel on Windows reads a BOM-less UTF-8 CSV as
       * the system codepage — which turns them into mojibake in the one
       * application this file is guaranteed to be opened in.
       */
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Cape-Parcels": String(rows.length),
      "X-Cape-Population": String(population ?? ""),
    },
  });
}
