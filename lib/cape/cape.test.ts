/**
 * CAPE intake + source-verification assertions.
 * Run: npx tsx lib/cape/cape.test.ts
 *
 * No network, no database. Every host in the classification block is one we
 * actually ingest from today, so these are assertions about real sources rather
 * than invented ones.
 */
import { assessIntake, INTAKE_KEYS, type IntakeInput } from "./intake";
import { classifySource, TIER_RANK } from "./sources";
import { productionDeadline } from "./deadline";
import { buildPackage, redemptionWindow } from "./components";
import {
  assembleScript,
  verifyNarration,
  countyHalfLeak,
  countyMismatch,
  spokenToDigits,
  stripAbsenceBullets,
} from "./script";
import {
  csvField,
  exportFilename,
  PROPSTREAM_COLUMNS,
  qualifies,
  toPropStreamCsv,
  type PropStreamRow,
} from "./propstream";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- Component Two: source tiering -------------------------------------------

/*
 * The case the tiering exists for. `isGovernmentSource` in policy.ts asks
 * whether a host ends .gov/.us, which is right for crawl policy and wrong here:
 * cosl.org is a state agency carrying 6,063 of our parcels and reads as private
 * on a TLD test.
 */
assert(
  classifySource("https://cosl.org/Home/Buyers").tier === "government",
  "the Arkansas Commissioner of State Lands is government, .org notwithstanding",
);
// A county on a bare .org is recognised by name, not by pattern — see the note
// in sources.ts on why that shape is not inferred.
assert(
  classifySource("https://www.franklinmo.org/x").tier === "government",
  "Franklin County MO is listed explicitly",
);
assert(
  classifySource("https://calhounclerk.com/taxdeeds").tier === "government",
  "a clerk of court on .com is still a county office",
);
assert(
  classifySource("https://www.tax.newmexico.gov/x").tier === "government",
  "state agency on .gov",
);
assert(
  classifySource("https://www.brevardclerk.us/x").tier === "government",
  "county clerk on .us",
);

// Law firms publishing statutory notice are their own tier — authoritative,
// but not the county.
for (const u of ["https://taxsales.lgbs.com/a", "https://mvbalaw.com/b"]) {
  assert(classifySource(u).tier === "statutory_agent", `${u} is a statutory agent`);
}

for (const u of [
  "https://www.tax-sale.info/a",
  "https://sriservices.com/b",
  "https://liveauctions.govease.com/c",
]) {
  assert(classifySource(u).tier === "contracted_vendor", `${u} is a vendor`);
}

// Anything unrecognised is unverified, never assumed official.
assert(classifySource("https://random-listings.com/x").tier === "unverified", "unknown host");
assert(classifySource(null).tier === "unverified", "no URL at all");
assert(classifySource("not a url").tier === "unverified", "unparseable URL");

// A company merely *named* after a county is not a county office. The office
// word has to end the host, not appear in it.
assert(
  classifySource("https://jeffersoncountyabstract.com/x").tier === "unverified",
  "a title company with a county in its name is not an office",
);
// And an unlisted county .org stays unverified rather than being guessed at.
assert(
  classifySource("https://someothercountymo.org/x").tier === "unverified",
  "an unrecognised county-shaped .org is a prompt to look, not a verdict",
);

assert(
  TIER_RANK.government < TIER_RANK.statutory_agent &&
    TIER_RANK.statutory_agent < TIER_RANK.contracted_vendor &&
    TIER_RANK.contracted_vendor < TIER_RANK.unverified,
  "tiers rank by closeness to the legal authority for the sale",
);

// --- Component One: intake ---------------------------------------------------

const base: IntakeInput = {
  auctionId: "a1",
  countyFips: "05143",
  countyName: "Washington",
  state: "AR",
  saleDate: "2026-09-01",
  saleDateConfirmed: true,
  saleType: "Tax Deed",
  sourceUrl: "https://cosl.org/sale",
  platform: "county_site",
  registrationDeadline: "2026-08-25",
  depositDeadline: "2026-08-28",
  lotCount: 120,
  listingKind: "sale_list",
  rule: null,
};

const full = assessIntake(base);
assert(full.fields.length === INTAKE_KEYS.length, "all nine intake fields evaluated");
assert(
  full.fields.map((f) => f.key).join() === INTAKE_KEYS.join(),
  "and in the documented order",
);
assert(full.intakeScore === 1 && full.outstanding.length === 0, "complete intake scores 1");
assert(full.ready && full.blockedBy === null, "complete + confirmed + sale list is ready");

// The two fields no adapter populates today.
const noRegPay = assessIntake({ ...base, registrationDeadline: null, depositDeadline: null });
assert(
  noRegPay.outstanding.join() === "registration,payment",
  `registration and payment are the live gap, got ${noRegPay.outstanding.join()}`,
);
assert(!noRegPay.ready && /registration requirements, payment rules/.test(noRegPay.blockedBy ?? ""),
  `blocked reason names them: ${noRegPay.blockedBy}`);
assert(Math.round(noRegPay.intakeScore * 100) === 78, `7 of 9, got ${noRegPay.intakeScore}`);

// County research fills a gap, and the provenance says so — an inherited
// deposit rule is weaker than one read off this sale's own notice.
const fromCounty = assessIntake({
  ...base,
  depositDeadline: null,
  rule: { depositRules: "10% deposit due at the fall of the hammer" } as never,
});
const pay = fromCounty.fields.find((f) => f.key === "payment")!;
assert(pay.present && pay.from === "county-research", "county research fills payment rules");
const src = full.fields.find((f) => f.key === "payment")!;
assert(src.from === "auction", "a value on the auction itself is credited to the auction");

// --- readiness is not a score threshold --------------------------------------

// A projected date is disqualifying however complete the rest is.
const projected = assessIntake({ ...base, saleDateConfirmed: false });
assert(projected.intakeScore === 1, "intake can be complete");
assert(!projected.ready, "and the package still is not ready");
assert(/projected/.test(projected.blockedBy ?? ""), `says why: ${projected.blockedBy}`);

// So is a document that is not a sale list.
const roll = assessIntake({ ...base, listingKind: "delinquent_list" });
assert(!roll.ready && /delinquent_list/.test(roll.blockedBy ?? ""), "a roll is not a sale list");

// An unrecognised source blocks even a complete, confirmed sale list.
const shady = assessIntake({ ...base, sourceUrl: "https://random-listings.com/x" });
assert(!shady.ready && /not a recognised/.test(shady.blockedBy ?? ""), "unverified source blocks");

// A parcel list of zero is an absence, not a value.
const shell = assessIntake({ ...base, lotCount: 0 });
assert(shell.outstanding.includes("parcelList"), "a calendar shell has no parcel list");
const three = assessIntake({ ...base, lotCount: 3 });
assert(!three.outstanding.includes("parcelList"), "three parcels is a list; availability, not size");

console.log("cape: all assertions passed");

// --- Component Eight: production calendar ------------------------------------

/*
 * The Texas case that makes the rule concrete: sales are the first Tuesday of
 * the month, and 1 September 2026 carries seventeen of them. Every one of those
 * packages is due Monday 31 August.
 */
{
  const d = productionDeadline({ saleDate: "2026-09-01", platform: "lgbs", today: "2026-08-11" });
  assert(d.mode === "online", "a hosted sale is online");
  /*
   * 1 September 2026 is itself a Tuesday, so "Tuesday of the sale week" lands
   * on the sale day — no lead time at all, which the fallback rejects. Texas's
   * first-Tuesday online sales therefore land a full week ahead. That is the
   * schedule doing its job rather than an edge case working around it.
   */
  assert(d.dueDate === "2026-08-25", `falls back a week, got ${d.dueDate}`);
  assert(d.leadDays === 7, `a full week of lead, got ${d.leadDays}`);
}
{
  // A Thursday online sale gets the Tuesday of its own week.
  const d = productionDeadline({ saleDate: "2026-09-03", platform: "lgbs", today: "2026-08-11" });
  assert(d.dueDate === "2026-09-01", `Tuesday of the sale week, got ${d.dueDate}`);
  assert(d.leadDays === 2, `two days of lead, got ${d.leadDays}`);
}
{
  // Same sale conducted in person: Monday night, one day earlier.
  const d = productionDeadline({ saleDate: "2026-09-02", platform: "in_person", today: "2026-08-11" });
  assert(d.mode === "live", "in_person is live");
  assert(d.dueDate === "2026-08-31", `live is Monday of the sale week, got ${d.dueDate}`);
  assert(d.leadDays === 2, `lead days counted, got ${d.leadDays}`);
}

// A deadline on or after the sale is not a deadline — it falls back a week.
{
  const d = productionDeadline({ saleDate: "2026-08-31", platform: "in_person", today: "2026-08-11" });
  assert(d.dueDate === "2026-08-24", `Monday sale falls back a week, got ${d.dueDate}`);
  assert(d.leadDays === 7, "and gets a full week of lead");
}
{
  const d = productionDeadline({ saleDate: "2026-09-01", platform: "in_person", today: "2026-08-11" });
  assert(d.dueDate === "2026-08-31", "a Tuesday live sale is still Monday of that week");
}

// Sunday belongs to the previous ISO week. Reading it as day 0 would push the
// deadline to the day after the sale.
{
  const d = productionDeadline({ saleDate: "2026-09-06", platform: "lgbs", today: "2026-08-11" });
  assert(d.dueDate === "2026-09-01", `Sunday maps back to its own week, got ${d.dueDate}`);
  assert(d.dueDate < "2026-09-06", "and lands before the sale");
}

// Overdue is only meaningful while the sale is still ahead.
{
  const late = productionDeadline({ saleDate: "2026-08-14", platform: "lgbs", today: "2026-08-13" });
  assert(late.overdue && !late.salePassed, "past deadline, sale still coming → overdue");
  const done = productionDeadline({ saleDate: "2026-08-04", platform: "lgbs", today: "2026-08-13" });
  assert(!done.overdue && done.salePassed, "a finished sale is not overdue, it is finished");
}

// --- the nine-component package ----------------------------------------------

const pkgBase = {
  auctionId: "a1",
  countyName: "Washington",
  state: "AR",
  saleDate: "2026-09-01",
  saleDateConfirmed: true,
  saleType: "Tax Deed",
  sourceUrl: "https://cosl.org/sale",
  platform: "county_site",
  startTime: "10:00",
  registrationDeadline: "2026-08-25",
  depositDeadline: "2026-08-28",
  lotCount: 120,
  listingKind: "sale_list",
  rule: null,
  statute: null,
  offices: {},
  population: 250_000,
  parcels: { total: 120, withParcelNumber: 120, withAssessed: 60, withAddress: 40, withZoning: 0, withGeo: 12 },
  today: "2026-08-11",
};

const pkg = buildPackage(pkgBase as never);
assert(pkg.components.length === 10, `nine documented components plus the export, got ${pkg.components.length}`);
assert(
  pkg.components.map((c) => c.n).join() === "1,2,3,4,5,6,7,8,9,10",
  "numbered in the document's order",
);

// Component Ten gates on the population rule and reports both match keys.
const ten = pkg.components.find((c) => c.n === 10)!;
assert(ten.items[0].state === "have", "a 250k county clears the threshold");
const small = buildPackage({ ...pkgBase, population: 12_000 } as never);
assert(
  small.components.find((c) => c.n === 10)!.items[0].state === "verify",
  "a 12k county does not, and is flagged rather than silently exported",
);
assert(
  ten.items.filter((it) => it.state === "absent").length === 4,
  "the four downstream automations are external, not gaps to close here",
);

// Arkansas has no statute entry, so the package cannot be released however
// complete the intake is — the same blocker the AR proposal exists to remove.
assert(!pkg.releasable, "no statutory parameters blocks release");
assert(
  pkg.blockedBy.some((b) => /statutory parameters for AR/.test(b)),
  `and says so: ${pkg.blockedBy.join(" | ")}`,
);

// `absent` items are excluded from scoring — a package is not marked down for
// lacking an environmental report this product was never going to have.
const four = pkg.components.find((c) => c.n === 4)!;
assert(four.counts.absent >= 4, "property-level has genuinely unavailable items");
assert(four.score <= 1 && four.score >= 0, "and still scores in range");
const allAbsent = buildPackage({ ...pkgBase, parcels: { ...pkgBase.parcels } } as never);
assert(allAbsent.components.every((c) => c.score >= 0 && c.score <= 1), "every score is a fraction");

// The three-way split is the point: an unconfirmed deposit rule is a phone
// call, an environmental report is a vendor we do not have.
const states = new Set(pkg.components.flatMap((c) => c.items.map((i) => i.state)));
assert(states.has("have") && states.has("verify") && states.has("absent"),
  "all three item states occur");

// A projected date blocks release even with everything else in place.
const projectedPkg = buildPackage({ ...pkgBase, saleDateConfirmed: false } as never);
assert(
  projectedPkg.blockedBy.some((b) => /projected/.test(b)),
  "a projected date is a release blocker",
);

console.log("cape components: all assertions passed");

// --- Component Ten: PropStream export ----------------------------------------

// The document's threshold, and "more than" means more than.
assert(qualifies(50_001).qualifies, "above the bar");
assert(!qualifies(50_000).qualifies, "exactly 50,000 is not more than 50,000");
assert(!qualifies(49_999).qualifies, "below the bar");
/*
 * Unknown is not a pass. The Census table is missing precisely the smallest
 * counties, so treating unknown as qualifying would fill a list defined by
 * being large with the ones we could not measure.
 */
assert(!qualifies(null).qualifies, "unknown population does not qualify");
assert(/No population figure/.test(qualifies(null).reason), "and says why");
assert(/under the 50,000/.test(qualifies(1_000).reason), "the reason names the threshold");

// --- CSV correctness ---------------------------------------------------------

const row = (o: Partial<PropStreamRow> = {}): PropStreamRow => ({
  subjectProperty: "7410 SARNES RD",
  countyName: "Saline",
  auctionType: "Tax Deed",
  saleDate: "2026-09-01",
  openingBid: 2973,
  parcelNumber: "001-02194-000",
  addressLine: "7410 SARNES RD",
  cityStateZip: "MABELVALE, AR, 72103",
  taxesOwed: 2973,
  assessedValue: 19690,
  ownerName: "CASH, BILLY R & ROSIE N",
  buildingSqft: 1248,
  landUse: "SFR",
  yearBuilt: 1981,
  bedsBaths: "3/1",
  lotSize: "1.13 acres",
  lastSaleDate: "2017-11-17",
  arv: 98450,
  maxBid: 60153,
  arvBasis: "Provider market estimate",
  ...o,
});

const csv = toPropStreamCsv([row()]);
const lines = csv.split("\r\n");
/* The template's own labels, in its own order. */
assert(
  lines[0].startsWith("Subject Property,County,Auction Type,Auction Date,Opening Bid,APN#"),
  `header matches the TDC Property Info form, got ${lines[0]}`,
);
assert(lines[0].includes("After Rehab Value = ARV"), "the sheet's E8 label, verbatim");
assert(
  lines[0].includes("DeedPilot Max Bid"),
  "our max bid is a separate column, not the sheet's own cell",
);
assert(csv.endsWith("\r\n"), "CRLF line endings and a trailing newline, per RFC 4180");
assert(
  lines[0].split(",").length === PROPSTREAM_COLUMNS.length,
  "header column count matches the definition",
);

/*
 * The failure that makes an import look like garbage data rather than a
 * formatting bug: an unquoted comma shifts every later column on the row.
 * Owner names here carry commas as a matter of course.
 */
assert(
  lines[1].includes('"CASH, BILLY R & ROSIE N"'),
  `a comma-bearing field is quoted, got ${lines[1]}`,
);
assert(
  csvField('He said "hi"') === '"He said ""hi"""',
  "inner quotes are doubled",
);
assert(csvField("a\nb") === '"a\nb"', "newlines force quoting");
assert(csvField(null) === "" && csvField(undefined) === "", "null and undefined are empty");
assert(csvField(0) === "0", "zero is a value, not an absence");

// Formula injection: this file is opened in a spreadsheet by design.
assert(csvField("=1+1") === "'=1+1", "a leading = is defused");
assert(csvField("-0012-345") === "'-0012-345", "a parcel number is not a subtraction");
assert(csvField("@x") === "'@x" && csvField("+x") === "'+x", "@ and + too");

// A missing address must not shift the row — empty fields hold their position.
const sparse = toPropStreamCsv([
  row({ addressLine: null, cityStateZip: null, subjectProperty: "001-02194-000" }),
]).split("\r\n")[1];
assert(
  sparse.split(",").length >= PROPSTREAM_COLUMNS.length,
  `absent fields keep their columns, got ${sparse}`,
);
/* With no street line the subject falls back to the APN — the sheet's first
   field should never be blank. */
assert(sparse.startsWith("001-02194-000,Saline,Tax Deed,"), `APN-keyed row, got ${sparse}`);

/* An assumed floor must reach the spreadsheet labelled. A CSV strips every
   caveat the page carries, so the basis travels as its own column. */
const floored = toPropStreamCsv([row({ arvBasis: "ASSUMED FLOOR — not a valuation of this parcel" })]);
assert(/ASSUMED FLOOR/.test(floored), "the ARV basis survives into the file");

assert(
  exportFilename("St. Francis", "AR", "2026-09-01") === "st-francis-ar-2026-09-01-propstream.csv",
  `filename slug, got ${exportFilename("St. Francis", "AR", "2026-09-01")}`,
);

console.log("cape propstream: all assertions passed");

// ---------------------------------------------------------------------------
// What the narrator is allowed to hear
// ---------------------------------------------------------------------------
/*
 * Ed watched the Fulton recut and asked why a slide still read "Assessor/GIS
 * not in file" after the prompt had been told never to list what the briefing
 * does not cover. It read that way because the FACTS handed to the model were,
 * line by line, an inventory of absence — `verify` items whose whole content
 * was that this database holds nothing. An instruction in a prompt cannot
 * outvote the evidence beneath it, so both halves are asserted here: the
 * evidence no longer contains the absences, and a guard catches them anyway.
 */

/* The silent/audible split is structural, not a matter of wording. */
const two = pkg.components.find((c) => c.n === 2)!;
const four2 = pkg.components.find((c) => c.n === 4)!;

const item = (c: (typeof pkg.components)[number], label: string) =>
  c.items.find((i) => i.label === label)!;

/* Coverage absences are counted against the score and never spoken. */
for (const label of ["Assessor records", "GIS mapping", "Zoning", "Location / mapping"]) {
  const it = item(four2, label);
  if (it.state === "verify") {
    assert(it.silent === true, `${label} is silent when empty`);
  }
}
assert(
  four2.counts.verify > 0 && four2.score < 1,
  "silencing does not quietly improve the score",
);

/* Sale-day logistics are the exception: unconfirmed, but the viewer can act. */
const time = item(two, "Auction time");
if (time.state === "verify") {
  assert(!time.silent, "an unconfirmed start time still reaches the narrator");
  assert(
    /confirm/i.test(time.detail ?? "") && !/^no\b/i.test(time.detail ?? ""),
    `and does so as an instruction, got ${time.detail}`,
  );
}

/* The guard, against the bullets that actually shipped and ones that must not
   be swept up with them. "No post-sale redemption" is a fact about the county;
   "No county GIS link" is a fact about us. */
const slide = (b: string) =>
  ({
    title: "t",
    keyTakeaway: "k",
    sections: [
      { heading: "h", narration: "n", slide: { headline: "H", bullets: [b], figure: null, figureLabel: null } },
    ],
  }) as never;

for (const b of [
  "Assessor/GIS not in file",
  "No county GIS link",
  "No coordinates on parcels",
  "Zoning data absent",
  "Payment deadlines unverified",
  "Registration not verified",
  "Lien survival not researched",
  "Source unavailable",
]) {
  assert(stripAbsenceBullets(slide(b)).length === 1, `dropped: ${b}`);
}

for (const b of [
  "No post-sale redemption",
  "No clear title at hammer",
  "No deposit required",
  "No immediate control",
  "No barment before 365 days",
  "365 days + 20% first tier",
  "100% have parcel numbers",
  "Confirm start time",
  "Online auction",
]) {
  assert(stripAbsenceBullets(slide(b)).length === 0, `kept: ${b}`);
}

console.log("cape narration scope: all assertions passed");

// ---------------------------------------------------------------------------
// Spoken dates are two numbers, not one
// ---------------------------------------------------------------------------
/*
 * A batch run held four of its first six packages — Union IN, Jefferson IN,
 * Bath KY, Collier FL — every one reporting the same invented figure, 16026.
 * None of them had invented anything. "September fourteenth two thousand
 * twenty-six" was being read as a single cardinal: fourteen and two summed to
 * sixteen, scaled by the thousand, topped with twenty-six. Every sale falling
 * on a day spoken with "-th" was unproducible.
 */
for (const [spoken, want] of [
  ["september fourteenth two thousand twenty-six", "september 14 2026"],
  ["october sixth two thousand twenty-six", "october 6 2026"],
  ["november third two thousand twenty-six", "november 3 2026"],
  ["august twenty-first two thousand twenty-six", "august 21 2026"],
  /* An ordinal at the end of a run still reads as one number. */
  ["august twentieth", "august 20"],
  ["one hundred forty-seven parcels", "147 parcels"],
  /* And the earlier false positives stay fixed. */
  ["twenty twenty-six", "2026"],
  ["forty-eight dash four dash forty", "forty-eight dash four dash forty"],
  ["seven seven zero", "seven seven zero"],
  ["one million ninety thousand three hundred fifty-four", "1090354"],
] as const) {
  assert(spokenToDigits(spoken) === want, `${spoken} -> ${spokenToDigits(spoken)}, want ${want}`);
}

/*
 * A spoken statute citation is not a quantity, and neither half of a spoken
 * figure is a figure.
 *
 * These two between them held 82 of 454 packages in one batch — scripts whose
 * text was correct and whose verdict was not. The `point`/`dash` rule only
 * catches a citation spoken with its punctuation; most are spoken as bare
 * words, and a comma inside a number ended the run halfway through.
 */
for (const [spoken, want] of [
  /* Ark. Code 18-12-609, summed to 3609. */
  ["section eighteen twelve six hundred nine", "section eighteen twelve six hundred nine"],
  /* N.J.S.A. 54:5, summed to 59. */
  ["new jersey statutes annotated fifty-four five", "new jersey statutes annotated fifty-four five"],
  /* RPTL 1110, summed to 21. */
  ["sections eleven ten and eleven thirty-one", "sections eleven ten and eleven thirty-one"],
  /* Bergen's population, split at the comma into 978000 and 641. */
  ["nine hundred seventy-eight thousand, six hundred forty-one", "978641"],
  ["one million ninety thousand, three hundred fifty-four", "1090354"],
  /*
   * A comma joins a number only after a scale word. "All five, one hundred
   * percent, carry a parcel number" is two figures and an appositive; joining
   * them read 600 out of a sentence that says five and a hundred per cent.
   */
  ["all five, one hundred percent", "all 5, 100 percent"],
  ["every one of those ten, one hundred percent", "every 1 of those 10, 100 percent"],
  /* And the comma must not resurrect the date fold. */
  ["september fifteenth, two thousand twenty-six", "september 15, 2026"],
  ["october sixth, two thousand twenty-six", "october 6, 2026"],
  /*
   * "oh" is how a person reads an identifier off a sign, never how they say a
   * quantity: a venue address from the sale calendar, a statute, a phone
   * number. Fragments of each were being reported as invented figures.
   */
  ["thirty-four oh four linwood drive", "thirty-four oh four linwood drive"],
  ["sixty-seven five twenty-seven oh one", "sixty-seven five twenty-seven oh one"],
  /*
   * Three or more bare digits is somebody reading a number out. The descending
   * rule caught "seven seven zero" and missed "eight six three" — area codes,
   * spoken the way a phone number is, each holding a good script.
   */
  ["eight six three", "eight six three"],
  ["seven six five", "seven six five"],
  ["seven seven zero", "seven seven zero"],
  /*
   * English hyphenates at most two words inside one number — a tens word and a
   * unit. Three or more parts is a citation wearing a cardinal's punctuation:
   * S.C. Code 12-51-55 was summed to 118.
   */
  ["twelve-fifty-one-fifty-five", "twelve-fifty-one-fifty-five"],
  ["twelve-fifty-one-one-thirty", "twelve-fifty-one-one-thirty"],
  /*
   * Two adjacent groups of ten or more add up to nothing. "Thirty-seven
   * thirty-one" is Cal. Rev. & Tax. Code 3731, summed to 68. A second group is
   * licensed only when it is a bare unit ("twenty six") or a scale joins them.
   */
  ["thirty-seven thirty-one", "thirty-seven thirty-one"],
  ["eighteen twelve", "eighteen twelve"],
  ["twenty six", "26"],
  ["forty seven parcels", "47 parcels"],
  ["one hundred ten dollars", "110 dollars"],
  /*
   * One number has one `hundred` in it. "Seven hundred seventy-four and five
   * hundred fifty-seven" is two figures read out, folded into 77,957 by scaling
   * the running total at the second hundred. A larger scale between them is the
   * legitimate case.
   */
  ["seven hundred seventy-four and five hundred fifty-seven",
   "seven hundred seventy-four and five hundred fifty-seven"],
  ["one hundred thousand, five hundred", "100500"],
  ["two hundred thousand", "200000"],
  /*
   * One number uses each scale word once. A cardinal descends through its
   * scales, so a scale that repeats with nothing larger around it is a list:
   * Columbiana's three deposit tiers summed to 17,000, a Louisiana statute to
   * 77,957. The legitimate repeat has a larger scale in it.
   */
  ["seven hundred seventy-four and five hundred fifty-seven",
   "seven hundred seventy-four and five hundred fifty-seven"],
  ["two thousand, five thousand and ten thousand dollars",
   "2000, five thousand and ten thousand dollars"],
  ["one hundred thousand, five hundred", "100500"],
  ["two hundred thousand", "200000"],
  ["one million ninety thousand, three hundred fifty-four", "1090354"],
  /* A cue has to be adjacent — a real figure later in the passage still counts. */
  ["the statute applies. the deposit is four thousand dollars",
   "the statute applies. the deposit is 4000 dollars"],
] as const) {
  assert(spokenToDigits(spoken) === want, `${spoken} -> ${spokenToDigits(spoken)}, want ${want}`);
}

/*
 * What the verifier accepts as supported, beyond an exact digit match.
 *
 * All six figures still flagged after the citation work turned out to be
 * correctly spoken facts the verifier could not recognise in the form the
 * research records them.
 */
const vfacts = [
  "Payment rules — costs + recording (~$110.25) + 2% transfer tax + $25 deed prep",
  "Deposit requirements — RealAuction registration + $2k/$5k/$10k deposit tiers",
  "County population: 471,240",
].join("\n");

const narration = (text: string) =>
  ({ title: "t", keyTakeaway: "k",
     sections: [{ heading: "h", narration: text,
       slide: { headline: "H", bullets: [], figure: null, figureLabel: null } }] }) as never;

/* A price is one token in the facts and two when spoken. */
assert(
  verifyNarration(narration("Costs are one hundred ten dollars and twenty-five cents."), vfacts).length === 0,
  `110.25 spoken as two figures: ${verifyNarration(narration("Costs are one hundred ten dollars and twenty-five cents."), vfacts).join(", ")}`,
);

/* Research writes "$2k"; a narrator cannot say "two kay". */
assert(
  verifyNarration(narration("Deposit tiers are two thousand, five thousand and ten thousand dollars."), vfacts).length === 0,
  `k-notation: ${verifyNarration(narration("Deposit tiers are two thousand, five thousand and ten thousand dollars."), vfacts).join(", ")}`,
);

/* A hedged rounding of a fact is not a fabrication. */
assert(
  verifyNarration(narration("The county has about four hundred seventy-one thousand residents."), vfacts).length === 0,
  "a rounded population is supported",
);

/* But a figure that is merely round is not thereby supported. */
assert(
  verifyNarration(narration("The county has about five hundred thousand residents."), vfacts).length > 0,
  "a wrong round number is still caught",
);

/* A place named after a number is not a number. */
assert(
  verifyNarration(narration("Kingston and Forty Fort sit across the river."), vfacts).length === 0,
  "Forty Fort is a borough",
);
assert(
  verifyNarration(narration("The fee is forty dollars."), vfacts).length > 0,
  "but forty dollars is still a figure",
);

/*
 * The name can be the last word of the run, not the first. Pasco's payment
 * address ran straight into the street's own ordinal: 14,236 Sixth Street was
 * read as 14,242.
 */
assert(
  verifyNarration(
    narration("Cash is accepted at fourteen thousand two hundred thirty-six Sixth Street, Dade City."),
    vfacts,
  ).length === 0,
  "an address running into a street name is not a figure",
);

/* A hedged rounding under one per cent: 6,047 people spoken as six thousand. */
assert(
  verifyNarration(narration("A county of roughly six thousand people."), "County population: 6,047").length === 0,
  "6,047 spoken as roughly six thousand",
);

console.log("cape spoken numbers: all assertions passed");

// ---------------------------------------------------------------------------
// The county half must survive being reused
// ---------------------------------------------------------------------------
/*
 * Monmouth NJ holds nineteen sales in six weeks and every one regenerated the
 * statute, redemption, deed and submarket sections from scratch. Those are
 * written once per county now and reused verbatim — which means a sale date
 * that slips into one of them is not a typo in a script, it is a sale that
 * already happened being announced in eighteen later videos. `verifyNarration`
 * cannot catch that: on the day it is written the date is a supported fact.
 */
const sec = (heading: string, narration: string, bullets: string[] = []) => ({
  heading,
  narration,
  slide: { headline: "H", bullets, figure: null, figureLabel: null },
});

const cleanHalf = {
  howItWorks: sec("statute", "New Jersey municipalities sell tax liens under the Tax Sale Law."),
  redemption: sec("redemption", "The owner may redeem at any time until the lien is foreclosed."),
  deedConveys: sec("deed", "A certificate is not a deed. Foreclosure is a separate proceeding."),
  submarkets: [sec("asbury", "The Asbury Park edge is a coastal redevelopment corridor.")],
};

assert(countyHalfLeak(cleanHalf as never) === null, "a half with no occasion in it is cacheable");

/*
 * "May" is a month and the commonest modal verb in this subject. Matching the
 * bare word rejected every half that named a right the statute grants — which
 * in production is silent: the split would appear to work while never caching
 * anything.
 */
for (const fine of [
  "The owner may redeem the certificate at any time before foreclosure.",
  "Liens may be sold at a premium above the statutory rate.",
  "A municipality may hold more than one sale a year.",
  "March of the redemption clock does not stop for a bidder.",
]) {
  const half = { ...cleanHalf, redemption: sec("redemption", fine) };
  assert(countyHalfLeak(half as never) === null, `not an occasion: ${fine}`);
}

for (const leak of [
  "The next sale is on October sixth.",
  "Bidding opens at 10:00 AM.",
  "Registration closes before this sale.",
  "Liens sold in 2026 redeem at the statutory rate.",
  "Arrive early on sale day.",
  "The auction starts at ten o'clock.",
]) {
  const dirty = { ...cleanHalf, redemption: sec("redemption", leak) };
  assert(countyHalfLeak(dirty as never) !== null, `caught as an occasion: ${leak}`);
}

/*
 * A statute citation is not a clock. `\d{1,2}[.:]\d{2}` reads "Wis. Stat.
 * 75.521" as 75.52 and "RCW 84.64" as 84.64, so Wisconsin and Washington would
 * have written a county half for every sale and cached none of them, the log
 * insisting each one named an occasion. Same silent-and-total failure as "may".
 */
for (const fine of [
  "Wis. Stat. 75.521, 75.35, 75.69 govern the sale.",
  "The county may sell at any time under RCW 84.64.",
  "Sales run under A.C.A. 26-37-202.",
  "Colorado Revised Statutes sections 39-11-101 through 39-12-113 apply.",
  "Georgia sells redeemable deeds under O.C.G.A. 48-4-40 through 48-4-48.",
  "Kentucky certificates fall under KRS 134.128 and KRS 426.530.",
  "Indiana Code 6-1.1-24 covers delinquent property.",
]) {
  const half = { ...cleanHalf, howItWorks: sec("statute", fine) };
  assert(countyHalfLeak(half as never) === null, `a citation is not a time: ${fine}`);
}

/* A real time still is one, written any of the ways a narrator says it. */
for (const clock of [
  "Bidding opens at 10:00 AM.",
  "The auction starts at ten a.m.",
  "Registration closes at 9 a.m. on the day.",
  "Doors open at noon.",
]) {
  const half = { ...cleanHalf, howItWorks: sec("statute", clock) };
  assert(countyHalfLeak(half as never) !== null, `a time is an occasion: ${clock}`);
}

/* A bullet is read by the viewer too, so it is checked the same way. */
const dirtyBullet = { ...cleanHalf, howItWorks: sec("statute", "Liens are sold at auction.", ["October 6 sale"]) };
assert(countyHalfLeak(dirtyBullet as never) !== null, "an occasion on a slide is caught");

/* Assembly order: what is sold and on what terms, before how to turn up. */
const assembled = assembleScript(cleanHalf as never, {
  title: "T",
  keyTakeaway: "K",
  opening: sec("opening", "o"),
  beforeSaleDay: sec("before", "b"),
  inventory: sec("inventory", "i"),
  stillToVerify: sec("verify", "v"),
  close: sec("close", "c"),
} as never);

assert(
  assembled.sections.map((x) => x.heading).join(",") ===
    "opening,statute,redemption,deed,before,inventory,asbury,verify,close",
  `running order, got ${assembled.sections.map((x) => x.heading).join(",")}`,
);

console.log("cape county half: all assertions passed");

// ---------------------------------------------------------------------------
// The briefing must be about the county it was commissioned for
// ---------------------------------------------------------------------------
/*
 * A stored Lake County, Indiana script is titled "St. Joseph County, Indiana —
 * September 15 Tax Lien Sale" and narrates St. Joseph throughout: its downtown,
 * its university corridor, its treasurer. The facts said Lake. Nothing in the
 * pipeline could see it — `verifyNarration` checks figures and a county name is
 * not a figure — and it is the worst thing this system can produce, a briefing
 * naming the wrong courthouse.
 */
const scriptFor = (title: string, opening: string) =>
  ({ title, keyTakeaway: "k", sections: [sec("opening", opening)] }) as never;

assert(
  countyMismatch(scriptFor("Lake County, Indiana — Tax Lien Sale", "This covers Lake County."),
    { countyName: "Lake", state: "IN", saleDate: "2026-09-08", saleDateConfirmed: true,
      saleType: "Tax Lien", platform: "zeus" }) === null,
  "the right county passes",
);

assert(
  countyMismatch(scriptFor("St. Joseph County, Indiana — Tax Lien Sale", "This covers St. Joseph County."),
    { countyName: "Lake", state: "IN", saleDate: "2026-09-08", saleDateConfirmed: true,
      saleType: "Tax Lien", platform: "zeus" }) !== null,
  "a substituted county is caught",
);

/* "St. Lucie", "St Lucie" and "Saint Lucie" are one county, not three. */
assert(
  countyMismatch(scriptFor("Saint Lucie County, Florida — Tax Deed Sale", "Saint Lucie County sells deeds."),
    { countyName: "St. Lucie", state: "FL", saleDate: "2026-09-14", saleDateConfirmed: true,
      saleType: "Tax Deed", platform: "realforeclose" }) === null,
  "punctuation and Saint/St are not a mismatch",
);

// ---------------------------------------------------------------------------
// A redemption window a listener can picture
// ---------------------------------------------------------------------------
/*
 * Kentucky's is 4,015 days — the eleven-year limit in KRS 134.546, and correct.
 * Spoken it became "the redemption period on record is four thousand fifteen
 * days", which is true and useless: nobody holds a number that size as a
 * duration. The statutory figure stays so the narration can cite it.
 */
assert(redemptionWindow(4015) === "4,015 days (about eleven years)", redemptionWindow(4015));
assert(redemptionWindow(365) === "365 days (one year)", redemptionWindow(365));
assert(redemptionWindow(1095) === "1,095 days (about three years)", redemptionWindow(1095));
/* Under a year, the days are already the clearest form. */
assert(redemptionWindow(180) === "180 days", redemptionWindow(180));

console.log("cape script identity: all assertions passed");
