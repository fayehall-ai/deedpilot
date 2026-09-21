/**
 * Reading the Auction Scout workbook.
 * Run: npx tsx lib/import/scout-workbook.test.ts
 *
 * The jurisdiction labels are the part worth pinning. Each shape below is one
 * the report actually wrote, and each misreading has a specific cost: a
 * municipality read as its county files a town's sale as the county's own, and
 * a re-offer read as a separate county rejects the row outright.
 */
import { readJurisdiction, saleDateOf, saleTypeOf, urlOf, venueOf, clean, type ScoutRow } from "./scout-workbook";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}
function reads(state: string, label: string, county: string, sale: string | null, reoffer = false) {
  const j = readJurisdiction(state, label);
  assert(j.ok, `${label}: expected to read, got ${JSON.stringify(j)}`);
  if (!j.ok) return;
  assert(j.county === county, `${label}: county ${JSON.stringify(j.county)}, want ${JSON.stringify(county)}`);
  assert(j.sale === sale, `${label}: sale ${JSON.stringify(j.sale)}, want ${JSON.stringify(sale)}`);
  assert(j.reoffer === reoffer, `${label}: reoffer ${j.reoffer}, want ${reoffer}`);
}

// ---- jurisdiction -------------------------------------------------------------

reads("MN", "Carver County", "Carver County", null);
reads("VA", "Newport News City (Newport News)", "Newport News City (Newport News)", null);
reads("MI", "Arenac County Re-Offer", "Arenac County", null, true);
reads("GA", "Chatham County / City of Savannah Judicial In Rem", "Chatham County", "City of Savannah Judicial In Rem");
reads("TX", "Gladewater ISD – Smith County", "Smith County", "Gladewater ISD");
reads("GA", "City of Sardis (Burke County)", "Burke County", "City of Sardis");
reads("CT", "Town of Berlin", "Hartford", "Town of Berlin");
reads("CT", "City of Hartford", "Hartford", "City of Hartford");
reads("NY", "City of Poughkeepsie", "Dutchess", "City of Poughkeepsie");
reads("CT", "Killingly Town (Northeastern Connecticut)", "Windham", "Killingly Town");
reads("CT", "Oronoque Village Tax District (Stratford)", "Fairfield", "Oronoque Village Tax District (Stratford)");

// A town the table does not know is refused, never filed under a guess.
const unknown = readJurisdiction("CT", "Town of Nowhere");
assert(!unknown.ok, "an unknown town must not resolve");
// Outside the states the town table covers, a bracket passes through to CountyIndex.
reads("NJ", "Lumberton Township (Burlington)", "Lumberton Township (Burlington)", null);

// ---- sale type ----------------------------------------------------------------

assert(saleTypeOf("Deed") === "Tax Deed", "Deed");
assert(saleTypeOf("Redeemable Deed") === "Redeemable Deed", "Redeemable Deed");
assert(saleTypeOf("Tax Commissioner Sale — Redeemable Tax Deed") === "Redeemable Deed", "GA commissioner");
assert(saleTypeOf("Tax-Foreclosed Property No-Reserve Auction") === "Tax Deed", "MI no-reserve");
assert(saleTypeOf("  tax-foreclosed   property minimum-bid re-offer ") === "Tax Deed", "case and spacing");
assert(saleTypeOf("Tax Lien Certificate Sale") === null, "an unread label is rejected, not defaulted");

// ---- cells --------------------------------------------------------------------

assert(saleDateOf("46286") === "2026-09-21", "Excel serial");
assert(saleDateOf("2026-09-01") === "2026-09-01", "ISO text");
assert(saleDateOf("Sep 21, 2026") === null, "prose date is not guessed");
assert(urlOf("www.publicsurplus.com") === "https://www.publicsurplus.com", "bare host");
assert(urlOf("Full listings not yet available") === null, "prose is not a URL");
assert(clean("Online auction, &nbsp;, &nbsp;, &nbsp;") === "Online auction", "entity junk");

// ---- venue --------------------------------------------------------------------

const row = (method: string | null, address: string | null) => ({ method, address }) as ScoutRow;
assert(venueOf(row("Online auction", "Online auction"))?.kind === "online", "online sale");
const live = venueOf(row("Live public sale", "Courthouse steps, 100 Main St"));
assert(live?.kind === "in_person" && live.text === "Courthouse steps, 100 Main St", "live sale takes the address");
assert(venueOf(row("In person / online as posted", "Courtroom 1"))?.kind === "in_person", "streamed but held in a room");
assert(venueOf(row(null, "River Center Gym, Benton"))?.kind === "in_person", "source tab: address only");
assert(venueOf(row(null, null)) === null, "nothing to say");
assert(venueOf(row("Live public outcry", "")) === null, "a method is not a place");
assert(venueOf(row("Live municipal auction", "Live municipal auction")) === null, "nor is a method repeated as the address");

console.log(`scout-workbook: ${passed} assertions passed`);
