# South Carolina — SUPERSEDES `statute-sc-2026-08-01.md`

The August draft listed five open questions and blocked on all of them. Two are
now answered against the statute text, and the answers split cleanly: **the
redemption schedule is settled and mergeable; the assessment ratio is not a
research question at all but a schema decision.**

A third finding matters more than either: **promoting SC would price 11 lots, not
3,477.**

## Redemption — verified, and the draft was missing a cap

Fetched directly from the South Carolina Legislature (27,872 characters of
statute text, not a search fallback):

> **§ 12-51-90(A)–(B)** — *"The defaulting taxpayer, any grantee from the owner,
> or any mortgage or judgment creditor may within twelve months from the date of
> the delinquent tax sale redeem each item of real estate… The lump sum amount of
> interest due on the whole amount of the delinquent tax sale based on the month
> during the redemption period the property is redeemed and that rate relates
> back to the beginning of the redemption period according to the following
> schedule: … First three months three percent of the bid amount / Months four,
> five, and six six percent / Months seven, eight, and nine nine percent / Last
> three months twelve percent"*

So the draft's guess was right on the tiers, and incomplete in two ways.

**It is a lump sum that relates back, not an accrual.** A redemption in month
seven pays 9% of the bid — not nine months of accrued interest. The tiers are
step functions on the whole bid, which is exactly what `RedemptionTier` models,
so no schema change is needed.

**There is a cap the draft did not mention:**

> *"However, in every redemption, the amount of interest due must not exceed the
> amount of the bid on the property submitted on behalf of the forfeited land
> commission pursuant to Section 12-51-55."*

That is a real ceiling on return and has no representation in `StatuteParams`
today. On a parcel bid far above the forfeited land commission's opening figure,
the 12% tier overstates what a redeeming taxpayer actually owes. Worth carrying
as a caveat at minimum; worth a field if SC is promoted.

Also noted: **2020 Act No. 174** extended redemption by a further twelve months
for property sold at 2019 sales whose period had not expired by 30 September
2020. Spent, but it establishes that the period is not immutable — the same
lesson Louisiana taught expensively.

```ts
redemption: {
  tiers: [
    { throughDays: 90,  penalty: 0.03 },
    { throughDays: 181, penalty: 0.06 },
    { throughDays: 273, penalty: 0.09 },
    { throughDays: 365, penalty: 0.12 },
  ],
  maxDays: 365,
},
```

## Assessment ratio — not a research question

The draft asked for "the" assessment ratio. There isn't one.

> **§ 12-43-220** — *"Except as otherwise provided, the ratio of assessment to
> value of property in each class shall be equal and uniform throughout the
> State. All property presently subject to ad valorem taxation shall be
> classified and assessed as follows:"*

| Class | Ratio |
|---|---|
| Owner-occupied legal residence | **4%** |
| Other real property (rental, commercial) | **6%** |
| Manufacturing and utility | **10.5%** |
| Agricultural | 4% or 6% by ownership form |

`StatuteParams.assessmentRatio` is a single number. South Carolina needs one of
four, chosen per parcel.

### Why this cannot be papered over with a default

`compute_maxbid` derives `ARV = assessedValue / assessmentRatio`, so a *lower*
ratio produces a *higher* ARV:

| Ratio used | ARV multiple of assessed |
|---|---|
| 4% | 25.0× |
| 6% | 16.7× |
| 10.5% | 9.5× |

Defaulting to 6% — the residual "all other real property" class, and the most
likely for tax-sale inventory — is right for most parcels and **overstates a
manufacturing parcel's ARV by 75%**. That error runs in the dangerous direction:
it tells a subscriber a distressed industrial site is worth more than it is.

Worse, the 4% class cannot be inferred from anything we crawl. It is a status the
owner must **apply** for and certify, and the property may not be rented more
than 72 days a year. It is a legal claim, not an attribute of the parcel.

### The decision this needs

This is the same schema question Colorado is blocked on, and SC makes it sharper
because it has four classes rather than two. Three options:

1. **A per-class map** — `assessmentRatios: { residential: 0.04, other: 0.06, manufacturing: 0.105 }`
   plus a per-parcel class. Correct, and requires a classification field the sale
   lists do not publish.
2. **A conservative single ratio with a stated caveat** — 6%, warned as
   "assumes non-owner-occupied; a manufacturing parcel is overstated." Ships now,
   honest, occasionally wrong.
3. **Refuse to derive ARV from assessed value in classified states**, requiring
   `marketValue` or `arvOverride`. Never wrong, and prices nothing in SC.

Option 1 is right if the classification can be enriched. Given no SC parcel
currently carries an assessed value at all, that is not a near-term constraint —
which brings us to the finding that actually governs.

## Promoting SC would price 11 lots

Measured against the live database rather than assumed from the draft's
"**3,461** live lots" headline:

| County | Lots | Parcel numbers | Assessed values | Addresses |
|---|---|---|---|---|
| Greenville (45045) | 3,461 | 3,461 | **0** | 0 |
| Charleston (45019) | 11 | 11 | **11** | 0 |
| Richland (45079) | 5 | 5 | **0** | 5 |

Opening bids are present and plausible across all 3,477 — average $3,523, range
$300 to $687,870 — so the crawl is healthy. What is missing is valuation.

This is New Mexico's shape exactly: parcel numbers present, addresses absent,
valuations absent. Only a parcel-number lookup can fill it, and ATTOM returns
401 while BatchData reports an insufficient balance. **The statute is not what is
blocking South Carolina.**

The same holds everywhere it was assumed otherwise:

| State | Pending lots | With assessed value |
|---|---|---|
| GA *(already priceable)* | 8,730 | **0** |
| AR *(already priceable)* | 6,760 | 1,885 |
| SC | 3,477 | 11 |
| NM | 616 | **0** |

Across the whole corpus: **20,358 of 24,934 pending lots carry no valuation at
all.** Statute coverage is not the constraint on this product. One expired
credential is.

## Still open

- **Instrument semantics.** All 3,461 Greenville rows share a single sale date of
  2026-10-15 and carry `listing_kind: 'unknown'`. Consistent with one upcoming
  sale, but the draft's worry that the table mixes multi-year certificates is not
  disproved by a shared date — the crawler could equally have stamped one.
- **Quiet title / tax title practice** after the redemption period expires — not
  researched; needs the market pass.
- **What survives the sale** — municipal liens, HOA. Not researched.

## Recommendation

Do **not** promote SC yet, but for a much narrower reason than the August draft
gave. The redemption schedule is verified and ready. What remains is one schema
decision that SC shares with Colorado, and one credential that gates the entire
product.

Order:

1. **Renew `ATTOM_API_KEY`.** Nothing in South Carolina prices without it.
2. **Decide the classified-ratio question** — it unblocks SC and CO together.
3. Run the market pass for quiet-title and surviving liens.
4. Confirm the Greenville table is one sale, not a certificate backlog.
