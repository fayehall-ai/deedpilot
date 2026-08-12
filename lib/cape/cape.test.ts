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
import { buildPackage } from "./components";

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
  parcels: { total: 120, withParcelNumber: 120, withAssessed: 60, withAddress: 40, withZoning: 0, withGeo: 12 },
  today: "2026-08-11",
};

const pkg = buildPackage(pkgBase as never);
assert(pkg.components.length === 9, `all nine components, got ${pkg.components.length}`);
assert(
  pkg.components.map((c) => c.n).join() === "1,2,3,4,5,6,7,8,9",
  "numbered in the document's order",
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
