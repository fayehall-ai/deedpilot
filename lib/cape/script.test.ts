/**
 * Narration verification assertions.
 * Run: npx tsx lib/cape/script.test.ts
 *
 * No network. This pins the check that stops a fabricated figure reaching
 * audio — the one output surface where a listener cannot see the source.
 */
import { verifyNarration, spokenToDigits, estimateDurationSec, type CapeScript } from "./script";

let failures = 0;
function check(name: string, cond: unknown, detail = "") {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const script = (narration: string): CapeScript => ({
  title: "Test County",
  keyTakeaway: "Verify before bidding.",
  sections: [
    {
      heading: "Body",
      narration,
      slide: { headline: "Test", bullets: [], figure: null, figureLabel: null },
    },
  ],
});

const FACTS = [
  "County: Cobb, GA",
  "Sale date: 2026-11-03 (confirmed by the county)",
  "[ON RECORD] Assessment ratio — 40%",
  "[ON RECORD] Redemption — 12 months",
  "[ON RECORD] Parcels on the list — 2825",
  "[ON RECORD] Quiet title cost — $5,000",
].join("\n");

// --- the figures that are supported ----------------------------------------
check(
  "a figure quoted from the facts passes",
  verifyNarration(script("The assessment ratio is 40 percent."), FACTS).length === 0,
);

/*
 * The narration is deliberately spoken, so it says "forty percent" where the
 * fact sheet says "40%". A check that could not reconcile those two would fire
 * on every script ever generated and would be switched off within a day.
 */
check(
  "a spoken figure reconciles with the written one",
  verifyNarration(script("The assessment ratio is forty percent."), FACTS).length === 0,
  JSON.stringify(verifyNarration(script("The assessment ratio is forty percent."), FACTS)),
);
check(
  "a spoken redemption period reconciles",
  verifyNarration(script("Owners have twelve months to redeem."), FACTS).length === 0,
);
check(
  "a large figure from the facts passes",
  verifyNarration(script("There are 2,825 parcels on the list."), FACTS).length === 0,
  JSON.stringify(verifyNarration(script("There are 2,825 parcels on the list."), FACTS)),
);
check(
  "a dollar figure from the facts passes",
  verifyNarration(script("Quiet title runs about $5,000."), FACTS).length === 0,
);

// --- the figures that must be caught ---------------------------------------
const invented = verifyNarration(script("Owners have 18 months to redeem."), FACTS);
check("an invented redemption period is caught", invented.includes("18"), JSON.stringify(invented));

const rate = verifyNarration(script("Expect a 25 percent penalty."), FACTS);
check("an invented penalty rate is caught", rate.includes("25"), JSON.stringify(rate));

const money = verifyNarration(script("Budget around $12,500 for clearing title."), FACTS);
check("an invented dollar amount is caught", money.includes("12500"), JSON.stringify(money));

const spokenInvented = verifyNarration(script("The ratio is ninety percent."), FACTS);
check(
  "an invented figure spoken as a word is still caught",
  spokenInvented.includes("90"),
  JSON.stringify(spokenInvented),
);

// --- what must NOT be flagged ----------------------------------------------
/*
 * Small counts are ordinary speech. Flagging "three things to check" would make
 * the check noisy, and a noisy safety check gets disabled — which is how they
 * fail in practice.
 */
check(
  "a small ordinal count is not flagged",
  verifyNarration(script("There are three things to check before you bid."), FACTS).length === 0,
  JSON.stringify(verifyNarration(script("There are three things to check before you bid."), FACTS)),
);
check(
  "counting to twelve is not flagged",
  verifyNarration(script("Step one, step two, step 10."), FACTS).length === 0,
);
check(
  "narration with no figures at all passes",
  verifyNarration(script("Read the deed and the plat before you bid."), FACTS).length === 0,
);

// Every section is checked, not just the first.
const multi: CapeScript = {
  ...script("The ratio is 40 percent."),
  sections: [
    { heading: "A", narration: "The ratio is 40 percent.", slide: { headline: "A", bullets: [], figure: null, figureLabel: null } },
    { heading: "B", narration: "Redemption runs 36 months.", slide: { headline: "B", bullets: [], figure: null, figureLabel: null } },
  ],
};
check(
  "a later section is checked too",
  verifyNarration(multi, FACTS).includes("36"),
  JSON.stringify(verifyNarration(multi, FACTS)),
);

// --- compound number words --------------------------------------------------
/*
 * These three are verbatim from the first real production run — a San Juan
 * County NM script that was correct and was held anyway, because the checker
 * substituted number words one at a time and split every compound.
 */
check("'forty-seven' reads as 47, not 40 and 7", spokenToDigits("forty-seven parcels") === "47 parcels", spokenToDigits("forty-seven parcels"));
check("'two thousand twenty-six' reads as 2026", spokenToDigits("august two thousand twenty-six") === "august 2026", spokenToDigits("august two thousand twenty-six"));
check("'sixty-four' reads as 64", spokenToDigits("u.s. sixty-four fringe") === "u.s. 64 fringe", spokenToDigits("u.s. sixty-four fringe"));
check("'one hundred percent' reads as 100", spokenToDigits("one hundred percent") === "100 percent", spokenToDigits("one hundred percent"));
check("a bare ten stays 10", spokenToDigits("ten") === "10");
check("'seventeenth' reads as 17", spokenToDigits("august seventeenth") === "august 17", spokenToDigits("august seventeenth"));
check("non-number words are untouched", spokenToDigits("the county tax sale") === "the county tax sale");

/*
 * Years spoken as pairs. "twenty twenty-six" summed to 46 on the second real
 * production run and held a correct script — the same class of bug as the
 * compound split, one level up.
 */
check("'twenty twenty-six' reads as 2026", spokenToDigits("august twenty twenty-six") === "august 2026", spokenToDigits("august twenty twenty-six"));
check("'nineteen ninety-nine' reads as 1999", spokenToDigits("nineteen ninety-nine") === "1999", spokenToDigits("nineteen ninety-nine"));
check("'twenty ten' reads as 2010", spokenToDigits("twenty ten") === "2010", spokenToDigits("twenty ten"));
/*
 * But a bare unit after a tens word is still a count, not a year — "twenty six
 * parcels" means 26, and reading it as 2006 would hide a wrong parcel count.
 */
check("'twenty six' still reads as 26", spokenToDigits("twenty six parcels") === "26 parcels", spokenToDigits("twenty six parcels"));
check("'forty seven' unhyphenated still reads as 47", spokenToDigits("forty seven") === "47", spokenToDigits("forty seven"));
check(
  "a large population reads correctly",
  spokenToDigits("one hundred twenty thousand eight hundred seventeen") === "120817",
  spokenToDigits("one hundred twenty thousand eight hundred seventeen"),
);

const SANJUAN = [
  "Sale date: 2026-08-17 (confirmed by the county)",
  "[have] Parcel list — 47 parcels",
  "[have] Parcel verification — 100% carry a parcel number",
  "[have] Submarkets — Bloomfield / US-64 fringe",
].join("\n");

check(
  "the real San Juan narration now passes",
  verifyNarration(
    script(
      "This covers the sale on August seventeenth, two thousand twenty-six. " +
        "The published sale list shows forty-seven parcels. One hundred percent carry a parcel number. " +
        "Submarkets include the Bloomfield U.S. sixty-four fringe.",
    ),
    SANJUAN,
  ).length === 0,
  JSON.stringify(
    verifyNarration(
      script(
        "This covers the sale on August seventeenth, two thousand twenty-six. " +
          "The published sale list shows forty-seven parcels. One hundred percent carry a parcel number. " +
          "Submarkets include the Bloomfield U.S. sixty-four fringe.",
      ),
      SANJUAN,
    ),
  ),
);

/*
 * The fix must not blunt the check: a compound that is genuinely wrong still
 * has to be caught. The sale is on the seventeenth; a script saying the
 * twenty-fourth is the error this whole module exists for.
 */
const wrongDate = verifyNarration(script("The sale is on August twenty-fourth."), SANJUAN);
check("a wrong compound date is still caught", wrongDate.includes("24"), JSON.stringify(wrongDate));
const wrongCount = verifyNarration(script("The list shows sixty-three parcels."), SANJUAN);
check("a wrong compound count is still caught", wrongCount.includes("63"), JSON.stringify(wrongCount));

// --- duration ---------------------------------------------------------------
const long = script(Array(300).fill("word").join(" "));
check(
  "300 words is about two minutes at 150 wpm",
  Math.abs(estimateDurationSec(long) - 120) <= 2,
  String(estimateDurationSec(long)),
);
check("an empty narration is zero seconds", estimateDurationSec(script("")) === 0, String(estimateDurationSec(script(""))));

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("cape/script: all assertions passed");
