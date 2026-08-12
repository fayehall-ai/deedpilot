/**
 * What the operations console reads.
 *
 * Every figure here answers one of three questions an operator actually asks:
 * did the source run, what did it return, and where is the pipeline stuck.
 * Nothing is smoothed or rounded up — a source that has never produced a lot
 * should look like a source that has never produced a lot.
 */
import "server-only";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { ADAPTERS } from "../ingest/adapters";
import { SOURCE_POLICIES, type PolicyDecision } from "../ingest/policy";

export interface AdapterHealth {
  name: string;
  platform: string;
  description: string;
  /** Null when the adapter is registered but has never run. */
  lastRunAt: string | null;
  lastStatus: string | null;
  /** Most recent error text across any county, newest first. */
  lastError: string | null;
  runs: number;
  countiesTouched: number;
  auctionsFound: number;
  lotsFound: number;
  rejected: number;
  repaired: number;
  /** Runs in the last 7 days, and how many of them failed outright. */
  recentRuns: number;
  recentFailures: number;
  /** Distinct counties that produced at least one lot, ever. */
  countiesProducing: number;
  medianDurationMs: number | null;
}

/**
 * Per-adapter health, joined onto the registry rather than derived from it.
 *
 * The registry is the source of truth for what *exists*; `ingest_runs` is the
 * source of truth for what *happened*. An adapter present in code but absent
 * from the run table is the single most useful row on this page — it is
 * either newly added or silently never scheduled, and both look identical
 * from the outside until someone checks.
 */
export async function getAdapterHealth(): Promise<AdapterHealth[]> {
  const rows = (await db.execute(sql.raw(`
    SELECT
      adapter,
      max(started_at)::text                                            AS last_run_at,
      count(*)::int                                                    AS runs,
      count(DISTINCT county_fips)::int                                 AS counties_touched,
      count(DISTINCT county_fips) FILTER (WHERE lots_found > 0)::int   AS counties_producing,
      coalesce(sum(auctions_found), 0)::int                            AS auctions_found,
      coalesce(sum(lots_found), 0)::int                                AS lots_found,
      coalesce(sum(rejected), 0)::int                                  AS rejected,
      coalesce(sum(repaired), 0)::int                                  AS repaired,
      count(*) FILTER (WHERE started_at > now() - interval '7 days')::int AS recent_runs,
      count(*) FILTER (WHERE started_at > now() - interval '7 days'
                         AND status NOT IN ('ok','partial'))::int      AS recent_failures,
      (array_agg(status ORDER BY started_at DESC))[1]                  AS last_status,
      (array_agg(error  ORDER BY started_at DESC)
         FILTER (WHERE error IS NOT NULL))[1]                          AS last_error,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)::int    AS median_duration_ms
    FROM ingest_runs
    GROUP BY adapter
  `))) as Record<string, unknown>[];

  const byName = new Map(rows.map((r) => [String(r.adapter), r]));

  return ADAPTERS.map((a) => {
    const r = byName.get(a.name);
    return {
      name: a.name,
      platform: a.platform,
      description: a.description,
      lastRunAt: (r?.last_run_at as string | null) ?? null,
      lastStatus: (r?.last_status as string | null) ?? null,
      lastError: (r?.last_error as string | null) ?? null,
      runs: Number(r?.runs ?? 0),
      countiesTouched: Number(r?.counties_touched ?? 0),
      countiesProducing: Number(r?.counties_producing ?? 0),
      auctionsFound: Number(r?.auctions_found ?? 0),
      lotsFound: Number(r?.lots_found ?? 0),
      rejected: Number(r?.rejected ?? 0),
      repaired: Number(r?.repaired ?? 0),
      recentRuns: Number(r?.recent_runs ?? 0),
      recentFailures: Number(r?.recent_failures ?? 0),
      medianDurationMs: r?.median_duration_ms == null ? null : Number(r.median_duration_ms),
    };
  }).sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
}

export interface RunRow {
  adapter: string;
  county: string | null;
  state: string | null;
  status: string;
  auctionsFound: number;
  lotsFound: number;
  rejected: number;
  error: string | null;
  startedAt: string;
  durationMs: number | null;
}

/** The most recent runs, newest first — the tail an operator reads after a cron. */
export async function getRecentRuns(limit = 40): Promise<RunRow[]> {
  const rows = (await db.execute(sql.raw(`
    SELECT r.adapter, c.name AS county, c.state, r.status,
           coalesce(r.auctions_found,0)::int AS auctions_found,
           coalesce(r.lots_found,0)::int     AS lots_found,
           coalesce(r.rejected,0)::int       AS rejected,
           r.error, r.started_at::text AS started_at, r.duration_ms
    FROM ingest_runs r
    LEFT JOIN counties c ON c.fips = r.county_fips
    ORDER BY r.started_at DESC
    LIMIT ${Math.min(200, Math.max(1, Math.trunc(limit)))}
  `))) as Record<string, unknown>[];

  return rows.map((r) => ({
    adapter: String(r.adapter),
    county: (r.county as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    status: String(r.status),
    auctionsFound: Number(r.auctions_found),
    lotsFound: Number(r.lots_found),
    rejected: Number(r.rejected),
    error: (r.error as string | null) ?? null,
    startedAt: String(r.started_at),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  }));
}

export interface PolicyRow {
  host: string;
  decision: PolicyDecision;
  minDelayMs: number;
  reason: string;
}

/**
 * Access decisions, straight from code.
 *
 * Deliberately not stored in the database: a decision not to crawl a host is a
 * reviewed judgement that belongs in version control with its reasoning, not
 * in a table someone can edit at 2am. The console renders it so the operator
 * can see *why* a source is missing without reading the source.
 */
export function getPolicies(): PolicyRow[] {
  return [...SOURCE_POLICIES]
    .map((p) => ({ host: p.host, decision: p.decision, minDelayMs: p.minDelayMs, reason: p.reason }))
    .sort((a, b) => a.decision.localeCompare(b.decision) || a.host.localeCompare(b.host));
}

export interface InventorySnapshot {
  totalAuctions: number;
  upcoming: number;
  confirmed: number;
  inventoryAuctions: number;
  inventoryParcels: number;
  leadParcels: number;
  states: { state: string; auctions: number; parcels: number; inventory: number }[];
}

/**
 * What the database actually holds, split by the rule that defines inventory.
 *
 * `listing_kind = 'sale_list' AND sale_date_confirmed` is the pair that
 * separates something biddable from a delinquent roll under a projected date.
 * Both halves are shown because the gap between them is the number that
 * explains a quiet calendar.
 */
export async function getInventorySnapshot(): Promise<InventorySnapshot> {
  const [totals] = (await db.execute(sql.raw(`
    SELECT
      count(*)::int AS total_auctions,
      count(*) FILTER (WHERE sale_date >= CURRENT_DATE)::int AS upcoming,
      count(*) FILTER (WHERE sale_date_confirmed AND sale_date >= CURRENT_DATE)::int AS confirmed,
      count(*) FILTER (WHERE listing_kind='sale_list' AND sale_date_confirmed
                         AND sale_date >= CURRENT_DATE)::int AS inventory_auctions
    FROM auctions
  `))) as Record<string, unknown>[];

  const [parcels] = (await db.execute(sql.raw(`
    SELECT
      count(*) FILTER (WHERE a.listing_kind='sale_list' AND a.sale_date_confirmed
                         AND a.sale_date >= CURRENT_DATE)::int AS inventory_parcels,
      count(*) FILTER (WHERE a.listing_kind <> 'sale_list' OR NOT a.sale_date_confirmed)::int AS lead_parcels
    FROM lots l JOIN auctions a ON a.id = l.auction_id
  `))) as Record<string, unknown>[];

  const states = (await db.execute(sql.raw(`
    SELECT c.state,
      count(DISTINCT a.id)::int AS auctions,
      coalesce(sum(a.lot_count), 0)::int AS parcels,
      count(DISTINCT a.id) FILTER (WHERE a.listing_kind='sale_list' AND a.sale_date_confirmed
                                     AND a.sale_date >= CURRENT_DATE)::int AS inventory
    FROM auctions a JOIN counties c ON c.fips = a.county_fips
    GROUP BY c.state
    ORDER BY inventory DESC, parcels DESC
  `))) as Record<string, unknown>[];

  return {
    totalAuctions: Number(totals?.total_auctions ?? 0),
    upcoming: Number(totals?.upcoming ?? 0),
    confirmed: Number(totals?.confirmed ?? 0),
    inventoryAuctions: Number(totals?.inventory_auctions ?? 0),
    inventoryParcels: Number(parcels?.inventory_parcels ?? 0),
    leadParcels: Number(parcels?.lead_parcels ?? 0),
    states: states.map((s) => ({
      state: String(s.state),
      auctions: Number(s.auctions),
      parcels: Number(s.parcels),
      inventory: Number(s.inventory),
    })),
  };
}

/** Operator overrides currently overlaying the code registry. */
export async function getSourceOverrides() {
  const { sourceOverrides } = await import("../db/schema");
  const { desc } = await import("drizzle-orm");
  return db.select().from(sourceOverrides).orderBy(desc(sourceOverrides.updatedAt));
}

/** Operator overrides currently overlaying the reviewed access decisions. */
export async function getPolicyOverrides() {
  const { policyOverrides } = await import("../db/schema");
  const { desc } = await import("drizzle-orm");
  return db.select().from(policyOverrides).orderBy(desc(policyOverrides.updatedAt));
}
