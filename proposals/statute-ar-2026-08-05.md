# Statute proposal — AR — REVIEW REQUIRED

Triggered by the Arkansas COSL adapter: **6,760 live lots across 46 counties**
— 74% of all live inventory — with opening bids, **0 assessed values**, and no
`STATUTE_PARAMS.AR`, so max-bid returns insufficient-data on every one.

**Nothing here is in production.** Check citations before merging into
`lib/deal/statute.ts`.

## Why this one is worth doing first

Arkansas is a single statewide seller (Commissioner of State Lands), so one
statute entry prices 46 counties at once. And unlike Florida, ARV is reachable:
**ATTOM resolved 16/16 sampled AR parcels** across 8 counties and 6 parcel
formats, most returning a street address as well. COSL publishes real assessor
APNs, not the tax-deed account IDs that block Brevard
(`docs/brevard-apn-resolution.md`).

## Confirmed by statute

### Assessment ratio — 20%

**A.C.A. § 26-26-303(c)**: real property is assessed at **20% of true, actual,
or market value**. § 26-26-304 backs this with a ratio study, deeming a county
to have failed if its September 15 ratio falls below 18% or above 22% of full
fair market value — so 20% is both the statutory rate and an enforced one, which
is stronger than a bare statutory figure.

This is the single most load-bearing number in the entry. Treating an Arkansas
assessed value as market value understates the property **5x**.

### No post-sale redemption — Arkansas is a Tax Deed state

**A.C.A. § 26-37-202**: the owner may redeem only until **4:00 p.m. CST on the
last business day before the sale**. A limited warranty deed issues to the
purchaser upon sale.

**A.C.A. § 26-37-203**: the 90-day provision is a **bar on actions contesting
the validity of the conveyance** — not a redemption right. An action to contest
is barred if not commenced within 90 days of conveyance, extended to two years
after removal of disability for minors, the mentally incapacitated, and service
members who were on wartime active duty during the window.

These are different instruments and conflating them is the error this file
exists to prevent. A redemption right is a penalty the investor *earns*; a
contest window is a title defect the investor *carries*. Pricing the 90 days as
a redemption tier would invent a return that does not exist.

### Minimum bid

**A.C.A. § 26-37-202**: parcels offered at in-person auction within two years of
the initial offering must be offered for at least delinquent taxes, penalties,
interest and costs of sale. After two years the Commissioner may negotiate.

This confirms what `lib/ingest/adapters/arkansas.ts` already records: the
published figure is **taxes owed, which doubles as the opening bid — never an
assessed value**.

### Quiet title is required in practice

Per COSL's own buyer guidance: the Commissioner **does not warrant that title
is clear or marketable**, and in most cases the purchaser must file a quiet
title or confirmation action to obtain marketable title. Unavailability of title
insurance is expressly not grounds for cancelling a sale.

Act 2270 of 2005 provides an alternative: title becomes marketable without suit
once the tax deed has been of record 15 years, taxes have been paid by the
grantee or successors throughout, no adverse possession claim has been made, and
the taxes underlying the deed were genuinely unpaid. Fifteen years is not an
investment horizon — treat quiet title as required.

## Open questions (block merge)

- [ ] **Quiet title cost and duration.** No verified Arkansas figure. The draft
      below carries placeholders that must not ship. Arkansas confirmation
      actions are commonly cheaper than the $2,500–$6,000 seen in TX/GA because
      the 90-day contest bar does much of the work, but that is an impression,
      not a citation.
- [ ] **What survives the sale.** § 26-37-203 is silent on prior liens and
      encumbrances. Need the answer for municipal liens, improvement district
      assessments and mortgages. Arkansas improvement districts (levee, drainage,
      street) are common and appear directly in our own data — the Jefferson
      County list shows "HARDING DRAIN IMP DISTRICT" as an interested party on
      multiple parcels.
- [ ] **Whether the 90-day contest window should surface as a hold period** in
      the UI even though it is not a redemption tier. It affects when a
      subscriber can resell, which is a real carrying cost.
- [ ] **Atlas conflict.** `lib/atlas/states.ts` currently records AR redemption
      as *"30 days post-sale in limited circumstances; generally none once deed
      issues."* The 30-day claim is uncited and does not match § 26-37-202's
      pre-sale cutoff. Resolve before or with this merge.

## Draft skeleton (do not merge without quiet-title figures)

```ts
  AR: {
    state: "AR",
    saleType: "Tax Deed",
    // No post-sale redemption. Redemption closes at 4:00 p.m. CST the last
    // business day before the sale (A.C.A. § 26-37-202), so a purchaser takes
    // the deed free of any redemption right. The 90-day window in § 26-37-203
    // is a bar on contesting the conveyance, not a redemption tier — do not
    // model it here.
    redemption: null,
    quietTitle: {
      typicalLow: 0,      // TODO cite — placeholder, must not ship
      typicalHigh: 0,     // TODO cite
      typicalMonths: 0,   // TODO cite
      required: true,     // confirmed: COSL warrants nothing; suit needed for marketability
    },
    closingCosts: 0,      // TODO: COSL deed issuance + county recording
    assessmentRatio: 0.2,
    assessmentBasis:
      "Arkansas assesses real property at 20% of true, actual or market value " +
      "(A.C.A. § 26-26-303(c)); § 26-26-304 fails a county whose ratio study " +
      "falls outside 18–22% of full fair market value.",
    statute: "A.C.A. §§ 26-37-202, 26-37-203 (sale and conveyance); § 26-26-303 (assessment)",
    asOf: "2026-08",
    sources: [
      "https://codes.findlaw.com/ar/title-26-taxation/ar-code-sect-26-37-202/",
      "https://codes.findlaw.com/ar/title-26-taxation/ar-code-sect-26-37-203/",
      "https://law.justia.com/codes/arkansas/title-26/subtitle-3/chapter-26/subchapter-3/section-26-26-303/",
      "https://cosl.org/Home/Buyers",
    ],
    caveats: [
      "COSL conveys by limited warranty deed and warrants nothing about title; a quiet title or confirmation action is needed for marketability. Title insurance being unavailable is not grounds to cancel the sale.",
      "The 90-day window to contest the conveyance (§ 26-37-203) is a title risk, not a redemption right, and extends to two years after removal of disability for minors, the incapacitated, and wartime service members.",
      "The published figure is taxes, penalties, interest and costs — the statutory minimum bid, not an assessed or market value.",
      "Improvement district assessments (levee, drainage, street) are common in Arkansas and appear as interested parties on COSL lists; survival after sale is unresolved.",
    ],
  },
```

## What this unlocks, and what it does not

With the 20% ratio and an ATTOM enrichment pass, all 6,760 AR lots become
priceable. That would move auto-priceable from **23.5%** back above 90%.

It will not make most of them attractive, and the entry should not be sold as
if it does. On a 10-parcel sample, estimated market value (assessed × 5) ran
**$150 to $43,100, median about $2,375** — cheap rural land, mostly unbuilt
subdivision lots around Greers Ferry Lake in Van Buren County and distressed
parcels in Pine Bluff. Back taxes were 5–22% of estimated value on 9 of 10,
which is a genuine tax-deed spread, but on small absolute numbers. One parcel
carried $172 in taxes against $150 of estimated value — a lot the engine should
tell a subscriber to walk away from, and the reason this work is worth doing.

## Coverage-loop next actions

1. **Human:** quiet-title cost/duration and lien survival — the two blockers.
2. **Human:** resolve the `states.ts` "30 days post-sale" claim.
3. **Eng:** ATTOM enrichment pass over AR lots. ~6,760 calls; consider an
   assessed-value floor first, since a $30 parcel does not repay a lookup.
4. **Eng (done):** `lib/ingest/adapters/arkansas.ts` set `saleType:
   "Redeemable Deed"`, which contradicts both the statute and `states.ts`.
   Corrected to `Tax Deed` alongside this proposal.
