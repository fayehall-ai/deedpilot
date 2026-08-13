/**
 * Run-queue invariants.
 * Run: npx tsx lib/admin/queue.test.ts
 *
 * Talks to the real database and cleans up after itself — the behaviour worth
 * testing here is the atomicity of the claim, which a mock cannot show.
 *
 * ## It must not assume an idle queue
 *
 * The first version asserted `claimNext() === null` to mean "nothing else is
 * claimable", which was only ever true because the pipeline never actually ran.
 * Once the calendar planner began queuing real county crawls at priority 113,
 * every one of those assertions started claiming somebody else's work — and the
 * invariants being tested were never about the queue being empty. They are about
 * *this* job: that it cannot be claimed twice while leased, that it returns after
 * its lease expires, that it stops being claimed once complete.
 *
 * So the test now enqueues above any real priority and asserts on job identity
 * rather than emptiness. It also releases anything it claims by accident, so
 * running it never strands production work in a lease.
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
    // Above `priorityOf`'s ceiling of 115, so the claim under test wins against
    // whatever real work the planner has queued.
    priority: 10_000,
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

  /**
   * Claim, and immediately release anything that is not ours.
   *
   * Returns whether *this* job came back. Running the suite must never leave a
   * real county crawl leased to a test process that has already exited.
   */
  const claimIsOurs = async (): Promise<boolean> => {
    const c = await claimNext();
    if (!c) return false;
    if (c.id === job.id || c.requestedBy === TAG) return c.id === job.id;
    await db.execute(
      sql`UPDATE run_jobs SET status = 'queued', lease_expires_at = NULL,
          attempts = greatest(attempts - 1, 0) WHERE id = ${c.id}`,
    );
    return false;
  };

  assert(!(await claimIsOurs()), "a leased job cannot be claimed twice");

  // --- an expired lease returns the job to the pool --------------------------

  await db.execute(
    sql`UPDATE run_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = ${job.id}`,
  );
  const reclaimed = await claimNext();
  assert(reclaimed?.id === job.id, "an expired lease makes the job claimable again");
  eq(reclaimed!.attempts, 2, "reclaiming counts a second attempt");

  // --- completion takes it out of circulation --------------------------------

  await completeJob(job.id, { note: TAG });
  assert(!(await claimIsOurs()), "a completed job is not claimable");

  // --- retries are bounded ---------------------------------------------------

  const doomed = await enqueue({ adapter: "ga-counties", requestedBy: TAG, priority: 10_000 });
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const c = await claimNext();
    assert(c?.id === doomed.id, `attempt ${i + 1} claims the failing job`);
    await failJob(doomed.id, `synthetic failure ${i + 1}`);
  }
  const after = await claimNext();
  assert(after?.id !== doomed.id, "a job that exhausts its attempts stops being claimed");
  if (after && after.requestedBy !== TAG) {
    await db.execute(
      sql`UPDATE run_jobs SET status = 'queued', lease_expires_at = NULL,
          attempts = greatest(attempts - 1, 0) WHERE id = ${after.id}`,
    );
  }

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
