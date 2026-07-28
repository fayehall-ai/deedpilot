import "server-only";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  NoProviderAvailableError,
  runStructured,
  configuredProviders,
} from "./providers";
import type { DealResult } from "../deal/maxbid";
import type { ResolvedCountyRule } from "../atlas/types";
import type { Lot, Auction } from "../db/schema";

/**
 * The AI auction buddy's research half.
 *
 * Division of labour, deliberately strict: `lib/deal/maxbid.ts` computes every
 * number — max bid, costs, redemption yield — and this module explains them and
 * surfaces risk. The model is given the computed figures as facts and told not
 * to produce its own. A hallucinated walk-away price is the one output that
 * could directly cost a subscriber money at auction.
 *
 * Provider choice lives in `./providers` (Grok primary, Claude fallback) — this
 * module is provider-agnostic on purpose.
 */

const RiskFlagSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().describe("Short label, e.g. 'Federal tax lien survives'"),
  detail: z.string().describe("Two sentences on what it means and what it could cost"),
});

const BriefSchema = z.object({
  headline: z
    .string()
    .describe("One sentence: what this parcel is and whether it is worth pursuing"),
  riskFlags: z
    .array(RiskFlagSchema)
    .describe("Ordered most severe first. Empty only if there is genuinely nothing to flag."),
  dueDiligence: z
    .array(z.string())
    .describe("Specific, checkable actions before bidding — not generic advice"),
  unknowns: z
    .array(z.string())
    .describe("Material facts absent from the data that change the analysis if wrong"),
  narrative: z.string().describe("2-3 short paragraphs of markdown analysis"),
});

export type ParcelBrief = z.infer<typeof BriefSchema>;

export interface BriefInput {
  lot: Pick<
    Lot,
    | "parcelNumber"
    | "addressLine"
    | "city"
    | "zip"
    | "openingBid"
    | "assessedValue"
    | "landUse"
    | "acreage"
    | "buildingSqft"
    | "yearBuilt"
    | "ownerName"
    | "legalDescription"
  >;
  auction: Pick<Auction, "saleDate" | "saleType" | "platform">;
  rule: ResolvedCountyRule;
  deal: DealResult;
}

/**
 * Stable hash of everything that feeds the brief, so a cached analysis is
 * reused only when the inputs are genuinely identical. Changing your rehab
 * assumption produces a new brief rather than silently serving the old one.
 *
 * Deliberately excludes the model: which provider answered is an operational
 * detail, and a valid brief for these inputs stays valid if the chain fails
 * over. The producing model is recorded on the row instead.
 */
export function briefInputsHash(input: BriefInput): string {
  const material = {
    parcel: input.lot.parcelNumber,
    opening: input.lot.openingBid,
    assessed: input.lot.assessedValue,
    saleDate: input.auction.saleDate,
    fips: input.rule.county.fips,
    maxBid: input.deal.maxBid,
    totalCosts: input.deal.totalCosts,
    arv: input.deal.arv.value,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

const SYSTEM = `You write pre-auction risk briefs for tax deed and tax lien investors.

Your reader is about to bid real money, sight unseen, on a property they cannot
inspect. They need to know what could go wrong, not encouragement.

Hard rules:
- Every dollar figure in your output must come from the DEAL ANALYSIS block you
  are given. Never compute, estimate, or invent a price, a max bid, a value, or
  a cost. If a number is not in the data, say it is unknown.
- Distinguish what is verified for this specific county from what is a state
  default. The data marks this explicitly; carry that distinction through.
- Surface the boring, expensive risks: liens that survive the sale, redemption
  rights, quiet title cost and duration, occupancy, and access. These lose
  people money far more often than a bad valuation does.
- Say "unknown" freely. An honest gap is more useful than a confident guess.
- No hedging boilerplate, no "consult a professional" filler. The reader knows.
  Be specific to this parcel and this jurisdiction.`;

function buildPrompt(input: BriefInput): string {
  const { lot, auction, rule, deal } = input;
  const money = (v: unknown) =>
    v === null || v === undefined ? "unknown" : `$${Number(v).toLocaleString("en-US")}`;

  return `## PARCEL
County: ${rule.county.name} County, ${rule.county.stateName} (FIPS ${rule.county.fips})
Parcel number: ${lot.parcelNumber ?? "unknown"}
Address: ${lot.addressLine ?? "no street address published"}${lot.city ? `, ${lot.city}` : ""}${lot.zip ? ` ${lot.zip}` : ""}
Land use: ${lot.landUse ?? "unknown"}
Acreage: ${lot.acreage ?? "unknown"}
Building: ${lot.buildingSqft ? `${lot.buildingSqft} sqft` : "unknown"}${lot.yearBuilt ? `, built ${lot.yearBuilt}` : ""}
Owner of record: ${lot.ownerName ?? "unknown"}
Legal description: ${lot.legalDescription ?? "not published"}

## SALE
Date: ${auction.saleDate}
Type: ${auction.saleType}
Platform: ${auction.platform}
Opening bid: ${money(lot.openingBid)}
County assessed value: ${money(lot.assessedValue)}

## JURISDICTION RULES
Sale type: ${rule.type}
Redemption: ${rule.redemption}
Return if redeemed: ${rule.returns}
Statute: ${rule.statute}
Surviving liens: ${rule.survivingLiens ?? "NOT RESEARCHED for this county"}
Quiet title: ${rule.quietTitle ?? "NOT RESEARCHED for this county"}
Deposit rules: ${rule.depositRules ?? "unknown"}
County research status: ${
    rule.isStateDefault
      ? "NO county-specific research — everything above is the STATE DEFAULT and is unverified for this county"
      : `researched, last verified ${rule.asOf ?? "date unknown"}`
  }
Fields inherited from state defaults rather than county research: ${
    rule.inherited.join(", ") || "none"
  }

## DEAL ANALYSIS (computed — these are the only figures you may cite)
After-repair value: ${money(deal.arv.value)} — ${deal.arv.basis}
Total costs: ${money(deal.totalCosts)}
Maximum bid: ${money(deal.maxBid)}
Projected profit at ceiling: ${money(deal.projectedProfit)}
Room between opening bid and ceiling: ${money(deal.bidRoom)}
Recommendation: ${deal.recommendation}
Confidence: ${deal.confidence}
Cost lines:
${deal.costs.map((c) => `  - ${c.label}: ${money(c.amount)}${c.assumed ? " (ASSUMED, not verified)" : ""} — ${c.note}`).join("\n")}
${
  deal.redemption
    ? `Redemption: ${(deal.redemption.flatPenalty * 100).toFixed(0)}% flat penalty, ${deal.redemption.windowDays}-day window. ${deal.redemption.note}`
    : "Redemption: none after sale."
}
Engine warnings:
${deal.warnings.map((w) => `  - ${w}`).join("\n") || "  (none)"}

Write the brief.`;
}

export class BriefUnavailableError extends Error {}

/**
 * Generate a parcel brief through the provider chain (Grok, then Claude).
 *
 * Throws `BriefUnavailableError` when no provider is configured or every leg
 * fails — callers render the deterministic deal analysis without a narrative
 * rather than failing the page.
 */
export async function generateBrief(
  input: BriefInput,
): Promise<{ brief: ParcelBrief; model: string; usedFallback: boolean }> {
  try {
    const result = await runStructured({
      system: SYSTEM,
      prompt: buildPrompt(input),
      schema: BriefSchema,
      schemaName: "parcel_brief",
      maxTokens: 16000,
    });
    return {
      brief: result.data,
      model: result.model,
      usedFallback: result.usedFallback,
    };
  } catch (e) {
    if (e instanceof NoProviderAvailableError) {
      throw new BriefUnavailableError(e.message);
    }
    throw e;
  }
}

/** Which providers are usable right now — surfaced on the coverage page. */
export { configuredProviders };
