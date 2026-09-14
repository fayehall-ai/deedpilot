/**
 * The CAPE script worker, which continues itself until the work is done.
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
 * ## Why it chains instead of being scheduled
 *
 * There is no cron. A backlog of 477 packages is a job with an end, and a
 * schedule is the wrong shape for that: it either runs forever after the work
 * is finished, or it has to be removed by hand at a moment nobody is watching
 * for. So the last thing each invocation does, if work remains, is start its
 * own successor and return. The chain ends when `enqueueCapeScripts` reports
 * nothing outstanding — which is the same question that decides what to queue,
 * so "finished" means exactly "every upcoming package has a script written from
 * the facts now in force".
 *
 * ## What stops a chain that should not have started
 *
 * A function that invokes itself is a loop with a deploy cycle between you and
 * the brakes, so it gets three independent ones:
 *
 *  - It stops when nothing is outstanding. This is the ordinary exit.
 *  - `MAX_LINKS` caps the chain whatever the queue says, so a bug that
 *    miscounts outstanding work still terminates.
 *  - `CAPE_CHAIN_DISABLED=1` in the environment stops every chain at its next
 *    link, with no deploy. This is the one to reach for.
 *
 * Successors are started through `waitUntil`, because the response returns
 * first and a plain fire-and-forget fetch would be cancelled with the
 * invocation — a chain that silently fails to continue looks identical to one
 * that finished.
 *
 * ## Lanes
 *
 * One chain is one function at a time, which is `CONCURRENCY` generations. Two
 * chains started independently give twice that. `?lane=` carries a label so the
 * logs say which is which; nothing else depends on it, because `claimNext` is
 * atomic and lanes simply take different rows.
 */
import { NextResponse, type NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
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
export const maxDuration = 800;

/*
 * Claim for the first minute only, then let the chain do the rest.
 *
 * The previous shape claimed for 220 seconds and reserved 170 for the job to
 * finish in, which does not survive contact with a retry: two model calls, each
 * allowed three attempts at 150 seconds, is 900 seconds of worst case behind a
 * 600-second ceiling. The logs duly recorded it — `Vercel Runtime Timeout
 * Error: Task timed out after 600 seconds`, with a job cut off mid-write.
 *
 * Long invocations are the wrong answer anyway once the work chains. A short
 * claim window and a fresh successor is strictly better: the arithmetic is
 * simple enough to check, a killed function stops being the normal case, and
 * throughput comes from lanes rather than from any one function living longer.
 *
 * The bound now: last claim at 60s, worst-case job 600s, ceiling 800s.
 */
const BUDGET_MS = 300_000;
/** Stop claiming with this much left, so a claimed job is not orphaned. */
const RESERVE_MS = 240_000;
/**
 * The per-provider deadline for this path, well under the four-minute default.
 *
 * `runStructured` retries a timeout three times with backoff, so the default
 * would put a single job's worst case past twelve minutes — longer than any
 * function may run. At eighty seconds a job that fails every attempt gives up
 * inside the reserve instead of being cut off mid-write.
 */
const SCRIPT_TIMEOUT_MS = 150_000;
/**
 * Three, and the schedule is every three minutes — so about six calls in flight.
 *
 * The first deployment ran four per function against a two-minute schedule and a
 * ten-minute ceiling, which is up to five overlapping invocations and twenty
 * concurrent generations. The logs show what that bought: "grok attempt 1 —
 * Request timed out" seven times in one tick. Piling on more concurrency made
 * every individual call slower until they all missed the deadline, and the
 * eighty-second deadline then turned ordinary slowness into failure — locally
 * the same work takes ninety to a hundred and fifty seconds.
 *
 * Six in flight finishes the backlog in roughly three hours and leaves the
 * provider able to answer.
 */
const CONCURRENCY = 3;

/**
 * Who may run this.
 *
 * `CRON_SECRET` is the one that matters, and it is here because the schedule
 * did not work without it. The cron fired on time, every two minutes, and every
 * invocation was refused: `x-vercel-cron` alone is not something to rely on, and
 * the logs showed a tidy column of 401s next to a queue that never moved — a
 * schedule that looks healthy from the outside and does nothing. When
 * `CRON_SECRET` is set, Vercel presents it as `Authorization: Bearer`, which is
 * the documented contract and the one this checks first.
 *
 * The operator token still works, so a tick can be forced from a terminal
 * without waiting for the schedule.
 */
/** However long the chain says it is, it is not longer than this. */
const MAX_LINKS = 400;

function authorised(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  if (req.headers.get("x-vercel-cron")) return true;

  return tokenMatches(bearer) || tokenMatches(req.nextUrl.searchParams.get("token"));
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);

  const link = Number(req.nextUrl.searchParams.get("link") ?? "0") || 0;
  const lane = req.nextUrl.searchParams.get("lane") ?? "1";

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

  /*
   * Ask again rather than trusting the count from the top of the tick.
   *
   * This invocation has just written scripts, so the number that decided what
   * to queue four hundred seconds ago is stale by exactly the work we did. The
   * successor is started, or not, on what is true now.
   */
  const after = await enqueueCapeScripts();
  const disabled = /^(1|true|yes)$/i.test(process.env.CAPE_CHAIN_DISABLED ?? "");
  const more = after.outstanding > 0 && link < MAX_LINKS && !disabled;

  let chained: string | null = null;
  if (more) {
    const next = new URL(req.nextUrl);
    next.searchParams.set("link", String(link + 1));
    next.searchParams.set("lane", lane);
    const secret = (process.env.CRON_SECRET ?? "").trim();

    /*
     * `waitUntil`, not a bare fetch. The response below returns first and the
     * invocation is torn down with it; a fire-and-forget request would be
     * cancelled in flight, and a chain that silently fails to continue looks
     * exactly like one that finished.
     */
    waitUntil(
      fetch(next.toString(), {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      }).catch(() => {
        /* Nothing useful to do here: the chain is broken and the queue is
           durable, so a later kick picks the work up exactly where it is. */
      }),
    );
    chained = `link ${link + 1} lane ${lane}`;
  }

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - started,
    lane,
    link,
    chained,
    stopped: more ? null : disabled ? "CAPE_CHAIN_DISABLED" : link >= MAX_LINKS ? "max links" : "nothing outstanding",
    outstanding: after.outstanding,
    queued: fill.queued,
    inFlight: fill.inFlight,
    wrote: wrote.length,
    held: held.length,
    failed: failed.length,
    detail: { wrote, held, failed },
  });
}
