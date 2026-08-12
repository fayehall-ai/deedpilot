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
import type { CountyRule } from "@/lib/atlas/types";
import type { StatuteParams } from "@/lib/deal/statute";
import { classifySource, type SourceClassification } from "./sources";
import { productionDeadline, type ProductionDeadline } from "./deadline";

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
  const seven = component(7, "Education and video", [
    verify("Narration script", "Not produced"),
    verify("Narration audio", "Not produced"),
    verify("Slide plan", "Not produced"),
    verify("Final video", "Not produced"),
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
    verify("Narration accuracy", "No narration produced"),
    verify("Video formatting and audio", "No video produced"),
  ]);

  const components = [one, two, three, four, five, six, seven, eight, nine];

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
