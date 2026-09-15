/**
 * Receive a RealAuction sale capture from the operator's own browser.
 *
 * ## Why this exists rather than a fetcher
 *
 * RealAuction answers 403 to this project's user agent and `Disallow: /` in
 * robots.txt. Measured again 2026-09-15 with `underAgreement` set, which skips
 * robots but not the agent check: still 403, 118 bytes. The operator holds a
 * data agreement, and an agreement is a reason to be given access rather than a
 * reason to present a user agent that is not ours — the position
 * `lib/ingest/adapters/bid4assets.ts` takes and the reason it reads captures.
 *
 * The pages are public and render fully in a browser with no login. So the
 * capture pattern applies, exactly as it does for GovEase and Bid4Assets: the
 * operator opens the sale in their own browser and the page is read there.
 *
 * ## Why a POST endpoint and not a clipboard
 *
 * `docs/govease-capture.md` has the operator copy a fragment and save it to a
 * file, which is fine for one sale and unworkable for eighty-six across
 * thirty-five counties — each paginated sixteen pages deep. The snippet in
 * `docs/realauction-capture.md` walks a county's pages inside the browser and
 * posts what it finds here, so one paste covers a whole county and the data
 * never has to travel by hand.
 *
 * ## Why it is development-only
 *
 * It writes files and accepts cross-origin posts, which is exactly what a
 * capture workflow needs on a laptop and exactly what should never be reachable
 * in production. `NODE_ENV` gates it, and the admin token is still required.
 */
import { NextResponse, type NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tokenMatches } from "@/lib/admin/token";

export const maxDuration = 60;

const DIR = path.join(process.cwd(), "data", "realauction-capture");

/** The page is on another origin, so the browser preflights and needs these. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

interface CaptureRow {
  parcelNumber?: string;
  openingBid?: string;
  addressLine?: string;
  certificate?: string;
  caseNumber?: string;
  status?: string;
  assessedValue?: string;
  /** The page's own "Auction Type" — TAXDEED, TAXLIEN or FORECLOSURE.
   *
   * Recorded because several counties run a tax deed sale and a mortgage
   * foreclosure sale on one realforeclose host, separated only by the date.
   * Without it the adapter cannot tell which one a capture holds. */
  auctionType?: string;
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404, headers: CORS });
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(bearer)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const body = (await req.json()) as {
    host?: string;
    saleDate?: string;
    rows?: CaptureRow[];
  };

  const host = (body.host ?? "").replace(/^www\./, "").toLowerCase();
  const saleDate = body.saleDate ?? "";
  if (!/^[a-z0-9.-]+\.(realtaxdeed|realforeclose|realtaxlien)\.com$/.test(host)) {
    return NextResponse.json({ error: `not a RealAuction host: ${host}` }, { status: 400, headers: CORS });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
    return NextResponse.json({ error: "saleDate must be YYYY-MM-DD" }, { status: 400, headers: CORS });
  }

  /*
   * Rows without a parcel number are dropped here rather than on the way in.
   *
   * A RealAuction page renders a fixed number of item blocks per page and pads
   * the last one with empties; Charlotte's twenty blocks held ten parcels. An
   * empty block is not a parcel with missing data, it is not a parcel.
   */
  const rows = (body.rows ?? []).filter((r) => (r.parcelNumber ?? "").trim().length > 0);

  await mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${host}__${saleDate}.json`);
  await writeFile(file, JSON.stringify({ host, saleDate, capturedAt: new Date().toISOString(), rows }, null, 1));

  return NextResponse.json(
    { ok: true, host, saleDate, rows: rows.length, file: path.relative(process.cwd(), file) },
    { headers: CORS },
  );
}
