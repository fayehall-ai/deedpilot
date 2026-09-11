/**
 * Structured statutory parameters for the deal maths.
 *
 * The atlas stores redemption rules as prose, which is right for reading and
 * useless for arithmetic. This module encodes the same rules as numbers for
 * the five covered states only — every entry carries its statute and a check
 * date, and states without an entry return null so the engine degrades to
 * "we can't compute this, here's the prose" instead of inventing a number.
 *
 * These figures move with legislation. Re-verify against the cited statute
 * before trusting a computed max bid in a state whose `asOf` has gone stale.
 */

import type { SaleType } from "../atlas/types";

export interface RedemptionTier {
  /** Upper bound of this tier, in days from the sale/deed date. */
  throughDays: number;
  /**
   * Penalty as a fraction of the bid, e.g. 0.25 for 25%.
   *
   * Texas and Georgia levy a flat *penalty*, not interest — 25% is 25%
   * whether the owner redeems on day 3 or day 179. Annualising it produces
   * absurd headline yields, so the engine reports both the flat penalty and a
   * separate annualised figure, clearly labelled.
   */
  penalty: number;
}

/**
 * Auctions where bidders compete by lowering the penalty rate, not raising the
 * price.
 *
 * Illinois is the case that forced this to exist. Statute caps the penalty at
 * 18% per six-month period, and a naive reading makes an Illinois lien look like
 * a 36%/year instrument. Across 64,526 Cook County sales carrying a
 * `winning_bid_percent` in the county's own data catalogue — see
 * `observedSource` on the IL entry — the rate actually cleared at a
 * **median of 0% and a mean of 1.88%**, with 81.4% bid all the way to zero.
 *
 * That catalogue is the source of the RATE. It is not the same set as the
 * 70,109 Cook rows in our own historical corpus, which carry outcomes but no
 * rate field at all; conflating the two would claim we measured something we
 * only cited. Institutional buyers take these for the
 * deed remainder, not the interest.
 *
 * So the statutory cap is the best case and the observed median is the base
 * case, and the two must not be conflated. Pricing a lien at the cap overstates
 * its return by an order of magnitude — the mirror image of counting absent
 * redemption data as observed non-redemption.
 */
export interface BidDownPenalty {
  /** Statutory ceiling bidders compete down from. */
  statutoryMax: number;
  /** Median rate actually cleared, as a fraction. */
  observedMedian: number;
  observedMean: number;
  /** Recorded sales behind those figures. */
  n: number;
  /** Where the observation came from — not the statute. */
  observedSource: string;
  note: string;
}

export interface StatuteParams {
  state: string;
  saleType: SaleType;
  /** Null when the sale conveys clear title with no post-sale redemption. */
  redemption: {
    /**
     * Whether `tiers[].penalty` is a one-off penalty or a yearly rate.
     *
     * This existed only as prose and the engine guessed, always wrongly in the
     * same direction. Georgia's 20% is flat: 20% whether the owner redeems in
     * month one or month twelve, so annualising it over a short window
     * correctly produces a large number. Arizona's 16% is per year, and the
     * same arithmetic divided it across a three-year window and reported 5.33%
     * — understating a 16% instrument by three times. Kentucky was worse: 12%
     * per annum over an eleven-year statutory life came out as 1.09%.
     *
     * Defaults to "flat", which is what every entry written before this field
     * assumed and what the majority of states actually are.
     */
    interestKind?: "flat" | "annual";
    tiers: RedemptionTier[];
    /** Longest possible redemption window, in days. */
    maxDays: number;
    /** Property classes that get the longer window, in plain language. */
    extendedFor?: string;
    /**
     * Present only where the penalty is set by bidding rather than by statute.
     * When set, `tiers` describe the legal ceiling and this describes the market.
     */
    bidDown?: BidDownPenalty;
  } | null;
  /**
   * Typical cost to obtain insurable title, in dollars. A tax deed is not a
   * warranty deed; in most states you cannot resell or finance until this is
   * done, and leaving it out is the single most common way a "profitable"
   * tax deed purchase turns out not to be.
   */
  quietTitle: { typicalLow: number; typicalHigh: number; typicalMonths: number; required: boolean };
  /** Recording, documentary stamps, and deed issuance, as a rough fixed cost. */
  closingCosts: number;
  /**
   * Judgment pad on top of `closingCosts`, kept separate on purpose.
   *
   * `closingCosts` is arithmetic on published fee schedules and carries a
   * source. This is the operator's safety margin for publication, service and
   * filing incidentals — a different kind of number, and mixing the two would
   * make a judgement look sourced.
   *
   * It is NOT a lien allowance. Surviving assessments are parcel-specific and
   * can run to thousands on blighted land; a flat pad does not cover them and
   * implying otherwise hides the risk. Those belong in `caveats`.
   */
  extraClosingBuffer?: number;
  /**
   * Months from winning the auction to holding marketable title.
   *
   * Distinct from `quietTitle.typicalMonths`, which is filing-to-decree — the
   * length of the lawsuit. This is the economic figure: how long capital is
   * actually tied up, including any statutory window a purchaser waits out
   * before filing at all.
   *
   * Arkansas is the case that forced the split. Attorneys there generally wait
   * out the one-year challenge period (A.C.A. § 18-12-609) before filing, so a
   * five-month action sits inside an eighteen-month hold. Modelling carry on
   * the lawsuit alone understated it by more than a year.
   *
   * Absent, `compute_maxbid` falls back to `typicalMonths + 2`, which is the
   * right assumption for states with no such waiting period.
   */
  auctionToMarketableMonths?: number;
  /**
   * Assessed value as a fraction of fair market value — the most dangerous
   * number in this file.
   *
   * Georgia assesses at 40% of FMV and Michigan at 50%. Treating a Georgia
   * assessment as market value understates the property by 2.5x and makes
   * every parcel in the state look like a catastrophic overpay. Texas
   * assesses at 100% by statute, so the same code with one ratio would be
   * badly wrong in four of the five covered states.
   */
  assessmentRatio: number;
  /** How that ratio is set, for the "where did this number come from" panel. */
  assessmentBasis: string;
  /**
   * Counties that depart from the state ratio, keyed by 5-digit FIPS.
   *
   * Illinois assesses at 33⅓% of fair cash value statewide — except Cook
   * County, which runs a classified system under home rule at roughly 10% for
   * residential. Cook is also the source of 70,109 of our historical rows, so
   * applying the statewide ratio there would misvalue the single largest block
   * of data we have by a factor of three.
   */
  countyAssessmentRatios?: Record<string, { ratio: number; basis: string }>;
  /**
   * Warning attached whenever ARV is *derived* from an assessed value in this
   * state, because the ratio is legally right but practically misleading.
   *
   * California is the case: statute requires assessment at full cash value, so
   * the ratio is honestly 1.0 — but Proposition 13 freezes the base year and
   * factors it forward at up to 2%/yr, so a long-held parcel's assessed value
   * can sit far below what it would sell for. A 1.0 ratio is not a licence to
   * treat assessed value as an appraisal.
   */
  derivedArvCaveat?: string;
  statute: string;
  /** YYYY-MM this entry was last verified. */
  asOf: string;
  sources: string[];
  /** Anything that materially changes the maths and isn't a number. */
  caveats: string[];
}

export const STATUTE_PARAMS: Record<string, StatuteParams> = {
  AR: {
    state: "AR",
    saleType: "Tax Deed",
    /*
     * No post-sale redemption — verified against the statute text itself, not a
     * summary of it.
     *
     * § 26-37-202(e): the owner has "the right to redeem the parcel before 4:00
     * p.m. central standard time (CST) on the last business day before the date
     * of the sale by paying all taxes, penalties, interest, and costs due", and
     * a parcel not redeemed by that deadline is offered for sale, with a
     * limited warranty deed issuing if it sells. Act 241 of 2023 removed any
     * post-sale redemption; COSL's own FAQ and catalogue language match.
     *
     * § 26-37-203 governs only the deed and the contest window: (a) the limited
     * warranty deed issues on sale, (b) an action contesting the validity of
     * the conveyance is barred unless brought within 90 days, with narrow
     * disability exceptions.
     *
     * The two are opposite in sign, which is why conflating them would be
     * expensive: a redemption right is a penalty the investor EARNS, a contest
     * window is a title defect the investor CARRIES. Modelling the 90 days as a
     * tier would invent a return that does not exist.
     */
    redemption: null,
    quietTitle: {
      // Reviewed and set by the operator. Uncontested Arkansas quotes at the
      // low end; specialist tax-deed work and contingencies at the high end.
      typicalLow: 2500,
      typicalHigh: 5000,
      // Filing to decree — the length of the lawsuit, not the hold. See
      // auctionToMarketableMonths for the economic figure.
      typicalMonths: 5,
      required: true,
    },
    /*
     * From published schedules, not judgement: COSL's $25 collection fee and
     * circuit-clerk recording at $15 first page plus $5 each additional.
     * Arkansas transfer tax does NOT apply here — tax-sale deeds are
     * statutorily exempt — though it does hit a later resale at $3.30/$1,000.
     */
    closingCosts: 38,
    extraClosingBuffer: 500,
    /*
     * Eighteen months, not five. Arkansas attorneys generally wait out the
     * one-year challenge period (A.C.A. § 18-12-609) before filing, so the
     * five-month action sits inside a much longer hold. Modelling carry on the
     * lawsuit alone understated the tie-up by more than a year.
     */
    auctionToMarketableMonths: 18,
    assessmentRatio: 0.2,
    assessmentBasis:
      "Arkansas assesses real property at 20% of true, actual or market value " +
      "(A.C.A. § 26-26-303(c)); § 26-26-304 fails a county whose ratio study falls " +
      "outside 18–22% of full fair market value. Measured across 1,669 Arkansas " +
      "parcels carrying both figures, assessed/market was exactly 0.2000 on every one.",
    statute:
      "A.C.A. § 26-37-202(e) (redemption ends 4:00 p.m. CST the last business day before sale); " +
      "§ 26-37-203 (limited warranty deed; 90-day contest bar); Act 241 of 2023 (removed " +
      "post-sale redemption); § 26-26-303(c) (20% assessment ratio); § 18-12-609 (challenge period)",
    asOf: "2026-08",
    sources: [
      "https://law.justia.com/codes/arkansas/title-26/subtitle-3/chapter-26/subchapter-3/section-26-26-303/",
      "https://codes.findlaw.com/ar/title-26-taxation/ar-code-sect-26-37-202/",
      "https://codes.findlaw.com/ar/title-26-taxation/ar-code-sect-26-37-203/",
      "https://cosl.org/Home/Buyers",
      "https://www.law.cornell.edu/regulations/arkansas/135-00-21-Ark-Code-R-001",
    ],
    caveats: [
      "COSL conveys by limited warranty deed and warrants nothing about title. A quiet title or confirmation action is needed for marketability, and title insurance being unavailable is expressly not grounds to cancel the sale.",
      "The 90-day window to contest the conveyance (§ 26-37-203) is a title risk, not a redemption right, and extends to two years after removal of disability for minors, the incapacitated, and wartime service members.",
      "HISTORICAL OUTCOMES BEFORE MID-2023 ARE A DIFFERENT REGIME. Act 241 of 2023 removed post-sale redemption; Arkansas results recorded under the prior rules describe a redeemable position and must not be pooled with post-Act sales when fitting a redemption rate. Current inventory is entirely post-Act.",
      "Quiet-title cost is market practice, not statute — no Arkansas bar fee survey publishes one. The range is an operator estimate; a contested action or curative work costs materially more.",
      "SURVIVING LIENS ARE NOT PRICED HERE. Municipal code-enforcement and clean-up liens (§ 14-54-903) and special improvement district assessments can survive and are parcel-specific — 'HARDING DRAIN IMP DISTRICT' appears on Jefferson County parcels in our own data. IRS liens turn on notice and keep a 120-day redemption right if notice was defective. Mortgages, state tax liens and judgment liens are generally extinguished where COSL gave proper statutory notice. Check each parcel; the closing contingency does not cover these.",
      "The published opening bid is taxes, penalties, interest and costs — the statutory minimum bid under § 26-37-202, never an assessed or market value.",
      "The 90-day contest bar is not absolute. § 26-37-203(d) preserves a taxpayer's right to contest the deed on the ground that the taxes were actually paid, with no 90-day limit stated — a residual challenge route that outlives the window and is the reason to check payment history rather than only the notice trail. § 26-37-203(b)(2) tolls the bar for two years after removal of disability for minors, the mentally incapacitated, and those serving in the armed forces in time of war.",
      "§ 26-37-203(c) cuts the other way and favours the purchaser: a deed issued after 1 January 1987 is not void or voidable merely because the county failed to strictly comply with the tax-delinquent land laws.",
    ],
  },
  /*
   * Pennsylvania is two statutes wearing one state's name, and the split
   * changes the maths more than anything else in this file.
   *
   * ## Two regimes
   *
   * The Real Estate Tax Sale Law (72 P.S. § 5860.101 et seq., "RETSL") governs
   * 65 of the 67 counties through their county Tax Claim Bureaus. Philadelphia
   * and Allegheny run instead under the Municipal Claims and Tax Liens Act
   * (53 P.S. § 7101 et seq., "MCTLA"). USTLA's own calendar already reflects
   * this: every Pennsylvania row imports as "Deed" except Philadelphia
   * City-County, which imports as "Redeemable Deed".
   *
   * ## No post-sale redemption — under RETSL
   *
   * RETSL gives the owner a right to pay up to the sale, not after it. There is
   * no statutory right to redeem once an upset or judicial sale is confirmed,
   * which is why `redemption` is null.
   *
   * That is wrong for Philadelphia, and deliberately so. MCTLA § 7293 gives a
   * nine-month redemption running from acknowledgment of the sheriff's deed, at
   * the price paid plus 10% per annum — but only where the property was
   * owner-occupied, determined 90 days before the sale. This type has no
   * per-county redemption override, so encoding it here would apply a
   * Philadelphia rule to 65 counties that do not have it and invent a return
   * in every one of them. Null is the conservative reading: it assumes the
   * investor earns no redemption penalty anywhere. The Philadelphia risk is
   * recorded in `caveats` instead, and the missing capability is noted there
   * too. ~180 of Pennsylvania's ~40,500 announced parcels are Philadelphia's.
   *
   * ## Upset vs judicial is a title question, not a price question
   *
   * An upset sale (§§ 5860.601-609) conveys SUBJECT TO existing mortgages,
   * judgments and liens — they are not divested. A judicial sale
   * (§§ 5860.610-612) is ordered free and clear. Same state, same parcel, two
   * completely different `survivingLiens` inputs, and nothing in the sale row
   * distinguishes them. Treating an upset purchase as clear title is the most
   * expensive mistake available in Pennsylvania.
   */
  /*
   * New York is the state where the assessed value tells you almost nothing,
   * and everything else is unusually clean.
   *
   * ## What an auction buyer actually gets
   *
   * Counties enforce in rem under RPTL Article 11: the tax district forecloses,
   * the owner's redemption period runs BEFORE the district takes title, and on
   * a default judgment the owner is "barred and forever foreclosed of all
   * right, title, interest, claim, lien or equity of redemption" (RPTL 1136(3),
   * 1131). The county then resells at public auction. So the two-year period in
   * RPTL 1110 has already expired by the time an investor bids, and the deed
   * carries no redemption at all. `redemption` is null and that is the whole
   * truth, unlike Pennsylvania where null is a 65-of-67 approximation.
   *
   * ## The ratio is the problem, and 1.0 is a floor rather than an estimate
   *
   * There is no statewide level of assessment. Each of more than 1,200
   * assessing units sets its own, and ORPTS publishes an equalization rate and
   * a residential assessment ratio for each one annually. Levels run from a few
   * percent of market value to a full 100%, so a single number for New York
   * could be wrong by more than an order of magnitude in either direction.
   *
   * 1.0 is chosen deliberately as the SAFE end of that range: it treats the
   * assessment as if it were already full market value, which is exact in a
   * town at 100% and understates everywhere else. A derived New York ARV is
   * therefore a floor, and the max bid computed from it is a number that will
   * not get anyone into trouble — it will simply be too low. Supply
   * `arvOverride` from comparable sales to get a real one.
   *
   * The county-keyed `countyAssessmentRatios` cannot fix this: assessing units
   * are towns and cities, and two towns in one county routinely differ.
   */
  NY: {
    state: "NY",
    saleType: "Tax Deed",
    redemption: null,
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — placeholder, as elsewhere.
       *
       * An Article 11 deed comes out of a court judgment that expressly bars
       * the former owner, so it starts stronger than an administrative tax
       * deed. Insurers still commonly want an action, particularly where
       * service in the in rem proceeding is open to attack.
       */
      typicalLow: 2500,
      typicalHigh: 6000,
      typicalMonths: 6,
      required: true,
    },
    closingCosts: 300,
    /*
     * Short, because the waiting happened before the auction. The redemption
     * period expired while the county was foreclosing; the buyer's clock is
     * deed, recording and any title work.
     */
    auctionToMarketableMonths: 8,
    assessmentRatio: 1.0,
    assessmentBasis:
      "New York has no statewide level of assessment. Each of 1,200+ assessing units sets its own, and ORPTS publishes an equalization rate and residential assessment ratio per unit each year. 1.0 is used here as a deliberate floor — see the derived-ARV note — not as a claim that New York assesses at full value.",
    derivedArvCaveat:
      "DO NOT TRADE OFF A DERIVED ARV IN NEW YORK. Levels of assessment range from a few percent of market value to 100% across more than 1,200 assessing units, and this entry assumes 100% precisely because that is the end of the range that cannot cause an overbid. In a town assessing at 5%, a derived ARV understates the property twentyfold and the max bid will look absurdly low — that is the model refusing to guess, not the parcel being worthless. Look up the municipality's equalization rate or RAR, or supply arvOverride from comparable sales.",
    statute:
      "N.Y. Real Property Tax Law Article 11 (in rem tax foreclosure: §§ 1110 redemption, 1131 failure to redeem, 1136 judgment); L 2024, ch 55, pt BB (surplus proceeds)",
    asOf: "2026-09",
    sources: [
      "https://www.nysenate.gov/legislation/laws/RPT/A11",
      "https://www.tax.ny.gov/pdf/publications/orpts/legis/legsum24.pdf",
      "https://www.tax.ny.gov/pdf/publications/orpts/under_eqrates.pdf",
      "https://www.tax.ny.gov/research/property/equal/rar/index.htm",
      "https://phillipslytle.com/a-review-of-new-yorks-response-to-tyler-v-hennepin-county/",
    ],
    caveats: [
      "THE ASSESSED VALUE IS NOT COMPARABLE ACROSS MUNICIPALITIES. More than 1,200 assessing units each set their own level of assessment, published annually by ORPTS as an equalization rate and a residential assessment ratio. This row assumes 100% as a deliberate floor, so a derived ARV in a low-assessing town is far too low. That is the safe direction, and it makes the derived figure useless as a valuation — get the municipality's rate or supply arvOverride.",
      "NO REDEMPTION FOR THE AUCTION BUYER, AND THIS TIME THAT IS UNQUALIFIED. RPTL 1110's period runs before the tax district takes title; RPTL 1131 and 1136(3) bar the former owner on judgment. By the time a parcel reaches the county auction the right is gone. The default period is two years from the lien date and a district may set a longer one, but either way it expires pre-auction.",
      "SURPLUS NOW GOES BACK TO THE FORMER OWNER. L 2024, ch 55, pt BB amended Article 11 after Tyler v. Hennepin County so excess proceeds are returned to the former owner and, where appropriate, to lienors. This does not change what a bidder pays, but it removes the county's old incentive to retain equity and is worth understanding before assuming how a district will run its sale.",
      "NOT EVERY NEW YORK TAX SALE IS AN ARTICLE 11 COUNTY AUCTION. New York City and several cities have run their own tax lien certificate programmes under separate authority, which are different instruments with different economics. Confirm the selling entity and the enabling law before applying this row.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator. Do not rely on a computed New York max bid until they are set.",
    ],
  },
  PA: {
    state: "PA",
    saleType: "Tax Deed",
    redemption: null,
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — see the AR entry, whose figures are
       * marked as operator-set. These are a placeholder range pending that
       * review and should not be trusted for a live bid.
       */
      typicalLow: 2500,
      typicalHigh: 6000,
      typicalMonths: 6,
      required: true,
    },
    /*
     * Recording and deed issuance only. This deliberately EXCLUDES Pennsylvania
     * realty transfer tax, which is the larger cost and is a percentage, not a
     * fixed fee — see caveats. A fixed field cannot carry it.
     */
    closingCosts: 250,
    /*
     * There is no statewide assessment ratio, so this number is a placeholder
     * that should never be reached: every one of the 67 counties is listed in
     * countyAssessmentRatios below. It is the median county ratio, present only
     * so the field is not a lie by omission if a FIPS ever misses.
     */
    assessmentRatio: 0.4065,
    assessmentBasis:
      "Pennsylvania has no statewide assessment ratio. Counties assess against their own base years, some decades old, and the State Tax Equalization Board publishes a Common Level Ratio per county each year. Always use the county ratio.",
    countyAssessmentRatios: {
      "42001": { ratio: 0.6757, basis: "Adams County CLR factor 1.48 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42003": { ratio: 0.4926, basis: "Allegheny County CLR factor 2.03 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42005": { ratio: 0.2457, basis: "Armstrong County CLR factor 4.07 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42007": { ratio: 0.7463, basis: "Beaver County CLR factor 1.34 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42009": { ratio: 0.5236, basis: "Bedford County CLR factor 1.91 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42011": { ratio: 0.3205, basis: "Berks County CLR factor 3.12 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42013": { ratio: 0.7813, basis: "Blair County CLR factor 1.28 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42015": { ratio: 0.1669, basis: "Bradford County CLR factor 5.99 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42017": { ratio: 0.056, basis: "Bucks County CLR factor 17.86 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42019": { ratio: 0.06, basis: "Butler County CLR factor 16.67 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42021": { ratio: 0.112, basis: "Cambria County CLR factor 8.93 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42023": { ratio: 0.1988, basis: "Cameron County CLR factor 5.03 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42025": { ratio: 0.1721, basis: "Carbon County CLR factor 5.81 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42027": { ratio: 0.1639, basis: "Centre County CLR factor 6.10 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42029": { ratio: 0.3058, basis: "Chester County CLR factor 3.27 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42031": { ratio: 1, basis: "Clarion County CLR factor 1.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42033": { ratio: 0.1919, basis: "Clearfield County CLR factor 5.21 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42035": { ratio: 0.5181, basis: "Clinton County CLR factor 1.93 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42037": { ratio: 0.1361, basis: "Columbia County CLR factor 7.35 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42039": { ratio: 0.158, basis: "Crawford County CLR factor 6.33 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42041": { ratio: 0.641, basis: "Cumberland County CLR factor 1.56 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42043": { ratio: 0.3831, basis: "Dauphin County CLR factor 2.61 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42045": { ratio: 0.5464, basis: "Delaware County CLR factor 1.83 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42047": { ratio: 0.1799, basis: "Elk County CLR factor 5.56 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42049": { ratio: 0.5025, basis: "Erie County CLR factor 1.99 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42051": { ratio: 0.4065, basis: "Fayette County CLR factor 2.46 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42053": { ratio: 0.114, basis: "Forest County CLR factor 8.77 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42055": { ratio: 0.072, basis: "Franklin County CLR factor 13.89 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42057": { ratio: 0.202, basis: "Fulton County CLR factor 4.95 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42059": { ratio: 0.3636, basis: "Greene County CLR factor 2.75 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42061": { ratio: 0.125, basis: "Huntingdon County CLR factor 8.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42063": { ratio: 0.7042, basis: "Indiana County CLR factor 1.42 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42065": { ratio: 0.1908, basis: "Jefferson County CLR factor 5.24 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42067": { ratio: 0.074, basis: "Juniata County CLR factor 13.51 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42069": { ratio: 1, basis: "Lackawanna County CLR factor 1.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42071": { ratio: 0.5, basis: "Lancaster County CLR factor 2.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42073": { ratio: 0.4545, basis: "Lawrence County CLR factor 2.20 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42075": { ratio: 0.5208, basis: "Lebanon County CLR factor 1.92 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42077": { ratio: 0.4695, basis: "Lehigh County CLR factor 2.13 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42079": { ratio: 0.8772, basis: "Luzerne County CLR factor 1.14 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42081": { ratio: 0.4367, basis: "Lycoming County CLR factor 2.29 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42083": { ratio: 0.4808, basis: "McKean County CLR factor 2.08 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42085": { ratio: 0.105, basis: "Mercer County CLR factor 9.52 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42087": { ratio: 0.207, basis: "Mifflin County CLR factor 4.83 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42089": { ratio: 0.4405, basis: "Monroe County CLR factor 2.27 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42091": { ratio: 0.2976, basis: "Montgomery County CLR factor 3.36 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42093": { ratio: 0.4484, basis: "Montour County CLR factor 2.23 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42095": { ratio: 0.161, basis: "Northampton County CLR factor 6.21 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42097": { ratio: 0.095, basis: "Northumberland County CLR factor 10.53 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42099": { ratio: 1, basis: "Perry County CLR factor 1.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42101": { ratio: 0.9434, basis: "Philadelphia County CLR factor 1.06 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42103": { ratio: 0.089, basis: "Pike County CLR factor 11.24 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42105": { ratio: 0.161, basis: "Potter County CLR factor 6.21 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42107": { ratio: 1, basis: "Schuylkill County CLR factor 1.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42109": { ratio: 0.092, basis: "Snyder County CLR factor 10.87 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42111": { ratio: 0.1812, basis: "Somerset County CLR factor 5.52 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42113": { ratio: 0.4049, basis: "Sullivan County CLR factor 2.47 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42115": { ratio: 0.1631, basis: "Susquehanna County CLR factor 6.13 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42117": { ratio: 0.8, basis: "Tioga County CLR factor 1.25 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42119": { ratio: 0.4292, basis: "Union County CLR factor 2.33 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42121": { ratio: 0.4878, basis: "Venango County CLR factor 2.05 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42123": { ratio: 1, basis: "Warren County CLR factor 1.00 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42125": { ratio: 0.6803, basis: "Washington County CLR factor 1.47 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42127": { ratio: 0.6711, basis: "Wayne County CLR factor 1.49 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42129": { ratio: 0.087, basis: "Westmoreland County CLR factor 11.49 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42131": { ratio: 0.111, basis: "Wyoming County CLR factor 9.01 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
      "42133": { ratio: 0.4878, basis: "York County CLR factor 2.05 (STEB 2025 CLR, effective 2026-07-01 to 2027-06-30); ratio is its reciprocal." },
    },
    derivedArvCaveat:
      "Pennsylvania county assessments run against base years that can be decades stale, and the spread is extreme — Bucks assesses at about 5.6% of market and Schuylkill at 100%, an 18x range inside one state. The Common Level Ratio is a county MEDIAN published for realty transfer tax equalisation, not a per-parcel appraisal, so deriving ARV from it multiplies any error in that one parcel's assessment by the factor: in Bucks a $50,000 assessment derives an ARV near $893,000. Treat a derived ARV in a high-factor county as a research lead, not a valuation, and get comparable sales before bidding.",
    statute:
      "72 P.S. §§ 5860.101-5860.803 (Real Estate Tax Sale Law); 53 P.S. §§ 7101-7505 (Municipal Claims and Tax Liens Act, Philadelphia and Allegheny)",
    asOf: "2026-09",
    sources: [
      "https://www.legis.state.pa.us/WU01/LI/LI/US/PDF/1947/0/0542..PDF",
      "https://www.pa.gov/content/dam/copapwp-pagov/en/revenue/documents/taxtypes/rtt/documents/clr_factor_current.pdf",
      "https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/realty-transfer-tax/common-level-ratios",
      "https://www.law.cornell.edu/regulations/pennsylvania/61-Pa-Code-SS-91-193",
      "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/061/chapter91/s91.193.html&d=reduce",
    ],
    caveats: [
      "UPSET SALE vs JUDICIAL SALE is the single most important distinction in Pennsylvania and this row cannot express it. An upset sale (72 P.S. §§ 5860.601-609) conveys subject to existing mortgages, judgments and liens, which are NOT divested; a judicial sale (§§ 5860.610-612) is ordered free and clear. Establish which one a parcel is in before treating survivingLiens as zero.",
      "REALTY TRANSFER TAX IS NOT IN closingCosts. 61 Pa. Code § 91.193 excludes a conveyance to a local taxing authority acquiring at a tax claim bureau sale, and exempts a mortgage holder purchasing at judicial sale — it grants NO exclusion to a third-party purchaser. A third-party investor should expect 1% state plus local transfer tax (commonly 1%, and about 3.278% in Philadelphia) on the price. On a $50,000 parcel that is roughly $1,000 outside Philadelphia and materially more inside it. The engine has no percentage field for this; budget it manually.",
      "PHILADELPHIA HAS A REDEMPTION AND THIS ROW SAYS IT DOES NOT. Under MCTLA 53 P.S. § 7293 an owner-occupied property (occupancy determined 90 days before the sale) may be redeemed within nine months of acknowledgment of the sheriff's deed, at the price paid plus 10% per annum. Non-owner-occupied and abandoned property carries no such right. Modelling that here would apply it to the 65 RETSL counties that lack it, so it is recorded as a caveat and the redemption field stays null — conservative for return, but it means the engine does not warn about redemption risk on a Philadelphia parcel.",
      "Allegheny County also runs under MCTLA rather than RETSL, so its procedure and notice rules differ from the other 65 counties.",
      "Common Level Ratios are re-published by STEB every year and take effect each 1 July. The figures here are the 2025 CLR set effective 2026-07-01 to 2027-06-30; re-verify after the next July.",
      "Philadelphia's CLR factor is 1.06 for documents accepted 2026-07-01 through 2026-12-31 and 1.00 after 2026-12-31, following an assessment base change. The ratio recorded here (0.9434) is the former; it becomes 1.00 on 2027-01-01.",
      "In high-CLR-factor counties (Bucks 17.86, Butler 16.67, Franklin 13.89, Juniata 13.51, Westmoreland 11.49, Pike 11.24, Northumberland 10.53) a derived ARV is amplified roughly 11-18x from the assessment. Do not bid off a ratio-derived ARV in those counties; supply arvOverride from comparable sales.",
      "quietTitle costs in this entry are a placeholder and have not been reviewed by the operator, unlike AR. Do not rely on the computed max bid in Pennsylvania until they are set.",
      "RETSL requires publication, posting and certified mail notice, and an owner-occupied property cannot be sold unless the owner was personally served at least ten days before the sale. Defective notice is the most common ground on which Pennsylvania tax sales are set aside, which is a risk to the purchaser's title rather than to the price.",
    ],
  },
  /*
   * South Carolina is the tidiest redemption schedule in this file, and the
   * only one where bidding harder makes the instrument strictly worse.
   *
   * ## The schedule
   *
   * S.C. Code § 12-51-90: twelve months from the sale, with a flat penalty set
   * by which quarter the redemption lands in — 3% in months 1-3, 6% in 4-6, 9%
   * in 7-9, 12% in 10-12, computed on the bid. Flat, like Georgia and Texas,
   * not annualised like Arizona or Kentucky.
   *
   * ## Why a premium is punished twice
   *
   * The same section caps it: "in every redemption, the amount of interest due
   * must not exceed the amount of the bid on the property submitted on behalf
   * of the forfeited land commission pursuant to Section 12-51-55" — the FLC
   * bid being roughly taxes plus costs. So the penalty accrues on the bid but
   * can never exceed the opening bid, and a purchase at several times the
   * minimum collects the same capped sum a minimum bid would.
   *
   * And the premium itself is not the purchaser's to recover. Under
   * § 12-51-130 the overage — everything above taxes, assessments, penalties
   * and costs — belongs to the owner of record immediately before the
   * redemption period ended, payable ninety days after the deed, escheating to
   * the county only after five unclaimed years. South Carolina was therefore
   * already doing what Tyler v. Hennepin County later required of other states.
   *
   * The practical reading: the modelled tier is a ceiling that only a bid at or
   * near the minimum actually earns.
   */
  SC: {
    state: "SC",
    saleType: "Redeemable Deed",
    redemption: {
      /*
       * Quarters, as the statute frames them. Day bounds are the quarter ends —
       * 90/181/273/365 — because § 12-51-90 counts by month of redemption, not
       * by day.
       */
      tiers: [
        { throughDays: 90, penalty: 0.03 },
        { throughDays: 181, penalty: 0.06 },
        { throughDays: 273, penalty: 0.09 },
        { throughDays: 365, penalty: 0.12 },
      ],
      maxDays: 365,
    },
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — placeholder, as for PA, KY and IN.
       *
       * § 12-51-90 makes the tax deed incontestable on procedural or other
       * grounds once the redemption year and a further twelve months have run,
       * so time does much of the work a quiet title suit does elsewhere. Most
       * title insurers still want the action before writing a policy, which is
       * why `required` stays true.
       */
      typicalLow: 2000,
      typicalHigh: 5000,
      typicalMonths: 5,
      required: true,
    },
    closingCosts: 250,
    /*
     * Twelve months of redemption, then the further twelve after which the deed
     * is incontestable. Capital is committed for the first year whatever
     * happens, and marketable title realistically arrives after the second.
     */
    auctionToMarketableMonths: 24,
    /*
     * The "all other real property" rate. South Carolina assesses by CLASS, not
     * by county, and 6% is both the statutory residual (§ 12-43-220(e)) and the
     * conservative choice: deriving ARV at 6% from a parcel actually assessed
     * at the 4% legal-residence rate understates the property, which is the
     * safe direction to be wrong in.
     */
    assessmentRatio: 0.06,
    assessmentBasis:
      "S.C. Code § 12-43-220(e): all other real property not otherwise provided for is assessed at six percent of fair market value. South Carolina assesses by property class rather than by county — 4% legal residence (c), 4% agricultural held by individuals (d)(1)(A), 6% agricultural held by corporations (d)(1)(B), 10.5% manufacturing and utility (a)(1).",
    derivedArvCaveat:
      "South Carolina's ratio depends on the property's CLASS, and this entry uses the 6% residual. A parcel actually carrying the 4% legal-residence ratio will have its ARV understated by a third here, which is the safe direction. A manufacturing or utility parcel assessed at 10.5% is the dangerous one: dividing by 0.06 overstates its value by roughly 1.75x. Confirm the class on the assessor's record before bidding on anything that is not ordinary residential or commercial land.",
    statute:
      "S.C. Code Title 12, Ch. 51 (alternate procedure for collection of property taxes: §§ 12-51-55, 12-51-90, 12-51-130); § 12-43-220 (assessment ratios)",
    asOf: "2026-09",
    sources: [
      "https://www.scstatehouse.gov/code/t12c051.php",
      "https://www.scstatehouse.gov/code/t12c043.php",
      "https://law.justia.com/codes/south-carolina/title-12/chapter-51/section-12-51-90/",
      "https://law.justia.com/codes/south-carolina/title-12/chapter-51/section-12-51-130/",
      "https://dor.sc.gov/property-tax-redemption-property",
    ],
    caveats: [
      "THE PENALTY IS CAPPED AT THE OPENING BID. § 12-51-90 provides that interest due on redemption may not exceed the forfeited land commission's bid under § 12-51-55 — roughly taxes plus costs. The tiers above are therefore a ceiling reached only by a bid at or near the minimum; a purchase at several times the minimum collects the same capped sum, so the effective yield falls as the premium rises.",
      "THE OVERAGE IS NOT YOURS. Under § 12-51-130 everything bid above taxes, assessments, penalties and costs belongs to the owner of record immediately before the redemption period ended, payable ninety days after the deed and escheating to the county only after five unclaimed years. A premium is not recoverable equity; South Carolina was already Tyler-compliant on this point.",
      "Assessment is by class, not by county. This row uses the 6% residual under § 12-43-220(e); legal residences sit at 4% and manufacturing and utility property at 10.5%. See the derived-ARV note — the 10.5% case is the one that produces a dangerous overstatement.",
      "The deed becomes incontestable on procedural or other grounds only after the twelve-month redemption period plus a further twelve months (§ 12-51-90). Before that, procedural defects in the sale remain a live attack on title.",
      "Unsold parcels are bid in for the Forfeited Land Commission under § 12-51-55 rather than left unsold, which is also what sets the interest cap above. An FLC-held parcel is a different instrument from one bought at open auction.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator. Do not rely on a computed South Carolina max bid until they are set.",
    ],
  },
  /*
   * Tennessee is the only state here where the redemption clock is shortened by
   * the delinquency that caused the sale, and where it does not start at the
   * sale at all.
   *
   * ## The clock starts at confirmation, not the auction
   *
   * T.C.A. § 67-5-2701(a)(1) runs every period "from the entry of the order
   * confirming the sale". Tennessee sells judicially, through the Clerk and
   * Master of the Chancery Court, so there is a gap between the hammer and the
   * order — weeks, sometimes longer — during which the buyer holds money and
   * the redemption period has not begun. `auctionToMarketableMonths` carries
   * that gap; `maxDays` cannot, because it is measured from the wrong event.
   *
   * ## A sliding scale, shortest where the arrears are deepest
   *
   * One year where the delinquency is five years or less, 180 days where it is
   * more than five and less than eight, 90 days at eight or more, and 30 days
   * for property shown to be vacant or abandoned regardless of arrears. The
   * default encoded here is the longest — one year — which is the conservative
   * reading: it assumes the slowest return of capital and the largest accrual
   * the buyer must wait out.
   *
   * ## The premium earns, which is unusual in this file
   *
   * § 67-5-2701(b)(1) accrues 12% per annum on "the entire purchase price paid
   * by the purchaser", from payment until the redemption motion is filed. Not
   * on a minimum bid as in Indiana, and not capped at an opening bid as in
   * South Carolina. A Tennessee premium is working capital rather than dead
   * money, which makes it the one state so far where bidding up does not
   * quietly dilute the yield.
   */
  TN: {
    state: "TN",
    saleType: "Redeemable Deed",
    redemption: {
      interestKind: "annual",
      // Annual rate, like AZ and KY — not a flat penalty like GA, TX and SC.
      tiers: [{ throughDays: 365, penalty: 0.12 }],
      maxDays: 365,
      extendedFor:
        "property delinquent five years or less; deeper arrears redeem faster — 180 days over five years, 90 days at eight or more, and 30 days for property shown vacant or abandoned",
    },
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — placeholder, as for PA, KY, IN, SC.
       *
       * A Tennessee sale is already a court proceeding and title is divested by
       * order once redemption lapses, so the deed starts stronger than an
       * administrative tax deed. Insurers still commonly want an action before
       * writing, which is why `required` stays true.
       */
      typicalLow: 2000,
      typicalHigh: 5000,
      typicalMonths: 5,
      required: true,
    },
    closingCosts: 250,
    /*
     * Auction, then the confirmation order the clock actually starts from, then
     * a year of redemption, then divestiture. The gap before confirmation is
     * why this is not simply 12 plus filing.
     */
    auctionToMarketableMonths: 18,
    /*
     * Residential. Tennessee assesses by CLASS under T.C.A. § 67-5-801 —
     * residential and farm at 25%, industrial and commercial at 40% — and
     * residential is the modal tax-sale parcel. Unlike South Carolina there is
     * no residual class to fall back on, so this is a choice about the common
     * case rather than the safe direction, and the commercial error is called
     * out in the derived-ARV note.
     */
    assessmentRatio: 0.25,
    assessmentBasis:
      "T.C.A. § 67-5-801 and Tenn. Const. art. II, § 28: residential and farm property is assessed at 25% of value, industrial and commercial at 40%, public utility at 55%. This entry uses the 25% residential rate.",
    derivedArvCaveat:
      "Tennessee assesses by class and this entry assumes residential at 25%. On an industrial or commercial parcel actually assessed at 40%, dividing by 0.25 overstates the property by about 1.6x — the dangerous direction. A mixed-use parcel is apportioned between subclasses by State Board of Equalization rules, so it will sit somewhere between. Check the class on the assessor's record before bidding on anything that is not plainly residential.",
    statute:
      "T.C.A. Title 67, ch. 5: §§ 67-5-2701 to 67-5-2703 (redemption), § 67-5-801 (classification and rate of assessment)",
    asOf: "2026-09",
    sources: [
      "https://www.ctas.tennessee.edu/eli/redemption",
      "https://codes.findlaw.com/tn/title-67-taxes-and-licenses/tn-code-sect-67-5-2701/",
      "https://law.justia.com/codes/tennessee/title-67/chapter-5/part-27/section-67-5-2701/",
      "https://law.justia.com/codes/tennessee/title-67/chapter-5/part-8/section-67-5-801/",
      "https://comptroller.tn.gov/content/dam/cot/pa/documents/tax-aggregate-reports/2025TaxAggregateReport.pdf",
    ],
    caveats: [
      "THE REDEMPTION PERIOD DEPENDS ON THE ARREARS, AND THIS ROW ENCODES THE LONGEST. One year at five years' delinquency or less, 180 days above five, 90 days at eight or more, and 30 days for property shown vacant or abandoned (§ 67-5-2701(a)(1)). A deeply delinquent parcel therefore returns capital far sooner than modelled — favourable, but it also means a shorter window in which the 12% accrues.",
      "THE CLOCK STARTS AT THE ORDER CONFIRMING THE SALE, NOT THE SALE. Tennessee sells through the Chancery Court's Clerk and Master, and the period runs from confirmation. Money is committed from the auction; the redemption period begins later. Budget the gap separately — it is in auctionToMarketableMonths and cannot be in maxDays.",
      "Interest accrues on the ENTIRE purchase price, not a minimum bid and not capped (§ 67-5-2701(b)(1)), and it runs from payment until the redemption motion is filed rather than to the end of the period. A premium here earns, unlike Indiana or South Carolina.",
      "Redemption also repays delinquent taxes, penalty, interest and court costs, and the court may award the purchaser amounts expended on the property (§ 67-5-2701(e), (f), (j)). Those are recoverable only on redemption, not if the buyer keeps the parcel.",
      "Assessment is by class, not county. This row assumes residential at 25%; commercial and industrial sit at 40% and public utility at 55%. See the derived-ARV note — the commercial case overstates value by roughly 1.6x.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator. Do not rely on a computed Tennessee max bid until they are set.",
    ],
  },
  TX: {
    state: "TX",
    saleType: "Redeemable Deed",
    redemption: {
      // Tex. Tax Code § 34.21. Non-homestead, non-agricultural: 180 days at
      // 25%. Homestead/agricultural: 2 years, 25% in year one, 50% in year two.
      tiers: [
        { throughDays: 365, penalty: 0.25 },
        { throughDays: 730, penalty: 0.5 },
      ],
      maxDays: 730,
      extendedFor: "homestead and agricultural-use property (2 years); all other property is 180 days",
    },
    quietTitle: { typicalLow: 2500, typicalHigh: 6000, typicalMonths: 4, required: true },
    closingCosts: 400,
    assessmentRatio: 1.0,
    assessmentBasis:
      "Texas requires appraisal at 100% of market value as of Jan 1 (Tex. Tax Code § 23.01).",
    statute: "Tex. Tax Code § 34.21 (right of redemption)",
    asOf: "2026-07",
    sources: [
      "https://statutes.capitol.texas.gov/Docs/TX/htm/TX.34.htm",
      "https://liensuite.com/tax-deed/texas",
    ],
    caveats: [
      "The 180-day vs 2-year window turns on the property's use at the time of sale, which the sale list does not state — treat any homestead-looking residential parcel as potentially 2-year.",
      "Purchaser takes subject to the redemption right; you cannot deliver insurable title until it expires.",
      "The 25% is a flat penalty, not annual interest.",
    ],
  },

  GA: {
    state: "GA",
    saleType: "Redeemable Deed",
    redemption: {
      // O.C.G.A. § 48-4-40 et seq. 20% flat for the first year; an additional
      // 10% for each year thereafter until the right is barred by notice.
      tiers: [
        { throughDays: 365, penalty: 0.2 },
        { throughDays: 730, penalty: 0.3 },
        { throughDays: 1095, penalty: 0.4 },
      ],
      maxDays: 1095,
      extendedFor:
        "redemption stays open indefinitely until the purchaser forecloses it by statutory notice (barment)",
    },
    quietTitle: { typicalLow: 3000, typicalHigh: 7500, typicalMonths: 6, required: true },
    closingCosts: 350,
    assessmentRatio: 0.4,
    assessmentBasis:
      "Georgia assesses at 40% of fair market value (O.C.G.A. § 48-5-7).",
    statute: "O.C.G.A. § 48-4-40 through § 48-4-48 (redemption and barment)",
    asOf: "2026-07",
    sources: [
      "https://law.justia.com/codes/georgia/title-48/chapter-4/article-3/",
      "https://www.accgov.com/1717/Right-of-Redemption",
    ],
    caveats: [
      "The 12-month period is a minimum, not an expiry — the redemption right persists until you serve barment notice, so budget for that process.",
      "A redeemable deed conveys no right of possession during the redemption period.",
    ],
  },

  FL: {
    state: "FL",
    saleType: "Tax Deed",
    // Florida extinguishes the owner's right at the sale itself; redemption
    // must happen before the auction closes.
    redemption: null,
    quietTitle: { typicalLow: 2500, typicalHigh: 5500, typicalMonths: 4, required: true },
    closingCosts: 500,
    assessmentRatio: 0.85,
    assessmentBasis:
      "Florida assesses at just value, but Save Our Homes / Amendment 1 caps compress assessed below market on long-held homesteads.",
    statute: "Fla. Stat. ch. 197 (tax deed sales)",
    asOf: "2026-07",
    sources: ["http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0197/0197.html"],
    caveats: [
      "Governmental liens (municipal code enforcement, some special assessments) can survive a Florida tax deed — check the specific municipality.",
      "Federal tax liens survive with a 120-day IRS right of redemption after the sale.",
      "Most title insurers will not insure until a quiet title action completes, and many not until a year after recording.",
    ],
  },

  AZ: {
    state: "AZ",
    saleType: "Tax Lien",
    redemption: {
      interestKind: "annual",
      // A.R.S. § 42-18152. Three years from the sale before the certificate
      // holder may bring a judicial foreclosure. Interest is bid down from
      // 16% and accrues annually, so it is an annual rate rather than a flat
      // penalty — see `interestKind` above.
      //
      // This comment used to cite `annualInterest` handling in maxbid.ts. No
      // such handling existed, and the engine annualised the 16% by dividing
      // it across the three-year window and reporting 5.33%. The comment
      // described an intention; the arithmetic did the opposite for as long as
      // the entry existed.
      tiers: [{ throughDays: 1095, penalty: 0.16 }],
      maxDays: 1095,
      extendedFor: "interest is bid down at auction from a 16% statutory maximum",
    },
    quietTitle: { typicalLow: 2000, typicalHigh: 5000, typicalMonths: 5, required: true },
    closingCosts: 300,
    assessmentRatio: 0.85,
    assessmentBasis:
      "Arizona uses Limited Property Value, which lags full cash value and is capped at 5% annual growth (A.R.S. § 42-13301).",
    statute: "A.R.S. Title 42, ch. 18 (tax liens and foreclosure)",
    asOf: "2026-07",
    sources: ["https://www.azleg.gov/arsDetail/?title=42"],
    caveats: [
      "Arizona sells liens, not deeds — the usual outcome is redemption with interest, not property ownership.",
      "Taking title requires a separate judicial foreclosure after 3 years, at additional legal cost.",
      "16% is the maximum; competitive auctions routinely bid the rate into low single digits.",
    ],
  },

  /*
   * Kentucky sells a debt, not a property, and almost everything about the
   * maths follows from that.
   *
   * ## What is actually bought
   *
   * County clerks sell "certificates of delinquency" — tax lien certificates —
   * at annual sales running mid-July into late October, most of them between
   * mid-July and the end of August (KRS 134.128; 103 KAR 5:180). The
   * certificate accrues simple interest at 12% per annum on the amount paid to
   * the clerk, from the date of purchase until it is satisfied, plus
   * prelitigation attorneys' fees (KRS 134.125; 134.452; the notice a purchaser
   * must send states the rate as 1% per month, KRS 134.490).
   *
   * The expected outcome is being paid, not taking the land. Taking the land
   * requires a judicial foreclosure in circuit court, and that is what the
   * `quietTitle` figures below actually represent — see the note there.
   *
   * ## The one-year tolling period is why the carry is long
   *
   * Taxes fall due 31 December and are delinquent 1 January (KRS 134.015;
   * 134.119). KRS 134.546 bars any action on a certificate until one year from
   * the date the taxes became delinquent, so a certificate bought in July
   * cannot be sued on until 1 January following — roughly six further months of
   * holding before the clock on foreclosure even starts. The same section bars
   * an action more than eleven years after delinquency, which is where
   * `maxDays` comes from.
   *
   * ## Two redemptions at two different rates, and only one fits here
   *
   * The 12% above is what a taxpayer pays to satisfy the certificate at any
   * point, and it is modelled as the tier. If the holder forecloses and the
   * property sells at the judicial sale for LESS than two-thirds of its
   * appraised value, a second and quite separate right appears: KRS 426.530
   * lets the defendant redeem within six months of the sale at the purchase
   * money plus 10% per annum.
   *
   * Six months, not a year. The statute was amended effective 15 July 2016 and
   * the pre-2016 text said a year; secondary summaries and older case law still
   * quote the old figure, so this was read off the current statute text rather
   * than a digest. It is a conditional, second-stage redemption at a lower
   * rate, which `RedemptionTier` cannot express — tiers are sequential windows
   * of one redemption — so it is a caveat.
   */
  /*
   * Indiana is the cleanest fit for `RedemptionTier` in this file and, for that
   * exact reason, the easiest to get quietly wrong.
   *
   * ## The tiers are real, the base is not what this type assumes
   *
   * IC 6-1.1-25-2: redemption costs 110% of the MINIMUM BID within six months
   * of the sale, 115% between six months and a year — plus, for sales after
   * 30 June 2014, only 5% per annum on the amount by which the purchase price
   * exceeded that minimum bid, plus any subsequent taxes the buyer paid.
   *
   * `RedemptionTier.penalty` is documented as a fraction OF THE BID. In Indiana
   * it is a fraction of the minimum bid, and Indiana sells by premium bidding,
   * so the two diverge the moment anyone competes. A parcel with a $1,200
   * minimum taken at $6,000 does not return 10% on $6,000; it returns 10% on
   * $1,200 and 5% per annum on the other $4,800. Encoding 0.10 and stopping
   * there would overstate a competitive purchase by roughly half — the same
   * shape of error as reading Illinois' 18% cap as its yield.
   *
   * The tiers below are the statute. The divergence is the first caveat, and
   * the fix is a penalty-base field on the type — which does not exist yet —
   * rather than a fudged number here.
   *
   * ## Three redemption regimes, one row
   *
   * IC 6-1.1-25-4(a) sets one year for an ordinary county tax sale; 120 days
   * where the county executive holds the lien and the certificate went unsold,
   * or on a sale to a qualified purchasing agency; and NO right of redemption
   * at all where the parcel sits on the county auditor's vacant-and-abandoned
   * list under IC 6-1.1-24-1.5. The last is a deed sale wearing a lien state's
   * clothes, and nothing in a sale row says which regime a parcel is in.
   *
   * One year is encoded because it is the default and the conservative reading:
   * it assumes the longest wait and the smallest penalty tier available.
   */
  IN: {
    state: "IN",
    saleType: "Tax Lien",
    redemption: {
      /*
       * Flat penalties, not interest — 110% is 110% whether the owner redeems
       * on day 3 or day 180, which is Georgia's and Texas's treatment rather
       * than Arizona's or Kentucky's. 182 days is "not more than six months"
       * (IC 6-1.1-25-2(b)).
       */
      tiers: [
        { throughDays: 182, penalty: 0.1 },
        { throughDays: 365, penalty: 0.15 },
      ],
      maxDays: 365,
    },
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — placeholder, as for PA and KY.
       *
       * Indiana does issue a deed: once redemption lapses the purchaser
       * petitions the court for a tax deed under IC 6-1.1-25-4.6, after the
       * notices required by IC 6-1.1-25-4.5. The petition is not the expensive
       * part; making the resulting deed insurable usually is.
       */
      typicalLow: 2500,
      typicalHigh: 6000,
      typicalMonths: 6,
      required: true,
    },
    closingCosts: 250,
    /*
     * A year of redemption, then the petition and deed, then quiet title. The
     * redemption year dominates and cannot be shortened by the buyer.
     */
    auctionToMarketableMonths: 18,
    assessmentRatio: 1.0,
    assessmentBasis:
      "Indiana assesses at 100% of true tax value (assessed value has equalled 100% of true tax value since the 2001 assessment year), so the statutory ratio is 1.0.",
    derivedArvCaveat:
      "Indiana's ratio is 1.0, but IC 6-1.1-31-6(c) says in terms that true tax value DOES NOT mean fair market value — it means market value-in-use, the value of the parcel for its current use. On a derelict or under-used parcel, which is most of what reaches a tax sale, value-in-use can sit well below what the land would fetch redeveloped, and on special-purpose property it can sit above. A 1.0 ratio here is not a licence to treat the assessment as an appraisal; get comparable sales.",
    statute:
      "IC 6-1.1-24 (sale of real property when taxes delinquent); IC 6-1.1-25 (redemption and tax deeds); IC 6-1.1-31-6 (true tax value)",
    asOf: "2026-09",
    sources: [
      "https://iga.in.gov/ic/2026/Title_6/Article_1.1/Chapter_25.pdf",
      "https://codes.findlaw.com/in/title-6-taxation/in-code-sect-6-1-1-25-2/",
      "https://codes.findlaw.com/in/title-6-taxation/in-code-sect-6-1-1-25-4/",
      "https://codes.findlaw.com/in/title-6-taxation/in-code-sect-6-1-1-31-6/",
      "https://www.in.gov/dlgf/files/2021-assessment-guidelines/Assessment-Manual.pdf",
      "https://www.in.gov/dlgf/assessments/overview/",
    ],
    caveats: [
      "THE PENALTY BASE IS THE MINIMUM BID, NOT YOUR BID. 110%/115% under IC 6-1.1-25-2 is computed on the minimum bid; the amount you paid above it earns only 5% per annum, and only for sales after 2014-06-30. Indiana sells by premium bidding, so on any competitive parcel the modelled tier overstates the return — a $1,200 minimum taken at $6,000 returns 10% on $1,200 and 5%/yr on $4,800, not 10% on $6,000. Treat the computed penalty as a ceiling until the type carries a penalty base.",
      "THREE REDEMPTION REGIMES AND THIS ROW ENCODES ONE. IC 6-1.1-25-4(a): one year at an ordinary county tax sale; 120 days where the county executive holds the lien and the certificate went unsold, or on sale to a qualified purchasing agency; and NO redemption at all for a parcel on the county auditor's vacant-and-abandoned list under IC 6-1.1-24-1.5. Establish which applies before trusting the hold period — a vacant-and-abandoned parcel is effectively a deed sale.",
      "Redemption also repays every subsequent tax, special assessment, interest, penalty and fee the purchaser paid after the sale, so carrying taxes during the redemption year is recoverable rather than sunk — but only if the parcel is in fact redeemed.",
      "Commissioners' certificate sales under IC 6-1.1-24-6.1 sell previously unsold parcels at a discounted minimum bid set by the county executive, advertised three consecutive weeks at least thirty days ahead. Cheaper entry, 120-day redemption, and generally the parcels nobody wanted at the regular sale.",
      "A tax deed is not a marketable title. After redemption lapses the purchaser must petition the court under IC 6-1.1-25-4.6, having given the notices required by IC 6-1.1-25-4.5; defective notice is the usual ground on which an Indiana tax deed is later attacked.",
      "If the parcel sells above the minimum bid and is NOT redeemed, the former owner may claim the tax sale surplus. That money is not the purchaser's and should never be modelled as recoverable.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator. Do not rely on a computed Indiana max bid until they are set.",
    ],
  },
  /*
   * Kansas, like New York, does its redeeming before the auction — but it
   * leaves a year of title risk behind afterwards, which New York does not.
   *
   * ## The redemption is spent by the time you bid
   *
   * Delinquent real estate is first bid off to the county and held subject to
   * redemption under K.S.A. 79-2401a: one year if abandoned, two years for
   * general non-homestead property, three for a homestead. Only when that runs
   * does the county counselor bring the judicial foreclosure under K.S.A.
   * 79-2801 et seq., and redemption closes at 5pm the day before the sheriff's
   * sale. An investor bidding at that sale faces no redemption, so `redemption`
   * is null.
   *
   * ## Two things that are not redemption but behave like overhang
   *
   * You do not own the parcel when the hammer falls — only when the court
   * confirms the sale. Until confirmation there is no right to possession or to
   * collect rent.
   *
   * And K.S.A. 79-2804b gives twelve months from confirmation for an action to
   * open, vacate, modify or set aside the judgment or the order of sale. That is
   * a defect window rather than a right the owner earns, so it pays the
   * purchaser nothing — it is pure carry, and it is why
   * `auctionToMarketableMonths` is fourteen rather than three.
   */
  KS: {
    state: "KS",
    saleType: "Tax Deed",
    redemption: null,
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — placeholder, as elsewhere.
       *
       * A sheriff's deed on a confirmed judgment starts strong. The exposure is
       * the twelve-month window in 79-2804b, which most insurers will want to
       * see run before writing rather than an action brought to close it.
       */
      typicalLow: 2000,
      typicalHigh: 5000,
      typicalMonths: 5,
      required: true,
    },
    closingCosts: 250,
    /*
     * Sale, confirmation, then the twelve months in 79-2804b during which the
     * judgment can still be attacked. The waiting is after the purchase here,
     * not before it as in New York.
     */
    auctionToMarketableMonths: 14,
    /*
     * Residential. Kansas assesses by constitutional SUBCLASS, not by county,
     * and residential at 11.5% sits next to vacant lots at 12% — between them
     * they cover most of what reaches a tax sale. Commercial at 25% and the
     * "all other" residual at 30% are the dangerous directions.
     */
    assessmentRatio: 0.115,
    assessmentBasis:
      "Kansas Constitution art. 11, § 1: real property is assessed uniformly by subclass — residential including multi-family at 11.5%, vacant lots 12%, not-for-profit 12%, commercial and industrial 25%, land devoted to agricultural use 30% of agricultural income value, public utility 33%, and all other urban and rural real property 30%. This entry uses the 11.5% residential rate.",
    derivedArvCaveat:
      "Kansas assesses by subclass and this entry assumes residential at 11.5%. Vacant lots at 12% are close enough not to matter. Commercial and industrial at 25% and the 'all other' residual at 30% are not: dividing by 0.115 overstates those by roughly 2.2x and 2.6x — the dangerous direction, and 'all other' is a residual that catches more than its name suggests. Agricultural land is assessed at 30% of agricultural income value rather than of market value at all, so a derived ARV there is meaningless. Check the subclass on the appraiser's record before bidding on anything that is not plainly a house or a vacant lot.",
    statute:
      "K.S.A. 79-2801 et seq. (judicial foreclosure and sale by county), 79-2401a (redemption while held by the county), 79-2804b (twelve-month action to set aside); Kan. Const. art. 11, § 1 (assessment subclasses)",
    asOf: "2026-09",
    sources: [
      "https://ksrevisor.gov/statutes/chapters/ch79/079_028_0001.html",
      "https://ksrevisor.gov/statutes/chapters/ch79/079_024_0001a.html",
      "https://ksrevisor.gov/statutes/chapters/ch79/079_028_0004b.html",
      "https://ksrevisor.gov/kanconst/093_011_0001.html",
      "https://www.snco.gov/counselor/tax_sale.php",
    ],
    caveats: [
      "TWELVE MONTHS OF TITLE RISK AFTER THE SALE, AND IT PAYS NOTHING. K.S.A. 79-2804b allows an action to open, vacate, modify or set aside the judgment or order of sale within twelve months of confirmation. It is a defect window, not a redemption — the purchaser earns no penalty for waiting it out, so unlike a redeemable-deed state the wait is pure carry.",
      "YOU DO NOT OWN IT AT THE HAMMER. Title passes on the court's confirmation of the sale, not at the auction. Before confirmation there is no right to possession and no right to collect rent, which matters if the parcel is tenanted.",
      "The redemption is spent before you bid. K.S.A. 79-2401a holds county-bid real estate subject to redemption for one year if abandoned, two for general non-homestead property and three for a homestead; the judicial foreclosure follows only after that, and the last chance to redeem is 5pm the day before the sheriff's sale.",
      "Assessment is by constitutional subclass, not county: 11.5% residential, 12% vacant lots and not-for-profit, 25% commercial and industrial, 30% all other urban and rural, 33% public utility. Agricultural land is assessed on agricultural income value rather than market value.",
      "Proceeds above the judgment go to the former owner, so a premium is not recoverable equity — Kansas already did what Tyler v. Hennepin County later required of other states.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator. Do not rely on a computed Kansas max bid until they are set.",
    ],
  },
  KY: {
    state: "KY",
    saleType: "Tax Lien",
    redemption: {
      interestKind: "annual",
      /*
       * 12% per annum simple, modelled as an annual rate rather than a flat
       * penalty — the same treatment as Arizona, and the opposite of Georgia
       * and Texas, where 20% and 25% are flat whenever the owner redeems.
       *
       * `throughDays` is the eleven-year limit in KRS 134.546, measured from
       * DELINQUENCY (1 January), not from purchase. A July purchaser has
       * roughly ten years and five months of it left. There is no shorter
       * window: the taxpayer may satisfy the certificate at any point inside
       * it, so a KY lien has no natural maturity the way a deed state's
       * redemption period does.
       */
      tiers: [{ throughDays: 4015, penalty: 0.12 }],
      maxDays: 4015,
    },
    quietTitle: {
      /*
       * NOT A QUIET TITLE ACTION, and NOT YET REVIEWED BY THE OPERATOR.
       *
       * Kentucky gives no deed to quiet. The route to ownership is a judicial
       * foreclosure in circuit court under KRS 134.546 — complaint, service,
       * master commissioner appraisal, sale — and these figures stand in for
       * that, because it occupies the same place in the arithmetic: the money
       * and months between winning at auction and owning something saleable.
       * The costs are a placeholder pending operator review, like PA.
       */
      typicalLow: 3000,
      typicalHigh: 7000,
      typicalMonths: 9,
      required: true,
    },
    /*
     * Clerk's fees on purchase and assignment. The certificate's face amount
     * already carries a 10% penalty, the sheriff's commission and 10% add-on,
     * and the clerk's 10% (KRS 134.119; 134.126) — those are inside what is
     * paid, not on top of it, and the 12% accrues on the whole sum.
     */
    closingCosts: 200,
    /*
     * Purchase, then the remainder of the tolling year, then the foreclosure,
     * then the conditional six-month redemption if the sale clears below
     * two-thirds of appraisal. Roughly 6 + 9 + 6. Long, and the reason a
     * Kentucky certificate is a patient instrument rather than a flip.
     */
    auctionToMarketableMonths: 21,
    assessmentRatio: 1.0,
    assessmentBasis:
      "Section 172 of the Kentucky Constitution requires all non-exempt property to be assessed at 100% of fair cash value — the price it would bring at a fair voluntary sale — as of 1 January (see also KRS 132.190).",
    derivedArvCaveat:
      "Kentucky assesses at 100% of fair cash value, so the ratio is honestly 1.0 — but that is the PVA's opinion of value as of 1 January of the assessment year, not an appraisal of this parcel today. Treat a derived ARV as a starting point and get comparable sales before bidding.",
    statute:
      "KRS Chapter 134 (certificates of delinquency: §§ 134.015, 134.119, 134.125-134.131, 134.420, 134.452, 134.490, 134.546); KRS 426.530 (post-sale redemption)",
    asOf: "2026-09",
    sources: [
      "https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=45200",
      "https://codes.findlaw.com/ky/title-xi-revenue-and-taxation/ky-rev-st-sect-134-546/",
      "https://revenue.ky.gov/DOR%20Training%20Materials/103%20KAR%205.180.%20Procedures%20for%20sale%20of%20certificates%20of%20delinquincy%20by%20county%20clerks.pdf",
      "https://revenue.ky.gov/Property/Pages/Delinquent-Property-Tax.aspx",
      "https://www.lawserver.com/law/state/kentucky/ky-statutes/kentucky_statutes_134-452",
      "https://revenue.ky.gov/Forms/62F003914.pdf",
    ],
    caveats: [
      "Kentucky sells LIENS, not deeds. The expected outcome is the taxpayer satisfying the certificate at 12% per annum, not acquiring the property. Ownership requires a separate judicial foreclosure at additional legal cost, and the maths above treats that cost as if it were quiet title.",
      "THE ADVERTISED PARCEL COUNT OVERSTATES WHAT IS BUYABLE. A third-party purchaser already holding a prior-year certificate on a parcel has first priority, submits a priority list up to ten days before the sale, and every certificate allocated that way is REMOVED from the annual sale (KRS 134.128). On a large county roll a material share of the advertised certificates never reaches open bidding, so an announced count is an upper bound on availability, not inventory.",
      "SECOND REDEMPTION THIS ROW CANNOT EXPRESS. If a foreclosure sale brings less than two-thirds of the appraised value, KRS 426.530 gives the defendant six months from the day of sale to redeem at the purchase money plus 10% per annum plus the purchaser's reasonable post-sale costs. Six months is the current text, amended effective 2016-07-15; older summaries say a year. Bidding above two-thirds of appraisal is what extinguishes this right.",
      "ONE-YEAR TOLLING PERIOD. No action may be brought on a certificate until one year after the taxes became delinquent (1 January), and none at all after eleven years (KRS 134.546). A July purchase therefore sits roughly six months before enforcement can even begin.",
      "Premium-bid sale. The opening figure is taxes, penalties, interest and administrative costs, and bidders bid the price UP; the 12% accrues on the amount paid to the clerk, so a premium is not dead money, but it does lower the effective yield against the certificate's face.",
      "You cannot cherry-pick. Certificates are sold in lots whose size is set by the size of the county's roll — up to 5 for rolls under 500, rising to 50 for rolls of 2,500-7,500, and 2% of the roll per round beyond that — with selection order set by a random drawing at the start of the sale (103 KAR 5:180).",
      "Registration is mandatory and volume triggers obligations. Participants register with the county clerk at least a week ahead; anyone paying more than five certificates statewide, more than three in one county, or more than $10,000 statewide in a calendar year must also register with the Department of Revenue and must offer delinquent taxpayers a monthly installment plan (KRS 134.128; 134.129; 134.490).",
      "Notice duties are continuing, not one-off. Within 50 days of delivery the purchaser must notify the taxpayer by first-class mail with proof of mailing, must repeat that notice at least annually until an action is instituted, and must give 45 days' notice before instituting one (KRS 134.490). These are carrying costs and a source of title risk if missed.",
      "Home-rule cities can differ. Kentucky grants broad home rule under KRS 82.082, and first-class city procedure sits in KRS Chapter 91 rather than Chapter 134. Confirm the selling entity in Louisville and Lexington before assuming county clerk procedure.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator, and they stand for a judicial foreclosure rather than a quiet title suit. Do not rely on a computed Kentucky max bid until they are set.",
    ],
  },
  MI: {
    state: "MI",
    saleType: "Tax Deed",
    // MCL 211.78k — the foreclosure judgment extinguishes all prior interests
    // before the property reaches the auction.
    redemption: null,
    quietTitle: { typicalLow: 1500, typicalHigh: 4000, typicalMonths: 3, required: false },
    closingCosts: 300,
    assessmentRatio: 0.5,
    assessmentBasis:
      "Michigan state equalized value is 50% of true cash value by constitution (Mich. Const. art. IX, § 3); taxable value may be lower still. " +
      "The SEV published with these auction listings is taken from the delinquent tax year that was foreclosed upon, so it is typically several years stale — " +
      "in a rising market it understates current value, and in a falling one it overstates it.",
    statute: "MCL 211.78 et seq. (general property tax act, foreclosure)",
    asOf: "2026-07",
    sources: ["https://www.legislature.mi.gov/Laws/MCL?objectName=MCL-211-78K"],
    caveats: [
      "Michigan's foreclosure judgment cuts off prior liens and the owner's interest, so title is comparatively clean — quiet title is often unnecessary.",
      "Valuations here derive from a stale SEV, not comps. Treat the computed ARV as a starting point and override it with real comparable sales before bidding at the ceiling.",
      "Rand v. Rand / Hall-era excess-proceeds rules mean former owners may claim surplus; this does not affect the buyer's title.",
    ],
  },

  IL: {
    state: "IL",
    saleType: "Tax Lien",
    redemption: {
      // 35 ILCS 200/21-355. The statutory ceiling is 18% per six-month period,
      // which compounds to 90% over the extended 30-month window. These tiers
      // are the legal maximum and are almost never what a bidder receives —
      // see `bidDown` below before quoting any of them as a return.
      tiers: [
        { throughDays: 182, penalty: 0.18 },
        { throughDays: 365, penalty: 0.36 },
        { throughDays: 547, penalty: 0.54 },
        { throughDays: 730, penalty: 0.72 },
        { throughDays: 912, penalty: 0.9 },
      ],
      maxDays: 912,
      extendedFor:
        "owner-occupied principal residence of 1–6 dwelling units (30 months); most other property redeems at 24 months",
      bidDown: {
        statutoryMax: 0.18,
        observedMedian: 0.0,
        observedMean: 0.0188,
        n: 64526,
        observedSource:
          "https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json (Cook County annual tax sale, winning_bid_percent)",
        note:
          "81.4% of recorded Cook County liens cleared at a 0% penalty bid. Institutional " +
          "buyers take these for the deed remainder rather than the interest, so expected " +
          "return on the redemption path is close to zero and the real thesis is acquisition.",
      },
    },
    quietTitle: {
      typicalLow: 2000,
      typicalHigh: 5500,
      typicalMonths: 6,
      required: true,
    },
    closingCosts: 350,
    assessmentRatio: 0.3333,
    assessmentBasis:
      "35 ILCS 200/9-145: property outside Cook County is assessed at 33⅓% of fair cash value.",
    countyAssessmentRatios: {
      // Cook runs a classified system under home rule rather than the statutory
      // one-third. Residential is the class our parcels overwhelmingly fall in.
      "17031": {
        ratio: 0.1,
        basis:
          "Cook County Classification Ordinance: Class 2 residential is assessed at 10% of market value, not the statutory 33⅓%.",
      },
    },
    statute: "35 ILCS 200, Art. 21 (sale and redemption); Art. 22 (tax deed)",
    asOf: "2026-07",
    sources: [
      "https://www.ilga.gov/legislation/ilcs/ilcs5.asp?ActID=596&ChapterID=8",
      "https://www.ilga.gov/legislation/ilcs/documents/003502000K21-355.htm",
      "https://www.ilga.gov/legislation/ilcs/documents/003502000K9-145.htm",
      "https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json",
    ],
    caveats: [
      "The penalty is bid DOWN from an 18% ceiling, so the tiers above are a best case, not an expectation. Recorded Cook sales cleared at a 0% median and a 1.88% mean across 64,526 liens — price an Illinois lien on the acquisition thesis, not the interest.",
      "Cook County assesses residential at ~10% of market value, not the statutory 33⅓%. The county override above handles this; parcels in other Illinois counties use the statutory ratio.",
      "Title is perfected by petition for tax deed under Art. 22 rather than a classic quiet-title action. The cost and duration here are market practice for that proceeding plus any curative work an insurer requires, and are not fixed by statute.",
      "Redemption runs 24 months for most property and 30 months only for an owner-occupied principal residence of 1–6 units. Commercial, industrial and vacant non-residential stay at 24.",
      "Cook also runs a scavenger sale for long-delinquent parcels under different minimum-bid rules (35 ILCS 200/21-145 et seq.) that this entry does not model.",
    ],
  },

  CA: {
    state: "CA",
    saleType: "Tax Deed",
    // The owner's right to redeem ends at 5pm on the last business day before
    // the sale, so a California tax deed carries no post-sale redemption at all.
    redemption: null,
    quietTitle: {
      typicalLow: 2500,
      typicalHigh: 6000,
      typicalMonths: 6,
      required: false,
    },
    closingCosts: 250,
    assessmentRatio: 1.0,
    assessmentBasis:
      "Cal. Rev. & Tax. Code § 401: property is assessed at full cash value, so the statutory ratio is 1.0.",
    derivedArvCaveat:
      "California assesses at full cash value, but Proposition 13 fixes the base year and factors it forward at up to 2%/yr. On a long-held parcel the assessed value can sit far below market, so an ARV derived from it understates the property — get comparable sales before bidding.",
    statute: "Cal. Rev. & Tax. Code §§ 3691–3731 (tax-defaulted property sales)",
    asOf: "2026-07",
    sources: [
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=401",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3691",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=3711",
      "https://www.boe.ca.gov/proptaxes/prop13.htm",
    ],
    caveats: [
      "No post-sale redemption. The owner's right ends at 5pm on the last business day before the sale, so the deed conveys without that overhang.",
      "Proposition 13 means assessed value systematically understates market value on long-held parcels. Do not treat a ratio-derived ARV as an appraisal in California.",
      "RTC § 3711 makes the tax deed presumptively valid, so quiet title is optional rather than required — but most title insurers still want it before writing a policy.",
      "Some non-residential commercial property reaches power-to-sell after 3 years of default rather than the usual 5 (RTC § 3691).",
      "Recorded San Diego sale lists mark pre-sale cures as 'REDEEMED'. That is the owner paying before the auction, not a post-sale redemption, and it is quarantined in the copilot's label rules.",
    ],
  },
  /*
   * Wyoming is the only state in this file where you do not bid.
   *
   * ## Liens are allocated, not auctioned
   *
   * The county treasurer offers each lien in turn and buyers are drawn at
   * random; there is no bidding up the price and no bidding down the rate. The
   * certificate is taxes plus costs, and the statutory return is the same
   * whoever draws it. Our own imported calendar records the mechanism in
   * USTLA's words — Uinta County's sale carries "Random Selection" where every
   * other state's rows say "Bid Up or Premium", "Bid Down" or "Combination".
   *
   * That removes, in one state, every distortion the rest of this file has to
   * warn about: no premium to dilute the yield, no minimum-bid base, no cap, no
   * observed median that collapses to zero. What you see is what the instrument
   * pays.
   *
   * ## Four years before you can act, six before you lose the right
   *
   * The owner may redeem at any time until a deed issues. The certificate
   * holder may apply for a tax deed only after four years from the sale, and
   * not more than six — so the window to act is two years wide and closes.
   * `maxDays` is the four-year floor, which is the period the buyer is
   * certainly waiting.
   */
  WY: {
    state: "WY",
    saleType: "Tax Lien",
    redemption: {
      interestKind: "annual",
      /*
       * 15% per annum from the date of sale. A further 3% penalty on the amount
       * purchased is earned in the first year and is NOT modelled here: the
       * tier is one number and 15% is the sustained rate, so encoding 18% would
       * overstate years two through four. The first-year uplift is a caveat.
       */
      tiers: [{ throughDays: 1460, penalty: 0.15 }],
      maxDays: 1460,
    },
    quietTitle: {
      /*
       * NOT YET REVIEWED BY THE OPERATOR — placeholder, as for PA, KY, IN, SC
       * and TN. Wyoming issues a treasurer's tax deed on application rather
       * than through a court, so the deed arrives without judicial blessing and
       * an action is the usual route to an insurable title.
       */
      typicalLow: 2000,
      typicalHigh: 5000,
      typicalMonths: 5,
      required: true,
    },
    closingCosts: 200,
    /*
     * Four years of waiting before the deed application is even permitted, then
     * the application and an action. Wyoming is the longest hold in this file
     * and the arithmetic should say so.
     */
    auctionToMarketableMonths: 54,
    /*
     * "All other property" under W.S. 39-13-103(b)(xi) — agricultural,
     * commercial and residential alike. Industrial sits at 11.5%, which is the
     * dangerous direction; see the derived-ARV note.
     */
    assessmentRatio: 0.095,
    assessmentBasis:
      "W.S. 39-13-103: property used for industrial purposes is assessed at 11.5% of fair market value; all other property, real and personal, at 9.5%. Wyoming assesses by use, not by county.",
    derivedArvCaveat:
      "Two things pull a Wyoming derived ARV in opposite directions. Industrial property is assessed at 11.5% rather than 9.5%, so dividing by 0.095 overstates it by about 1.2x — the dangerous direction. And since tax year 2025 a homeowner claiming the exemption in W.S. 39-11-105(a)(xlvi) has 25% of fair market value exempted, capped at the first $1,000,000, so an owner-occupied assessment reflects roughly three quarters of value and a derived ARV understates it — the safe direction, but by a quarter. Neither is visible in a bare assessed figure; check the assessor's record.",
    statute:
      "W.S. 39-13-108 (enforcement: tax lien sales, certificates of purchase, redemption and tax deeds); W.S. 39-13-103 (assessment rates); W.S. 39-11-105(a)(xlvi) (homeowner exemption, 2025 Enrolled Act No. 60)",
    asOf: "2026-09",
    sources: [
      "https://law.justia.com/codes/wyoming/title-39/chapter-13/section-39-13-108/",
      "https://codes.findlaw.com/wy/title-39-taxation-and-revenue/wy-st-sect-39-13-108/",
      "https://codes.findlaw.com/wy/title-39-taxation-and-revenue/wy-st-sect-39-13-103.html",
      "https://wyoleg.gov/2025/Enroll/SF0069.pdf",
      "https://www.albanycountywy.gov/299/Tax-Lien-Sale",
    ],
    caveats: [
      "NO BIDDING. Wyoming allocates liens by random draw rather than auction — the certificate is taxes plus costs and the return does not depend on competition. Our own calendar records Uinta County's procedure as 'Random Selection'. A model that assumes premium or bid-down behaviour does not apply here.",
      "A FURTHER 3% PENALTY IS EARNED IN THE FIRST YEAR, on top of the 15% per annum, and is not in the tier — one number cannot hold both. Year one is therefore better than modelled and years two to four are as modelled.",
      "FOUR YEARS BEFORE A DEED, SIX BEFORE THE RIGHT LAPSES. The holder may apply for a tax deed only after four years from the sale and not more than six. Capital is committed for at least four years, the owner may redeem throughout, and a holder who sleeps past six loses the ability to take title at all.",
      "Wyoming is the longest hold in this file. At 15% simple that is attractive on paper, but auctionToMarketableMonths is 54 and the money is illiquid throughout — compare against what else that capital could do over four and a half years rather than against a one-year lien state.",
      "Assessment is by use, not county: 11.5% industrial, 9.5% everything else. This row uses 9.5%.",
      "The 2025 homeowner exemption (W.S. 39-11-105(a)(xlvi), Enrolled Act No. 60) exempts 25% of fair market value on a single family residence and its improved land, capped at the first $1,000,000, first applying to tax year 2025; from tax year 2026 the claimant must actually reside there at least eight months of the year. Note this is an EXEMPTION, not a rate change — press reporting of an 8.3% owner-occupied rate described a floor amendment that did not survive into the enrolled act.",
      "quietTitle costs here are a placeholder and have not been reviewed by the operator. Do not rely on a computed Wyoming max bid until they are set.",
    ],
  },
};

export function statuteFor(state: string): StatuteParams | null {
  return STATUTE_PARAMS[state] ?? null;
}

/**
 * States the deal engine can price, derived rather than listed.
 *
 * Hardcoded copies of this list went stale the moment IL and CA were added,
 * leaving user-facing warnings naming five states while the engine priced
 * seven. Read it from the map.
 */
export function coveredStateList(): string[] {
  return Object.keys(STATUTE_PARAMS).sort();
}

/** Whether the deal engine can produce numbers for this state at all. */
export function hasStatuteParams(state: string): boolean {
  return state in STATUTE_PARAMS;
}
