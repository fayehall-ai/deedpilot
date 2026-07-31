/**
 * Shared shapes for the historical comparables index.
 *
 * Split out from `comparables.ts` because that module reads the index off disk
 * with `fs`, and the deal calculator is a client component. A type-only import
 * is erased by TypeScript but Turbopack still traces the module graph, so the
 * bundler followed the edge and the production build failed on `Can't resolve
 * 'fs'` — while `tsc --noEmit` passed. Keeping the types in a module with no
 * runtime imports makes the server boundary structural rather than a convention
 * someone has to remember.
 */

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
