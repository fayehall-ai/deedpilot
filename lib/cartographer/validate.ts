/**
 * Invariant checks for proposed statutory parameters.
 *
 * These figures are the inputs to a walk-away price a subscriber acts on, and
 * they are the only outputs in this system whose errors a user cannot see. A
 * wrong assessment ratio does not throw, does not look odd on the page, and does
 * not fail a test — it silently shifts every max bid in a state. Georgia
 * assesses at 40% of market value, so using 100% understates every Georgia
 * property by 2.5x and makes the whole state look like a catastrophic overpay.
 *
 * So: nothing here decides whether a number is *correct*. That needs a person
 * with the statute open. What these checks do is refuse the proposals that are
 * provably wrong or unsourced, so the human reviewing them spends their
 * attention on the judgement calls rather than on arithmetic and missing
 * citations.
 */

import type { SaleType } from "../atlas/types";

/** One proposed field with its own provenance. */
export interface FieldProvenance {
  /** URL the value was read from. */
  source: string;
  /** YYYY-MM the value was verified. */
  asOf: string;
  /** Verbatim supporting text, so a reviewer can check without re-fetching. */
  quote?: string;
}

/**
 * A drafted statutory record awaiting review.
 *
 * Deliberately not `StatuteParams`: a proposal is not a statute record until a
 * person promotes it, and giving it a different type stops it being assigned
 * into `STATUTE_PARAMS` by accident.
 */
export interface StatuteProposal {
  state: string;
  saleType: SaleType;
  redemption: {
    tiers: { throughDays: number; penalty: number }[];
    maxDays: number;
    extendedFor?: string;
  } | null;
  quietTitle: {
    typicalLow: number;
    typicalHigh: number;
    typicalMonths: number;
    required: boolean;
  };
  closingCosts: number;
  assessmentRatio: number;
  assessmentBasis: string;
  statute: string;
  asOf: string;
  sources: string[];
  caveats: string[];
  /** Per-field provenance. Keys are field paths, e.g. "assessmentRatio". */
  provenance: Record<string, FieldProvenance>;
  /** Model's own reasoning, kept for the reviewer. Never used as evidence. */
  notes?: string;
}

export type Severity = "error" | "warning";

export interface ValidationIssue {
  field: string;
  severity: Severity;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Fields with no citation — the reviewer's first stop. */
  uncited: string[];
}

/** Fields that must carry their own source, because each ages differently. */
const MUST_CITE = [
  "assessmentRatio",
  "redemption",
  "quietTitle",
  "closingCosts",
] as const;

/**
 * Plausible bands.
 *
 * Wide on purpose. These reject the impossible, not the surprising — a band
 * tight enough to catch a subtly wrong penalty rate would also reject the real
 * outliers, and an over-tight check that a drafter learns to route around is
 * worse than no check.
 */
const BANDS = {
  assessmentRatio: { min: 0.05, max: 1.0 },
  penalty: { min: 0.0, max: 1.0 },
  maxDays: { min: 0, max: 1826 }, // five years
  quietTitleLow: { min: 0, max: 50_000 },
  quietTitleHigh: { min: 0, max: 100_000 },
  quietTitleMonths: { min: 0, max: 60 },
  closingCosts: { min: 0, max: 10_000 },
};

function isYearMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * Validate a proposal.
 *
 * `ok` means "safe to put in front of a reviewer", never "safe to merge".
 */
export function validateProposal(p: StatuteProposal): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ field, severity: "error", message });
  const warn = (field: string, message: string) =>
    issues.push({ field, severity: "warning", message });

  if (!/^[A-Z]{2}$/.test(p.state)) err("state", "must be a 2-letter postal code");

  // --- assessment ratio: the most dangerous number in the file --------------
  const ar = p.assessmentRatio;
  if (!Number.isFinite(ar) || ar <= BANDS.assessmentRatio.min || ar > BANDS.assessmentRatio.max) {
    err(
      "assessmentRatio",
      `must be in (${BANDS.assessmentRatio.min}, ${BANDS.assessmentRatio.max}] — got ${ar}. ` +
        "This is a fraction of market value, not a percentage.",
    );
  }
  if (!p.assessmentBasis?.trim()) {
    err("assessmentBasis", "required — a bare ratio with no stated basis cannot be reviewed");
  }

  // --- redemption -----------------------------------------------------------
  if (p.redemption) {
    const { tiers, maxDays } = p.redemption;
    if (!tiers.length) {
      err("redemption.tiers", "a redemption period with no tiers cannot price a penalty");
    }
    let prevDays = -1;
    let prevPenalty = -1;
    for (const [i, t] of tiers.entries()) {
      if (t.throughDays <= prevDays) {
        err(`redemption.tiers[${i}]`, "tiers must be strictly increasing in throughDays");
      }
      if (t.penalty < prevPenalty) {
        err(
          `redemption.tiers[${i}]`,
          "penalty must not decrease in a later tier — redeeming later never costs the owner less",
        );
      }
      if (t.penalty < BANDS.penalty.min || t.penalty > BANDS.penalty.max) {
        err(
          `redemption.tiers[${i}].penalty`,
          `penalty ${t.penalty} outside [0, 1] — express as a fraction, not a percentage`,
        );
      }
      prevDays = t.throughDays;
      prevPenalty = t.penalty;
    }
    if (maxDays < prevDays) {
      err("redemption.maxDays", `maxDays ${maxDays} is shorter than the last tier (${prevDays})`);
    }
    if (maxDays > BANDS.maxDays.max) {
      err("redemption.maxDays", `${maxDays} exceeds ${BANDS.maxDays.max} days — verify the unit`);
    }
    if (p.saleType === "Tax Deed") {
      warn(
        "redemption",
        "a plain Tax Deed with a redemption period is unusual — confirm this is not a Redeemable Deed",
      );
    }
  } else if (p.saleType === "Tax Lien" || p.saleType === "Redeemable Deed") {
    err(
      "redemption",
      `${p.saleType} without a redemption period is contradictory — the redemption IS the instrument`,
    );
  }

  // --- quiet title ----------------------------------------------------------
  const qt = p.quietTitle;
  if (qt.typicalLow > qt.typicalHigh) {
    err("quietTitle", `typicalLow ${qt.typicalLow} exceeds typicalHigh ${qt.typicalHigh}`);
  }
  if (qt.typicalLow < BANDS.quietTitleLow.min || qt.typicalHigh > BANDS.quietTitleHigh.max) {
    err("quietTitle", "cost range outside plausible bounds — verify the unit is dollars");
  }
  if (qt.typicalMonths < BANDS.quietTitleMonths.min || qt.typicalMonths > BANDS.quietTitleMonths.max) {
    err("quietTitle.typicalMonths", `${qt.typicalMonths} outside 0-60 months`);
  }
  if (qt.required && qt.typicalHigh === 0) {
    err("quietTitle", "marked required but costs nothing — one of the two is wrong");
  }

  // --- closing costs --------------------------------------------------------
  if (p.closingCosts < BANDS.closingCosts.min || p.closingCosts > BANDS.closingCosts.max) {
    err("closingCosts", `${p.closingCosts} outside plausible bounds`);
  }

  // --- provenance -----------------------------------------------------------
  if (!isYearMonth(p.asOf)) err("asOf", "must be YYYY-MM");
  if (!p.statute?.trim()) err("statute", "a statutory citation is required");
  if (!p.sources.length) err("sources", "at least one source URL is required");

  const uncited: string[] = [];
  for (const field of MUST_CITE) {
    const prov = p.provenance[field];
    if (!prov?.source) {
      uncited.push(field);
      err(
        `provenance.${field}`,
        "no source — every field ages separately, so a single record-level citation is not enough",
      );
      continue;
    }
    if (!isYearMonth(prov.asOf)) {
      err(`provenance.${field}.asOf`, "must be YYYY-MM");
    }
    try {
      const u = new URL(prov.source);
      if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
      if (!/\.(gov|us)$/.test(u.hostname) && !/law|justia|casetext|legis/.test(u.hostname)) {
        warn(
          `provenance.${field}`,
          `cited from ${u.hostname} — prefer the state legislature or an official code publisher`,
        );
      }
    } catch {
      err(`provenance.${field}.source`, `not a valid URL: ${prov.source}`);
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    uncited,
  };
}

/** Render a proposal as reviewable TypeScript for the `STATUTE_PARAMS` map. */
export function renderProposal(p: StatuteProposal): string {
  const q = (s: string) => JSON.stringify(s);
  const cite = (field: string) => {
    const pr = p.provenance[field];
    return pr ? `      // ${field}: ${pr.source} (${pr.asOf})` : `      // ${field}: UNCITED`;
  };

  const redemption = p.redemption
    ? `{
      tiers: [
${p.redemption.tiers.map((t) => `        { throughDays: ${t.throughDays}, penalty: ${t.penalty} },`).join("\n")}
      ],
      maxDays: ${p.redemption.maxDays},${
        p.redemption.extendedFor ? `\n      extendedFor: ${q(p.redemption.extendedFor)},` : ""
      }
    }`
    : "null";

  return `  ${p.state}: {
    state: ${q(p.state)},
    saleType: ${q(p.saleType)},
${cite("redemption")}
    redemption: ${redemption},
${cite("quietTitle")}
    quietTitle: {
      typicalLow: ${p.quietTitle.typicalLow},
      typicalHigh: ${p.quietTitle.typicalHigh},
      typicalMonths: ${p.quietTitle.typicalMonths},
      required: ${p.quietTitle.required},
    },
${cite("closingCosts")}
    closingCosts: ${p.closingCosts},
${cite("assessmentRatio")}
    assessmentRatio: ${p.assessmentRatio},
    assessmentBasis: ${q(p.assessmentBasis)},
    statute: ${q(p.statute)},
    asOf: ${q(p.asOf)},
    sources: [
${p.sources.map((s) => `      ${q(s)},`).join("\n")}
    ],
    caveats: [
${p.caveats.map((c) => `      ${q(c)},`).join("\n")}
    ],
  },`;
}
