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

export const CapeScriptSchema = z.object({
  title: z.string().describe("Video title, e.g. 'Cobb County, Georgia — November 3 Tax Deed Sale'"),
  sections: z
    .array(SectionSchema)
    .min(4)
    .max(9)
    .describe("Ordered. Opening, the sale mechanics, the risks, the inventory, and a close."),
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

Where a fact is marked as requiring verification, say so in the narration. Telling a viewer what is not yet confirmed is the most useful thing this system does.`;

/**
 * The facts, flattened for the prompt.
 *
 * Built from the computed package rather than from the database, so the script
 * can only ever describe what CAPE itself concluded — and so anything the
 * checklist marks `verify` reaches the narrator as unconfirmed rather than as
 * fact.
 */
function factSheet(pkg: CapePackage, meta: CapeScriptMeta): string {
  const lines: string[] = [
    `County: ${meta.countyName ?? "unknown"}, ${meta.state ?? "unknown"}`,
    `Sale date: ${meta.saleDate}${meta.saleDateConfirmed ? " (confirmed by the county)" : " (PROJECTED — not confirmed by the county)"}`,
    `Sale type: ${meta.saleType ?? "unknown"}`,
    `Auction platform: ${meta.platform ?? "not recorded"}`,
    `Official source: ${pkg.source.tier} (${pkg.source.host || "no host"}) — ${pkg.source.basis}`,
    `Package due: ${pkg.deadline.dueDate} (${pkg.deadline.mode} auction)`,
    "",
    "COMPONENT CHECKLIST — what is on record and what is not:",
  ];

  for (const c of pkg.components) {
    // Seven describes this very deliverable; narrating its own absence is noise.
    if (c.n === 7) continue;
    lines.push(`\n${c.n}. ${c.title}`);
    for (const item of c.items) {
      const mark = item.state === "have" ? "ON RECORD" : item.state === "verify" ? "NEEDS VERIFICATION" : "NO SOURCE";
      lines.push(`   [${mark}] ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
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
}

export interface GeneratedScript {
  script: CapeScript;
  model: string;
  usedFallback: boolean;
  /** Numbers the model spoke that were not in the facts. Empty is the pass. */
  unsupportedFigures: string[];
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
export function spokenToDigits(text: string): string {
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

  return text.replace(
    /*
     * A run of number words, allowing hyphens and spaces between them — and
     * `point` / `dash`, which are not number words but which join one into an
     * identifier. Matching them here is what lets the identifier be recognised
     * as a whole instead of being silently split into two innocent cardinals.
     */
    new RegExp(
      `(${NUMBER_WORD.source})(?:[\\s-]+(?:point|dash)?[\\s-]*(${NUMBER_WORD.source}))*`,
      "g",
    ),
    (run) => {
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
      if (/\b(?:point|dash)\b/.test(lower)) return run;
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
    },
  );
}

export function verifyNarration(script: CapeScript, facts: string): string[] {
  const factDigits = new Set<string>();
  for (const m of facts.matchAll(/\d[\d,.]*/g)) {
    const cleaned = m[0].replace(/[,.]+$/, "").replace(/,/g, "");
    factDigits.add(cleaned);
    // "08" in a date is the same claim as "8" in speech.
    factDigits.add(String(Number(cleaned)));
  }

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
      unsupported.push(raw);
    }
  }

  return [...new Set(unsupported)];
}

/**
 * Write the script and slide plan for one auction package.
 *
 * Throws `NoProviderAvailableError` when neither Grok nor Claude is configured,
 * rather than returning an empty script — an empty narration that renders into
 * a silent video is the failure nobody would think to question.
 */
export async function generateCapeScript(
  pkg: CapePackage,
  meta: CapeScriptMeta,
): Promise<GeneratedScript> {
  const facts = factSheet(pkg, meta);

  const result = await runStructured({
    operation: "cape-script",
    countyFips: meta.countyFips,
    system: SYSTEM,
    schema: CapeScriptSchema,
    schemaName: "CapeScript",
    maxTokens: 4000,
    prompt:
      `Write the narration script and slide plan for the county auction briefing video.\n\n` +
      `Open by naming the county, the state and the sale date. Cover: how this sale type works ` +
      `in this state, redemption and title exposure, what a bidder must do before sale day ` +
      `(registration and deposit), what the inventory looks like, and what still needs ` +
      `verifying. Close on the single most important point.\n\n` +
      `Aim for four to nine sections and roughly two to four minutes of speech in total.\n\n` +
      `Every number you speak must appear in the FACTS below.\n\n` +
      `FACTS\n=====\n${facts}\n`,
  });

  return {
    script: result.data,
    model: result.model,
    usedFallback: result.usedFallback,
    unsupportedFigures: verifyNarration(result.data, facts),
  };
}

/** Roughly how long the narration runs, for the production calendar and slide timing. */
export function estimateDurationSec(script: CapeScript): number {
  const words = script.sections.reduce(
    (n, s) => n + s.narration.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  // ~150 wpm is a calm narration pace; ElevenLabs lands near this by default.
  return Math.round((words / 150) * 60);
}
