/**
 * MVBA Texas notice parser.
 *
 * No network. Every fixture here is a reduced copy of a real MVBA notice, and
 * each one encodes a mistake the parser made before it was fixed. What must
 * not drift: the minimum bid, which parcels are sold, and how many.
 *
 * Run: npx tsx lib/ingest/mvba-parser.test.ts
 */
import { entryToLot, parseMoney, parseNotice, toIsoDate } from "./adapters/mvba";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// parseMoney
// ---------------------------------------------------------------------------

// Jasper's notice extracts a $20,285.28 bid as the literal text "$20.285.28":
// the thousands comma comes out of the PDF as a dot. Reading that as $20.28
// understates the minimum bid a thousandfold.
assert(parseMoney("20.285.28") === 20285.28, "comma-as-dot recovers 20285.28");
assert(parseMoney("12,500.00") === 12500, "standard figure with cents");
assert(parseMoney("2,200") === 2200, "Eastland prints whole dollars, no cents");
assert(parseMoney("50.00") === 50, "small genuine bid survives");
// "1.049 Acre" must not be read as a dollar amount with three decimals.
assert(parseMoney("1.049") === 1, "three-decimal group is not cents");

assert(toIsoDate("SEPTEMBER 1, 2026") === "2026-09-01", "uppercase month parses");
assert(toIsoDate("August 4, 2026") === "2026-08-04", "title-case month parses");

// ---------------------------------------------------------------------------
// Bastrop shape: cause on the entry line, account and judgment on their own.
// ---------------------------------------------------------------------------

const BASTROP = `PROPERTIES TO BE SOLD ON AUGUST 4, 2026:
TRACT SUIT # STYLE PROPERTY DESCRIPTION, APPROXIMATE ADDRESS, ACCT # MIN BID
1 423-T-14398 The County of Bastrop, Texas v
Jose L. Lopez
1.112 Acre, more or less, being Lot 17, Block B, Cielo Vista
Ranch, Section Two, Bastrop County, Texas, 171 Higinia Run,
Del Valle, Texas
Account #109555
Judgment Through Tax Year: 2025
$12,500.00
2 423-T-14601 The County of Bastrop, Texas v
Leland George Leonard et al
0.75 Acre, more or less, and a Manufactured Home (Instrument
#201801295, Official Public Records, Bastrop County, Texas),
113 Angelia Dr, Cedar Creek, Texas
Account #70985
Judgment Through Tax Year: 2025
$10,300.00
`;

{
  const { saleDate, entries } = parseNotice(BASTROP);
  assert(toIsoDate(saleDate ?? "") === "2026-08-04", "sale date read from the notice");
  assert(entries.length === 2, `two entries, got ${entries.length}`);

  const lots = entries.map((e) => entryToLot(e, "u")).filter(Boolean);
  assert(lots.length === 2, "both entries become lots");
  assert(lots[0]!.openingBid === 12500, "first bid is 12500");
  assert(lots[0]!.parcelNumber === "109555", "account #, not sequence or cause");
  assert(lots[0]!.caseNumber === "423-T-14398", "cause number retained");

  // The Instrument number is a recorded-document reference inside the legal
  // description. The generic PDF parser took it as the parcel id — the same
  // failure that leaves ~130 Brevard FL lots unpriceable.
  assert(
    lots[1]!.parcelNumber === "70985",
    `instrument # must not become the parcel, got ${lots[1]!.parcelNumber}`,
  );
  // The minimum bid must never be promoted to an assessed value: an ARV equal
  // to the opening bid makes every lot look like a break-even.
  assert(lots[0]!.assessedValue === undefined, "no assessed value is invented");
}

// ---------------------------------------------------------------------------
// Rusk shape: withdrawn tracts, and one cause covering several accounts.
// ---------------------------------------------------------------------------

const RUSK = `PROPERTIES TO BE SOLD ON AUGUST 4, 2026:
TRACT SUIT # STYLE PROPERTY DESCRIPTION, APPROXIMATE ADDRESS, ACCT # MIN BID
1 2022-081 Tatum Independent School District v
Rachel J. Reynolds et al
1.8080 Acres, more or less, out of the P. Wells Survey
Account #25695
Judgment Through Tax Year: 2025
$47,094.39
2 2024-029 Tatum Independent School District v
Marion Bradford et al
9.634 acres, more or less, out of the J Matthews Survey
Account #60650
Judgment Through Tax Year: 2025
WITHDRAWN
3 2024-291 Tatum Independent School District v
Jerlene Garrett et al
TRACT 1: BEING A 0.001781 ROYALTY INTEREST IN
THE YOUNG GAS UNIT, WELL 3, RUSK COUNTY, TEXAS.
Account #149516
Judgment Through Tax Year: 2025
TRACT 2: BEING A 0.001781 ROYALTY INTEREST IN
THE YOUNG GAS UNIT, WELL 2, RUSK COUNTY, TEXAS.
Account #149552
Judgment Through Tax Year: 2025
$50.00
`;

{
  const { entries } = parseNotice(RUSK);
  assert(entries.length === 3, `three entries, got ${entries.length}`);

  const lots = entries.map((e) => entryToLot(e, "u")).filter(Boolean);
  // A withdrawn tract is not for sale and must not appear as a lot with a
  // null bid.
  assert(lots.length === 2, `withdrawn entry dropped, got ${lots.length} lots`);
  assert(
    lots.every((l) => l!.parcelNumber !== "60650"),
    "the withdrawn account is absent",
  );

  // An earlier regex scanned past the entry boundary and paired cause 2024-029
  // with a later tract's account and its $50 bid. It looked entirely
  // plausible, which is what made it dangerous.
  assert(lots[0]!.openingBid === 47094.39, "first bid not contaminated by later entries");

  // The sale unit in Texas is the cause, not the tract: one bidder buys the
  // bundle for one minimum bid. Emitting a lot per tract would multiply
  // apparent inventory and misstate every price.
  const multi = lots[1]!;
  assert(multi.parcelNumber === "149516", "primary account is the first tract");
  assert(
    (multi.raw as { additionalAccounts?: string[] }).additionalAccounts?.includes("149552") ===
      true,
    "additional tracts retained in raw, never dropped",
  );
  assert(multi.openingBid === 50, "one bid for the whole cause");
  assert(multi.landUse === "mineral interest", "royalty interest flagged, no ratio applies");
}

// ---------------------------------------------------------------------------
// Jasper shape: "bid in trust" lots whose minimum is printed as TBD.
// ---------------------------------------------------------------------------

const JASPER = `PROPERTIES TO BE SOLD ON AUGUST 4, 2026:
TRACT SUIT # STYLE PROPERTY DESCRIPTION, APPROXIMATE ADDRESS, ACCT # MIN BID
1 5878 Jasper Independent School District v
Pearlie Mae Hadnot
Lot 9, Block 8, Trotti Subdivision, Jasper County, Texas
Account #R028608
Judgment Through Tax Year: 2025
$20.285.28
2 7338 Jasper Independent School District v
Lillie Mae Stribling et al
BEING 0.50 OF AN ACRE, JASPER COUNTY, TEXAS
Account #R008363
Bid in Trust 4/1/2025
Judgment Through Tax Year: 2023
TBD
`;

{
  const { entries } = parseNotice(JASPER);
  const lots = entries.map((e) => entryToLot(e, "u")).filter(Boolean);
  assert(lots.length === 2, "both lots kept");
  assert(lots[0]!.openingBid === 20285.28, "malformed figure recovered, not 20.28");

  // Struck to the taxing units with no published minimum. Real inventory, so
  // keeping it with no price beats dropping a parcel a subscriber could bid
  // on — but a price must not be invented for it either.
  assert(lots[1]!.openingBid === undefined, "TBD yields no opening bid");
  assert(
    String((lots[1]!.raw as { bidStatus?: string }).bidStatus).includes("TBD"),
    "bid-in-trust status recorded",
  );
}

// ---------------------------------------------------------------------------
// Page furniture must not be read as entries.
// ---------------------------------------------------------------------------

const PAGED = `PROPERTIES TO BE SOLD ON AUGUST 4, 2026:
TRACT SUIT # STYLE PROPERTY DESCRIPTION, APPROXIMATE ADDRESS, ACCT # MIN BID
1 T116-20 The County of Hill, Texas v Willie D. Brooks
Part of Lot 1, Block 56, McMullen Addn, recorded in VOLUME 1 PAGE
137OF THE PLAT RECORDS, Hill County, Texas, Account #101465
$3,710.02

-- 2 of 3 --

TRACT SUIT # STYLE PROPERTY DESCRIPTION, APPROXIMATE
ADDRESS, ACCT # MIN BID
2 T077-21 The County of Hill, Texas v Charles R. Williams
Part of Lot 1, Block 3, Duncan Addn, Account #102608
$14,781.27
`;

{
  const { entries } = parseNotice(PAGED);
  // "137OF THE PLAT RECORDS" starts a line with a number, and the page break
  // repeats the column header. Requiring the sequence to run 1, 2, 3 ignores
  // both without needing to recognise either.
  assert(entries.length === 2, `page furniture ignored, got ${entries.length} entries`);
  const lots = entries.map((e) => entryToLot(e, "u")).filter(Boolean);
  assert(lots[0]!.parcelNumber === "101465", "inline account parsed (Hill shape)");
  assert(lots[1]!.openingBid === 14781.27, "second bid correct across the page break");
}

console.log(process.exitCode ? "\nFAILURES" : "\nall MVBA parser checks passed");
