/**
 * Copy street addresses out of stored provider payloads onto the lots.
 *
 *   npx tsx scripts/sync-addresses-from-payloads.ts [--apply]
 *
 * A lot with no `address_line` cannot be priced by RentCast, whose AVM is
 * address-gated, and cannot be checked against a county portal that searches by
 * address. Where a provider already returned one and it was never written back
 * to the lot, this closes that gap for free.
 *
 * It is deliberately small in effect and worth keeping anyway. Today it moves
 * 61 lots — the address-less parcels almost all have no provider record at all,
 * so the gap is a fetching problem rather than a plumbing one. But every future
 * enrichment run creates more of exactly this case, and running it after one
 * costs nothing.
 *
 * No provider call. Dry by default; pass `--apply` to write.
 */
import "../lib/env";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { lots, lotValuations } from "../lib/db/schema";

const APPLY = process.argv.includes("--apply");

/** Provider paths to a street line, best first. */
const LINE1 = ["address.line1", "addressLine1", "address.oneLine"];
const CITY = ["address.locality", "city"];
const ZIP = ["address.postal1", "zipCode"];

function at(raw: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[k];
  }, raw);
}

function pick(raw: Record<string, unknown>, paths: string[]): string | null {
  for (const p of paths) {
    const v = at(raw, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function main() {
  const rows = await db
    .select({
      lotId: lots.id,
      raw: lotValuations.raw,
      source: lotValuations.source,
      city: lots.city,
      zip: lots.zip,
    })
    .from(lots)
    .innerJoin(lotValuations, eq(lotValuations.lotId, lots.id))
    .where(and(isNull(lots.addressLine), sql`${lotValuations.raw} is not null`));

  console.log(`${rows.length} address-less lot(s) with a stored payload`);

  const seen = new Set<string>();
  let applied = 0;
  let noLine = 0;

  for (const r of rows) {
    if (seen.has(r.lotId)) continue;
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    const line = pick(raw, LINE1);
    if (!line) {
      noLine++;
      continue;
    }
    seen.add(r.lotId);

    /*
     * City and zip only fill where the lot has none. The sale list is the
     * county's own description of what it is selling; a provider's idea of the
     * municipality does not get to overwrite it, and only the street line —
     * which the list genuinely lacked — is being added here.
     */
    const set: Record<string, unknown> = { addressLine: line };
    if (!r.city) {
      const c = pick(raw, CITY);
      if (c) set.city = c;
    }
    if (!r.zip) {
      const z = pick(raw, ZIP);
      if (z) set.zip = z;
    }

    if (APPLY) await db.update(lots).set(set).where(eq(lots.id, r.lotId));
    applied++;
  }

  console.log(`${applied} lot(s) with a recoverable street line (${noLine} payload(s) had none)`);
  console.log(APPLY ? "applied" : "dry run — pass --apply to write");
  process.exit(0);
}

main();
