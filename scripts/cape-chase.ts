/**
 * Keep the Vercel chain running until every script is written.
 *
 *   npx tsx scripts/cape-chase.ts            # supervise, re-kicking as needed
 *   npx tsx scripts/cape-chase.ts --once     # report and exit
 *
 * ## What this is, and what it deliberately is not
 *
 * It is not the worker. The generation happens in `/api/cron/cape` on Vercel and
 * nothing here calls a model, writes a script or touches a fact. This is a
 * watchdog: it asks how much work is outstanding, notices when the chain has
 * stopped advancing, and starts it again.
 *
 * The chain always breaks, and now we know why. Vercel refuses a function that
 * invokes itself: every lane dies at link 5 with HTTP 508, Loop Detected. The
 * logs are unambiguous — `[cape] lane a successor refused: 508` three times, then
 * `chain broken at link 5`, on every lane, every time. That is platform
 * behaviour protecting against runaway recursion, not something to work around.
 *
 * So chaining is a way to get five links of work per kick, not a way to run a
 * backlog unattended. This watchdog supplies the kicks. A deploy breaks a chain
 * too — an in-flight link carries the `CRON_SECRET` of the deployment it started
 * on — as does a provider outage long enough to exhaust a job's three leases.
 * None of it loses work: the queue is durable and an expired lease is claimable
 * again. But nothing restarts a dead chain on its own, and a stopped chain looks
 * exactly like a finished one from the outside.
 *
 * ## Why it is not a cron
 *
 * Because it ends. The operator asked for the schedules off, and a backlog is a
 * job with a finish line: this exits when `outstanding` reaches zero, which is
 * the same question the worker asks to decide what to queue.
 */
import "./../lib/env";
import { readFileSync } from "node:fs";
import { capePackageInputs } from "../lib/cape/inputs";
import { capeInputsHash } from "../lib/cape/components";
import { db } from "../lib/db";
import { capeProductions } from "../lib/db/schema";
import { inArray, sql } from "drizzle-orm";

const ONCE = process.argv.includes("--once");
const BASE = process.env.CAPE_BASE_URL ?? "https://deedpilot.vercel.app";
const LANES = Number(process.env.CAPE_LANES ?? 3);
const POLL_MS = 4 * 60 * 1000;
/**
 * Kick when fewer than this many jobs are actually in flight.
 *
 * Better than waiting for a stall. Chains die at link 5 by design, so the
 * interesting question is not "has progress stopped" — it always will — but "is
 * anyone working right now". A leased row is a worker holding a job; when that
 * count falls to nothing, every lane has hit its 508 and the queue is idle with
 * work still in it.
 */
const IDLE_LEASES = 1;

function secret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET.trim();
  const path = process.argv[process.argv.indexOf("--secret-file") + 1];
  if (path) return readFileSync(path, "utf8").trim();
  throw new Error("Set CRON_SECRET, or pass --secret-file <path>. Never on the command line.");
}

/** Packages with no script written from the facts now in force. */
async function outstanding(): Promise<{ total: number; done: number }> {
  const inputs = await capePackageInputs();
  const wanted = new Map(inputs.map((i) => [i.auctionId, capeInputsHash(i)]));
  const rows = await db
    .select({ auctionId: capeProductions.auctionId, hash: capeProductions.inputsHash,
              script: capeProductions.script })
    .from(capeProductions)
    .where(inArray(capeProductions.auctionId, [...wanted.keys()]));
  const current = new Map(rows.filter((r) => r.script).map((r) => [r.auctionId, r.hash]));
  const done = inputs.filter((i) => current.get(i.auctionId) === wanted.get(i.auctionId)).length;
  return { total: inputs.length, done };
}

async function kick(sec: string) {
  for (let lane = 1; lane <= LANES; lane++) {
    /*
     * Not awaited. The first link holds the connection for its whole slot, and
     * waiting for it would make this a worker rather than a watchdog.
     */
    fetch(`${BASE}/api/cron/cape?lane=${lane}&link=0`, {
      headers: { authorization: `Bearer ${sec}` },
    }).catch(() => {});
  }
}

/** Jobs a worker is holding right now. Zero means every lane has died. */
async function leased(): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n from run_jobs
    where adapter like 'cape-script:%' and status = 'leased'
      and lease_expires_at > now()`)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  const sec = secret();

  for (;;) {
    const { total, done } = await outstanding();
    const left = total - done;
    const busy = await leased();
    const stamp = new Date().toISOString().slice(11, 19);

    if (left === 0) {
      console.log(`${stamp} all ${total} package(s) written`);
      return;
    }

    const idle = busy < IDLE_LEASES;
    console.log(
      `${stamp} ${done}/${total} written, ${left} to go, ${busy} in flight` +
        (idle ? " — idle, kicking" : ""),
    );

    if (ONCE) return;
    if (idle) await kick(sec);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
