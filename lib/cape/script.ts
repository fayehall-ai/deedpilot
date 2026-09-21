/*
 * Deliberately not marked `server-only`, matching `lib/ai/providers.ts` and
 * `lib/admin/queue.ts` rather than `lib/ai/brief.ts`. Script generation runs
 * from `scripts/cape-produce.ts` under plain tsx, outside any React server
 * context, where that guard throws on import — and `verifyNarration` is a pure
 * function that has to be testable without one.
 */
import { z } from "zod";
import { runStructured } from "@/lib/ai/providers";
import type { CapePackage } from "./components";

/**
 * CAPE Component Seven — the narration script and slide plan.
 *
 * ## The division this inherits
 *
 * `lib/deal/maxbid.ts` computes every number a subscriber acts on and
 * `lib/ai/brief.ts` explains those numbers without producing its own. This is
 * the same contract at county scope rather than parcel scope, and it matters
 * more here rather than less: a brief is read by one person who can see the
 * figures beside it, while a narration script becomes audio, and audio is
 * listened to by someone driving. There is no column of numbers next to a
 * voice. A fabricated redemption period in a video is a claim with no visible
 * source, repeated to everyone who takes the course.
 *
 * So the model receives the computed package as facts and is told, explicitly
 * and more than once, that every figure it may speak is already in the input.
 * `verifyNarration` then checks the output against those inputs and rejects a
 * script that introduces a number nobody computed.
 *
 * ## Why a slide plan rather than slides
 *
 * The model decides what each slide *says*; `lib/cape/slides.ts` decides what
 * it looks like. Letting a language model emit layout would put typography and
 * brand in a place nobody can review or diff, and would make every video
 * subtly different. Structure here, rendering there.
 *
 * ## What this deliberately does not do
 *
 * It does not read the sale list, name individual parcels, or recommend a bid.
 * A county video is an orientation to a sale — the rules, the dates, the risks,
 * what the inventory looks like in aggregate. Per-parcel advice belongs on the
 * parcel page where the numbers are visible and checkable.
 */

const SlideSchema = z.object({
  headline: z.string().describe("Six words or fewer. Appears large on the slide. Written notation, not spelled-out numbers."),
  bullets: z
    .array(z.string())
    .max(4)
    .describe("At most four, each under twelve words. Written notation — \"20%\", \"365 days\" — never spelled out. May be empty for a title slide."),
  /** One figure worth showing large, e.g. "20%" or "Nov 3". */
  figure: z.string().nullable().describe("A single short figure to display prominently, or null"),
  figureLabel: z.string().nullable().describe("What the figure means, e.g. 'assessment ratio'"),
});

const SectionSchema = z.object({
  heading: z.string().describe("Internal label for this section, not spoken"),
  narration: z
    .string()
    .describe(
      "What the narrator says. Plain spoken English, no markdown, no bullet characters, " +
        "no stage directions. Expand abbreviations: say 'twenty percent', not '20%'.",
    ),
  slide: SlideSchema,
});

/**
 * The county half: everything true of any sale this county holds under this
 * statute.
 *
 * Named fields rather than a free array, and that is deliberate. The assembled
 * script interleaves the two halves in a fixed order, and an array would make
 * the ordering a guess about what the model meant by each heading — which is
 * exactly the kind of inference that produces a briefing explaining redemption
 * before it has said what is being sold. Named slots make the running order a
 * property of the code.
 */
export const CountyHalfSchema = z.object({
  howItWorks: SectionSchema.describe(
    "How this sale type works in this state, naming the governing statute.",
  ),
  redemption: SectionSchema.describe(
    "Redemption: how long, what it costs the redeemer, and when it ends. If the state has no post-sale redemption, say so and what that means instead.",
  ),
  deedConveys: SectionSchema.describe(
    "What the deed conveys, and what curative work is still required after it.",
  ),
  submarkets: z
    .array(SectionSchema)
    .max(5)
    .describe(
      "One section for EACH submarket in the FACTS, in order. Name it, say what kind of place it is and what that implies for a bidder. Empty when the facts list none.",
    ),
});

/**
 * The sale half: everything that turns on which occasion this is.
 *
 * These five are regenerated for every sale, because every one of them names
 * the date, the time, the venue, the parcel count or the checks outstanding on
 * this particular notice.
 */
export const SaleHalfSchema = z.object({
  title: z.string().describe("Video title, e.g. 'Cobb County, Georgia — November 3 Tax Deed Sale'"),
  opening: SectionSchema.describe(
    "Open by naming the county, the state and the sale date.",
  ),
  beforeSaleDay: SectionSchema.describe(
    "Before sale day: registration, deposit, payment method and deadlines.",
  ),
  inventory: SectionSchema.describe(
    "The inventory in aggregate — how many parcels, and what the list gives a bidder to work from.",
  ),
  stillToVerify: SectionSchema.describe(
    "What still needs verifying with the county before anyone acts.",
  ),
  close: SectionSchema.describe("Close on the single most important point."),
  keyTakeaway: z.string().describe("One sentence"),
});

export type CountyHalf = z.infer<typeof CountyHalfSchema>;
export type SaleHalf = z.infer<typeof SaleHalfSchema>;

/**
 * Put the halves in running order.
 *
 * Opening, then what is being sold and on what terms, then how to turn up and
 * what is on offer, then the neighbourhoods, then the checks and the close. The
 * submarket sections sit after the inventory because they are about the parcels
 * a bidder has just been told exist.
 */
export function assembleScript(county: CountyHalf, sale: SaleHalf): CapeScript {
  return {
    title: sale.title,
    keyTakeaway: sale.keyTakeaway,
    sections: [
      sale.opening,
      county.howItWorks,
      county.redemption,
      county.deedConveys,
      sale.beforeSaleDay,
      sale.inventory,
      ...county.submarkets,
      sale.stillToVerify,
      sale.close,
    ],
  };
}

export const CapeScriptSchema = z.object({
  title: z.string().describe("Video title, e.g. 'Cobb County, Georgia — November 3 Tax Deed Sale'"),
  sections: z
    .array(SectionSchema)
    .min(8)
    .max(11)
    .describe(
      "Ordered. Opening, how the sale type works here, redemption and title, what the deed " +
        "conveys, before sale day, the inventory, one section per submarket on file, what " +
        "still needs verifying, and a close.",
    ),
  /** The one thing a viewer should remember. */
  keyTakeaway: z.string().describe("One sentence"),
});

export type CapeScript = z.infer<typeof CapeScriptSchema>;
export type CapeSection = z.infer<typeof SectionSchema>;

const SYSTEM = `You write narration for county tax-sale briefing videos for The Tax Deed Collective.

Your audience is a real-estate investor deciding whether to attend or bid at a specific county tax sale. They are competent adults, often first-time bidders, and they are going to act on what they hear.

ABSOLUTE RULE — NUMBERS.
Every figure you speak must already appear in the FACTS you are given. You may not compute, estimate, round differently, infer, or illustrate with a number that is not there. If a fact is missing, say plainly that it is not confirmed and must be verified with the county. Never invent a redemption period, an interest rate, a deposit percentage, a deadline, a parcel count, or a dollar amount. A wrong number in a video is repeated to every viewer and cannot be corrected by them.

WHAT NOT TO DO.
- No bid recommendations, no target prices, no "this is a good deal".
- Do not name or describe individual parcels.
- No hype, no urgency, no "don't miss out". This is a briefing, not a pitch.
- Do not claim the sale is verified if the facts say the date is projected.

VOICE.
Direct and calm. Short sentences. Spoken English — the NARRATION is read aloud, so expand symbols and abbreviations there: "twenty percent", "November third", "twelve months". No markdown, no lists, no stage directions, no speaker labels.\nSLIDE text is read, not spoken, so it uses ordinary written notation instead: "20%", "November 3", "12 months", "O.C.G.A. 48-4-40". Never spell a figure out on a slide.

Where a fact is marked as requiring verification, say so — as an instruction to the viewer, not as an inventory of what is missing. "Confirm the start time with the county before you register" is useful. "There is no start time in our file" is not: it describes us rather than the sale.

Never list what this briefing does not cover. If a subject is not in the FACTS, it does not exist for the purposes of this script — do not name it, do not say a source is unavailable for it, and do not gather several such subjects into a sentence about what was not collected.`;

/**
 * The facts, flattened for the prompt.
 *
 * Built from the computed package rather than from the database, so the script
 * can only ever describe what CAPE itself concluded — and so anything the
 * checklist marks `verify` reaches the narrator as unconfirmed rather than as
 * fact.
 */
export function factSheet(pkg: CapePackage, meta: CapeScriptMeta): string {
  const lines: string[] = [
    `County: ${meta.countyName ?? "unknown"}, ${meta.state ?? "unknown"}`,
    `Sale date: ${meta.saleDate}${meta.saleDateConfirmed ? " (confirmed by the county)" : " (PROJECTED — not confirmed by the county)"}`,
    `Sale type: ${meta.saleType ?? "unknown"}`,
    `Auction platform: ${meta.platform ?? "not recorded"}`,
    `Official source: ${pkg.source.tier} (${pkg.source.host || "no host"}) — ${pkg.source.basis}`,
    /*
     * The mode, not the due date.
     *
     * `deadline.dueDate` is when TDC must have the package finished — a fact
     * about this company's calendar and nothing to do with the sale. It reached
     * the Fulton narration as "The package is due September twenty-ninth,
     * twenty twenty-six, seven days before the sale" and onto a slide as
     * "Package due Sept 29, 2026", which a bidder can only read as a deadline
     * that applies to them. It does not. Whether the sale is live or online
     * does apply to them, so that half stays.
     */
    `Auction mode: ${pkg.deadline.mode === "live" ? "live, in person" : "online"}`,
    /*
     * Population, because the narrator kept reaching for it and inventing it.
     * "About one million ninety thousand residents" was held on a Fulton script
     * — a figure recalled from training rather than computed here, and exactly
     * what the guard exists to stop. It is real context for a briefing and we
     * already hold it, so the fix is to supply it rather than to forbid the
     * sentence.
     */
    ...(meta.population != null ? [`County population: ${meta.population.toLocaleString()}`] : []),
    "",
    "COMPONENT CHECKLIST — what is on record and what is not:",
  ];

  for (const c of pkg.components) {
    /*
     * One through Six are about the sale. Seven through Ten are about us.
     *
     * Seven is this very deliverable, Eight is TDC's production calendar, Nine
     * is the quality gate on the video being written, and Ten is the PropStream
     * export and the downstream automations. Every one of those was being
     * handed to the narrator as though it were a fact about the auction, which
     * is how "Export format — PropStream CSV, headers pending the TDC template"
     * came to sit in a fact sheet for a public briefing.
     *
     * The board still shows all ten and the score still averages all ten. The
     * cut is only about audience: a bidder is owed the sale, not our pipeline.
     */
    if (c.n >= 7) continue;
    /*
     * Within those six, two more kinds of line are dropped.
     *
     * `absent` is an item there was never going to be a source for — code
     * enforcement, IRS liens, HOA exposure, probate, environmental. Listing
     * them produced narration that catalogued what the briefing does not cover,
     * which tells a bidder nothing and makes the product sound thin.
     * `component()` already excludes them from its own denominator for the same
     * reason: they measure the product's scope, not this sale.
     *
     * `silent` is the subtler one, and it is why the Fulton recut still said
     * "Assessor records are not on file for parcels in this sale. No county GIS
     * link and no coordinates appear on these parcels. Zoning data is absent."
     * after the system prompt was told never to list what the briefing does not
     * cover. Those lines were `verify`, not `absent`, so they came through —
     * four consecutive statements about this database dressed as facts about a
     * county. An instruction in the prompt cannot outvote the evidence beneath
     * it. See `ComponentItem.silent`.
     *
     * What survives is the `verify` written as an instruction: confirm the
     * start time, read the payment deadline off the notice, inspect before
     * bidding. That is the most useful thing this system says, and it is the
     * only reason the state reaches the narrator at all.
     */
    const items = c.items.filter((i) => i.state !== "absent" && !i.silent);
    if (items.length === 0) continue;
    lines.push(`\n${c.n}. ${c.title}`);
    for (const item of items) {
      const mark = item.state === "have" ? "ON RECORD" : "NEEDS VERIFICATION";
      const detail = item.spoken ?? item.detail;
      lines.push(`   [${mark}] ${item.label}${detail ? ` — ${detail}` : ""}`);
    }
  }

  return lines.join("\n");
}

export interface CapeScriptMeta {
  countyName: string | null;
  state: string | null;
  saleDate: string;
  saleDateConfirmed: boolean;
  saleType: string | null;
  platform: string | null;
  countyFips?: string;
  /** Census population, so the narrator does not reach for it from memory. */
  population?: number | null;
}

export interface GeneratedScript {
  script: CapeScript;
  model: string;
  usedFallback: boolean;
  /** Numbers the model spoke that were not in the facts. Empty is the pass. */
  unsupportedFigures: string[];
  /** Slide bullets dropped by `stripAbsenceBullets`. Empty is the pass. */
  droppedBullets: string[];
  /**
   * Set when a freshly written county half named an occasion and was therefore
   * used but not cached. Null on the ordinary path, cached or not.
   */
  countyLeak?: string | null;
  /** Set when the script is about a different county than the facts. */
  countyMismatch?: string | null;
}

/*
 * The inputs hash lives in `components.ts` as `capeInputsHash`, not here.
 *
 * It is computed from `PackageInput` — the facts — rather than from the built
 * package, so that the checklist and the producer derive it from the same
 * place. Two hash functions over two representations of the same facts would
 * disagree eventually, and the disagreement would show up as artifacts that are
 * either never stale or always stale, both silently.
 */

/**
 * Numbers spoken in the narration that do not appear in the facts.
 *
 * ## Why this exists at all
 *
 * The system prompt forbids invented figures, and a model that follows
 * instructions almost always will. "Almost always" is the problem: this output
 * becomes audio, and audio is the one surface where a listener cannot see the
 * source. So the rule is enforced rather than requested.
 *
 * Written numbers are converted back to digits before comparison, because the
 * narration is deliberately spoken — a script that says "twenty percent" and a
 * fact sheet that says "20%" agree, and a naive string check would call that a
 * violation on every script.
 *
 * Small integers are ignored. "Three things to check before you bid" is
 * ordinary speech, not a claim about the sale, and flagging it would make the
 * check noisy enough to be switched off — which is how safety checks die.
 */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
  // Ordinals, because dates are spoken this way. "August twentieth" against a
  // sale on the seventeenth is exactly the error worth catching.
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60,
  seventieth: 70, eightieth: 80, ninetieth: 90,
};

const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/**
 * The ordinal spellings, which are in `UNITS` and `TENS` for their values but
 * must not behave like cardinals inside a run.
 *
 * English lets a cardinal keep accumulating — "two thousand twenty-six" is one
 * number — and an ordinal ends that. "Fourteenth two thousand twenty-six" is a
 * day followed by a year, never a single quantity, and reading it as one
 * produced 16026: fourteen and two summed to sixteen, scaled by the thousand
 * and topped with twenty-six. Every sale whose date falls on a day spoken with
 * "-th" was held as though the narrator had invented a figure — four of the
 * first six packages in a batch run, in four different states, all reporting
 * the same impossible number.
 */
const ORDINALS = new Set(
  [...Object.keys(UNITS), ...Object.keys(TENS)].filter((w) =>
    /(?:th|st|nd|rd)$/.test(w) && !/^(?:six|seven|eight|nine|ten)$/.test(w),
  ),
);

export const NUMBER_WORD = new RegExp(
  `\\b(?:${[...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALES), "and"].join("|")})\\b`,
  "g",
);

/**
 * Convert runs of spoken number words into digits.
 *
 * ## Why a parser and not a lookup table
 *
 * The first version substituted one word at a time, and it manufactured
 * figures that were never spoken. Run against a real San Juan County script it
 * reported three violations, all false:
 *
 *   "forty-seven parcels"        -> 40 and 7   (the facts say 47)
 *   "two thousand twenty-six"    -> 20         (the sale date is 2026)
 *   "U.S. sixty-four"            -> 60         (the submarket is US-64)
 *
 * Every one of those held a correct script back, and a check that blocks
 * correct work is a check somebody turns off. Numbers are spoken as compounds,
 * so they have to be read as compounds.
 */
export function spokenToDigits(
  text: string,
  /**
   * Called with every run this converts and what it became.
   *
   * So a caller can say which words produced a figure without reimplementing
   * the decision. Doing it by converting candidate phrases in isolation gets a
   * different answer, because several of the rules read the text *around* a run
   * — the citation cue looks at what precedes it — and an isolated phrase has
   * no around. Six of sixteen flagged scripts resolved to no phrase at all that
   * way.
   */
  onRun?: (original: string, converted: string) => void,
): string {
  /** Accumulate one cardinal, e.g. ["one","hundred","twenty"] -> 120. */
  const cardinal = (words: string[]): { value: number; sawNumber: boolean } => {
    let total = 0;
    let current = 0;
    let sawNumber = false;
    for (const w of words) {
      if (w in UNITS) {
        current += UNITS[w];
        sawNumber = true;
      } else if (w in TENS) {
        current += TENS[w];
        sawNumber = true;
      } else if (w in SCALES) {
        const scale = SCALES[w];
        if (scale === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * scale;
          current = 0;
        }
        sawNumber = true;
      }
    }
    return { value: total + current, sawNumber };
  };

  const convertRun = (run: string): string => {
      const lower = run.toLowerCase();

      /*
       * `point` or `dash` inside a run means this is a citation, not a
       * quantity: "chapter eighty-four point sixty-four" is RCW 84.64 and
       * "forty-eight dash four dash forty" is O.C.G.A. 48-4-40. Left as words,
       * so no figure is read from them at all.
       *
       * The trade, stated plainly: a spoken decimal quantity — "twenty point
       * five percent" — is no longer verified either. These briefings speak
       * percentages as whole numbers, and the alternative was flagging every
       * statute this system cites as a fabricated number.
       */
      /*
       * `oh` belongs with `point` and `dash`: it is how a person reads out an
       * identifier digit by digit, never how they say a quantity. Nobody says
       * "thirty-four oh four" meaning a number — they are reading 3404 off a
       * sign. It appears here in street addresses imported from the sale
       * calendar ("thirty-four oh four Linwood Drive"), in statute citations
       * ("sixty-seven five twenty-seven oh one") and in phone numbers, and in
       * each case the parser was taking a fragment of it as a figure the
       * narrator had invented.
       */
      if (/\b(?:point|dash|oh)\b/.test(lower)) return run;
      /*
       * Space-separated groups are kept distinct from hyphenated ones, because
       * the difference is what distinguishes a year from a count.
       *
       *   "twenty-six"        one group   ->  26
       *   "twenty twenty-six" two groups  ->  2026
       *
       * Summing straight through gave 46 for the second — a real false positive
       * on a real script, since "twenty twenty-six" is how a narrator says the
       * year the sale is in.
       */
      const groups = lower
        .replace(/,/g, " ")
        .split(/\s+/)
        .map((g) => g.split(/-+/).filter((w) => w && w !== "and"))
        .filter((g) => g.length > 0);

      const flat = groups.flat();
      if (flat.length === 0) return run;

      const hasScale = flat.some((w) => w in SCALES);

      if (!hasScale && groups.length === 2) {
        const a = cardinal(groups[0]);
        const b = cardinal(groups[1]);
        /*
         * A spoken year: a century word followed by a two-digit remainder.
         * "twenty twenty-six" and "nineteen ninety-nine" qualify; "twenty six"
         * does not, because its second group is a bare unit and that phrasing
         * means twenty-six.
         */
        const yearish =
          (a.value === 19 || a.value === 20) && b.value >= 10 && b.value <= 99;
        if (yearish) return String(a.value * 100 + b.value);
      }

      /*
       * A spoken cardinal descends. "twenty six" is 26 and "forty seven" is
       * 47, because a unit may follow a ten — but nothing in English puts a
       * ten after a ten, or repeats a unit, and means a single number by it.
       * What does that is an identifier read out group by group.
       *
       * Without this the parser summed them into figures nobody said, and
       * because those figures were absent from the facts the script was held
       * as though the model had invented a number. Measured on the five held
       * packages, every one:
       *
       *   "seven seven zero" (a phone number)        -> 14
       *   "five two eight"                           -> 15
       *   "twenty-six thirty-seven two hundred two"  -> 6502  (A.C.A. 26-37-202)
       *   "one ninety-seven" (Fla. Stat. ch. 197)    -> 98
       *
       * Scales are what license a second group: in "two hundred twelve" the
       * twelve follows `hundred`, so it is part of one cardinal and the check
       * does not apply to it.
       */
      /*
       * Three or more bare single digits in a row is somebody reading out a
       * number, not saying one.
       *
       * The descending rule below was meant to catch this and only half does:
       * "seven seven zero" repeats and is rejected, but "eight six three"
       * descends cleanly and was summed to 17. Those are area codes — 863 for
       * Highlands County, 765 for Boone and Delaware in Indiana — spoken the way
       * a phone number is spoken, and each one held a perfectly good script.
       *
       * No quantity in this narration is said as loose digits. A count is "one
       * hundred forty-seven", a rate is "twenty percent", a period is "three
       * hundred sixty-five days" — every one of them carries a scale word or a
       * hyphen. A run of bare units carries neither, and that is the signal.
       */
      const bareDigits = groups.filter((g) => g.length === 1 && g[0] in UNITS && UNITS[g[0]] < 10);
      if (groups.length >= 3 && bareDigits.length === groups.length) return run;

      /*
       * English hyphenates at most two words inside one number.
       *
       * "twenty-six", "forty-five", "sixty-five" — a tens word and a unit, and
       * that is the whole of it. Three or more hyphenated parts is a citation
       * wearing a cardinal's punctuation: "twelve-fifty-one-fifty-five" is
       * S.C. Code 12-51-55 and was summed to 118, "twelve-fifty-one-one-thirty"
       * to 94.
       */
      if (groups.some((g) => g.filter((w) => w in UNITS || w in TENS || w in SCALES).length > 2)) {
        return run;
      }

      /*
       * Two adjacent groups of ten or more do not add up to anything.
       *
       * "Thirty-seven thirty-one" is California Revenue and Taxation Code 3731
       * and was summed to 68; "eighteen twelve" is Arkansas Code 18-12. English
       * licenses a second group only when it is a bare unit — "twenty six" for
       * 26, "forty seven" for 47 — or when a scale word joins them, as in "two
       * thousand twenty-six". A year is the one exception that looks like this,
       * and `yearish` above has already returned it.
       */
      if (
        !hasScale &&
        groups.length >= 2 &&
        groups.every((g) => cardinal(g).value >= 10)
      ) {
        return run;
      }

      /*
       * One number uses each scale word once.
       *
       * A cardinal descends through its scales — million, then thousand, then
       * hundred — so a scale that repeats with nothing larger around it is not
       * one number, it is a list of them. Two ways this appeared:
       *
       *   "seven hundred seventy-four and five hundred fifty-seven"  -> 77,957
       *   "two thousand, five thousand and ten thousand"             -> 17,000
       *
       * The first is a Louisiana statute read aloud; the parser scaled its
       * running total at the second hundred, turning 779 into 77,900 before
       * adding 57. The second is Columbiana's three deposit tiers, summed into a
       * figure nobody said and no source holds.
       *
       * The legitimate repeat has a larger scale in it — "one hundred thousand,
       * five hundred" says hundred twice and is a single number — which is
       * exactly what the test allows.
       */
      const order = ["hundred", "thousand", "million"];
      for (const [i, scale] of order.entries()) {
        const times = flat.filter((w) => w === scale).length;
        if (times <= 1) continue;
        const larger = order.slice(i + 1).some((w) => flat.includes(w));
        if (!larger) return run;
      }

      const descends = (vs: number[]) => vs.every((v, i) => i === 0 || v < vs[i - 1]);

      let segment: number[] = [];
      for (const g of groups) {
        if (g.some((w) => w in SCALES)) {
          // A scale closes the current stretch of bare groups and opens a new
          // one — check what it closed before discarding it.
          if (!descends(segment)) return run;
          segment = [];
          continue;
        }
        segment.push(cardinal(g).value);
      }
      if (!descends(segment)) return run;

      const { value, sawNumber } = cardinal(flat);
      return sawNumber ? String(value) : run;
  };

  const record = (original: string, converted: string) => {
    if (onRun && converted !== original) onRun(original, converted);
    return converted;
  };

  return text.replace(
    /*
     * A run of number words, allowing hyphens and spaces between them — and
     * `point` / `dash`, which are not number words but which join one into an
     * identifier. Matching them here is what lets the identifier be recognised
     * as a whole instead of being silently split into two innocent cardinals.
     */
    new RegExp(
      /*
       * A comma may sit inside a single spoken number, and must not end the run.
       *
       * "nine hundred seventy-eight thousand, six hundred forty-one" is one
       * figure — Bergen County's population, 978,641, and in the facts. Ending
       * the run at the comma split it into 978,000 and 641, neither of which
       * appears anywhere, so a correct script was held as though the narrator
       * had invented two numbers.
       */
      `(${NUMBER_WORD.source})(?:[\\s,-]+(?:point|dash|oh)?[\\s,-]*(${NUMBER_WORD.source}))*`,
      "g",
    ),
    (run, _a, _b, offset: number, whole: string) => {
      /*
       * A citation cue immediately before the run means it is an identifier.
       *
       * The `point`/`dash` rule already catches a citation spoken with its
       * punctuation — "forty-eight dash four dash forty" for O.C.G.A. 48-4-40.
       * It cannot catch one spoken as bare words, and most are: "Section
       * eighteen twelve six hundred nine" is Ark. Code 18-12-609 and summed to
       * 3609; "New Jersey Statutes Annotated fifty-four five" is N.J.S.A. 54:5
       * and summed to 59; "Section eleven ten" is RPTL 1110 and summed to 21.
       * Between them these accounted for most of a batch's held packages —
       * scripts whose text was correct and whose verdict was not.
       *
       * The cue has to be adjacent: a sentence that merely mentions a statute
       * somewhere and then states a real figure is still checked.
       */
      const before = whole.slice(Math.max(0, offset - 48), offset).toLowerCase();
      if (/\b(?:section|sections|chapter|chapters|article|articles|title|paragraph|subsection|annotated|code|statutes?|rule)\s*[.:§-]?\s*$/.test(before)) {
        return run;
      }

      /*
       * Cut the run after an ordinal that is not its last word, and read the
       * halves separately. See `ORDINALS`.
       *
       * Splitting rather than bailing out is what keeps the check useful: "14"
       * and "2026" are both then compared against the facts, so a narrator who
       * says the twentieth of a sale held on the fourteenth is still caught —
       * which the comment on the ordinal entries in `UNITS` says is the whole
       * reason they are there. Returning the run untouched would have bought
       * silence instead.
       */
      /*
       * A comma only stays inside the number when a scale word precedes it.
       *
       * "nine hundred seventy-eight thousand, six hundred forty-one" is one
       * figure and the comma is its thousands separator — the word before it is
       * `thousand`. "All five, one hundred percent, carry a parcel number" is
       * two figures and an appositive, and joining them produced 600 out of a
       * sentence that says five and a hundred per cent. English writes the
       * separator only after a scale, so that is the test.
       */
      {
        const tok = run.split(/([\s,-]+)/);
        for (let n = 1; n < tok.length; n += 2) {
          if (!tok[n].includes(",")) continue;
          const prev = tok[n - 1]?.toLowerCase().replace(/[^a-z]/g, "");
          /*
           * The part after the separator must be smaller than the scale before
           * it, because that is what a separator separates.
           *
           * "nine hundred seventy-eight thousand, six hundred forty-one" ends in
           * hundreds and continues a thousands number. "Two thousand, five
           * thousand and ten thousand" is a list of three deposit tiers, and
           * joining it summed them to 17,000 — a figure nobody said and no
           * source holds. A repeat of the same scale is a list; a smaller one
           * is a continuation.
           */
          if (prev && prev in SCALES) {
            const rest = tok.slice(n + 1).join("").toLowerCase();
            const nextScale = Math.max(
              0,
              ...Object.entries(SCALES)
                .filter(([w]) => new RegExp(`\\b${w}\\b`).test(rest))
                .map(([, v]) => v),
            );
            if (nextScale < SCALES[prev]) continue;
          }
          return (
            record(tok.slice(0, n).join(""), convertRun(tok.slice(0, n).join(""))) +
            tok[n] +
            record(tok.slice(n + 1).join(""), convertRun(tok.slice(n + 1).join("")))
          );
        }
      }

      /*
       * Split on commas as well as spaces and hyphens.
       *
       * The run may now span a comma, so a token taken on whitespace alone can
       * be "fifteenth," — which is not in `ORDINALS`, so the ordinal rule below
       * misses it and "September fifteenth, two thousand twenty-six" sums to
       * 17026. That is the same date fold as before, reintroduced by allowing
       * commas inside a number, and it held 110 correct scripts the moment the
       * two changes met. The tokenizer has to know about every separator the
       * matcher accepts.
       */
      const parts = run.split(/([\s,-]+)/);
      const words = parts.map((_, n) => n).filter((n) => n % 2 === 0 && parts[n]);
      const last = words[words.length - 1];
      for (const n of words) {
        if (n !== last && ORDINALS.has(parts[n].toLowerCase())) {
          return (
            record(parts.slice(0, n + 1).join(""), convertRun(parts.slice(0, n + 1).join(""))) +
            (parts[n + 1] ?? " ") +
            record(parts.slice(n + 2).join(""), convertRun(parts.slice(n + 2).join("")))
          );
        }
      }
      return record(run, convertRun(run));
    },
  );
}

/**
 * The words that produced a flagged figure.
 *
 * `verifyNarration` reports "480", and 480 appears nowhere in the script: the
 * narration says "four hundred eighty" and the figure is what the parser made
 * of it. A reviewer told a script speaks 480, searching for 480 and finding
 * nothing, has been handed an accusation they cannot check — which is worse
 * than not flagging it, because it costs them the time and teaches them to
 * distrust the flag.
 *
 * So the same matcher runs again and every run that converts to a wanted figure
 * is returned as it was written. The caller can then show a reviewer the actual
 * phrase.
 */
export function figurePhrases(text: string, figures: string[]): string[] {
  if (figures.length === 0) return [];
  const want = new Set(figures.map(String));
  const out = new Set<string>();

  /* Digits spoken as digits — rare in this narration, but free to catch. */
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    if (want.has(m[0].replace(/,/g, ""))) out.add(m[0]);
  }

  /*
   * The same pass the verifier made, listening to what it converted.
   *
   * `toLowerCase` because `verifyNarration` lowercases before converting and the
   * rules are case-sensitive; the phrase is then recovered from the original
   * text by position-independent match, which is enough for a highlight.
   */
  const lower = text.toLowerCase();
  const hits: string[] = [];
  spokenToDigits(lower, (original, converted) => {
    for (const f of want) {
      if (new RegExp(`(?<![\\d,.])${f}(?![\\d,.])`).test(converted)) {
        hits.push(original.trim());
        break;
      }
    }
  });

  /* Recover the original casing so the highlight matches what is displayed. */
  for (const h of hits) {
    const at = lower.indexOf(h);
    out.add(at >= 0 ? text.slice(at, at + h.length) : h);
  }
  return [...out];
}

export function verifyNarration(script: CapeScript, facts: string): string[] {
  const factDigits = new Set<string>();
  const factNumbers: number[] = [];

  for (const m of facts.matchAll(/\d[\d,.]*/g)) {
    const cleaned = m[0].replace(/[,.]+$/, "").replace(/,/g, "");
    factDigits.add(cleaned);
    // "08" in a date is the same claim as "8" in speech.
    factDigits.add(String(Number(cleaned)));
    /*
     * A price in the facts is one token; spoken, it is two.
     *
     * County research records "costs + recording (~$110.25)" and a narrator
     * says "one hundred ten dollars and twenty-five cents", which parses to 110
     * and 25. Neither is `110.25`, so a correctly quoted fee was reported as
     * invented. Both halves of a decimal are the same claim as the whole.
     */
    if (cleaned.includes(".")) {
      const [whole, frac] = cleaned.split(".");
      factDigits.add(whole);
      factDigits.add(String(Number(whole)));
      if (frac) factDigits.add(String(Number(frac)));
    }
    if (Number.isFinite(Number(cleaned))) factNumbers.push(Number(cleaned));
  }

  /*
   * Research writes "$2k/$5k/$10k"; a narrator cannot say "two kay".
   *
   * Columbiana's deposit tiers are recorded in that shorthand, so the facts hold
   * 2, 5 and 10 while the narration says two thousand, five thousand and ten
   * thousand — correctly, and every one was reported as unsupported.
   */
  for (const m of facts.matchAll(/(\d+(?:\.\d+)?)\s*([km])\b/gi)) {
    const scaled = Number(m[1]) * (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000);
    factDigits.add(String(scaled));
    factNumbers.push(scaled);
  }

  /**
   * Whether a spoken figure is a rounding of something in the facts.
   *
   * "A county of roughly six thousand people" against a population of 6,047, and
   * "about four hundred seventy-one thousand" against 471,240. Both are true,
   * both are hedged, and both were held. The prompt does tell the narrator not
   * to round — but a guard exists to catch fabrication, and a figure within one
   * per cent of a fact is not fabricated. A genuine invention is not that close
   * by accident: "about five hundred thousand" against 471,240 is six per cent
   * out and still caught. One per cent rather than a half because "roughly six
   * thousand people" against a population of 6,047 is eight tenths of a per
   * cent out, and is exactly the sentence this should allow.
   */
  const isRounding = (n: number) =>
    /0{2,}$/.test(String(n)) &&
    factNumbers.some((f) => f > 0 && Math.abs(f - n) / f <= 0.01);

  const unsupported: string[] = [];

  for (const section of script.sections) {
    const spoken = spokenToDigits(section.narration.toLowerCase());

    for (const m of spoken.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const raw = m[0].replace(/,/g, "");
      const n = Number(raw);
      /*
       * Ordinals and small counts are speech, not claims. Twelve is the
       * boundary because a twelve-month redemption period is a real fact that
       * must be supported, while "three risks" is not.
       */
      if (!Number.isFinite(n) || (n <= 12 && Number.isInteger(n))) continue;
      if (factDigits.has(raw)) continue;
      // Years are frequently spoken in dates the facts express differently.
      if (/^(19|20)\d{2}$/.test(raw) && facts.includes(raw)) continue;
      if (isRounding(n)) continue;
      /*
       * A place can be named after a number. Luzerne County contains the
       * borough of Forty Fort, and "Kingston and Forty Fort" was read as the
       * figure 40. Checked against the narration as written, because a proper
       * noun is only distinguishable by its capital — which the lowercasing
       * above has thrown away.
       */
      if (namesAPlace(section.narration, raw)) continue;
      unsupported.push(raw);
    }
  }

  return [...new Set(unsupported)];
}

/**
 * Whether the words behind a figure are a capitalised name rather than a number.
 *
 * Title Case mid-sentence, immediately followed by another capitalised word:
 * "Forty Fort", not "forty dollars". Deliberately narrow — a figure that opens a
 * sentence is capitalised too, so the following word has to be capitalised as
 * well for this to fire.
 */
function namesAPlace(narration: string, figure: string): boolean {
  for (const phrase of figurePhrases(narration, [figure])) {
    /*
     * Any capitalised number word in the run, not just the first.
     *
     * Two shapes, and neither is the opening word. Luzerne's run is "and Forty",
     * because the matcher treats "and" as part of it — testing the first word
     * finds a lowercase connective every time. Pasco's is "fourteen thousand two
     * hundred thirty-six Sixth", where a real figure runs straight into the
     * street's name and the capital is on the last word: 14,236 Sixth Street
     * became 14,242.
     *
     * So every number word in the run is considered, and one of them being Title
     * Case with another capitalised word after it is enough. The figure is
     * discarded whole, which is right — the run that produced it spans a name,
     * so the number it yielded was never said.
     */
    const at = narration.indexOf(phrase);
    if (at < 0) continue;

    for (const m of phrase.matchAll(/[A-Za-z][a-z-]*/g)) {
      const bare = m[0].toLowerCase().replace(/[^a-z]/g, "");
      if (!(bare in UNITS || bare in TENS || bare in SCALES)) continue;
      if (!/^[A-Z]/.test(m[0])) continue;
      /* Sentence-initial words are capitalised too, so require one after. */
      const rest = narration.slice(at + (m.index ?? 0) + m[0].length);
      const next = rest.match(/^\s+(\S+)/);
      if (next && /^[A-Z][a-z]/.test(next[1])) return true;
    }
  }
  return false;
}

/**
 * Phrases that turn a bullet into a statement about our file rather than the
 * sale.
 *
 * Deliberately narrow. Each pattern needs a negation *and* a record-ish noun,
 * because "No redemption after the sale" and "No deposit required" are facts
 * about the county worth showing, while "No GIS link" and "Assessor not in
 * file" are facts about us. A guard that caught every "no" would delete the
 * true ones.
 */
const ABSENCE_BULLET = [
  /\bnot (?:in|on) (?:file|record)\b/i,
  /\b(?:no|not)\s+(?:\w+\s+){0,3}(?:data|records?|link|layer|coverage|coordinates?|source|entry|listing)\b/i,
  /\b(?:unavailable|unverified|not verified|not researched|not collected|not modelled|not modeled)\b/i,
  /\b(?:assessor|gis|zoning|coordinates?|parcel numbers?|addresses)\b[^.]{0,24}\b(?:absent|missing|unknown|none)\b/i,
];

/**
 * Remove slide bullets that inventory what this system does not hold.
 *
 * The prompt has forbidden this since the last pass and the model did it
 * anyway: the Fulton recut shipped a slide reading "Assessor/GIS not in file".
 * `factSheet` no longer feeds the absences that produced it, which is the real
 * fix — but the same argument applies here as to `verifyNarration`. An
 * instruction in a prompt is a request; this is a guarantee, and the failure it
 * guards is a sentence in a published video that cannot be taken back.
 *
 * Bullets are dropped rather than the script rejected. A slide carrying three
 * bullets instead of four is a slide; a production that throws at the last step
 * because of one line of copy is an outage. What was dropped is returned so it
 * is visible rather than silent.
 */
export function stripAbsenceBullets(script: CapeScript): string[] {
  const dropped: string[] = [];
  for (const section of script.sections) {
    section.slide.bullets = section.slide.bullets.filter((b) => {
      if (!ABSENCE_BULLET.some((re) => re.test(b))) return true;
      dropped.push(b);
      return false;
    });
  }
  return dropped;
}

/*
 * The shared length budget, split between the halves.
 *
 * Still 850–950 spoken words for the finished briefing, because that is five
 * minutes at 180 wpm and five minutes is what gets watched. The split is by
 * section count rather than by a second word figure, so the two prompts cannot
 * quietly drift into commissioning eleven minutes between them.
 */
const WORDS_PER_SECTION = "EIGHTY TO NINETY WORDS";

const DEPTH =
  `Go deeper rather than wider: explain the mechanism behind each fact, what it means ` +
  `for a bidder's money and timeline, and what the consequence is of getting it wrong. ` +
  `A section that states a fact and stops is too short. Never pad by repeating a fact ` +
  `you have already given.\n\n`;

/**
 * Anything in a county half that ties it to one occasion.
 *
 * The prompt forbids all of this twice over and the sampled halves obeyed, but
 * the consequence of one slipping through is not proportional to how rarely it
 * happens: a county half is reused for every future sale in the county, so a
 * date that leaks into the redemption section is spoken confidently in
 * nineteen Monmouth videos, eighteen of them produced weeks after anyone read
 * this one, all naming a sale that already happened.
 *
 * `verifyNarration` cannot catch it. A leaked sale date is not an invented
 * number — it is in the facts, correctly, for the sale that commissioned the
 * half. It only becomes a lie on reuse, which is after every check has passed.
 */
const MONTH =
  "january|february|march|april|may|june|july|august|september|october|november|december";
/*
 * A day, spoken or written, so a month only counts as a date when one follows.
 *
 * "May" is a month and also the commonest modal verb in this whole subject —
 * "the owner may redeem", "liens may be sold at a premium". Matching the bare
 * word rejected a clean half on its first test, and in production that failure
 * is silent and total: every county half naming a right the statute grants
 * would have been used once and never cached, leaving the split switched off
 * while appearing to work.
 */
const DAY =
  "\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|" +
  "eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|" +
  "twentieth|thirtieth|twenty-\\w+|thirty-first";

const OCCASION = [
  new RegExp(`\\b(?:${MONTH})\\s+(?:the\\s+)?(?:${DAY})\\b`, "i"),
  new RegExp(`\\b(?:${DAY})\\s+of\\s+(?:${MONTH})\\b`, "i"),
  /\b(?:19|20)\d{2}\b/,
  /\btwo thousand\b/i,
  /*
   * A time needs a colon, or a meridiem beside it.
   *
   * `\d{1,2}[.:]\d{2}` on its own reads a statute citation as a clock: "Wis.
   * Stat. 75.521" is 75.52, "RCW 84.64" is 84.64, and both were rejected — so
   * Wisconsin and Washington would have written a county half for every sale
   * and cached none of them, with the log insisting each one named an occasion.
   * The dotted form is only a time when something says so.
   */
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?\b/i,
  /\b(?:\d{1,2}|ten|eleven|twelve)\s*[ap]\.?m\.?\b/i,
  /\b(?:noon|midnight)\b/i,
  /\ba\.m\.|\bp\.m\.|\bo'clock\b/i,
  /\bthis (?:sale|auction)\b/i,
  /\b(?:sale day|upcoming sale|this coming|next month)\b/i,
];

/**
 * Whether this half is safe to keep, and what disqualified it if not.
 *
 * A leaked half is still correct for the sale that produced it, so it is used
 * and simply not cached — the cheapest possible handling of a rare event, and
 * it degrades to exactly the behaviour before the split rather than failing a
 * package over a turn of phrase.
 */
export function countyHalfLeak(half: CountyHalf): string | null {
  const sections = [half.howItWorks, half.redemption, half.deedConveys, ...half.submarkets];
  for (const sec of sections) {
    for (const text of [sec.narration, sec.slide.headline, ...sec.slide.bullets]) {
      const hit = OCCASION.find((re) => re.test(text));
      if (hit) return `[${sec.heading}] ${text}`;
    }
  }
  return null;
}

/**
 * Write the county half — the sections true of any sale this county holds.
 *
 * Kept free of the occasion on purpose, and the prompt says so twice, because
 * this text is reused verbatim for every future sale in the county. A date that
 * slips into the redemption section is not a small error: it is a wrong date
 * spoken confidently in nineteen videos, sixteen of which were produced weeks
 * after anyone read this one.
 */
export async function generateCountyHalf(
  pkg: CapePackage,
  meta: CapeScriptMeta,
  timeoutMs?: number,
  attempts?: number,
): Promise<{ half: CountyHalf; model: string; usedFallback: boolean; facts: string }> {
  const facts = factSheet(pkg, meta);
  const submarkets = pkg.components
    .find((c) => c.n === 6)
    ?.items.find((i) => i.label === "Submarkets identified" && i.state === "have")?.detail;

  const result = await runStructured({
    operation: "cape-script",
    countyFips: meta.countyFips,
    system: SYSTEM,
    schema: CountyHalfSchema,
    schemaName: "CountyHalf",
    maxTokens: 7000,
    timeoutMs,
    attempts,
    prompt:
      `Write the standing sections of the briefing for ${meta.countyName ?? "this county"}, ` +
      `${meta.state ?? "this state"} — the parts that are true of EVERY ${meta.saleType ?? "tax"} ` +
      `sale this county holds under this statute.\n\n` +
      `THIS TEXT IS REUSED FOR EVERY FUTURE SALE IN THIS COUNTY. Therefore:\n` +
      `  - Do NOT name a sale date, a start time, a venue, a parcel count, a registration\n` +
      `    deadline or a payment deadline. Not once, in narration or on a slide.\n` +
      `  - Do NOT say "this sale", "this auction", "on sale day" or "the upcoming sale".\n` +
      `    Write about how sales work here, not about an occasion.\n` +
      `  - Everything you write must stay true a year from now.\n\n` +
      `Sections, one each:\n` +
      `  - How this sale type works in this state, naming the governing statute.\n` +
      `  - Redemption: how long, what it costs the redeemer, and when it ends.\n` +
      `  - What the deed conveys, and what curative work is still required after it.\n` +
      `  - One section for EACH submarket in the facts, if any. Name it, and say what kind\n` +
      `    of place it is and what that implies for a bidder. These are the most useful\n` +
      `    sections in the briefing; do not compress several submarkets into one.\n` +
      (submarkets ? `    The submarkets are: ${submarkets}\n` : `    There are none on file — return an empty array.\n`) +
      `\nLENGTH — A HARD BUDGET. ${WORDS_PER_SECTION} per section and no more.\n\n` +
      DEPTH +
      `Every number you speak must appear in the FACTS below.\n\n` +
      `FACTS\n=====\n${facts}\n`,
  });

  return { half: result.data, model: result.model, usedFallback: result.usedFallback, facts };
}

/**
 * Write the sale half — the sections that turn on which occasion this is.
 *
 * The county half is passed in as context rather than regenerated, so the model
 * can see what has already been said and avoid explaining redemption twice. It
 * is explicitly marked as not-to-be-rewritten: the schema only accepts the five
 * sale sections back, and a model invited to improve on text it cannot return
 * spends its budget doing so.
 */
export async function generateSaleHalf(
  pkg: CapePackage,
  meta: CapeScriptMeta,
  county: CountyHalf,
  timeoutMs?: number,
  attempts?: number,
): Promise<{ half: SaleHalf; model: string; usedFallback: boolean; facts: string }> {
  const facts = factSheet(pkg, meta);

  const already = [county.howItWorks, county.redemption, county.deedConveys, ...county.submarkets]
    .map((s) => `  [${s.heading}] ${s.narration}`)
    .join("\n");

  const result = await runStructured({
    operation: "cape-script",
    countyFips: meta.countyFips,
    system: SYSTEM,
    schema: SaleHalfSchema,
    schemaName: "SaleHalf",
    maxTokens: 7000,
    timeoutMs,
    attempts,
    prompt:
      `Write the sale-specific sections of the briefing for the ${meta.saleDate} sale in ` +
      `${meta.countyName ?? "this county"}, ${meta.state ?? "this state"}.\n\n` +
      `Sections, one each:\n` +
      `  - Opening: name the county, the state and the sale date.\n` +
      `  - Before sale day: registration, deposit, payment method and deadlines.\n` +
      `  - The inventory in aggregate — how many parcels, and what the list gives a bidder\n` +
      `    to work from. Describe what is there. Do not account for what is not: no\n` +
      `    sentence may name a record, layer or field as missing.\n` +
      `  - What still needs verifying with the county before anyone acts.\n` +
      `  - Close on the single most important point.\n\n` +
      `LENGTH — A HARD BUDGET. ${WORDS_PER_SECTION} per section and no more.\n\n` +
      DEPTH +
      `ALREADY WRITTEN — these sections run between yours and are NOT yours to rewrite.\n` +
      `Do not repeat what they say; refer back to it in a clause if you must.\n` +
      `${already}\n\n` +
      `Every number you speak must appear in the FACTS below.\n\n` +
      `FACTS\n=====\n${facts}\n`,
  });

  return { half: result.data, model: result.model, usedFallback: result.usedFallback, facts };
}

/**
 * Whether the script is about the county it was commissioned for.
 *
 * A stored Lake County, Indiana script is titled "St. Joseph County, Indiana —
 * September 15 Tax Lien Sale" and narrates St. Joseph throughout: its
 * downtown, its university corridor, its treasurer. The facts said Lake. The
 * model substituted a neighbouring county it evidently knows better and wrote
 * eight confident sections about the wrong place.
 *
 * Nothing in the pipeline could see it. `verifyNarration` checks figures, and
 * a wrong county name is not a figure; the slide guard checks for absences, and
 * this asserts rather than omits. It is the most serious failure this system
 * can produce — a briefing that names the wrong courthouse — and it was the
 * cheapest to detect: the county's name is right there in the facts.
 *
 * Checked against the title and the opening only. A later section may
 * legitimately name a neighbouring county ("the Mishawaka corridor runs into
 * St. Joseph"), and flagging that would be noise. If the opening has it right,
 * the briefing is about the right place.
 */
export function countyMismatch(script: CapeScript, meta: CapeScriptMeta): string | null {
  const county = meta.countyName?.trim();
  if (!county) return null;

  /* "St. Lucie" is written "St Lucie" and "Saint Lucie" about equally often. */
  const canon = (t: string) =>
    t.toLowerCase().replace(/\bsaint\b/g, "st").replace(/[^a-z0-9]+/g, " ");
  const want = canon(county);
  const where = `${script.title}\n${script.sections[0]?.narration ?? ""}`;
  if (canon(where).includes(want)) return null;

  return `facts say ${county}, the script opens with "${script.title}"`;
}

/**
 * Write the script and slide plan for one auction package.
 *
 * Two calls rather than one, and the first is usually not made: see
 * `capeCountyScripts`. `loadCountyHalf` is injected rather than imported so this
 * module stays free of the database and `cape.test.ts` can still run it with no
 * connection.
 *
 * Throws `NoProviderAvailableError` when neither Grok nor Claude is configured,
 * rather than returning an empty script — an empty narration that renders into
 * a silent video is the failure nobody would think to question.
 */
export async function generateCapeScript(
  pkg: CapePackage,
  meta: CapeScriptMeta,
  opts: {
    /** Returns a cached county half, or null to write a fresh one. */
    loadCountyHalf?: () => Promise<CountyHalf | null>;
    /** Called with a freshly written half, for the caller to cache. */
    saveCountyHalf?: (half: CountyHalf, model: string) => Promise<void>;
    /**
     * Per-provider deadline, for callers that have one of their own.
     *
     * A scheduled function does. `runStructured` retries a timeout three times
     * with backoff, so the default four-minute deadline makes a single job's
     * worst case over twelve minutes — longer than any function may run, and
     * the job would be killed mid-write rather than failing cleanly. A shorter
     * deadline there keeps the worst case inside the slot.
     */
    timeoutMs?: number;
    /** Per-provider retry count. See `StructuredRequest.attempts`. */
    attempts?: number;
  } = {},
): Promise<GeneratedScript> {
  const cached = opts.loadCountyHalf ? await opts.loadCountyHalf() : null;

  let county: CountyHalf;
  let countyModel = "cached";
  let usedFallback = false;
  let countyLeak: string | null = null;

  if (cached) {
    county = cached;
  } else {
    const written = await generateCountyHalf(pkg, meta, opts.timeoutMs, opts.attempts);
    county = written.half;
    countyModel = written.model;
    usedFallback = written.usedFallback;

    /*
     * Cached only if it is reusable. See `countyHalfLeak` — a half naming this
     * sale's date is right for this sale and wrong for every later one, so it
     * is used here and thrown away rather than stored.
     */
    const leak = countyHalfLeak(county);
    if (leak) countyLeak = leak;
    else if (opts.saveCountyHalf) await opts.saveCountyHalf(county, written.model);
  }

  const sale = await generateSaleHalf(pkg, meta, county, opts.timeoutMs, opts.attempts);
  const script = assembleScript(county, sale.half);
  const facts = sale.facts;

  /* Mutates `script` in place, before anything reads the slide plan. */
  const droppedBullets = stripAbsenceBullets(script);

  return {
    script,
    /*
     * Both, because they can differ: a county half written by Grok in August
     * and a sale half written by Claude today is one script from two models,
     * and "which model wrote this" is the first question asked of a bad line.
     */
    model: `${countyModel}+${sale.model}`,
    usedFallback: usedFallback || sale.usedFallback,
    /*
     * Verified as assembled, against this sale's facts.
     *
     * A reused county half is re-checked on every sale it is reused for, which
     * is the point: if the statute entry changed, `capeCountyInputsHash` would
     * have replaced the half — but if something else moved a figure out from
     * under it, this is what catches it before the audio is bought.
     */
    unsupportedFigures: verifyNarration(script, facts),
    droppedBullets,
    countyLeak,
    countyMismatch: countyMismatch(script, meta),
  };
}

/** Roughly how long the narration runs, for the production calendar and slide timing. */
export function estimateDurationSec(script: CapeScript): number {
  const words = script.sections.reduce(
    (n, s) => n + s.narration.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  /*
   * 180 wpm, measured rather than assumed. This read 150 and the estimate ran
   * consistently long: a Fulton script of 744 words was predicted at 298s and
   * came back as 247s of ElevenLabs audio, which is 180.7 wpm. The constant
   * matters because it is what the length instruction in the prompt is sized
   * against — at 150 a five-minute brief was commissioned and four arrived.
   */
  return Math.round((words / 180) * 60);
}
