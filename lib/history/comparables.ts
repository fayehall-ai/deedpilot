/**
 * Historical auction comparables for lot pages.
 *
 * Reads the compact index built by:
 *   deedpilot-copilot build-history-index
 * from copilot/data/history_index.json (recorded outcomes only).
 */

import { readFileSync, existsSync } from "fs";
import path from "path";

export interface HistoryComp {
  id: string;
  state: string;
  fips?: string | null;
  county?: string | null;
  saleType: string;
  saleDate?: string | null;
  openingBid?: number | null;
  winningBid?: number | null;
  assessedValue?: number | null;
  arvEstimate?: number | null;
  bidToAssessed?: number | null;
  redeemed?: boolean;
  ownershipTaken?: boolean;
  source?: string | null;
  provenance?: string;
}

export interface HistoryBucket {
  state: string;
  saleType: string;
  n: number;
  nWithWinningBid: number;
  /**
   * Rows whose winning bid is a comparable clearing price. Absent on indexes
   * built before label semantics landed, hence optional.
   */
  nComparablePrices?: number;
  nRedeemed: number;
  nOwnershipTaken: number;
  pRedeem: number | null;
  medianWinningBid: number | null;
  p25WinningBid: number | null;
  p75WinningBid: number | null;
  medianBidToAssessed: number | null;
  comps: HistoryComp[];
}

export interface HistoryIndex {
  builtAt: string;
  sourcePath: string;
  nOutcomes: number;
  nBuckets: number;
  buckets: Record<string, HistoryBucket>;
}

export interface ComparablesResult {
  key: string;
  bucket: HistoryBucket | null;
  comps: HistoryComp[];
  nOutcomesTotal: number;
  builtAt: string | null;
  note: string;
}

const INDEX_CANDIDATES = [
  path.join(process.cwd(), "copilot/data/history_index.json"),
  path.join(process.cwd(), "data/history_index.json"),
];

let cached: HistoryIndex | null | undefined;

function loadIndex(): HistoryIndex | null {
  if (cached !== undefined) return cached;
  for (const p of INDEX_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      cached = JSON.parse(readFileSync(p, "utf8")) as HistoryIndex;
      return cached;
    } catch {
      continue;
    }
  }
  cached = null;
  return null;
}

/** Test seam */
export function __clearHistoryIndexCache() {
  cached = undefined;
}

function scoreComp(
  c: HistoryComp,
  opts: { assessed?: number; opening?: number; fips?: string },
): number {
  let s = 0;
  if (opts.fips && c.fips === opts.fips) s -= 1000;
  if (opts.assessed && c.assessedValue && c.assessedValue > 0) {
    s += Math.abs(Math.log1p(c.assessedValue) - Math.log1p(opts.assessed));
  }
  if (opts.opening && c.winningBid && c.winningBid > 0) {
    s += Math.abs(Math.log1p(c.winningBid) - Math.log1p(opts.opening)) * 0.5;
  }
  if (!c.winningBid) s += 50;
  return s;
}

export function getComparables(opts: {
  state: string;
  saleType: string;
  assessedValue?: number;
  openingBid?: number;
  fips?: string;
  limit?: number;
}): ComparablesResult {
  const limit = opts.limit ?? 10;
  const index = loadIndex();
  const key = `${opts.state}|${opts.saleType}`;

  if (!index) {
    return {
      key,
      bucket: null,
      comps: [],
      nOutcomesTotal: 0,
      builtAt: null,
      note: "history_index.json missing — run: deedpilot-copilot build-history-index",
    };
  }

  let bucket = index.buckets[key] ?? null;
  // Fallback: any bucket for this state
  if (!bucket) {
    const stateKeys = Object.keys(index.buckets).filter((k) =>
      k.startsWith(`${opts.state}|`),
    );
    if (stateKeys.length) bucket = index.buckets[stateKeys[0]] ?? null;
  }

  if (!bucket) {
    return {
      key,
      bucket: null,
      comps: [],
      nOutcomesTotal: index.nOutcomes,
      builtAt: index.builtAt,
      note: `No historical bucket for ${key}`,
    };
  }

  const ranked = [...bucket.comps].sort(
    (a, b) =>
      scoreComp(a, {
        assessed: opts.assessedValue,
        opening: opts.openingBid,
        fips: opts.fips,
      }) -
      scoreComp(b, {
        assessed: opts.assessedValue,
        opening: opts.openingBid,
        fips: opts.fips,
      }),
  );

  return {
    key,
    bucket,
    comps: ranked.slice(0, limit),
    nOutcomesTotal: index.nOutcomes,
    builtAt: index.builtAt,
    note:
      bucket.nWithWinningBid > 0
        ? `${bucket.n} recorded outcomes in ${key} (${bucket.nWithWinningBid} with winning bid).`
        : `${bucket.n} recorded outcomes in ${key}; few winning bids in sample.`,
  };
}
