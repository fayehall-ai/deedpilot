/**
 * Sunday CAPE run, step one: the Auction Scout workbook from Drive.
 *
 * Reads the newest spreadsheet in CAPE/Auction Scout — an uploaded .xlsx, or
 * one opened and saved in Google Sheets — and applies it exactly as the admin
 * console's upload does (`ingestWorkbook`): sales filled in or added, list
 * links recorded, and a crawl queued for each county whose parcels are
 * missing. `/api/cron/dispatch?drain=1` reads those lists next.
 *
 * Re-reading the same workbook is harmless: the ingest fills empty fields and
 * matches existing sales, so an unchanged file changes nothing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/admin/cron-auth";
import { downloadFile, driveConfigured, isSpreadsheet, listSubfolder } from "@/lib/delivery/drive";
import { describePlan, ingestWorkbook } from "@/lib/import/scout-ingest";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!driveConfigured()) {
    return NextResponse.json({ ok: true, skipped: "Drive not configured" });
  }

  const files = (await listSubfolder("Auction Scout")).filter(isSpreadsheet);
  const newest = files[0];
  if (!newest) {
    return NextResponse.json({ ok: true, skipped: "no spreadsheet in CAPE/Auction Scout" });
  }

  const bytes = await downloadFile(newest);
  const outcomes = await ingestWorkbook(bytes, newest.name, {
    apply: true,
    via: "drive",
    actor: "cape-sunday",
  });

  return NextResponse.json({
    ok: true,
    workbook: newest.name,
    modified: newest.modifiedTime ?? null,
    tabs: outcomes.map((o) => ({
      tab: o.tab,
      sourcesAdded: o.sourcesAdded,
      summary: describePlan(o.plan).slice(0, 12),
    })),
  });
}
