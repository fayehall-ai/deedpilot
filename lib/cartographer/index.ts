/**
 * Statute Cartographer — draft statutory parameters for review.
 *
 * `lib/deal/statute.ts` covers seven states. The atlas markets fifty plus DC, so
 * `compute_maxbid` returns `insufficient-data` everywhere else — including
 * Arkansas, Louisiana and New Mexico, which carry thousands of crawled lots
 * that cannot be priced. Closing that gap means authoring eight numbers per
 * state.
 *
 * Those numbers are the single most dangerous thing in this codebase. An
 * assessment ratio that is wrong by a factor of 2.5 does not throw, does not
 * look odd, and does not fail a test; it silently shifts every walk-away price
 * in a state, and the subscriber acting on it is the one who finds out. So this
 * module deliberately does not ship statute data. It:
 *
 *   1. drafts a proposal with per-field citations,
 *   2. rejects the provably wrong and the uncited in code,
 *   3. writes a reviewable file and opens a pull request,
 *
 * and stops. Nothing here writes to `STATUTE_PARAMS`, and a `StatuteProposal` is
 * intentionally not a `StatuteParams` so it cannot be assigned into the map by
 * accident. A person with the statute open promotes it, or does not.
 *
 * This is not ceremony. It is the one place in the system where the LLM-extracts
 * / code-judges split is insufficient, because code cannot judge whether 40% is
 * the right assessment ratio for Georgia — only whether it is a number between 0
 * and 1 that somebody cited.
 */

import { z } from "zod";
import { getStateRule, STATE_NAMES } from "../atlas";
import { STATUTE_PARAMS } from "../deal/statute";
import { runStructured } from "../ai/providers";
import {
  researchMarketPractice,
  validateMarketPractice,
  type MarketPracticeResult,
} from "./market-practice";
import {
  renderProposal,
  validateProposal,
  type StatuteProposal,
  type ValidationResult,
} from "./validate";

export * from "./validate";

/** States the deal engine can already price. */
export function coveredStates(): string[] {
  return Object.keys(STATUTE_PARAMS).sort();
}

/** States the atlas claims but the deal engine cannot price. */
export function uncoveredStates(): string[] {
  const covered = new Set(coveredStates());
  return Object.keys(STATE_NAMES)
    .filter((s) => !covered.has(s))
    .sort();
}

const ProposalSchema = z.object({
  saleType: z.enum(["Tax Lien", "Tax Deed", "Redeemable Deed", "Hybrid"]),
  redemption: z
    .object({
      tiers: z
        .array(
          z.object({
            throughDays: z.number().int().describe("Upper bound of this tier in days from sale."),
            penalty: z
              .number()
              .describe("Penalty as a FRACTION of the bid. 25% is 0.25, never 25."),
          }),
        )
        .min(1),
      maxDays: z.number().int().describe("Longest possible redemption window in days."),
      extendedFor: z.string().nullable().describe("Property classes getting the longer window."),
    })
    .nullable()
    .describe("Null only when the sale conveys clear title with no post-sale redemption."),
  quietTitle: z.object({
    typicalLow: z.number(),
    typicalHigh: z.number(),
    typicalMonths: z.number(),
    required: z.boolean(),
  }),
  closingCosts: z.number().describe("Recording, stamps, deed issuance — a rough fixed dollar cost."),
  assessmentRatio: z
    .number()
    .describe(
      "Assessed value as a FRACTION of fair market value. Georgia is 0.40, Michigan 0.50, Texas 1.00.",
    ),
  assessmentBasis: z.string().describe("How that ratio is set, in one sentence."),
  statute: z.string().describe("Statutory citation, e.g. 'Tex. Tax Code § 34.21'."),
  sources: z.array(z.string()).min(1),
  caveats: z.array(z.string()),
  provenance: z
    .array(
      z.object({
        field: z.enum(["assessmentRatio", "redemption", "quietTitle", "closingCosts"]),
        source: z.string().describe("URL this specific value was read from."),
        asOf: z.string().describe("YYYY-MM."),
        quote: z.string().nullable().describe("Verbatim supporting text where available."),
      }),
    )
    .describe("One entry per field. Each field ages separately and needs its own citation."),
  notes: z.string().nullable(),
  confidenceNote: z
    .string()
    .describe("State plainly what you are least sure about. This goes to a human reviewer."),
});

const SYSTEM = `You draft structured statutory parameters for a tax-sale deal calculator.

What you produce is REVIEWED BY A PERSON before it is used. It is not shipped
from your output. Your job is to give that reviewer an accurate draft with
citations they can check, not to sound confident.

Hard requirements:

1. Penalties and assessment ratios are FRACTIONS. 25% is 0.25. 40% is 0.40.
   Returning 25 or 40 is the single most likely way to make every price in a
   state wrong by two orders of magnitude.
2. Cite each of assessmentRatio, redemption, quietTitle and closingCosts to its
   OWN source URL. These facts come from different places and go stale at
   different rates, so one citation for the record is not enough.
3. Prefer the state legislature's own site or an official code publisher.
4. quietTitle costs and durations are market practice, not statute. Say so in
   caveats and cite the best source you have.
5. If you do not know a value, say so in confidenceNote and give your best
   estimate with a low-confidence caveat. Do NOT invent a citation. A fabricated
   source URL is worse than an admitted gap, because it survives review.
6. assessmentBasis must explain how the ratio is set, not just restate it.

Remember what these numbers do: assessmentRatio converts an assessed value into
a market value, and every walk-away price in the state is computed from it. A
ratio wrong by 2.5x makes an entire state look like a catastrophic overpay, and
nothing downstream will notice.`;

export interface DraftResult {
  state: string;
  proposal: StatuteProposal | null;
  validation: ValidationResult | null;
  confidenceNote?: string;
  model?: string;
  error?: string;
  /**
   * The searched pass over the fields no statute answers.
   *
   * Present unless it was skipped or failed. Kept alongside the proposal rather
   * than folded invisibly into it, because these figures are estimates and a
   * reviewer needs to see their confidence and sources without digging.
   */
  market?: MarketPracticeResult;
  marketProblems?: string[];
  marketError?: string;
}

export interface DraftOptions {
  /**
   * Skip the searched market-practice pass.
   *
   * Costs a paid searched call per state, so iterating on the statutory half —
   * which is one cheap structured call — should not pay for search each time.
   */
  skipMarket?: boolean;
}

/**
 * Draft a proposal for one state.
 *
 * Returns the validation result alongside, so a caller cannot use the proposal
 * without also having been handed the reasons not to.
 */
export async function draftState(state: string, opts: DraftOptions = {}): Promise<DraftResult> {
  const stateRule = getStateRule(state);
  const name = STATE_NAMES[state] ?? state;

  const context = stateRule
    ? `The rules atlas already records this prose for ${name}, researched separately.
Use it as a cross-check; contradict it only with a citation.

  type:       ${stateRule.type}
  redemption: ${stateRule.redemption}
  returns:    ${stateRule.returns}
  statute:    ${stateRule.statute}
  notes:      ${stateRule.notes}`
    : `No atlas prose exists for ${name}.`;

  try {
    const { data, model } = await runStructured({
      system: SYSTEM,
      prompt: `Draft the statutory parameters for ${name} (${state}).\n\n${context}`,
      schema: ProposalSchema,
      schemaName: "StatuteProposal",
      maxTokens: 3000,
    });

    const provenance: StatuteProposal["provenance"] = {};
    for (const entry of data.provenance) {
      provenance[entry.field] = {
        source: entry.source,
        asOf: entry.asOf,
        quote: entry.quote ?? undefined,
      };
    }

    const proposal: StatuteProposal = {
      state,
      saleType: data.saleType,
      redemption: data.redemption
        ? {
            tiers: data.redemption.tiers,
            maxDays: data.redemption.maxDays,
            extendedFor: data.redemption.extendedFor ?? undefined,
          }
        : null,
      quietTitle: data.quietTitle,
      closingCosts: data.closingCosts,
      assessmentRatio: data.assessmentRatio,
      assessmentBasis: data.assessmentBasis,
      statute: data.statute,
      asOf: new Date().toISOString().slice(0, 7),
      sources: data.sources,
      caveats: data.caveats,
      provenance,
      notes: data.notes ?? undefined,
    };

    /*
     * The searched pass runs after the statutory draft and overwrites its
     * quietTitle and closingCosts, because those two come out of the structured
     * call as recall — and recall on a market-practice number returns the value
     * seen most often, not this state's. Asked from memory for Arkansas it gave
     * the Texas/Georgia range; asked to search, it found published county fee
     * schedules and a closing cost an order of magnitude lower.
     *
     * A failure here degrades to the recalled figures rather than losing the
     * whole draft, and says so — the statutory half is the expensive part to
     * reproduce and is sound on its own.
     */
    let market: MarketPracticeResult | undefined;
    let marketProblems: string[] | undefined;
    let marketError: string | undefined;

    if (!opts.skipMarket) {
      try {
        market = await researchMarketPractice(state);
        marketProblems = validateMarketPractice(market.data);
        if (marketProblems.length === 0) {
          proposal.quietTitle = {
            typicalLow: market.data.quietTitle.low,
            typicalHigh: market.data.quietTitle.high,
            typicalMonths: market.data.quietTitle.months,
            required: proposal.quietTitle.required,
          };
          proposal.closingCosts = Math.round(
            (market.data.closingCosts.low + market.data.closingCosts.high) / 2,
          );
          proposal.auctionToMarketableMonths = market.data.quietTitle.auctionToMarketableMonths;
          // Provenance per field, so the reviewer can tell a searched estimate
          // from a statutory citation at a glance.
          const first = (u: string[]) => u[0] ?? "no source";
          const asOf = market.generatedAt.slice(0, 7);
          proposal.provenance.quietTitle = {
            source: first(market.data.quietTitle.sources),
            asOf,
            quote: `${market.data.quietTitle.confidence} estimate — ${market.data.quietTitle.basis}`,
          };
          proposal.provenance.closingCosts = {
            source: first(market.data.closingCosts.sources),
            asOf,
            quote: `${market.data.closingCosts.confidence} estimate — ${market.data.closingCosts.basis}`,
          };
          proposal.caveats = [
            ...proposal.caveats,
            `Quiet title and closing costs are searched market estimates (${market.data.quietTitle.confidence}), not statute. ${market.data.caveats.join(" ")}`,
            `Surviving liens — NOT priced into closingCosts: ${market.data.survivingLiens}`,
          ];
        }
      } catch (e) {
        marketError = e instanceof Error ? e.message : String(e);
      }
    }

    return {
      state,
      proposal,
      validation: validateProposal(proposal),
      confidenceNote: data.confidenceNote,
      model,
      market,
      marketProblems,
      marketError,
    };
  } catch (e) {
    return {
      state,
      proposal: null,
      validation: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Render a set of drafts as a review packet.
 *
 * Leads with what is wrong and what is uncited, because that is what a reviewer
 * should read first — the generated TypeScript is the least important part of
 * the document.
 */
export function renderReviewPacket(drafts: DraftResult[]): string {
  const lines: string[] = [
    "# Statute proposals — REVIEW REQUIRED",
    "",
    "Generated drafts. **Nothing here is in use.** Each entry must be checked",
    "against its cited statute before being moved into `lib/deal/statute.ts`.",
    "",
    "These numbers set the walk-away price. An assessment ratio wrong by 2.5x",
    "silently shifts every max bid in the state, fails no test, and reaches the",
    "subscriber before anyone notices. Read the citations.",
    "",
  ];

  for (const d of drafts) {
    lines.push(`## ${d.state}`, "");
    if (d.error || !d.proposal || !d.validation) {
      lines.push(`Drafting failed: ${d.error ?? "no proposal returned"}`, "");
      continue;
    }

    const { validation: v, proposal: p } = d;
    lines.push(
      v.ok
        ? "**Validation: passed** — safe to review, *not* safe to merge unchecked."
        : "**Validation: FAILED** — do not merge; the drafter produced a provably wrong record.",
      "",
    );

    if (v.issues.length) {
      lines.push("| Severity | Field | Issue |", "|---|---|---|");
      for (const i of v.issues) {
        lines.push(`| ${i.severity} | \`${i.field}\` | ${i.message} |`);
      }
      lines.push("");
    }
    if (v.uncited.length) {
      lines.push(`**Uncited fields:** ${v.uncited.map((f) => `\`${f}\``).join(", ")}`, "");
    }
    if (d.confidenceNote) {
      lines.push(`**Drafter's stated uncertainty:** ${d.confidenceNote}`, "");
    }

    lines.push("### Citations", "");
    lines.push("| Field | Source | asOf |", "|---|---|---|");
    for (const [field, prov] of Object.entries(p.provenance)) {
      lines.push(`| \`${field}\` | ${prov.source} | ${prov.asOf} |`);
    }
    lines.push("");

    lines.push("### Proposed entry", "", "```ts", renderProposal(p), "```", "");
  }

  return lines.join("\n");
}
