/**
 * Auction Scout — the calendar-driven crawl loop.
 *
 * Composes the three pieces that already exist rather than replacing them: the
 * calendar decides *when*, the Prospector registry decides *where*, and the
 * existing `policy → fetch → adapter → judge → runner` spine still does the
 * fetching and the judging. Nothing here bypasses `politeFetch`, so the access
 * policy holds for scheduled crawls exactly as it does for manual ones.
 */

import { ADAPTERS } from "../ingest/adapters";
import { runAdapter, type CountyRunResult } from "../ingest/runner";
import type { SourceRegistry } from "../prospector/types";
import {
  adapterBacklog,
  planScout,
  sourceIndexFromRegistry,
  type CountyHealth,
  type ScoutPlan,
} from "./schedule";

export * from "./schedule";

/**
 * Build county → adapter from the adapters themselves.
 *
 * Adapters declare their own coverage via `discoverCounties()`, so this stays
 * correct as adapters are added without a second registry to keep in sync.
 * Cached because `discoverCounties` may hit the network for platform-wide
 * adapters, and the Scout asks for this on every planning pass.
 */
let adapterIndexCache: Record<string, string> | null = null;

export async function buildAdapterIndex(
  opts: { refresh?: boolean } = {},
): Promise<Record<string, string>> {
  if (adapterIndexCache && !opts.refresh) return adapterIndexCache;

  const index: Record<string, string> = {};
  for (const adapter of ADAPTERS) {
    try {
      for (const binding of await adapter.discoverCounties()) {
        // First adapter to claim a county keeps it. ADAPTERS order is therefore
        // a precedence list, which is worth knowing when adding one.
        index[binding.countyFips] ??= adapter.name;
      }
    } catch (e) {
      console.warn(`[scout] ${adapter.name}.discoverCounties failed: ${e}`);
    }
  }
  adapterIndexCache = index;
  return index;
}

export interface ScoutOptions {
  fipsList: readonly string[];
  registry?: SourceRegistry;
  healthByCounty?: Record<string, CountyHealth>;
  on?: Date;
  maxTasks?: number;
  dryRun?: boolean;
  onProgress?: (msg: string) => void;
}

/** Plan without running. Safe to call anywhere — no writes, no crawling. */
export async function planScoutRun(opts: ScoutOptions): Promise<ScoutPlan> {
  return planScout({
    fipsList: opts.fipsList,
    adapterByCounty: await buildAdapterIndex(),
    sourceByCounty: opts.registry ? sourceIndexFromRegistry(opts.registry) : {},
    healthByCounty: opts.healthByCounty,
    on: opts.on,
    maxTasks: opts.maxTasks,
  });
}

export interface ScoutRunResult {
  plan: ScoutPlan;
  results: (CountyRunResult & { adapter: string; kind: string })[];
  totals: {
    attempted: number;
    ok: number;
    failed: number;
    blocked: number;
    auctions: number;
    lots: number;
    rejected: number;
    repaired: number;
  };
  /** Counties with a live source and no parser — the adapter backlog. */
  backlog: { fips: string; state: string; url: string }[];
}

/**
 * Execute today's plan.
 *
 * Runs one county at a time through the existing runner. Sequential on purpose:
 * `politeFetch` enforces per-host delays, and many counties share a host, so
 * parallelising here would only defeat the rate limiting that keeps this
 * welcome on government servers.
 */
export async function runScout(opts: ScoutOptions): Promise<ScoutRunResult> {
  const plan = await planScoutRun(opts);
  const progress = opts.onProgress ?? (() => {});
  const results: ScoutRunResult["results"] = [];

  progress(
    `[scout] ${plan.date}: ${plan.coverage.runnable} runnable of ${plan.coverage.dueToday} due ` +
      `(${plan.coverage.noAdapter} no adapter, ${plan.coverage.noSource} no source, ` +
      `${plan.coverage.backedOff} backed off)`,
  );

  for (const task of plan.tasks) {
    const adapter = ADAPTERS.find((a) => a.name === task.adapter);
    if (!adapter) continue;
    progress(`[scout] ${task.fips} ${task.kind} via ${task.adapter} — ${task.reason}`);

    const summary = await runAdapter(adapter, {
      countyFips: task.fips,
      dryRun: opts.dryRun,
      onProgress: opts.onProgress,
    });
    for (const r of summary.counties) {
      results.push({ ...r, adapter: adapter.name, kind: task.kind });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      attempted: acc.attempted + 1,
      ok: acc.ok + (r.status === "ok" ? 1 : 0),
      failed: acc.failed + (r.status === "failed" ? 1 : 0),
      blocked: acc.blocked + (r.status === "blocked" ? 1 : 0),
      auctions: acc.auctions + r.auctionsFound,
      lots: acc.lots + r.lotsFound,
      rejected: acc.rejected + r.rejected,
      repaired: acc.repaired + r.repaired,
    }),
    {
      attempted: 0,
      ok: 0,
      failed: 0,
      blocked: 0,
      auctions: 0,
      lots: 0,
      rejected: 0,
      repaired: 0,
    },
  );

  return { plan, results, totals, backlog: adapterBacklog(plan) };
}
