/*
 * No `server-only`, matching the rest of `lib/cartographer/`. This is a CLI pass
 * — the whole Cartographer is driven from a terminal, and the guard throws
 * under plain tsx.
 */
import { z } from "zod";
import { runSearched } from "../ai/providers";
import { STATE_NAMES } from "../atlas";

/**
 * The fields no statute can answer, researched against the live web.
 *
 * ## Why this exists as a separate pass
 *
 * The Cartographer's human gate is right for statutory facts: a person can open
 * `A.C.A. § 26-26-303` and check that Arkansas assesses at 20%. It is the wrong
 * gate for `quietTitle` and `closingCosts`, because **there is no statute to
 * check them against**. A reviewer "verifying" a quiet-title cost is guessing
 * too, unless they phone a title attorney. Demanding a citation for an
 * uncitable number blocks forever — the Arkansas proposal sat unmergeable from
 * 5 August on exactly this, while its statutory half was sound and measurable.
 *
 * ## Why searched, not recalled
 *
 * Asked from memory, a model returns the number it has seen most often. Prompted
 * for Arkansas quiet-title costs it produced $2,500–$5,000 — essentially the
 * Texas/Georgia range, and the direct opposite of the Arkansas proposal's own
 * reasoning that the 90-day contest bar should make it *cheaper*. Recall
 * regresses to the mean of everything it read; search returns what a named
 * source says about this state. Every figure here must carry a URL.
 *
 * ## Why the estimates lean expensive
 *
 * `compute_maxbid` subtracts `(typicalLow + typicalHigh) / 2` straight off the
 * walk-away price, so this number decides whether inventory exists at all: at
 * $1,500 it makes 7.5% of Arkansas parcels unbuyable, at $3,750 it makes 21%,
 * at $6,000 it makes 31%.
 *
 * The two errors are not symmetric. Understating means the engine recommends a
 * bid that loses money at the courthouse. Overstating means it skips a deal that
 * was fine. Only one of those costs a subscriber their capital, so where the
 * evidence is thin the instruction is to widen the range upward rather than
 * guess a midpoint.
 */

const SourcedRange = z.object({
  low: z.number().describe("Low end in whole US dollars"),
  high: z.number().describe("High end in whole US dollars"),
  sources: z
    .array(z.string())
    .describe("URLs actually read for this figure. A figure with no source is not usable."),
  basis: z
    .string()
    .describe("What the sources are — attorney fee page, bar survey, filing schedule, court rule"),
  confidence: z
    .enum(["sourced", "inferred", "unknown"])
    .describe(
      "'sourced' only when a named source states a dollar figure for THIS state; " +
        "'inferred' when reasoning from neighbouring states or partial data; " +
        "'unknown' when nothing usable was found",
    ),
});

const MarketPracticeSchema = z.object({
  quietTitle: SourcedRange.extend({
    months: z.number().describe("Typical calendar months from filing to marketable title"),
    monthsSources: z.array(z.string()).describe("URLs supporting the duration"),
  }),
  closingCosts: SourcedRange.describe(
    "Deed issuance, recording and transfer taxes only — a flat per-parcel fee. " +
      "NOT liens or assessments that survive the sale, which are a different thing.",
  ),
  survivingLiens: z
    .string()
    .describe(
      "What a purchaser inherits: municipal liens, improvement district assessments, mortgages. " +
        "Prose, with sources named inline. This is NOT folded into closingCosts.",
    ),
  caveats: z.array(z.string()).describe("What a reviewer should distrust about the above"),
});

export type MarketPractice = z.infer<typeof MarketPracticeSchema>;

const SYSTEM = `You research the cost of clearing title on tax-deed property for an
investment desk. You report only figures you have READ on a page you fetched
during this task, and you attach the URL to each one.

These numbers are subtracted directly from a bid a subscriber places at auction.
An understated quiet-title cost causes a real loss; an overstated one only skips
a deal. Where evidence is thin, widen the range upward and say the confidence is
'inferred' rather than guessing a tidy midpoint.

Never report a national or neighbouring-state figure as if it were this state's.
If you cannot find a state-specific figure, say so with confidence 'unknown' —
that is a usable answer, and a fabricated range is not.`;

export interface MarketPracticeResult {
  state: string;
  data: MarketPractice;
  citations: { url: string; title: string | null }[];
  searchCount: number;
  model: string;
  generatedAt: string;
}

export async function researchMarketPractice(state: string): Promise<MarketPracticeResult> {
  const name = STATE_NAMES[state] ?? state;

  const prompt = `Research the practical cost of obtaining marketable title after a tax deed
sale in ${name} (${state}), and the cost of closing such a purchase.

FIND, WITH A URL FOR EACH:

1. QUIET TITLE / CONFIRMATION ACTION — what a ${name} attorney charges to bring
   the action a tax-deed purchaser needs for marketable title, and how many
   months it takes end to end. Look at ${name} real-estate and title attorneys'
   published fee pages, bar association fee surveys, legal-aid cost guides, and
   court self-help pages. ${name}-specific figures only.

2. CLOSING COSTS — deed issuance fee charged by the selling authority, county
   recorder fees, and any documentary or transfer tax, for one parcel. County
   recorder fee schedules are published and are the best source.

3. WHAT SURVIVES THE SALE — municipal liens, improvement or special district
   assessments, mortgages, IRS liens. Report this as prose with sources, and do
   NOT add it to closing costs: a surviving lien is inherited debt that varies
   per parcel, not a flat fee, and pricing it as a fee hides an unknown.

RULES
- A figure with no URL is not a figure. Set confidence 'unknown' instead.
- Do not report a national average or a neighbouring state's number as this
  state's. Say 'unknown' and explain in caveats.
- Where the evidence is thin, widen the range upward. An understated cost makes
  this desk overbid; an overstated one only makes it pass.`;

  const result = await runSearched({
    system: SYSTEM,
    prompt,
    schema: MarketPracticeSchema,
    schemaName: "market_practice",
    operation: "cartographer",
    maxTokens: 32_000,
  });

  return {
    state,
    data: result.data,
    citations: result.citations,
    searchCount: result.searchCount,
    model: result.model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Problems that should stop these figures reaching a proposal.
 *
 * Deliberately refuses an unsourced number rather than accepting it with a
 * warning. The whole reason this pass exists is that an unsourced figure was
 * already available by asking a model from memory; if that were good enough, no
 * search would be needed.
 */
export function validateMarketPractice(m: MarketPractice): string[] {
  const errors: string[] = [];

  if (m.quietTitle.confidence === "sourced" && m.quietTitle.sources.length === 0) {
    errors.push("quietTitle claims to be sourced but carries no URL");
  }
  if (m.closingCosts.confidence === "sourced" && m.closingCosts.sources.length === 0) {
    errors.push("closingCosts claims to be sourced but carries no URL");
  }
  if (m.quietTitle.low > m.quietTitle.high) errors.push("quietTitle low exceeds high");
  if (m.closingCosts.low > m.closingCosts.high) errors.push("closingCosts low exceeds high");
  if (m.quietTitle.months < 0 || m.quietTitle.months > 60) {
    errors.push(`quietTitle months of ${m.quietTitle.months} is outside 0-60`);
  }
  /*
   * A surviving-lien answer folded into closing costs is the error worth
   * catching by name: it makes an unresolved risk look like a priced fee.
   */
  if (/improvement district|municipal lien|mortgage/i.test(m.closingCosts.basis)) {
    errors.push(
      "closingCosts basis mentions liens — surviving liens belong in survivingLiens, " +
        "not in a flat per-parcel fee",
    );
  }
  return errors;
}
