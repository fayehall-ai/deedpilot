/**
 * Server-side suggested bid — loads the history index from disk, then computes.
 *
 * Kept out of `suggested-bid.ts` because that module is imported by the deal
 * calculator, which is a client component. The previous arrangement put this
 * function there behind a lazy `require("./comparables")` with a comment saying
 * the laziness kept `fs` out of client bundles. It did not: Turbopack traces
 * `require()` as readily as `import`, so the production build failed on
 * `Can't resolve 'fs'` — while `tsc --noEmit` passed, which is why it survived
 * review. A separate module makes the boundary structural.
 */

import "server-only";
import { getComparables } from "./comparables";
import { computeSuggestedBid, type SuggestedBidInput, type SuggestedBidResult } from "./suggested-bid";

/** Server/API helper: load bucket via history index then compute. */
export function computeSuggestedBidWithIndex(
  input: Omit<SuggestedBidInput, "historyBucket" | "historyKey">,
): SuggestedBidResult {
  const comps = getComparables({
    state: input.state,
    saleType: input.saleType,
    assessedValue: input.assessedValue,
    openingBid: input.openingBid,
    fips: input.fips,
    limit: 1,
  });
  return computeSuggestedBid({
    ...input,
    historyBucket: comps.bucket,
    historyKey: comps.key,
  });
}
