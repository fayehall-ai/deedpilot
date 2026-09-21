/**
 * The AI Scout's findings: what goes in unattended, what waits for Ed.
 * Run: npx tsx lib/import/scout-research.test.ts
 *
 * The pure half pins the rules; the second half round-trips a finding through
 * the review list against the real database, using a state that does not exist
 * so nothing it does can reach the calendar, and cleans up after itself.
 */
import "../env";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { scoutFindings } from "../db/schema";
import type { ScoutRow as ResearchRow } from "../ai/scout-report";
import { approveFinding, dismissFinding, researchOutcome, researchSaleType, trusted } from "./scout-research";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}

const row = (over: Partial<ResearchRow> = {}): ResearchRow => ({
  county: "Anoka",
  state: "MN",
  saleKind: "tax foreclosure",
  saleDate: "2099-10-14",
  saleTimeLocal: "10:00 AM CT",
  auctionFormat: "Online",
  platform: "Bid4Assets",
  platformLink: null,
  depositRules: null,
  registrationDeadline: null,
  depositDeadline: null,
  countyListUrl: "https://www.anokacounty.us/taxforfeit",
  sourceUrl: "https://www.anokacounty.us/taxsale",
  officialSource: true,
  verification: "confirmed",
  notes: null,
  ...over,
});

// ---- sale kinds -----------------------------------------------------------------

assert(researchSaleType("tax deed", "FL") === "Tax Deed", "tax deed");
assert(researchSaleType("Redeemable Tax Deed", "GA") === "Redeemable Deed", "case-insensitive");
assert(researchSaleType("tax foreclosure", "MI") === "Tax Deed", "foreclosure conveys a deed");
assert(researchSaleType("tax commissioner sale", "GA") === "Redeemable Deed", "GA commissioner sale is redeemable");
assert(researchSaleType("county tax auction", "AZ") === "Tax Lien", "an unnamed kind takes the state's type");
assert(researchSaleType("mystery auction", "FL") === null, "an unread kind is not guessed");

// ---- what goes in unattended -------------------------------------------------------

assert(trusted(row()), "confirmed on an official page goes straight in");
assert(!trusted(row({ verification: "manual" })), "unconfirmed waits");
assert(!trusted(row({ officialSource: false })), "a platform listing waits");

const ok = researchOutcome(row(), 1);
assert(ok.ok, "a good row translates");
if (ok.ok) {
  assert(ok.row.startTime === "10:00 AM CT", "start time carried");
  assert(ok.row.listUrl === "https://www.anokacounty.us/taxforfeit", "list link carried");
  assert(ok.row.site === "https://www.anokacounty.us/taxsale", "source page is the citation when there is no platform link");
  assert(ok.row.raw["Auction Type"] === "tax foreclosure", "kind kept for the matcher");
}
assert(!researchOutcome(row({ saleDate: "October 14" }), 1).ok, "an unreadable date is refused");

// ---- the review list, round trip -------------------------------------------------

async function main() {
  const fake = row({ state: "ZZ", county: "Nowhere Test County", saleKind: "tax deed" });
  const [f] = await db
    .insert(scoutFindings)
    .values({ state: "ZZ", county: fake.county, countyKey: "nowhere test county", saleDate: fake.saleDate, finding: fake as unknown as Record<string, unknown>, reason: "test" })
    .returning();
  try {
    const said = await approveFinding(f.id, "test");
    assert(/Still not placed/.test(said), `a row that cannot be placed stays pending (said: ${said})`);
    const [after] = await db.select().from(scoutFindings).where(eq(scoutFindings.id, f.id));
    assert(after.status === "pending", "still pending");
    await dismissFinding(f.id, "test");
    const [gone] = await db.select().from(scoutFindings).where(eq(scoutFindings.id, f.id));
    assert(gone.status === "dismissed" && gone.decidedBy === "test", "dismissed, with who did it");
    assert((await approveFinding(f.id, "test")) === "Already dismissed.", "a decided finding is not decided twice");
  } finally {
    await db.delete(scoutFindings).where(eq(scoutFindings.id, f.id));
  }

  console.log(`scout-research.test.ts — ${passed} assertions passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
