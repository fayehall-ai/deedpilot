/**
 * Sunday CAPE run, step three: RealEstateAPI detail for the parcels the
 * workbook's crawls brought in, and any other parcel the spend policy allows.
 * See `lib/property/reapi-detail-pass.ts`.
 *
 * No weekly budget: the spend policy — deed sales with a confirmed date,
 * pending, not land-only, no detail record in 90 days — is the limit. A tick
 * stops starting parcels with two minutes left; the next tick carries on, and
 * skips what this night already asked about.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/admin/cron-auth";
import { runReapiDetailPass } from "@/lib/property/reapi-detail-pass";

export const maxDuration = 800;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  const log: string[] = [];
  const result = await runReapiDetailPass({
    deadline: started + 660_000,
    skipAttemptedWithinHours: 12,
    onLog: (line) => log.push(line),
  });
  return NextResponse.json({ ok: true, elapsedMs: Date.now() - started, ...result, log: log.slice(-20) });
}
