/**
 * Apply property enrichment to a lot row + lot_valuations.
 */

import { and, eq, isNull, sql, gte } from "drizzle-orm";
import { db } from "../db";
import { lots, lotValuations, counties } from "../db/schema";
import type { EnrichInput, PropertyProvider, PropertyRecord } from "./types";
import { ProviderUnavailableError } from "./types";
import { rentcastProvider } from "./providers/rentcast";
import { attomProvider } from "./providers/attom";
import { batchdataProvider } from "./providers/batchdata";

/**
 * ATTOM first for APN → assessed (max-bid).
 * BatchData next for address/owner when ATTOM misses or for address fills.
 * RentCast last (address + AVM; needs street).
 */
const PROVIDERS: PropertyProvider[] = [
  attomProvider,
  batchdataProvider,
  rentcastProvider,
];

export function configuredEnrichmentProviders(): string[] {
  return PROVIDERS.filter((p) => p.configured()).map((p) => p.name);
}

/**
 * Try providers in order until one returns a record.
 * ATTOM first when parcel# present; RentCast needs an address.
 */
export async function lookupProperty(input: EnrichInput): Promise<PropertyRecord | null> {
  const order = [...PROVIDERS].sort((a, b) => {
    // Prefer ATTOM when we only have parcel
    if (!input.addressLine && a.name === "attom") return -1;
    if (!input.addressLine && b.name === "attom") return 1;
    return 0;
  });

  const errors: string[] = [];
  for (const p of order) {
    if (!p.configured()) continue;
    try {
      const rec = await p.lookup(input);
      if (rec) return rec;
    } catch (e) {
      // An unusable provider is not a miss on this parcel. Rethrow at once
      // rather than falling through to the others and returning null, which
      // is what turned an exhausted ATTOM key into 799 phantom "no match"
      // results on a single Arkansas run.
      if (e instanceof ProviderUnavailableError) throw e;
      errors.push(`${p.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (errors.length && !configuredEnrichmentProviders().length) {
    return null;
  }
  if (errors.length) {
    // Surface last errors only when all configured providers failed
    const configured = order.filter((p) => p.configured());
    if (configured.length && errors.length >= configured.length) {
      throw new Error(errors.join(" | "));
    }
  }
  return null;
}

export interface ApplyEnrichmentResult {
  lotId: string;
  provider: string | null;
  updated: boolean;
  record: PropertyRecord | null;
  reason?: string;
}

/** Lookup + write enrichment for one lot id. */
export async function enrichLotById(
  lotId: string,
  opts: { force?: boolean } = {},
): Promise<ApplyEnrichmentResult> {
  const [row] = await db
    .select({
      lot: lots,
      county: counties,
    })
    .from(lots)
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(eq(lots.id, lotId))
    .limit(1);

  if (!row) {
    return { lotId, provider: null, updated: false, record: null, reason: "lot not found" };
  }

  if (!opts.force && row.lot.assessedValue && row.lot.addressLine) {
    return {
      lotId,
      provider: null,
      updated: false,
      record: null,
      reason: "already has assessed value and address (pass force to refresh)",
    };
  }

  if (!configuredEnrichmentProviders().length) {
    return {
      lotId,
      provider: null,
      updated: false,
      record: null,
      reason:
        "No property API configured. Set ATTOM_API_KEY (parcel lookup) and/or RENTCAST_API_KEY (address lookup) in .env.local",
    };
  }

  const input: EnrichInput = {
    state: row.county.state,
    fips: row.county.fips,
    countyName: row.county.name,
    parcelNumber: row.lot.parcelNumber,
    addressLine: row.lot.addressLine,
    city: row.lot.city,
    zip: row.lot.zip,
  };

  const record = await lookupProperty(input);
  if (!record) {
    return {
      lotId,
      provider: null,
      updated: false,
      record: null,
      reason: "no match from configured providers",
    };
  }

  await applyRecordToLot(lotId, record);
  return { lotId, provider: record.source, updated: true, record };
}

export async function applyRecordToLot(lotId: string, record: PropertyRecord): Promise<void> {
  // Only write lots.assessed_value when the provider set assessedValue.
  // Do not promote marketValue/AVM into assessed here — that overwrote ATTOM
  // tax assessments when we only wanted a RentCast market valuation row.
  const assessed = record.assessedValue;

  const addressOk =
    record.addressLine &&
    /[A-Za-z0-9]/.test(record.addressLine) &&
    !/^,\s*,/.test(record.addressLine.trim());

  await db
    .update(lots)
    .set({
      ...(record.parcelNumber ? { parcelNumber: record.parcelNumber } : {}),
      ...(addressOk ? { addressLine: record.addressLine } : {}),
      ...(record.city ? { city: record.city } : {}),
      ...(record.zip ? { zip: record.zip } : {}),
      ...(record.ownerName ? { ownerName: record.ownerName } : {}),
      ...(assessed !== undefined ? { assessedValue: String(assessed) } : {}),
      ...(record.landUse || record.propertyType
        ? { landUse: record.landUse ?? record.propertyType }
        : {}),
      ...(record.acreage !== undefined ? { acreage: String(record.acreage) } : {}),
      ...(record.buildingSqft !== undefined ? { buildingSqft: Math.round(record.buildingSqft) } : {}),
      ...(record.yearBuilt !== undefined ? { yearBuilt: Math.round(record.yearBuilt) } : {}),
      ...(record.latitude !== undefined ? { latitude: String(record.latitude) } : {}),
      ...(record.longitude !== undefined ? { longitude: String(record.longitude) } : {}),
      lastSeenAt: new Date(),
    })
    .where(eq(lots.id, lotId));

  await db
    .insert(lotValuations)
    .values({
      lotId,
      source: record.source,
      assessedLand: record.landValue !== undefined ? String(record.landValue) : null,
      assessedImprovement:
        record.improvementValue !== undefined ? String(record.improvementValue) : null,
      assessedTotal: assessed !== undefined ? String(assessed) : null,
      marketValue: record.marketValue !== undefined ? String(record.marketValue) : null,
      lastSaleAmount:
        record.lastSaleAmount !== undefined ? String(record.lastSaleAmount) : null,
      lastSaleDate: record.lastSaleDate ?? null,
      homestead: record.homestead ?? null,
      zoning: record.zoning ?? null,
      // Columns now, not just `raw`. These were collected on every lookup and
      // written only into the JSON blob, so nothing could query them.
      beds: record.beds ?? null,
      baths: record.baths !== undefined ? String(record.baths) : null,
      lotSqft: record.lotSqft ?? null,
      buildingSqft: record.buildingSqft ?? null,
      yearBuilt: record.yearBuilt ?? null,
      propertyType: record.propertyType ?? null,
      // `raw` keeps the whole response. It is what let the assdImprValue typo
      // be repaired without re-paying ATTOM, so it stays complete rather than
      // being trimmed now that the fields have columns.
      raw: {
        ...record.raw,
        beds: record.beds,
        baths: record.baths,
        propertyType: record.propertyType,
      },
    })
    .onConflictDoUpdate({
      target: [lotValuations.lotId, lotValuations.source],
      set: {
        assessedTotal: sql`excluded.assessed_total`,
        marketValue: sql`excluded.market_value`,
        assessedLand: sql`excluded.assessed_land`,
        assessedImprovement: sql`excluded.assessed_improvement`,
        lastSaleAmount: sql`excluded.last_sale_amount`,
        lastSaleDate: sql`excluded.last_sale_date`,
        raw: sql`excluded.raw`,
        fetchedAt: sql`now()`,
      },
    });
}

/** Batch-enrich lots missing assessed value, optionally filtered by state. */
export async function enrichLotsMissingAssessed(opts: {
  state?: string;
  limit?: number;
  force?: boolean;
  /**
   * Enrich the most valuable parcels first, by opening bid descending.
   *
   * Every lookup costs the same, but the parcels are not worth the same. On
   * 246 enriched Arkansas lots the opening bid — which is taxes, penalties and
   * costs — correlates with assessed value at r = 0.852, so bid order is a
   * good proxy for value order when the value itself is what we are buying.
   *
   * It matters because the tail is long and cheap: Arkansas's median parcel
   * carries $194 in taxes against roughly $2,500 of implied market value, and
   * a quarter of them imply under $1,325. Enriching in arbitrary order spends
   * the same quota to surface parcels nobody will bid on.
   */
  highValueFirst?: boolean;
  /** Skip parcels below this opening bid entirely. */
  minOpeningBid?: number;
  onProgress?: (msg: string) => void;
}): Promise<{
  attempted: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Set when the run stopped early because a provider became unusable. */
  aborted?: string;
}> {
  const log = opts.onProgress ?? (() => {});
  const limit = opts.limit ?? 50;

  const conditions = [];
  if (opts.state) conditions.push(eq(counties.state, opts.state));
  if (!opts.force) conditions.push(isNull(lots.assessedValue));
  if (opts.minOpeningBid !== undefined) {
    conditions.push(gte(lots.openingBid, String(opts.minOpeningBid)));
  }

  // Prefer parcels that look like assessor APNs (dashes / letters). Pure numeric
  // IDs (e.g. Brevard tax-deed account #s) rarely match ATTOM and burn quota.
  const filtered = await db
    .select({
      id: lots.id,
      state: counties.state,
      assessed: lots.assessedValue,
    })
    .from(lots)
    .innerJoin(counties, eq(counties.fips, lots.countyFips))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      ...(opts.highValueFirst
        ? [sql`${lots.openingBid} desc nulls last`]
        : [
            sql`case
              when ${lots.parcelNumber} ~ '[A-Za-z-]' then 0
              when ${lots.addressLine} is not null then 1
              else 2
            end`,
          ]),
      lots.id,
    )
    .limit(limit);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, r] of filtered.entries()) {
    try {
      const result = await enrichLotById(r.id, { force: opts.force });
      if (result.updated) {
        updated++;
        log(`[${i + 1}/${filtered.length}] ${r.id.slice(0, 8)} ← ${result.provider}`);
      } else {
        skipped++;
        log(`[${i + 1}/${filtered.length}] skip: ${result.reason}`);
      }
    } catch (e) {
      // Stop the run. Grinding through the remaining lots against a dead
      // provider costs wall-clock, may cost quota, and — worse — buries the
      // real cause under a pile of per-lot noise. Report where it stopped so
      // the operator can resume from there once the key is fixed.
      if (e instanceof ProviderUnavailableError) {
        log(
          `\n[${i + 1}/${filtered.length}] ABORTED — ${e.message}\n` +
            `  ${updated} enriched before this point. The remaining ` +
            `${filtered.length - i} lot(s) were not attempted and are NOT misses.`,
        );
        return { attempted: i, updated, skipped, failed, aborted: e.message };
      }
      failed++;
      log(`[${i + 1}/${filtered.length}] fail: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { attempted: filtered.length, updated, skipped, failed };
}
