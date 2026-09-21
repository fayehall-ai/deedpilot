/**
 * Pipeline operations, as things the console can press rather than commands a
 * person has to remember.
 *
 * ## Why a registry and not one Server Action each
 *
 * Every one of these already existed as a script under `scripts/`, and every
 * one of them was a CLI entry point: `main()` reading `process.argv`, printing,
 * then `process.exit()`. None of that survives being called from a Server
 * Function — `process.exit()` inside a Lambda kills the request, and argv is
 * whatever Next was launched with. So the work each script does is defined
 * here, as a function taking options and returning a summary, and the script
 * becomes one of two callers rather than the only one. That is the same shape
 * `importAuctionCsv` has, and for the same reason: a console button and a
 * terminal command that do "the same thing" by having two implementations do
 * not stay the same thing.
 *
 * ## Why every task is bounded
 *
 * A Vercel function stops at 300 seconds and a Server Action well before that,
 * while several of these operations are national in scope. None of them may
 * assume it will be allowed to finish. Each takes a `deadline` and a `limit`,
 * does as much as fits, and reports what is left — so pressing the button twice
 * continues the work rather than restarting it. `drainQueueNow` already
 * established this: bounded, resumable, and honest about what it did not get to.
 *
 * This is not a spending guard. It is the only way the work runs at all.
 *
 * ## What is deliberately absent
 *
 * The prospector, the cartographer, the coverage cycle, the results crawler and
 * the found-list ingesters all read or write `data/source-registry.json` and
 * friends. That path is read-only on Vercel, so those cannot be buttons until
 * the registry moves into Postgres or Blob — a change to where that state
 * lives, not a change to how it is triggered. They stay in the terminal, and
 * `TERMINAL_ONLY` below records why, so the gap is visible rather than
 * mysterious.
 */

import { and, isNotNull, like, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions } from "../db/schema";
import { buildPackage, capeInputsHash } from "../cape/components";
import { capePackageInputs } from "../cape/inputs";
import { produceCapePackage } from "../cape/produce";
import { IMPORT_ID_SQL_PATTERN } from "../import/provenance";
import { enrichLotsMissingAssessed } from "../property/enrich";
import { configuredSignalSources, enrichLotIntel } from "../property/signals";
import { planIntelWork } from "../property/signals/scheduler";

/** The console's own pipeline stages, so a button lands where the work belongs. */
export type OpsStage = "Discover" | "Crawl" | "Observe" | "Price" | "Package" | "Operate";

export interface OpsRunOptions {
  /** Rows, counties or parcels to attempt. Always finite. */
  limit: number;
  /** Wall-clock moment to stop by, whatever is finished. */
  deadline: number;
  /** Optional state filter, where the operation supports one. */
  state?: string;
}

export interface OpsResult {
  /** One line for the operator, in their words. Never "OK". */
  summary: string;
  /** Structured counts, kept on the audit row. */
  detail: Record<string, unknown>;
}

export interface OpsTask {
  key: string;
  label: string;
  stage: OpsStage;
  /** What it does and what it changes, for the button's own caption. */
  blurb: string;
  /** The terminal equivalent, so the console and the docs cannot disagree. */
  script: string;
  /** True when a run calls a metered third-party API. Shown on the button. */
  paid: boolean;
  /** Whether a state filter means anything for this task. */
  stateful?: boolean;
  defaultLimit: number;
  run(o: OpsRunOptions): Promise<OpsResult>;
}

const out = (summary: string, detail: Record<string, unknown>): OpsResult => ({ summary, detail });

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

/**
 * Clear the delisting flag from imported announcements.
 *
 * An imported sale has no parcels, so a crawler that reconciles "what the county
 * is still publishing" against "what we hold" sees nothing and marks the whole
 * announcement as having vanished. The flag is about a *county page* dropping a
 * sale, which is not a claim any importer is in a position to make.
 */
const repairDelisting: OpsTask = {
  key: "repair-delisting",
  label: "Clear false delistings",
  stage: "Observe",
  blurb:
    "Imported announcements have no parcels, so reconciliation can flag them as dropped from " +
    "their county's calendar. This clears that flag where the sale came from an import.",
  script: "npm run repair:delisting",
  paid: false,
  defaultLimit: 0,
  async run() {
    const affected = and(
      like(auctions.externalId, IMPORT_ID_SQL_PATTERN),
      isNotNull(auctions.delistedAt),
    );

    const rows = await db
      .select({ saleDate: auctions.saleDate, announced: auctions.announcedParcelCount })
      .from(auctions)
      .where(affected);

    if (rows.length === 0) {
      return out("Nothing flagged — no imported announcement is marked as delisted.", {
        cleared: 0,
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const future = rows.filter((r) => r.saleDate >= today).length;
    const parcels = rows.reduce((n, r) => n + (r.announced ?? 0), 0);

    const cleared = await db
      .update(auctions)
      .set({ delistedAt: null })
      .where(affected)
      .returning({ id: auctions.id });

    const [remaining] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auctions)
      .where(affected);

    return out(
      `Cleared ${cleared.length} imported announcement${cleared.length === 1 ? "" : "s"} ` +
        `(${future} still in the future, ${parcels.toLocaleString()} announced parcels).` +
        (remaining.n > 0 ? ` ${remaining.n} still flagged — investigate.` : ""),
      { cleared: cleared.length, future, announcedParcels: parcels, remaining: remaining.n },
    );
  },
};

/**
 * One bounded pass of the parcel-intel worker.
 *
 * The script is a daemon: it passes, sleeps, passes again. A request cannot be
 * a daemon, so this is exactly one pass — which is what the daemon's loop body
 * already was.
 */
const intelPass: OpsTask = {
  key: "intel-pass",
  label: "Run parcel intel pass",
  stage: "Observe",
  blurb:
    "Enriches the highest-priority parcels with surroundings intel — transport, amenities, " +
    "hazards. One pass; press again to continue down the queue.",
  script: "npm run intel:worker",
  paid: false,
  stateful: true,
  defaultLimit: 20,
  async run({ limit, deadline, state }) {
    const tasks = await planIntelWork({ limit, state });
    if (tasks.length === 0) {
      return out("Nothing due — every in-scope parcel already has current intel.", { parcels: 0 });
    }

    /*
     * Grouped by parcel so one parcel's sources run together, matching the
     * worker: strict priority order across the whole list would leave several
     * parcels half-enriched for as long as the loop ran.
     */
    const byLot = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const list = byLot.get(t.lotId) ?? [];
      list.push(t);
      byLot.set(t.lotId, list);
    }

    let parcels = 0;
    let signals = 0;
    let skipped = 0;
    for (const [lotId, lotTasks] of byLot) {
      if (Date.now() > deadline) break;
      const wanted = new Set(lotTasks.map((t) => t.source));
      const sources = configuredSignalSources().filter((s) => wanted.has(s.name));
      const result = await enrichLotIntel(lotId, { sources });
      if (result.skipped) skipped++;
      else signals += result.totalSignals;
      parcels++;
    }

    const left = byLot.size - parcels;
    return out(
      `${parcels} parcel${parcels === 1 ? "" : "s"} enriched, ${signals} signal${
        signals === 1 ? "" : "s"
      } recorded` +
        (skipped ? `, ${skipped} skipped` : "") +
        (left > 0 ? `. ${left} in this batch not reached — press again.` : "."),
      { parcels, signals, skipped, notReached: left },
    );
  },
};

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

/**
 * Fill assessed value and address on parcels that have neither.
 *
 * Metered: ATTOM and RentCast both charge per lookup. The limit is the spend
 * control, and it is per press.
 */
const enrichLots: OpsTask = {
  key: "enrich-lots",
  label: "Enrich parcels (assessed value)",
  stage: "Price",
  blurb:
    "Fills address, assessed value and beds from ATTOM or RentCast for parcels missing them. " +
    "Highest opening bids first, because opening bid tracks assessed value closely.",
  script: "npm run enrich:lots",
  paid: true,
  stateful: true,
  defaultLimit: 25,
  async run({ limit, state }) {
    const summary = await enrichLotsMissingAssessed({
      state,
      limit,
      highValueFirst: true,
    });
    return out(
      `${summary.updated} of ${summary.attempted} parcel${
        summary.attempted === 1 ? "" : "s"
      } enriched.`,
      { ...summary },
    );
  },
};


// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

/*
 * These two import `lib/cape/script.ts` directly and never `lib/cape/produce.ts`.
 *
 * That is deliberate and load-bearing. `produce.ts` imports slides, voice and
 * video at module scope, which drags `sharp` and a child process that shells
 * out to ffmpeg into whatever bundle imports it. Neither belongs in a Server
 * Function, and importing the orchestrator to use only its first step would put
 * both there. The script stage is reachable without them because it writes
 * nothing but Postgres rows.
 */

/** Rank upcoming packages the way Component Eight does: by production deadline. */
async function rankedPackages() {
  const inputs = await capePackageInputs();
  return inputs
    .map((input) => ({ input, pkg: buildPackage(input) }))
    .sort((a, b) => a.pkg.deadline.dueDate.localeCompare(b.pkg.deadline.dueDate));
}

/** A package needs a script when none exists, or the facts have moved under it. */
function needsScript(r: { input: Awaited<ReturnType<typeof rankedPackages>>[number]["input"] }) {
  const p = r.input.production;
  return !p || !p.hasScript || p.inputsHash !== capeInputsHash(r.input);
}

/**
 * What a production run would do, without doing any of it.
 *
 * The terminal equivalent is `npm run cape:plan`, and it is on the console for
 * the same reason the plan exists at all: the decision to spend on 152
 * narrations should be made while looking at the number, not after.
 */
const capePlan: OpsTask = {
  key: "cape-plan",
  label: "Plan CAPE production",
  stage: "Package",
  blurb:
    "Counts upcoming county packages, how many are current, and which are due soonest by " +
    "production deadline. Reads only — no model calls, no speech, no spend.",
  script: "npm run cape:plan",
  paid: false,
  defaultLimit: 10,
  async run({ limit }) {
    const ranked = await rankedPackages();
    if (ranked.length === 0) {
      return out("No upcoming sales, so there is nothing to package.", { packages: 0 });
    }

    const stale = ranked.filter(needsScript);
    const noVideo = ranked.filter((r) => !r.input.production?.hasVideo);
    const held = ranked.filter((r) => (r.input.production?.unsupportedFigures ?? []).length > 0);
    const releasable = ranked.filter((r) => r.pkg.releasable).length;
    const overdue = ranked.filter((r) => r.pkg.deadline.overdue).length;

    const next = ranked.slice(0, Math.max(1, limit)).map((r) => ({
      due: r.pkg.deadline.dueDate,
      county: r.input.countyName,
      state: r.input.state,
      saleDate: r.input.saleDate,
      lots: r.input.lotCount,
      score: Math.round(r.pkg.score * 100),
      blockedBy: r.pkg.blockedBy,
    }));

    return out(
      `${ranked.length} upcoming package${ranked.length === 1 ? "" : "s"}: ` +
        `${releasable} releasable, ${stale.length} need a script, ` +
        `${noVideo.length} have no video` +
        (held.length > 0 ? `, ${held.length} held on unsupported figures` : "") +
        (overdue > 0 ? `. ${overdue} past their production deadline.` : "."),
      { packages: ranked.length, releasable, needScript: stale.length, noVideo: noVideo.length, held: held.length, overdue, next },
    );
  },
};

/**
 * Draft narration scripts, and nothing else.
 *
 * Metered: one model call per package. It stops there on purpose — the rest of
 * Component Seven needs ffmpeg and a writable disk, so it stays in the terminal
 * (see TERMINAL_ONLY). Drafting alone is still worth a button, because the
 * script stage is where the quality signal appears: `verifyNarration` rejects
 * any figure the model spoke that is not in the computed facts, and Component
 * Nine reads the result. Finding out which packages invent numbers should not
 * require buying speech for them first.
 */
const capeScripts: OpsTask = {
  key: "cape-scripts",
  label: "Draft CAPE narration scripts",
  stage: "Package",
  blurb:
    "Writes the narration script and slide plan for packages that have none or whose facts have " +
    "changed, checking every spoken figure against the computed package. No speech, no video.",
  script: "npm run cape:produce -- --script-only",
  paid: true,
  defaultLimit: 3,
  async run({ limit, deadline }) {
    const ranked = await rankedPackages();
    const pending = ranked.filter(needsScript).slice(0, limit);
    if (pending.length === 0) {
      return out("Every upcoming package has a current script.", { drafted: 0 });
    }

    let drafted = 0;
    let held = 0;
    let failed = 0;
    const holds: { county: string | null; figures: string[] }[] = [];

    for (const { input } of pending) {
      /*
       * Checked before the call, not after: a model call that starts at 24s
       * finishes well outside the budget and its result is lost anyway.
       */
      if (Date.now() > deadline) break;

      /*
       * The CAPE worker's own path, not a copy of it. This button used to call
       * the model directly: no per-county cache, no wrong-county hold, and none
       * of Ed's review notes — a second implementation drifting from the one
       * that runs every three minutes. `produceCapePackage` records failures
       * and holds on the production row itself.
       */
      const result = await produceCapePackage(input, { outRoot: "/tmp/cape", scriptOnly: true, scriptAttempts: 1 });
      if (result.stage === "failed") failed++;
      else if (result.unsupportedFigures.length > 0 || result.skipped) {
        held++;
        holds.push({ county: input.countyName, figures: result.unsupportedFigures.length ? result.unsupportedFigures : [result.skipped ?? "held"] });
      } else drafted++;
    }

    const attempted = drafted + held + failed;
    const left = ranked.filter(needsScript).length - attempted;
    return out(
      `${drafted} script${drafted === 1 ? "" : "s"} drafted` +
        (held > 0
          ? `, ${held} HELD on figures the facts do not support (${holds
              .map((h) => `${h.county}: ${h.figures.join(", ")}`)
              .join("; ")})`
          : "") +
        (failed > 0 ? `, ${failed} failed` : "") +
        (left > 0 ? `. ${left} still without a current script — press again.` : "."),
      { drafted, held, failed, holds, notReached: Math.max(0, left) },
    );
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const OPS_TASKS: OpsTask[] = [repairDelisting, intelPass, enrichLots, capePlan, capeScripts];

export const opsTask = (key: string): OpsTask | undefined =>
  OPS_TASKS.find((t) => t.key === key);

/**
 * Operations that cannot become buttons yet, and the one reason why.
 *
 * Rendered on the console beside the buttons rather than left as an absence, so
 * "why is the prospector not here" has an answer on the page instead of in
 * somebody's memory.
 */
export const TERMINAL_ONLY: { script: string; label: string; blocker: string }[] = [
  { script: "npm run prospect", label: "Prospector (researched counties)", blocker: "registry file" },
  { script: "npm run prospect:national", label: "Prospector (national sweep)", blocker: "registry file" },
  { script: "npm run prospect:announced", label: "Prospector (announced sales)", blocker: "registry file" },
  { script: "npm run cartographer", label: "Cartographer", blocker: "writes atlas files" },
  { script: "npm run scout", label: "Scout", blocker: "reads registry file" },
  { script: "npm run promote:sources", label: "Promote scout sources", blocker: "registry file" },
  { script: "npm run crawl:results", label: "Results crawler", blocker: "registry file + JSONL output" },
  { script: "npm run crawl:directory", label: "Directory crawler", blocker: "writes registry file" },
  { script: "npm run scan:html", label: "Scan HTML lot pages", blocker: "reads registry file" },
  { script: "npm run ingest:found", label: "Ingest found lists", blocker: "registry file" },
  { script: "npm run flywheel:coverage", label: "Coverage cycle", blocker: "writes scoreboard file" },
  {
    script: "npm run cape:produce",
    label: "CAPE slides, narration and encode",
    blocker: "sharp + ffmpeg + writes MP4/MP3/PNG",
  },
];
