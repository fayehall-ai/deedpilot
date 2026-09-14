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
export function capeInputsHash(i: PackageInput): string {
  const shape = {
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
    parcels: i.parcels,
    offices: i.offices,
    rule: i.rule ?? null,
    statute: i.statute ?? null,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

const have = (label: string, detail: string): ComponentItem => ({ label, state: "have", detail });
const verify = (label: string, detail: string): ComponentItem => ({
  label,
  state: "verify",
  detail,
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

/** `have` when present, otherwise `verify` with the reason. */
function field(label: string, value: unknown, missing: string): ComponentItem {
  const v = text(value);
  return v ? have(label, v) : verify(label, missing);
}

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
      : verify("Parcel list", "Calendar shell with no parcels published yet"),
  ]);

  // --- Two: source verification -------------------------------------------
  const two = component(2, "Source verification", [
    have("Source tier", `${source.tier} — ${source.basis}`),
    i.saleDateConfirmed
      ? have("Auction date confirmed", "Published by the county")
      : verify("Auction date confirmed", "Date projected from the state's typical schedule"),
    field("Auction time", i.startTime, "No start time on the sale notice"),
    field("Location", r?.auctionFormat, "No venue or format in county research"),
    have("Platform", i.platform ?? "unrecorded"),
    field("Registration process", r?.auctionFormat, "Not verified against the county notice"),
    field("Deposit requirements", i.depositDeadline ?? r?.depositRules, "Not verified"),
    field("Payment deadlines", i.depositDeadline, "Not verified"),
    field("Sale type", i.saleType, "Not verified"),
    i.listingKind === "sale_list"
      ? have("Parcel list source", "Published sale list")
      : verify("Parcel list source", `Document is a ${i.listingKind} listing, not a sale list`),
    i.statute?.redemption
      ? have("Redemption rules", `${i.statute.redemption.maxDays} day window`)
      : i.statute
        ? have("Redemption rules", "No post-sale redemption in this state")
        : verify("Redemption rules", `No verified statutory parameters for ${i.state}`),
    Object.keys(i.offices).length > 0
      ? have("Official county contacts", `${Object.keys(i.offices).length} offices on file`)
      : verify("Official county contacts", "No directory entry for this county"),
  ]);

  // --- Three: county due diligence framework -------------------------------
  const three = component(3, "County due diligence", [
    field("Governing law", i.statute?.statute ?? r?.type, `No statute entry for ${i.state}`),
    field("Sale type", i.saleType, "No sale type"),
    i.statute
      ? have(
          "Redemption period",
          i.statute.redemption ? `${i.statute.redemption.maxDays} days` : "None post-sale",
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
    verify("Possession limitations", "Not modelled — needs county research"),
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
    p.withParcelNumber === p.total && p.total > 0
      ? have("Parcel verification", `${pct(p.withParcelNumber)}% carry a parcel number`)
      : verify("Parcel verification", `${pct(p.withParcelNumber)}% carry a parcel number`),
    p.withAssessed > 0
      ? have("Assessor records", `${pct(p.withAssessed)}% enriched`)
      : verify("Assessor records", "No parcel in this sale has an assessor record"),
    i.offices.gis
      ? have("GIS mapping", "County GIS link on file")
      : verify("GIS mapping", "No county GIS link"),
    p.withZoning > 0
      ? have("Zoning", `${pct(p.withZoning)}% carry a zoning code`)
      : verify("Zoning", "No zoning data on these parcels"),
    p.withGeo > 0
      ? have("Location / mapping", `${pct(p.withGeo)}% geocoded`)
      : verify("Location / mapping", "No coordinates on these parcels"),
    verify("Legal access and road frontage", "ATTOM returns frontage on a minority of parcels"),
    verify("Occupancy", "Absentee flag available where enriched; occupancy not confirmed"),
    verify("Physical condition", "Cannot be established without inspection"),
    absent("Code enforcement / demolition orders", "No source for this"),
    r?.survivingLiens
      ? have("Municipal liens", "County research records what survives")
      : verify("Municipal liens", "Lien survival not researched for this county"),
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
