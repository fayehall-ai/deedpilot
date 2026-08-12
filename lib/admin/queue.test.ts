/**
 * Run-queue invariants.
 * Run: npx tsx lib/admin/queue.test.ts
 *
 * Talks to the real database and cleans up after itself — the behaviour worth
 * testing here is the atomicity of the claim, which a mock cannot show.
 *
 * The bug this file exists to prevent already happened once: `db.execute`
 * returns the database's own column names, so casting a raw row to `RunJob`
 * type-checks while every camelCase field reads `undefined`. The dispatcher
 * would have read `limit` and `countyFips` as undefined and run a full
 * unbounded pass for every job, including ones queued as a one-county smoke
 * test. Nothing would have thrown.
 */
/* Loads .env.local — this test talks to the real database. */
import "../env";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { claimNext, completeJob, enqueue, failJob, getQueue, MAX_ATTEMPTS } from "./queue";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const TAG = "queue-test";

async function main() {
  await db.execute(sql`DELETE FROM run_jobs WHERE requested_by = ${TAG}`);

  // --- every field survives the round trip -----------------------------------

  const job = await enqueue({
    adapter: "ga-counties",
    countyFips: "13121",
    limit: 3,
    dryRun: true,
    priority: 10,
    requestedBy: TAG,
  });
  eq(job.status, "queued", "a new job starts queued");

  const claimed = await claimNext();
  assert(claimed !== null, "the queued job is claimable");
  eq(claimed!.adapter, "ga-counties", "adapter survives the claim");
  eq(claimed!.countyFips, "13121", "countyFips survives the claim");
  eq(claimed!.limit, 3, "limit survives the claim");
  eq(claimed!.dryRun, true, "dryRun survives the claim");
  eq(claimed!.status, "leased", "claiming leases the job");
  eq(claimed!.attempts, 1, "claiming counts an attempt");
  assert(claimed!.leaseExpiresAt instanceof Date, "claiming sets a lease expiry");
  assert(claimed!.createdAt instanceof Date, "timestamps hydrate as Dates");

  // --- a held lease excludes other workers -----------------------------------

  eq(await claimNext(), null, "a leased job cannot be claimed twice");

  // --- an expired lease returns the job to the pool --------------------------

  await db.execute(
    sql`UPDATE run_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = ${job.id}`,
  );
  const reclaimed = await claimNext();
  assert(reclaimed?.id === job.id, "an expired lease makes the job claimable again");
  eq(reclaimed!.attempts, 2, "reclaiming counts a second attempt");

  // --- completion takes it out of circulation --------------------------------

  await completeJob(job.id, { note: TAG });
  eq(await claimNext(), null, "a completed job is not claimable");

  // --- retries are bounded ---------------------------------------------------

  const doomed = await enqueue({ adapter: "ga-counties", requestedBy: TAG });
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const c = await claimNext();
    assert(c?.id === doomed.id, `attempt ${i + 1} claims the failing job`);
    await failJob(doomed.id, `synthetic failure ${i + 1}`);
  }
  eq(await claimNext(), null, "a job that exhausts its attempts stops being claimed");

  const q = await getQueue(5);
  assert(q.failed >= 1, "the exhausted job is recorded as failed");

  await db.execute(sql`DELETE FROM run_jobs WHERE requested_by = ${TAG}`);
  console.log(`queue.test.ts — ${passed} assertions passed`);
  process.exit(0);
}

main().catch(async (e) => {
  await db.execute(sql`DELETE FROM run_jobs WHERE requested_by = ${TAG}`).catch(() => {});
  console.error(e);
  process.exit(1);
});
