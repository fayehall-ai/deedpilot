/**
 * Bring operator policy overrides into the running process.
 *
 * Kept out of `lib/ingest/policy.ts` so that module stays dependency-free and
 * importable anywhere, including tests that must see only the compiled-in
 * decisions. Anything about to fetch — the dispatcher, the ingest CLI — calls
 * this first; anything that does not, sees the code baseline.
 */
import { db } from "../db";
import { policyOverrides } from "../db/schema";
import { setPolicyOverrides, type SourcePolicy, type PolicyDecision } from "../ingest/policy";

export async function loadPolicyOverrides(): Promise<number> {
  const rows = await db.select().from(policyOverrides);
  setPolicyOverrides(
    rows.map((r): SourcePolicy => ({
      host: r.host,
      decision: r.decision as PolicyDecision,
      minDelayMs: r.minDelayMs,
      reason: `[operator override] ${r.reason}`,
    })),
  );
  return rows.length;
}
