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
 * The chain does break. A deploy is the reliable way: an in-flight link carries
 * the `CRON_SECRET` from the deployment it started on, so rotating the secret or
 * shipping anything at all leaves the running links holding a stale one and
 * their successors are refused. A provider outage long enough to exhaust a job's
 * three leases does it too. None of that loses work — the queue is durable and
 * an expired lease is claimable again — but nothing restarts a dead chain on its
 * own, and a stopped chain looks exactly like a finished one from the outside.
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
import { inArray } from "drizzle-orm";

const ONCE = process.argv.includes("--once");
const BASE = process.env.CAPE_BASE_URL ?? "https://deedpilot.vercel.app";
const LANES = Number(process.env.CAPE_LANES ?? 3);
const POLL_MS = 4 * 60 * 1000;
/** Re-kick after this long with no completion. Longer than one job. */
const STALL_MS = 11 * 60 * 1000;

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

async function main() {
  const sec = secret();
  let lastDone = -1;
  let lastProgress = Date.now();

  for (;;) {
    const { total, done } = await outstanding();
    const left = total - done;
    const stamp = new Date().toISOString().slice(11, 19);

    if (done !== lastDone) {
      lastProgress = Date.now();
      lastDone = done;
    }

    if (left === 0) {
      console.log(`${stamp} all ${total} package(s) written`);
      return;
    }

    const stalled = Date.now() - lastProgress > STALL_MS;
    console.log(
      `${stamp} ${done}/${total} written, ${left} to go` + (stalled ? " — stalled, re-kicking" : ""),
    );

    if (ONCE) return;
    if (stalled) {
      await kick(sec);
      lastProgress = Date.now();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
