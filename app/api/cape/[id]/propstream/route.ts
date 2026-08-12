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
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auctions, counties, lots } from "@/lib/db/schema";
import { getCounty } from "@/lib/atlas";
import {
  exportFilename,
  qualifies,
  toPropStreamCsv,
  type PropStreamRow,
} from "@/lib/cape/propstream";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
      parcelNumber: lots.parcelNumber,
      addressLine: lots.addressLine,
      city: lots.city,
      zip: lots.zip,
      ownerName: lots.ownerName,
      openingBid: lots.openingBid,
      assessedValue: lots.assessedValue,
      acreage: lots.acreage,
      landUse: lots.landUse,
    })
    .from(lots)
    .where(and(eq(lots.auctionId, id)))
    .orderBy(asc(lots.parcelNumber))
    .limit(10_000);

  const rows: PropStreamRow[] = parcels.map((p) => ({
    ...p,
    countyName: row.county.name,
    state: row.county.state,
    saleDate: row.auction.saleDate,
  }));

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
