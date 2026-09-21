/**
 * The nine CAPE components, as a package model.
 *
 * Each component carries the checklist the document specifies for it, and each
 * item resolves to one of three states rather than a boolean:
 *
 *   have    — a value is on record
 *   verify  — the document's phrase: "clearly marked as requiring manual
 *             verification". We hold something adjacent, or the item is
 *             inherently a human judgement, and nobody has confirmed it.
 *   absent  — no data exists here and none is coming from the current sources.
 *
 * The three-way split is the whole design. A checklist that reported "missing"
 * for both an unconfirmed deposit rule and an environmental assessment would be
 * useless: the first is a phone call, the second needs a vendor this product
 * does not have. Component Nine's quality gate depends on being able to tell
 * them apart.
 *
 * Nothing here generates content. Components Five, Six and Seven describe
 * written and produced deliverables — a risk summary, a market analysis, a
 * narration script and video. This model reports what inputs exist for them and
 * whether they have been produced; it does not write them, and it does not
 * claim they exist when they do not.
 */
import { createHash } from "node:crypto";
import type { AuctionLogistics } from "@/lib/db/schema";
import type { CountyRule } from "@/lib/atlas/types";
import type { StatuteParams } from "@/lib/deal/statute";
import { classifySource, type SourceClassification } from "./sources";
import { productionDeadline, type ProductionDeadline } from "./deadline";
import { qualifies } from "./propstream";

export type ItemState = "have" | "verify" | "absent";

export interface ComponentItem {
  label: string;
  state: ItemState;
  /** What we hold, or why the item cannot be satisfied. */
  detail: string | null;
  /**
   * True when this item's only content is our own absence, so the narrator
   * never sees it.
   *
   * `absent` was supposed to cover this and does not. An `absent` item is one no
   * source was ever going to satisfy — code enforcement, IRS liens, probate —
   * and `factSheet` already drops those. But a `verify` item can be just as
   * empty: "Assessor records — No parcel in this sale has an assessor record"
   * is a fact about this database, not about the sale.
   *
   * The Fulton recut is what this is for. The prompt has said "never list what
   * this briefing does not cover" since the last pass, and the model wrote
   * "Assessor records are not on file for parcels in this sale. No county GIS
   * link and no coordinates appear on these parcels. Zoning data is absent."
   * onto a slide reading "Assessor/GIS not in file" — because the FACTS it was
   * handed were, line by line, an inventory of absence. An instruction cannot
   * outvote the evidence beneath it. So the evidence goes.
   *
   * Scored exactly as before: `component()` counts these in its denominator,
   * because the product genuinely lacks them and the operator board must show
   * that. Only the narrator is spared.
   */
  silent?: boolean;
  /**
   * What the narrator is told, when it differs from what the board shows.
   *
   * The coverage items count parcels as enrichment fills them in — every ten
   * minutes now — and both the exact percentage and the counts behind it were
   * in the script's inputs hash. Each parcel valued moved the hash, so the
   * largest sales, the ones being enriched, had their scripts rewritten and
   * their videos re-rendered over and over, buying speech each time to change
   * "sixty-two percent" to "sixty-three". The board keeps the exact figure; the
   * narrator gets the band (`coverageBand`), and so does the hash.
   */
  spoken?: string;
}

/**
 * A share of a sale's parcels, in words that change only a few times as it fills.
 *
 * Quarter bands: a briefing is not the place for a percentage that is out of
 * date by the time it is heard, and a band is what a bidder does with it anyway.
 */
export function coverageBand(n: number, total: number): string {
  if (total <= 0 || n <= 0) return "none";
  const r = n / total;
  if (r >= 1) return "all";
  if (r >= 0.875) return "nearly all";
  if (r >= 0.625) return "about three quarters";
  if (r >= 0.375) return "about half";
  if (r >= 0.125) return "about a quarter";
  return "a few";
}

export interface Component {
  n: number;
  title: string;
  items: ComponentItem[];
  /** Share of items in `have`. */
  score: number;
  counts: Record<ItemState, number>;
}

export interface PackageInput {
  auctionId: string;
  /**
   * The county's FIPS code. Optional because the checklist never needed it —
   * it is what the establishing shot looks a county seat up by, and
   * `capePackageInputs` has always supplied it alongside.
   */
  countyFips?: string;
  countyName: string | null;
  state: string | null;
  saleDate: string;
  saleDateConfirmed: boolean;
  saleType: string | null;
  sourceUrl: string | null;
  platform: string | null;
  startTime: string | null;
  registrationDeadline: string | Date | null;
  depositDeadline: string | Date | null;
  lotCount: number;
  listingKind: string;
  rule: CountyRule | null;
  statute: StatuteParams | null;
  /** Directory office links for this county, by kind. */
  offices: Partial<Record<string, string>>;
  /** Venue and named contact, where an operator source supplied them. */
  logistics?: AuctionLogistics | null;
  /** Census population for the county, for Component Ten's threshold. */
  population: number | null;
  /** Parcel-level coverage across the sale, for Component Four. */
  parcels: {
    total: number;
    withParcelNumber: number;
    withAssessed: number;
    withAddress: number;
    withZoning: number;
    withGeo: number;
  };
  today: string;
  /**
   * What Component Seven has actually produced for this package, if anything.
   *
   * Passed in rather than looked up, so `buildPackage` stays a pure function of
   * its inputs — the property `cape.test.ts` depends on and the reason the
   * checklist can be reasoned about at all.
   *
   * `inputsHash` is what makes a stale artifact detectable: it is the identity
   * of the computed package the script was written from. A narration produced
   * before the sale date was confirmed describes a different sale, and must not
   * report itself as done.
   */
  production?: CapeProductionState | null;
}

/** The subset of a `cape_productions` row the checklist reads. */
export interface CapeProductionState {
  inputsHash: string;
  hasScript: boolean;
  slidePlanCount: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  /** Figures the narration spoke that were not in the facts. Empty is the pass. */
  unsupportedFigures: string[];
}

export interface CapePackage {
  auctionId: string;
  source: SourceClassification;
  deadline: ProductionDeadline;
  components: Component[];
  /** Mean of the nine component scores. */
  score: number;
  /** Component Nine's gate. */
  releasable: boolean;
  blockedBy: string[];
}

/**
 * Identity of the facts a narration is written from.
 *
 * ## What it must include
 *
 * Everything a script could legitimately speak: the county, the sale, the
 * statute, the rules, the parcel counts. If any of those move, the narration
 * describes a sale that no longer exists and every artifact built from it is
 * stale.
 *
 * ## What it must exclude, and why that matters more
 *
 * `today` is in `PackageInput` because Component Eight computes a deadline from
 * it. Folding it into this hash would change the hash every midnight, mark all
 * 152 packages stale every day, and — since staleness is what triggers
 * regeneration — re-synthesise every narration daily against a metered speech
 * API. A cache key that includes the clock is not a cache key.
 *
 * `production` is excluded because it is the thing being judged.
 */
/**
 * Bump when the *rendering* of the facts changes, not the facts themselves.
 *
 * This hash is computed from `PackageInput` and is documented as the identity
 * of "the computed package the script was written from". It is not: it is the
 * identity of the inputs. Change how an input is phrased for the narrator —
 * "4,015 days" becoming "4,015 days (about eleven years)", or the whole
 * production calendar leaving the fact sheet — and every stored script is now
 * written from a fact sheet that no longer exists, while the hash insists they
 * are current. Nothing is stale, nothing regenerates, and the fix ships to
 * nobody.
 *
 * `--force` is not the answer to that. It also bypasses the county-half cache
 * and makes a batch unresumable, so a five-hour run that dies at package 300
 * cannot be restarted without buying those 300 again. A version here makes the
 * regeneration ordinary: everything is stale, the run resumes like any other,
 * and reuse still works.
 *
 * 2 — the fact sheet dropped Components Seven through Ten and every silent
 *     item, and redemption windows over a year gained a human scale.
 * 3 — parcel coverage reaches the narrator, and the hash, as a band rather
 *     than a count; see `ComponentItem.spoken`.
 */
const FACT_SHEET_VERSION = 3;

export function capeInputsHash(i: PackageInput): string {
  const shape = {
    v: FACT_SHEET_VERSION,
    auctionId: i.auctionId,
    county: i.countyName,
    state: i.state,
    saleDate: i.saleDate,
    saleDateConfirmed: i.saleDateConfirmed,
    saleType: i.saleType,
    platform: i.platform,
    sourceUrl: i.sourceUrl,
    startTime: i.startTime,
    registrationDeadline: text(i.registrationDeadline),
    depositDeadline: text(i.depositDeadline),
    lotCount: i.lotCount,
    listingKind: i.listingKind,
    population: i.population,
    /* The total is a crawl's finding; the rest move with enrichment, so only their bands count. */
    parcels: {
      total: i.parcels.total,
      number: coverageBand(i.parcels.withParcelNumber, i.parcels.total),
      assessed: coverageBand(i.parcels.withAssessed, i.parcels.total),
      address: coverageBand(i.parcels.withAddress, i.parcels.total),
      zoning: coverageBand(i.parcels.withZoning, i.parcels.total),
      geo: coverageBand(i.parcels.withGeo, i.parcels.total),
    },
    offices: i.offices,
    logistics: i.logistics ?? null,
    rule: i.rule ?? null,
    statute: i.statute ?? null,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/**
 * The identity of everything a briefing says about the *county*, with nothing
 * about which sale prompted it.
 *
 * The partition is the whole idea, and it is decided by one question per field:
 * could two sales in this county, under this statute, honestly disagree about
 * it? The statute, the redemption window, what the deed conveys, the quiet-title
 * requirement, the submarkets and the offices — no. The date, the time, the
 * venue, the parcels and the platform — yes, every time.
 *
 * `saleType` sits on the county side despite living on the auction row, because
 * it is not a property of the occasion: it is which body of law the county is
 * selling under, and it is what the statute sections are written from. A county
 * that runs both a deed sale and a lien sale gets two rows, which is right —
 * those are two different explanations of what a bidder is buying.
 *
 * `population` is here because the narrator uses it for scale and it does not
 * move between sales. `countyName`/`state` are here because they are spoken.
 */
export function capeCountyInputsHash(i: PackageInput): string {
  const shape = {
    county: i.countyName,
    state: i.state,
    saleType: i.saleType,
    population: i.population,
    offices: i.offices,
    rule: i.rule ?? null,
    statute: i.statute ?? null,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

const have = (label: string, detail: string): ComponentItem => ({ label, state: "have", detail });
/** The same item, with what the narrator hears in place of the board's detail. */
const spoken = (item: ComponentItem, text: string): ComponentItem => ({ ...item, spoken: text });
/**
 * An item nobody has confirmed — silent to the narrator by default.
 *
 * The default is the whole point. This constructor used to be audible and
 * `blank` was the opt-out, which meant every new checklist item shipped
 * narratable unless its author remembered otherwise; the Fulton recut spoke
 * four absences in a row and put "Assessor/GIS not in file" on a slide because
 * of it. Now the safe state is the one you get for free, and making a line
 * audible is a deliberate act that costs you a sentence written for the viewer
 * — see `advise`.
 *
 * `detail` here is written for the operator reading the board, so it may name a
 * column or say "not researched". Nobody outside the company reads it.
 */
const verify = (label: string, detail: string): ComponentItem => ({
  label,
  state: "verify",
  detail,
  silent: true,
});

/**
 * An unconfirmed item the viewer should act on, in the words they should hear.
 *
 * Same state as `verify` and scored identically; the only difference is that
 * this one reaches the narrator. The rule for `instruction` is that it
 * describes the sale or what to do about it, never this system: "Confirm the
 * start time on the county's current sale notice" earns its place, "No start
 * time on the sale notice" does not — that tells a bidder about our file.
 */
const advise = (label: string, instruction: string): ComponentItem => ({
  label,
  state: "verify",
  detail: instruction,
});
const absent = (label: string, detail: string): ComponentItem => ({
  label,
  state: "absent",
  detail,
});

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s || null;
}

/**
 * `have` when present, otherwise a silent `verify` carrying the reason.
 *
 * Silence is not a judgement call here: every `missing`
 * string passed to this helper is an internal note about why we lack the value
 * — "No adapter writes registration_deadline", "No tax office link", "Not
 * verified against the county notice". None of them is a sentence a bidder
 * benefits from hearing. Where an absence *does* imply something the viewer
 * should go and do, the call site writes that instruction with `advise`
 * instead of reaching for this.
 */
function field(label: string, value: unknown, missing: string): ComponentItem {
  const v = text(value);
  return v ? have(label, v) : verify(label, missing);
}

/**
 * "Official county contacts", counted from both sources that can satisfy it.
 *
 * The directory supplies office *links*; the operator's sale calendar supplies a
 * *person* — a name, a line and an address for this specific sale. Either alone
 * answers the item, and a county with neither is the only honest `verify`.
 * Returns null so the caller states that case once, in its own words.
 */
function contactSummary(i: PackageInput): ComponentItem | null {
  const offices = Object.keys(i.offices).length;
  const c = i.logistics?.contact;
  const named = Boolean(c?.name || c?.phone || c?.email);

  const parts: string[] = [];
  if (offices > 0) parts.push(`${offices} offices on file`);
  // Named, not named — see the note at the call site on what may be spoken.
  if (named) parts.push(`a named contact for this sale from ${i.logistics!.source}`);

  return parts.length ? have("Official county contacts", parts.join(", plus ")) : null;
}

/**
 * A redemption window in days, and in something a listener can picture.
 *
 * Kentucky's is 4,015 days — the eleven-year limit in KRS 134.546, and correct.
 * Spoken, it came out as "the redemption period on record is four thousand
 * fifteen days", which is a true sentence that tells a bidder nothing: nobody
 * holds a number that size in their head as a duration. The figure stays,
 * because it is the statutory one and the narration must be able to cite it,
 * and the human scale travels beside it.
 *
 * Only added where it says something the days do not. "365 days (one year)"
 * earns its place; "90 days (about three months)" does not, so the threshold is
 * a year.
 */
export function redemptionWindow(days: number): string {
  if (days < 365) return `${days} days`;
  const years = days / 365;
  const rounded = Math.round(years);
  const human =
    Math.abs(years - rounded) < 0.08
      ? rounded === 1
        ? "one year"
        : `about ${NUMBER_NAMES[rounded] ?? rounded} years`
      : `about ${years.toFixed(1)} years`;
  return `${days.toLocaleString()} days (${human})`;
}

/** Spelled out so the narrator has the word, not just the digits, in the facts. */
const NUMBER_NAMES: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
  8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 15: "fifteen",
  20: "twenty",
};

function tally(items: ComponentItem[]): Component["counts"] {
  return {
    have: items.filter((i) => i.state === "have").length,
    verify: items.filter((i) => i.state === "verify").length,
    absent: items.filter((i) => i.state === "absent").length,
  };
}

function component(n: number, title: string, items: ComponentItem[]): Component {
  const counts = tally(items);
  /*
   * `absent` items are excluded from the denominator. Scoring a package down
   * for lacking an environmental report we were never going to have would make
   * every score a measure of the product's scope rather than of this package's
   * readiness, and would make the number useless for ranking work.
   */
  const scorable = items.length - counts.absent;
  return { n, title, items, counts, score: scorable > 0 ? counts.have / scorable : 1 };
}

export function buildPackage(i: PackageInput): CapePackage {
  const source = classifySource(i.sourceUrl);
  const r = i.rule;
  const p = i.parcels;
  const pct = (n: number) => (p.total > 0 ? Math.round((100 * n) / p.total) : 0);

  // --- One: auction intake -------------------------------------------------
  const one = component(1, "Auction intake", [
    field("County", i.countyName, "No county on the auction row"),
    field("State", i.state, "No state on the auction row"),
    field("Auction date", i.saleDate, "No sale date"),
    field("Sale type", i.saleType ?? r?.type, "No sale type"),
    field("Official source", i.sourceUrl, "No source URL recorded"),
    field("Auction platform", i.platform ?? r?.auctionPlatform?.label, "No platform recorded"),
    field(
      "Registration requirements",
      i.registrationDeadline ?? r?.auctionFormat,
      "No adapter writes registration_deadline; not in county research either",
    ),
    field(
      "Payment rules",
      i.depositDeadline ?? r?.depositRules,
      "No adapter writes deposit_deadline; not in county research either",
    ),
    p.total > 0
      ? have("Parcel list", `${p.total} parcels`)
      : advise("Parcel list", "The county has not published its parcel list for this sale yet"),
  ]);

  // --- Two: source verification -------------------------------------------
  const two = component(2, "Source verification", [
    have("Source tier", `${source.tier} — ${source.basis}`),
    i.saleDateConfirmed
      ? have("Auction date confirmed", "Published by the county")
      : advise("Auction date confirmed", "Date projected from the state's typical schedule — confirm it with the county"),
    /*
     * The four items below are the exception `field` documents: an absence a
     * bidder must act on. Phrased as the action, not as our gap — "Confirm the
     * start time on the county's current sale notice", never "no start time on
     * file". The first is useful to someone about to register; the second only
     * tells them about us.
     */
    i.startTime
      ? have("Auction time", i.startTime)
      : advise("Auction time", "Confirm the start time on the county's current sale notice"),
    /*
     * A venue is `have` only when it is a category, never when it is a street
     * address.
     *
     * "Online auction" is a claim about format that is either right or absurd,
     * and 207 of the sale calendar's rows say exactly that. A physical address
     * is different in kind: it was hand-typed — the calendar holds "Clevevland"
     * and "Timiami Trail" — and the consequence of it being wrong is somebody
     * driving to the wrong building on the one morning it matters. So the
     * address is reported, with where it came from, as something to confirm.
     *
     * `verify` is not a lesser answer than `have` here. The fact sheet hands
     * this detail to the narrator marked NEEDS VERIFICATION, and the prompt
     * turns that into "the sale is held at X — confirm the location with the
     * county", which is the sentence a bidder actually needs.
     */
    i.logistics?.venue?.kind === "online"
      ? have("Location", "Online auction")
      : i.logistics?.venue
        ? advise(
            "Location",
            `${i.logistics.venue.text} — from ${i.logistics.source}; confirm against the county notice`,
          )
        : field("Location", r?.auctionFormat, "No venue or format in county research"),
    have("Platform", i.platform ?? "unrecorded"),
    field("Registration process", r?.auctionFormat, "Not verified against the county notice"),
    i.depositDeadline ?? r?.depositRules
      ? have("Deposit requirements", text(i.depositDeadline ?? r?.depositRules)!)
      : advise("Deposit requirements", "Confirm the deposit and accepted funds with the county"),
    i.depositDeadline
      ? have("Payment deadlines", text(i.depositDeadline)!)
      : advise("Payment deadlines", "Read the payment deadline off the county's sale notice"),
    field("Sale type", i.saleType, "Not verified"),
    i.listingKind === "sale_list"
      ? have("Parcel list source", "Published sale list")
      : advise("Parcel list source", `The document behind this list is a ${i.listingKind} listing, not a published sale list`),
    i.statute?.redemption
      ? have("Redemption rules", redemptionWindow(i.statute.redemption.maxDays))
      : i.statute
        ? have("Redemption rules", "No post-sale redemption in this state")
        : verify("Redemption rules", `No verified statutory parameters for ${i.state}`),
    /*
     * The detail says a contact exists; it does not say who or on what number.
     *
     * Everything in this string is handed verbatim to the narrator and can be
     * read aloud in a public video. An office's listed URL is already published
     * for that purpose. A named county employee's direct line is not — it is
     * held on `auctions.logistics` for the token-gated console, where an
     * operator ringing the county is the whole point.
     */
    contactSummary(i) ?? verify("Official county contacts", "No directory entry for this county"),
  ]);

  // --- Three: county due diligence framework -------------------------------
  const three = component(3, "County due diligence", [
    field("Governing law", i.statute?.statute ?? r?.type, `No statute entry for ${i.state}`),
    field("Sale type", i.saleType, "No sale type"),
    i.statute
      ? have(
          "Redemption period",
          i.statute.redemption ? redemptionWindow(i.statute.redemption.maxDays) : "None post-sale",
        )
      : verify("Redemption period", `No verified statutory parameters for ${i.state}`),
    i.statute?.redemption
      ? have(
          "Interest / penalty structure",
          `${(i.statute.redemption.tiers[0].penalty * 100).toFixed(0)}% first tier`,
        )
      : i.statute
        ? have("Interest / penalty structure", "Not applicable — deed state")
        : verify("Interest / penalty structure", "Blocked on the statute entry"),
    field("Deed issued", r?.type, "Deed instrument not recorded in county research"),
    /*
     * Kept audible. Unlike the coverage items, this is not a gap in our file —
     * no database anywhere records whether a parcel is occupied, and a bidder
     * who assumes vacant possession loses money. The instruction is the point.
     */
    advise("Possession limitations", "Confirm occupancy and access on the ground before bidding"),
    i.statute
      ? have(
          "Quiet title / barment",
          i.statute.quietTitle.required ? "Required" : "Often unnecessary",
        )
      : verify("Quiet title / barment", "Blocked on the statute entry"),
    field("Auction logistics", r?.auctionFormat, "No format recorded"),
    field("Deposit / payment methods", r?.depositRules, "No deposit rules recorded"),
    field("Tax office", i.offices.collector ?? r?.taxCollector?.label, "No tax office link"),
    field("Clerk of court", i.offices.recorder ?? r?.clerkOfCourt?.label, "No clerk link"),
    field("Assessor", i.offices.assessor ?? r?.propertyAppraiser?.label, "No assessor link"),
    field("GIS department", i.offices.gis ?? r?.gisMap?.label, "No GIS link"),
    absent("Zoning office", "Not collected by the directory crawler"),
    absent("Code enforcement", "Not collected by the directory crawler"),
  ]);

  // --- Four: property-level due diligence ----------------------------------
  const four = component(4, "Property-level due diligence", [
    spoken(
      p.withParcelNumber === p.total && p.total > 0
        ? have("Parcel verification", `${pct(p.withParcelNumber)}% carry a parcel number`)
        : advise("Parcel verification", `${pct(p.withParcelNumber)}% carry a parcel number`),
      `${coverageBand(p.withParcelNumber, p.total)} of the parcels carry a parcel number`,
    ),
    /*
     * Four coverage items, silent when empty.
     *
     * Each of these is a count of rows in this database. At zero the only
     * sentence available is "we do not hold it", which is what produced the
     * Fulton slide reading "Assessor/GIS not in file" and a narration paragraph
     * listing four absences in a row. A viewer cannot act on any of it, and the
     * briefing sounds like an apology for itself.
     *
     * The corresponding instruction — go and pull the assessor record and the
     * GIS layer — belongs in one place, not four, and Component Nine's
     * "Independent verification required" already says it.
     */
    p.withAssessed > 0
      ? spoken(
          have("Assessor records", `${pct(p.withAssessed)}% enriched`),
          `${coverageBand(p.withAssessed, p.total)} of the parcels carry an assessor record`,
        )
      : verify("Assessor records", "No parcel in this sale has an assessor record"),
    /*
     * Both sources, as Component Three has always read them.
     *
     * This read `i.offices.gis` alone — the directory crawler — while Component
     * Three's "GIS department" reads the directory *or* the county research
     * atlas. Fulton has no directory entry and a perfectly good atlas one, so
     * the same package reported a GIS link on record in one component and
     * missing in another. Two copies of one fact, disagreeing.
     */
    i.offices.gis ?? r?.gisMap?.label
      ? have("GIS mapping", text(i.offices.gis ?? r?.gisMap?.label)!)
      : verify("GIS mapping", "No county GIS link in the directory or the atlas"),
    p.withZoning > 0
      ? spoken(
          have("Zoning", `${pct(p.withZoning)}% carry a zoning code`),
          `${coverageBand(p.withZoning, p.total)} of the parcels carry a zoning code`,
        )
      : verify("Zoning", "No zoning data on these parcels"),
    p.withGeo > 0
      ? spoken(
          have("Location / mapping", `${pct(p.withGeo)}% geocoded`),
          `${coverageBand(p.withGeo, p.total)} of the parcels are mapped`,
        )
      : verify("Location / mapping", "No coordinates on these parcels"),
    verify("Legal access and road frontage", "ATTOM returns frontage on a minority of parcels"),
    verify("Occupancy", "Absentee flag available where enriched; occupancy not confirmed"),
    advise("Physical condition", "Condition cannot be established from records — inspect before bidding"),
    absent("Code enforcement / demolition orders", "No source for this"),
    r?.survivingLiens
      ? have("Municipal liens", "County research records what survives")
      : advise("Municipal liens", "Ask the county which municipal liens survive a tax sale"),
    absent("IRS liens", "No source for this"),
    absent("HOA exposure", "No source for this"),
    absent("Probate / bankruptcy", "No source for this"),
    absent("Environmental", "No source for this"),
    i.statute
      ? have(
          "Title insurance availability",
          i.statute.quietTitle.required ? "Quiet title required first" : "Generally available",
        )
      : verify("Title insurance availability", "Blocked on the statute entry"),
  ]);

  // --- Five: investor risk summary -----------------------------------------
  const five = component(5, "Investor risk summary", [
    i.statute
      ? have("Title and redemption exposure", "Derivable from the statute entry")
      : verify("Title and redemption exposure", `Blocked on statutory parameters for ${i.state}`),
    i.statute
      ? have(
          "Immediate control",
          i.statute.redemption ? "No — redemption window applies" : "Yes — deed conveys at sale",
        )
      : verify("Immediate control", "Blocked on the statute entry"),
    i.statute
      ? have(
          "Title-curative work required",
          i.statute.quietTitle.required ? "Quiet title required" : "Often unnecessary",
        )
      : verify("Title-curative work required", "Blocked on the statute entry"),
    verify("Primary opportunity and largest risk", "Written summary — not yet produced"),
    verify("Investor level (beginning / intermediate / advanced)", "Editorial judgement"),
    verify("Suggested strategies", "Editorial judgement"),
  ]);

  // --- Six: market intelligence --------------------------------------------
  const growth = r?.growthNeighborhoods ?? [];
  const six = component(6, "Market intelligence", [
    growth.length > 0
      ? have("Submarkets identified", `${growth.length} on file: ${growth.map((g) => g.name).join(", ")}`)
      : verify("Submarkets identified", "No growth areas researched for this county"),
    absent("Housing demand and affordability", "No market data source"),
    absent("Employment growth", "No market data source"),
    absent("Rental activity and resale liquidity", "RentCast covers rent where addresses exist; not aggregated"),
    growth.length > 0
      ? have("What to favour and avoid", "Recorded alongside each growth area")
      : verify("What to favour and avoid", "Blocked on submarket research"),
  ]);

  // --- Seven: education and video production -------------------------------
  /*
   * Staleness is decided here, once, and every item below reads the result.
   *
   * An artifact produced from different inputs is not a produced artifact. A
   * narration written before the sale date was confirmed, or before the state's
   * statute entry landed, describes a sale that has since changed — and
   * reporting it as done would let a package pass Component Nine on the
   * strength of a video that contradicts the rest of the briefing.
   */
  const prod = i.production ?? null;
  const currentHash = capeInputsHash(i);
  const stale = prod !== null && prod.inputsHash !== currentHash;
  const staleNote = "Produced from earlier facts — regenerate";

  const seven = component(7, "Education and video", [
    prod?.hasScript
      ? stale
        ? verify("Narration script", staleNote)
        : /*
           * A script that spoke a number nobody computed is not a script. It is
           * held at `verify` however complete it looks, because the whole point
           * of the check is that audio carries no visible source — see
           * `verifyNarration`.
           */
          prod.unsupportedFigures.length > 0
          ? verify(
              "Narration script",
              `Unsupported figure(s): ${prod.unsupportedFigures.join(", ")}`,
            )
          : have("Narration script", "Written and verified against the computed facts")
      : verify("Narration script", "Not produced"),

    prod?.hasAudio
      ? stale
        ? verify("Narration audio", staleNote)
        : have("Narration audio", "Synthesised")
      : verify("Narration audio", "Not produced"),

    prod?.slidePlanCount
      ? stale
        ? verify("Slide plan", staleNote)
        : have("Slide plan", `${prod.slidePlanCount} slide(s)`)
      : verify("Slide plan", "Not produced"),

    prod?.hasVideo
      ? stale
        ? verify("Final video", staleNote)
        : have("Final video", "Encoded")
      : verify("Final video", "Not produced"),
  ]);

  // --- Eight: production calendar ------------------------------------------
  const deadline = productionDeadline({
    saleDate: i.saleDate,
    platform: i.platform,
    today: i.today,
  });
  const eight = component(8, "Production calendar", [
    have("Mode", deadline.mode === "live" ? "Live auction" : "Online auction"),
    have(
      "Package due",
      `${deadline.dueDate} (${deadline.mode === "live" ? "Monday" : "Tuesday"} night, ${deadline.leadDays}d before the sale)`,
    ),
    deadline.salePassed
      ? have("Schedule", "Sale has passed")
      : deadline.overdue
        ? verify("Schedule", `Overdue — due ${deadline.dueDate}`)
        : have("Schedule", "On schedule"),
  ]);

  // --- Nine: quality control ------------------------------------------------
  const qcBlocking: string[] = [];
  if (!i.saleDateConfirmed) qcBlocking.push("Auction date is projected, not county-published");
  if (i.listingKind !== "sale_list") qcBlocking.push(`Source document is a ${i.listingKind} listing`);
  if (source.tier === "unverified") qcBlocking.push("Source is not a recognised authority");
  if (one.counts.verify > 0) qcBlocking.push(`Intake incomplete (${one.counts.verify} outstanding)`);
  if (!i.statute) qcBlocking.push(`No verified statutory parameters for ${i.state}`);

  const nine = component(9, "Quality control", [
    i.saleDateConfirmed
      ? have("Auction date confirmed", "County-published")
      : verify("Auction date confirmed", "Projected"),
    field("Official source", i.sourceUrl, "No source URL"),
    field("Registration requirements", i.registrationDeadline ?? r?.auctionFormat, "Outstanding"),
    field("Payment rules", i.depositDeadline ?? r?.depositRules, "Outstanding"),
    i.statute ? have("Redemption structure", "Verified") : verify("Redemption structure", "Blocked"),
    r?.survivingLiens ? have("Title risks", "Researched") : verify("Title risks", "Not researched"),
    i.listingKind === "sale_list"
      ? have("Parcel-list source", "Published sale list")
      : verify("Parcel-list source", `A ${i.listingKind} listing`),
    /*
     * These two are Component Seven's quality gate, and they stay honest about
     * what the machine can and cannot certify.
     *
     * `verifyNarration` proves a negative — that no spoken figure is absent
     * from the computed facts — and that is worth recording as satisfied,
     * because it is the failure mode with real consequences: a fabricated
     * redemption period repeated to everyone who takes the course. It does not
     * prove the narration is *good*, and this item does not claim it does.
     *
     * Whether the video is watchable is a human judgement, so it stays at
     * `verify` even when an MP4 exists. An automated "looks fine" on a file
     * nobody has opened is precisely the false assurance Component Nine is
     * supposed to prevent.
     */
    prod?.hasScript && !stale
      ? prod.unsupportedFigures.length === 0
        ? have("Narration accuracy", "Every spoken figure traced to a computed fact")
        : verify("Narration accuracy", `Unsupported: ${prod.unsupportedFigures.join(", ")}`)
      : verify("Narration accuracy", stale ? staleNote : "No narration produced"),
    prod?.hasVideo && !stale
      ? verify("Video formatting and audio", "Encoded — needs a human review pass")
      : verify("Video formatting and audio", stale ? staleNote : "No video produced"),
  ]);

  // --- Ten: PropStream export and downstream automations -------------------
  const q = qualifies(i.population);
  const ten = component(10, "PropStream list and automations", [
    q.qualifies
      ? have("Population threshold", q.reason)
      : verify("Population threshold", q.reason),
    p.total > 0
      ? have("Parcel list to export", `${p.total} parcels`)
      : verify("Parcel list to export", "Nothing to export yet"),
    p.withParcelNumber > 0
      ? have("APN match key", `${pct(p.withParcelNumber)}% carry a parcel number`)
      : verify("APN match key", "No parcel numbers — PropStream has nothing to match on"),
    /*
     * Reported separately from the APN key because the difference is the point.
     * Across qualifying counties a complete address sits on about one parcel in
     * nine, so an address-keyed list would look like PropStream having no data
     * rather than like us having sent none.
     */
    p.withAddress > 0
      ? have("Address match key", `${pct(p.withAddress)}% carry a street line`)
      : verify("Address match key", "No addresses — export matches on APN alone"),
    have("Export format", "PropStream CSV, headers pending the TDC template"),
    absent("Detailed PDF reports (Viktor / Slack)", "External to this system"),
    absent("Google Drive upload", "External to this system"),
    absent("GHL course attachment", "External to this system"),
    absent("County video (ChatGPT / ElevenLabs)", "External to this system"),
  ]);

  const components = [one, two, three, four, five, six, seven, eight, nine, ten];

  return {
    auctionId: i.auctionId,
    source,
    deadline,
    components,
    score: components.reduce((n, c) => n + c.score, 0) / components.length,
    releasable: qcBlocking.length === 0,
    blockedBy: qcBlocking,
  };
}
