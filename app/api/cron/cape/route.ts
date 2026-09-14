/**
 * The CAPE script worker, as a scheduled function.
 *
 * ## Why this is not part of `/api/cron/dispatch`
 *
 * The dispatcher drains one job at a time, which is right for what it carries:
 * a crawl is bounded by a county's web server and running four at once against
 * the same host is rude at best. Script work is the opposite shape — every job
 * is one HTTPS request that spends two minutes waiting on a model — so it wants
 * concurrency, and taking it inside the shared dispatcher would mean crawls
 * competing with scripts for one 240-second budget on the day both are due.
 *
 * Separate route, separate budget, same queue. Leases are what make that safe:
 * two ticks overlapping claim different rows or nothing at all.
 *
 * ## Why the schedule can overlap itself
 *
 * `vercel.json` runs this every two minutes and the budget is four, so at
 * steady state two invocations are usually in flight. That is deliberate — it
 * is how throughput gets to roughly eight concurrent generations without any
 * one function running longer than its ceiling. `claimNext` is atomic
 * (`FOR UPDATE SKIP LOCKED`), so the overlap costs nothing but is the reason
 * the work is claimed rather than assigned.
 *
 * ## What stops it
 *
 * Nothing, and that is correct. `enqueueCapeScripts` queues only packages whose
 * script was not written from the facts now in force, so when everything is
 * current a tick queues nothing, claims nothing, and returns in one query. The
 * schedule is a standing offer to do work, not a job with an end.
 */
import { NextResponse, type NextRequest } from "next/server";
import { claimNext, completeJob, failJob } from "@/lib/admin/queue";
import { capeAuctionId, enqueueCapeScripts, isCapeJob } from "@/lib/admin/cape-jobs";
import { tokenMatches } from "@/lib/admin/token";
import { capePackageInputs } from "@/lib/cape/inputs";
import { produceCapePackage } from "@/lib/cape/produce";

/*
 * Ten minutes, and the arithmetic behind it.
 *
 * A package is two model calls and one was measured at 353 seconds against a
 * 300-second ceiling, so 300 was not a budget, it was a guarantee of being
 * killed. The numbers below are chosen so the worst case fits: a worker stops
 * claiming with RESERVE_MS left, and the job it claimed last can take at most
 * two calls at SCRIPT_TIMEOUT_MS plus two retries before it gives up on its
 * own. Being killed anyway is survivable — the lease lapses and a later tick
 * re-claims — but it should be the exception, not the design.
 */
export const maxDuration = 600;

const BUDGET_MS = 420_000;
/** Stop claiming with this much left, so a claimed job is not orphaned. */
const RESERVE_MS = 170_000;
/**
 * The per-provider deadline for this path, well under the four-minute default.
 *
 * `runStructured` retries a timeout three times with backoff, so the default
 * would put a single job's worst case past twelve minutes — longer than any
 * function may run. At eighty seconds a job that fails every attempt gives up
 * inside the reserve instead of being cut off mid-write.
 */
const SCRIPT_TIMEOUT_MS = 80_000;
/** Model calls, not CPU. Four in flight per function, ~8 across two ticks. */
const CONCURRENCY = 4;

function authorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return tokenMatches(bearer) || tokenMatches(req.nextUrl.searchParams.get("token"));
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);

  const fill = await enqueueCapeScripts();

  const wrote: string[] = [];
  const held: string[] = [];
  const failed: string[] = [];

  /*
   * One `capePackageInputs` read for the whole tick, not one per job.
   *
   * It is a handful of joins over every upcoming sale plus a parcel-coverage
   * aggregate, and doing it inside each worker would spend more of the budget
   * on the same query than on the work. The facts cannot change mid-tick, and
   * if they change between ticks the hash moves and the next pass catches it.
   */
  let inputs: Awaited<ReturnType<typeof capePackageInputs>> | null = null;

  async function worker() {
    while (left() > RESERVE_MS) {
      const job = await claimNext();
      if (!job) return;

      if (!isCapeJob(job.adapter)) {
        /*
         * Someone else's job, claimed because the queue is shared.
         *
         * Failing it would burn an attempt on work this route is not equipped
         * to do and would eventually retire a perfectly good crawl. The lease
         * is simply allowed to lapse — ten minutes later `/api/cron/dispatch`
         * finds it exactly as it was.
         */
        return;
      }

      const auctionId = capeAuctionId(job.adapter);
      try {
        inputs ??= await capePackageInputs();
        const input = inputs.find((i) => i.auctionId === auctionId);
        if (!input) {
          /* The sale passed, or dropped off its county's calendar mid-run. */
          await completeJob(job.id, { skipped: "no longer an upcoming package" });
          continue;
        }

        const result = await produceCapePackage(input, {
          outRoot: "/tmp/cape",
          scriptOnly: true,
          scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
        });

        await completeJob(job.id, {
          stage: result.stage,
          slides: result.slideCount ?? null,
          unsupported: result.unsupportedFigures ?? [],
          skipped: result.skipped ?? null,
        });

        const who = `${input.countyName}, ${input.state} ${input.saleDate}`;
        if (result.skipped) held.push(`${who} — ${result.skipped}`);
        else wrote.push(who);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await failJob(job.id, msg);
        failed.push(`${auctionId.slice(0, 8)} — ${msg.slice(0, 120)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - started,
    outstanding: fill.outstanding,
    queued: fill.queued,
    inFlight: fill.inFlight,
    wrote: wrote.length,
    held: held.length,
    failed: failed.length,
    detail: { wrote, held, failed },
  });
}
