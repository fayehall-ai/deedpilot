# Louisiana — SUPERSEDES the LA half of `statute-la-co-2026-08-13.md`

**Do not merge that draft.** It models Louisiana as a redeemable deed state with
5% penalty plus 1%/month. That system was repealed. Louisiana stopped selling
tax deeds on 1 January 2026.

This file records what verification found, and why LA is still not promotable —
for a completely different reason than the one the old draft was blocked on.

## What changed

Acts 2024, No. 774 (further amended by Acts 2025, No. 411) converted Louisiana
from tax sales to **tax lien certificates**, effective 1 January 2026.

Verified against the statute text, not summarised:

> **R.S. 47:2154(E)(1)** — "No later than thirty days after conclusion of the tax
> lien auction, the tax collector shall issue and file in the mortgage records of
> the parish in which the property is situated a tax lien certificate in favor of
> the winning bidder."

Two further results from the same pass:

- **R.S. 47:2266** — the quiet-title / confirmation provision the old draft priced
  against — returned `silent`, with the note *"Repealed by Acts 2024, No. 774, §2,
  eff. Jan. 1, 2026."* The draft costed a proceeding that no longer exists.
- **R.S. 47:2122** now defines "tax sale" and "tax sale title" as **pre-2026**
  terms and "tax lien auction" / "tax lien" as the post-2025 ones. The vocabulary
  itself is split on the date, which is a useful tell when reading any secondary
  source: anything not explicitly dated after 2025 is describing the old system.

## The economics are a different shape, not different numbers

Bidding is no longer on price. It is **competitive on the monthly interest rate**:
capped at 1% per month, with no bid permitted below 0.7% per month. The winner
takes the certificate at face value and earns the rate they bid.

So the investor's return is not a statutory penalty schedule at all — it is
whatever the room bids it down to, exactly the structure Illinois has.

## Why it still cannot be promoted

`StatuteParams.redemption.bidDown` is the correct shape for this, and it is the
reason LA is blocked:

```ts
interface BidDownPenalty {
  statutoryMax: number;      // 0.01/month — known
  observedMedian: number;    // unknown
  observedMean: number;      // unknown
  n: number;                 // 0
  observedSource: string;    // none
}
```

`statutoryMax` is the only field the statute answers. The other four require
**recorded clearing rates**, and Louisiana has none — the first auction under the
new regime is the one already on our calendar. Filling them from the statutory
ceiling would repeat the exact error the Illinois work existed to correct:
quoting an 18% cap as a return when 64,526 recorded Cook sales cleared at a 0%
median overstated it roughly tenfold.

The schema demands observation here precisely so this cannot be guessed.

## What we hold

1,638 lots across one auction dated **2026-08-12**, all post-Act. The adapter
already records `sale_type = 'Tax Lien'`, so the crawl side is correct and no
backfill is needed — it was only the pricing proposal that was wrong.

## Unblocking path

Results-crawl the 2026-08-12 auction. Winning **rates** — not prices — populate
`observedMedian`, `observedMean` and `n`, and LA becomes promotable from
observation rather than from a ceiling. Until then LA parcels should keep
returning `insufficient-data`, which is the honest answer and is what they do
today.

## Human checklist

- [ ] Confirm the certificate's redemption/termination price formula under the
      amended Chapter — the payoff a lienholder receives, and when foreclosure
      may begin
- [ ] Confirm whether any pre-2026 tax sale titles remain in the pipeline that
      still need the OLD deed model (a second entry, not a replacement)
- [ ] Decide whether a lien state with zero observed rates should carry an entry
      at all, or stay uncovered until the first results crawl
