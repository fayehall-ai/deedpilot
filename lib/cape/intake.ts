/**
 * CAPE Component One — auction intake.
 *
 * The workflow names the set a sale must be entered with: county, state,
 * auction date, sale type, official source, auction platform, registration
 * requirements, payment rules, and parcel-list availability. Its stated purpose
 * is not storage — every one of those already has somewhere to live here — but
 * knowing "which details still require verification".
 *
 * So this evaluates rather than records. Given an auction and its county
 * research, it says which of the nine are present, where each came from, and
 * what is outstanding.
 *
 * Two of the nine are populated on zero live auctions today: registration
 * requirements and payment rules. `auctions.registration_deadline` and
 * `deposit_deadline` exist and no adapter writes them, and `CountyRule.
 * depositRules` is the county-level fallback. That gap is the point of running
 * this — a checklist whose every box is already ticked would not be worth
 * building.
 */
import type { CountyRule } from "@/lib/atlas/types";
import { classifySource, type SourceClassification } from "./sources";

export interface IntakeInput {
  auctionId: string;
  countyFips: string | null;
  countyName: string | null;
  state: string | null;
  saleDate: string | null;
  saleDateConfirmed: boolean;
  saleType: string | null;
  sourceUrl: string | null;
  platform: string | null;
  registrationDeadline: string | Date | null;
  depositDeadline: string | Date | null;
  lotCount: number | null;
  listingKind: string | null;
  /** County research, where it exists. Absent is normal, not an error. */
  rule?: CountyRule | null;
}

export interface IntakeField {
  key: string;
  label: string;
  present: boolean;
  /** What was found, for display. Null when the field is outstanding. */
  value: string | null;
  /**
   * Where the value came from.
   *
   * `county-research` matters: a deposit rule inherited from the county profile
   * is weaker than one read off this sale's own notice, and a researcher
   * deciding what still needs checking has to be able to tell them apart.
   */
  from: "auction" | "county-research" | null;
}

export interface CapeAssessment {
  auctionId: string;
  source: SourceClassification;
  fields: IntakeField[];
  /** Keys of the fields still outstanding, in checklist order. */
  outstanding: string[];
  /** Share of the nine intake fields present, 0–1. */
  intakeScore: number;
  /**
   * Ready when intake is complete and the sale is on a county-published date.
   *
   * Deliberately not "score above a threshold". A parcel list under a date this
   * system projected is not investor-ready however many other boxes are ticked,
   * which is the same rule `listing_kind` + `sale_date_confirmed` already
   * enforce everywhere else.
   */
  ready: boolean;
  /** Why not ready, in one line, when it is not. */
  blockedBy: string | null;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s || null;
}

export function assessIntake(input: IntakeInput): CapeAssessment {
  const source = classifySource(input.sourceUrl);
  const rule = input.rule ?? null;

  const field = (
    key: string,
    label: string,
    fromAuction: unknown,
    fromCounty?: unknown,
  ): IntakeField => {
    const a = text(fromAuction);
    if (a !== null) return { key, label, present: true, value: a, from: "auction" };
    const c = text(fromCounty);
    if (c !== null) return { key, label, present: true, value: c, from: "county-research" };
    return { key, label, present: false, value: null, from: null };
  };

  const fields: IntakeField[] = [
    field("county", "County", input.countyName),
    field("state", "State", input.state),
    field("saleDate", "Auction date", input.saleDate),
    field("saleType", "Sale type", input.saleType, rule?.type),
    field("officialSource", "Official source", input.sourceUrl),
    field("platform", "Auction platform", input.platform, rule?.auctionPlatform?.label),
    field(
      "registration",
      "Registration requirements",
      input.registrationDeadline,
      rule?.auctionFormat,
    ),
    field("payment", "Payment rules", input.depositDeadline, rule?.depositRules),
    /*
     * Availability, not count. CAPE asks whether a parcel list exists to work
     * from; a sale with a published list of 3 parcels has satisfied intake,
     * while a calendar shell with none has not.
     */
    field(
      "parcelList",
      "Parcel list",
      input.lotCount && input.lotCount > 0 ? `${input.lotCount} parcels` : null,
    ),
  ];

  const outstanding = fields.filter((f) => !f.present).map((f) => f.key);
  const intakeScore = (fields.length - outstanding.length) / fields.length;

  let blockedBy: string | null = null;
  if (!input.saleDateConfirmed) {
    blockedBy = "Sale date is projected, not published by the county";
  } else if (input.listingKind !== "sale_list") {
    blockedBy = `Source document is a ${input.listingKind ?? "unknown"} listing, not a sale list`;
  } else if (outstanding.length > 0) {
    const labels = fields.filter((f) => !f.present).map((f) => f.label.toLowerCase());
    blockedBy = `Intake incomplete: ${labels.join(", ")}`;
  } else if (source.tier === "unverified") {
    blockedBy = "Source is not a recognised county office, statutory agent or contracted vendor";
  }

  return {
    auctionId: input.auctionId,
    source,
    fields,
    outstanding,
    intakeScore,
    ready: blockedBy === null,
    blockedBy,
  };
}

/** The nine intake keys, in checklist order. Exported so tests cannot drift. */
export const INTAKE_KEYS = [
  "county",
  "state",
  "saleDate",
  "saleType",
  "officialSource",
  "platform",
  "registration",
  "payment",
  "parcelList",
] as const;
