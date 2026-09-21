/**
 * Daily: the week's top sales' framework documents into CAPE/Framework on Drive.
 * See `lib/framework/deliver.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/admin/cron-auth";
import { driveConfigured } from "@/lib/delivery/drive";
import { deliverFrameworks } from "@/lib/framework/deliver";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!driveConfigured()) {
    return NextResponse.json({
      ok: true,
      skipped: "Drive delivery not configured — set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_CAPE_FOLDER_ID",
    });
  }
  const started = Date.now();
  const result = await deliverFrameworks({ deadline: started + 240_000 });
  return NextResponse.json({ ok: true, elapsedMs: Date.now() - started, ...result });
}
