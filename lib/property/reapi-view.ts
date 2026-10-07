/**
 * The parcel page's PropStream-shaped property card, as data.
 *
 * Bidders arrive from PropStream and read a property in its order: a summary
 * strip (the property, its value, its debt, the opportunity), then tabs, the
 * first of which walks ownership → characteristics → size → land → legal →
 * assessment → HOA → the last two transfers. This builds that layout from a
 * RealEstateAPI PropertyDetail payload, so the page only draws it.
 *
 * Pure, and kept out of the component so it can be tested without React.
 *
 * Sale-list facts (`LotFacts`) lead where the page has always led with them:
 * owner, building size, year built and legal description come from the county
 * holding the auction, and the provider fills what the list left out. Every
 * figure here is copied or derived by arithmetic from the payload; none is
 * estimated, which keeps this on the right side of maxbid's division.
 */
import { money, num } from "@/lib/format";

type O = Record<string, unknown>;

export interface Field {
  label: string;
  value: string;
}
export interface Group {
  /** Sub-heading inside a section ("Recording Information"). */
  title?: string;
  fields: Field[];
}
export interface Section {
  title: string;
  groups: Group[];
}
export interface Table {
  title: string;
  columns: string[];
  rows: string[][];
}
export interface Tab {
  id: string;
  label: string;
  sections: Section[];
  tables: Table[];
}

/** What the sale list (and the merged valuation) already knows about the parcel. */
export interface LotFacts {
  parcelNumber?: string | null;
  ownerName?: string | null;
  countyName: string;
  beds?: number | null;
  baths?: number | null;
  buildingSqft?: number | null;
  lotSqft?: number | null;
  acreage?: number | null;
  yearBuilt?: number | null;
  landUse?: string | null;
  propertyType?: string | null;
  legalDescription?: string | null;
  assessedValue?: number | null;
  assessedLand?: number | null;
  assessedImprovement?: number | null;
  marketValue?: number | null;
  lastSaleAmount?: number | null;
  lastSaleDate?: string | null;
  /** What the auction asks: the parcel's opening bid and the taxes behind it. */
  openingBid?: number | null;
  taxesOwed?: number | null;
}

export interface Stat {
  label: string;
  value: string;
  /** Small line under the value: a date, a percentage. */
  note?: string;
}

export interface PropertyView {
  /** The key-facts column beside the photo. */
  facts: Field[];
  /** The status column: type, distress, owner, occupancy. */
  status: Field[];
  value: Stat[];
  debt: Stat[];
  lastSale: Stat[];
  opportunity: Stat[];
  /** Whether the provider record exists at all; without it only `facts` and the details tab render. */
  enriched: boolean;
  tabs: Tab[];
}

// ---------------------------------------------------------------------------
// Readers. The payload mixes numbers and numeric strings ("lastSalePrice":
// "91794"), and marks absence with null, "" and sometimes 0.
// ---------------------------------------------------------------------------

function obj(v: unknown): O {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as O) : {};
}
function arr(v: unknown): O[] {
  return Array.isArray(v) ? v.filter((x): x is O => Boolean(x) && typeof x === "object") : [];
}
function n(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v.replace(/[,$]/g, ""));
    if (Number.isFinite(x)) return x;
  }
  return null;
}
function s(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}
/** First present value among several keys — mortgage and HOA entries are not uniformly named. */
function pick(o: O, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== null && o[k] !== undefined && o[k] !== "") return o[k];
  return null;
}

/** "2022-04-25T00:00:00.000Z" / "2022-04-25" → "04/25/2022", as PropStream writes dates. */
export function usDate(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : t;
}
const dollars = (v: unknown) => {
  const x = n(v);
  return x === null || x === 0 ? null : money(x);
};
const count = (v: unknown) => {
  const x = n(v);
  return x === null ? null : num(x);
};
const sqft = (v: unknown) => {
  const x = n(v);
  return x ? `${num(x)} SqFt.` : null;
};
const yesNo = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : null);
/** "SINGLE FAMILY" and "Single Family" both arrive; title-case the shouty ones only. */
function tidy(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  return t === t.toUpperCase() && /[A-Z]{3}/.test(t)
    ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : t;
}

/** Months → "4 Years 5 Months". */
export function ownershipLength(months: unknown): string | null {
  const m = n(months);
  if (m === null || m <= 0) return null;
  const y = Math.floor(m / 12);
  const r = Math.round(m % 12);
  return [y ? `${y} Year${y === 1 ? "" : "s"}` : null, r ? `${r} Month${r === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(" ");
}

function field(label: string, value: string | null | undefined): Field | null {
  return value ? { label, value } : null;
}
function group(title: string | undefined, fields: (Field | null)[]): Group | null {
  const kept = fields.filter((f): f is Field => f !== null);
  return kept.length ? { title, fields: kept } : null;
}
function section(title: string, groups: (Group | null)[]): Section | null {
  const kept = groups.filter((g): g is Group => g !== null);
  return kept.length ? { title, groups: kept } : null;
}
function table(title: string, entries: O[], cols: [string, (e: O) => string | null][]): Table | null {
  const rows = entries.map((e) => cols.map(([, get]) => get(e) ?? ""));
  // Drop columns no entry fills: a history table of blank columns reads as missing data.
  const keep = cols.map((_, i) => rows.some((r) => r[i] !== ""));
  if (!rows.length || !keep.some(Boolean)) return null;
  return {
    title,
    columns: cols.filter((_, i) => keep[i]).map(([c]) => c),
    rows: rows.map((r) => r.filter((_, i) => keep[i])),
  };
}
const notNull = <T,>(x: T | null): x is T => x !== null;

// ---------------------------------------------------------------------------

/** Newest first, by sale date then recording date. */
function bySaleDate(a: O, b: O): number {
  const d = (e: O) => s(pick(e, "saleDate", "recordingDate")) ?? "";
  return d(b).localeCompare(d(a));
}

/** The mortgage recorded with a sale: same recording date, first position. */
function mortgageFor(sale: O, mortgages: O[]): O | null {
  const day = (s(sale.recordingDate) ?? "").slice(0, 10);
  if (!day) return null;
  return (
    mortgages.find((m) => (s(pick(m, "recordingDate", "documentDate")) ?? "").slice(0, 10) === day) ??
    null
  );
}

function transferSection(title: string, sale: O | null, mortgages: O[], owner: O): Section | null {
  if (!sale) return null;
  const mail = obj(owner.mailAddress);
  /*
   * Names stay as one string. They arrive comma-joined, but "Smith, John" is
   * also comma-joined, so splitting into Buyer 1 / Buyer 2 would invent people.
   */
  const buyers = s(sale.buyerNames);
  const mortgage = sale.armsLength === true ? mortgageFor(sale, mortgages) : null;
  return section(title, [
    group(undefined, [
      field("Sale Date", usDate(sale.saleDate)),
      field("Sale Amount", dollars(sale.saleAmount)),
      field("Purchase Method", s(sale.purchaseMethod)),
      field("Transaction Type", s(sale.transactionType)),
    ]),
    group("Recording Information", [
      field("Recording Date", usDate(sale.recordingDate)),
      field("Document Type", s(sale.documentType)),
      field("Document Number", s(sale.documentNumber)),
      field("Book / Page", [s(sale.book), s(sale.page)].filter(Boolean).join(" / ") || null),
    ]),
    group("Buyer/Seller Information", [
      field("Buyer Name", buyers),
      // The owner's mailing address is the buyer's only when the buyer still owns it.
      buyers && buyers === s(owner.owner1FullName) ? field("Buyer Mailing Address", s(mail.label)) : null,
      field("Seller Name", s(sale.sellerNames)),
    ]),
    mortgage
      ? group("First Mortgage Information", [
          field("Amount", dollars(mortgage.amount)),
          field("Type", s(pick(mortgage, "loanType", "deedType"))),
          field("Lender Name", s(mortgage.lenderName)),
          field("Rate (Est.)", n(mortgage.interestRate) ? `${n(mortgage.interestRate)}%` : null),
          field("Term", count(mortgage.term)),
          field("Maturity Date", usDate(mortgage.maturityDate)),
        ])
      : null,
  ]);
}

/** HOA comes back as an object, an array of them, or not at all. */
function hoaGroups(raw: O): Group | null {
  const pi = obj(raw.propertyInfo);
  const src = raw.hoa ?? pi.hoa;
  const list = Array.isArray(src) ? arr(src) : Object.keys(obj(src)).length ? [obj(src)] : [];
  const fields: (Field | null)[] = [];
  list.slice(0, 3).forEach((h, i) => {
    const p = i === 0 ? "HOA" : `HOA ${i + 1}`;
    fields.push(
      field(`${p} Name`, s(pick(h, "name", "hoaName"))),
      field(`${p} Type`, s(pick(h, "type", "hoaType"))),
      field(`${p} Fee`, dollars(pick(h, "fee", "hoaFee", "amount"))),
      field(`${p} Fee Frequency`, s(pick(h, "feeFrequency", "hoaFeeFrequency", "frequency"))),
    );
  });
  return group(undefined, fields);
}

function rentFor(raw: O, beds: number | null): { value: number; label: string } | null {
  const d = obj(raw.demographics);
  const suggested = n(d.suggestedRent);
  if (suggested) return { value: suggested, label: "Suggested rent" };
  const keys = ["fmrEfficiency", "fmrOneBedroom", "fmrTwoBedroom", "fmrThreeBedroom", "fmrFourBedroom"];
  if (beds === null) return null;
  const v = n(d[keys[Math.min(Math.max(beds, 0), 4)]]);
  return v ? { value: v, label: `HUD fair market rent (${beds} bd)` } : null;
}

export function buildPropertyView(rawIn: Record<string, unknown> | null, lot: LotFacts): PropertyView {
  const raw: O = rawIn ?? {};
  const enriched = Object.keys(raw).length > 0;
  const pi = obj(raw.propertyInfo);
  const li = obj(raw.lotInfo);
  const ti = obj(raw.taxInfo);
  const oi = obj(raw.ownerInfo);
  const demo = obj(raw.demographics);
  const last = obj(raw.lastSale);
  const sales = arr(raw.saleHistory).sort(bySaleDate);
  const mortgages = [...arr(raw.currentMortgages), ...arr(raw.mortgageHistory)];
  const current = arr(raw.currentMortgages);
  const foreclosures = arr(raw.foreclosureInfo);

  const beds = lot.beds ?? n(pi.bedrooms);
  const baths = lot.baths ?? n(pi.bathrooms);
  const living = lot.buildingSqft ?? n(pi.livingSquareFeet);
  const lotSq = n(li.lotSquareFeet) ?? n(pi.lotSquareFeet) ?? lot.lotSqft ?? null;
  const acres = n(li.lotAcres) ?? lot.acreage ?? (lotSq ? lotSq / 43560 : null);
  const apn = lot.parcelNumber ?? s(li.apn);
  const owner = lot.ownerName ?? s(oi.owner1FullName) ?? s(oi.companyName);

  const facts = [
    field("Beds", count(beds)),
    field("Baths", count(baths)),
    field("SqFt", count(living)),
    field("Lot Size", lotSq ? num(lotSq) : acres ? `${num(+acres.toFixed(2))} ac` : null),
    field("Year Built", s(lot.yearBuilt ?? pi.yearBuilt)),
    field("APN", apn),
  ].filter(notNull);

  const distress = [
    raw.preForeclosure === true ? "Pre-Foreclosure" : null,
    raw.auction === true ? "Auction" : null,
    raw.taxLien === true ? "Tax Lien" : null,
    raw.bankOwned === true ? "Bank Owned" : null,
  ].filter(Boolean);
  const lastArms = sales.find((x) => x.armsLength === true) ?? null;
  const lastNonArms = sales.find((x) => x.armsLength === false) ?? null;

  const status = [
    field("Property Type", tidy(lot.propertyType) ?? tidy(pi.propertyUse) ?? tidy(lot.landUse)),
    enriched ? field("Distressed", distress.length ? distress.join(", ") : "No") : null,
    enriched ? field("Vacant", yesNo(raw.vacant)) : null,
    enriched ? field("HOA/COA", hoaGroups(raw) ? "Yes" : null) : null,
    field("Owner Type", s(oi.owner1Type)),
    enriched
      ? field(
          "Owner Status",
          raw.ownerOccupied === true
            ? "Owner Occupied"
            : raw.outOfStateAbsenteeOwner === true
              ? "Absentee (Out of State)"
              : raw.absenteeOwner === true
                ? "Absentee (In State)"
                : null,
        )
      : null,
    field("Length of Ownership", ownershipLength(oi.ownershipLength)),
    field("Purchase Method", s(last.purchaseMethod) ?? s(lastArms?.purchaseMethod)),
    field("County", lot.countyName),
  ].filter(notNull);

  const estimated = n(raw.estimatedValue);
  /*
   * The assessment is read as one set: the provider's total with the
   * provider's split, or the sale list's with the list's. Mixing them divided
   * a $5.55M improvement by a $1,154 list "assessed value" on 1703 S Colorado
   * St and printed an improvement ratio of 481,026%.
   */
  const fromProvider = n(ti.assessedValue) !== null;
  const assessed = fromProvider ? n(ti.assessedValue) : (lot.assessedValue ?? null);
  const assessedLand = fromProvider ? n(ti.assessedLandValue) : (lot.assessedLand ?? null);
  const assessedImpr = fromProvider ? n(ti.assessedImprovementValue) : (lot.assessedImprovement ?? null);
  const value: Stat[] = [
    estimated ? { label: "Estimated Value", value: money(estimated) } : null,
    n(ti.marketValue)
      ? { label: "County Market Value", value: money(n(ti.marketValue)), note: s(ti.year) ?? undefined }
      : null,
    assessed ? { label: "Assessed Value", value: money(assessed), note: s(ti.assessmentYear) ?? undefined } : null,
    !estimated && lot.marketValue ? { label: "Market / AVM", value: money(lot.marketValue) } : null,
  ].filter(notNull);

  const openBalance = n(raw.openMortgageBalance) ?? n(raw.estimatedMortgageBalance);
  const liens = [
    raw.taxLien === true ? "Tax lien" : null,
    raw.judgment === true ? "Judgment" : null,
    raw.lien === true ? "Lien" : null,
  ].filter(Boolean);
  const debt: Stat[] = enriched
    ? [
        { label: "Open Mortgages", value: num(current.filter((m) => m.open !== false).length) },
        { label: "Estimated Balance", value: openBalance ? money(openBalance) : "$0" },
        { label: "Involuntary Liens", value: liens.length ? liens.join(", ") : "None" },
        n(ti.taxDelinquentYear)
          ? { label: "Tax Delinquent Since", value: String(n(ti.taxDelinquentYear)) }
          : null,
      ].filter(notNull)
    : [];

  const saleAmount = n(last.saleAmount) ?? lot.lastSaleAmount ?? null;
  const lastSale: Stat[] = [
    saleAmount
      ? {
          label: "Public Record",
          value: money(saleAmount),
          note: usDate(last.saleDate ?? lot.lastSaleDate) ?? undefined,
        }
      : null,
    n(raw.mlsSoldPrice)
      ? { label: "MLS", value: money(n(raw.mlsSoldPrice)), note: usDate(raw.mlsLastSaleDate) ?? undefined }
      : null,
    s(last.documentType) ? { label: "Document Type", value: s(last.documentType)! } : null,
  ].filter(notNull);

  const equity = n(raw.estimatedEquity);
  const rent = enriched ? rentFor(raw, beds) : null;
  const yieldBase = estimated ?? lot.marketValue ?? null;
  /*
   * The auction's numbers lead this card. PropStream's opportunity is equity
   * against a mortgage; a tax-deed bidder's is the opening bid against what the
   * parcel is worth. Both figures are already facts on the page, and the ratio
   * is plain division, so nothing here is an estimate.
   */
  const worth = estimated ?? lot.marketValue ?? null;
  const opportunity: Stat[] = [
    lot.openingBid ? { label: "Opening Bid", value: money(lot.openingBid) } : null,
    lot.openingBid && worth
      ? {
          label: "Bid / Value",
          value: `${((lot.openingBid * 100) / worth).toFixed(lot.openingBid * 100 < worth ? 2 : 0)}%`,
          note: `of ${money(worth)}`,
        }
      : null,
    lot.taxesOwed ? { label: "Taxes Owed", value: money(lot.taxesOwed) } : null,
    equity !== null && enriched
      ? {
          label: "Equity (est.)",
          value: money(equity),
          note: n(raw.equityPercent) !== null ? `${n(raw.equityPercent)}%` : undefined,
        }
      : null,
    rent ? { label: "Monthly Rent", value: money(rent.value), note: rent.label } : null,
    rent && yieldBase
      ? { label: "Gross Yield", value: `${((rent.value * 12 * 100) / yieldBase).toFixed(2)}%` }
      : null,
    n(obj(raw.linkedProperties).totalOwned) !== null
      ? { label: "Linked Properties", value: num(n(obj(raw.linkedProperties).totalOwned)) }
      : null,
  ].filter(notNull);

  // --- Property Details tab, in PropStream's order --------------------------
  const mail = obj(oi.mailAddress);
  const details = [
    section("Ownership Information", [
      group(undefined, [
        field("Owner 1 Name", owner),
        field("Owner 2 Name", s(oi.owner2FullName)),
        field("Mailing Address", s(mail.label)),
        field("Owner Type", s(oi.owner1Type)),
        field("Corporate Owned", enriched ? yesNo(oi.corporateOwned) : null),
      ]),
    ]),
    section("Property Characteristics", [
      group(undefined, [
        field("Total Rooms", n(pi.roomsCount) ? count(pi.roomsCount) : null),
        field("Bedrooms", count(beds)),
        field("Total Bathrooms", count(baths)),
        field("Partial Bathrooms", n(pi.partialBathrooms) ? count(pi.partialBathrooms) : null),
        field("Number of Bathroom Fixtures", n(pi.plumbingFixturesCount) ? count(pi.plumbingFixturesCount) : null),
        field("Air Conditioning Type", s(pi.airConditioningType)),
        field("Heating Type", s(pi.heatingType)),
        field("Heating Fuel", s(pi.heatingFuelType)),
        field("Garage Type", s(pi.garageType)),
        field("Parking Spaces", n(pi.parkingSpaces) ? count(pi.parkingSpaces) : null),
        field("Building Condition", s(pi.buildingCondition)),
        field("Construction Type", s(pi.construction)),
        field("Roof Cover Type", s(pi.roofMaterial)),
        field("Basement", tidy(pi.basementType)),
        field("Pool", pi.pool === true ? "Yes" : null),
        field("Fireplace", pi.fireplace === true ? count(pi.fireplaces) ?? "Yes" : null),
        field("Porch", s(pi.porchType)),
        field("Number of Buildings", n(pi.buildingsCount) ? count(pi.buildingsCount) : null),
        field("Number of Stories", n(pi.stories) ? count(pi.stories) : null),
        field("Number of Units", n(pi.unitsCount) ? count(pi.unitsCount) : null),
      ]),
    ]),
    section("Building Size", [
      group(undefined, [
        field("Building Area", sqft(pi.buildingSquareFeet)),
        field("Living Area", sqft(living)),
        field("Garage Area", sqft(pi.garageSquareFeet)),
        field("Basement Area", sqft(pi.basementSquareFeet)),
        field("Porch Area", sqft(pi.porchArea)),
      ]),
    ]),
    section("Land/Location Information", [
      group(undefined, [
        field("APN", apn),
        field("Property Class", tidy(li.propertyClass)),
        field("Property Type", tidy(li.propertyUse) ?? tidy(lot.propertyType)),
        field("Land Use", tidy(li.landUse) ?? tidy(lot.landUse)),
        field("Zoning", s(li.zoning)),
        field("County Land Use Code", s(pi.propertyUseCode)),
        field("Census Tract", s(li.censusTract)),
        field("Census Block", s(li.censusBlock)),
        field("Lot Size", acres ? `${num(+acres.toFixed(2))} acres` : null),
        field("Lot Area", sqft(lotSq)),
        field("Lot Dimensions", n(li.lotWidthFeet) && n(li.lotDepthFeet) ? `${n(li.lotWidthFeet)} × ${n(li.lotDepthFeet)} ft` : null),
        field("Lot Number", s(li.lotNumber)),
        field("Subdivision Name", s(li.subdivision)),
        field("Legal Section", s(li.legalSection)),
        field("Flood Zone", [s(raw.floodZoneType), s(raw.floodZoneDescription)].filter(Boolean).join(" · ") || null),
        field("County", lot.countyName),
      ]),
    ]),
    section("Legal Description", [
      group(undefined, [field("", lot.legalDescription ?? s(li.legalDescription))]),
    ]),
    section("Tax Assessment Information", [
      group(undefined, [
        field("Total Assessed Value", dollars(assessed)),
        field("Assessed Land Value", dollars(assessedLand)),
        field("Assessed Improvement Value", dollars(assessedImpr)),
        field("Assessment Year", s(ti.assessmentYear)),
        field("Tax Year", s(ti.year)),
        field("Market Total Value", dollars(ti.marketValue)),
        field("Market Land Value", dollars(ti.marketLandValue)),
        field("Market Improvement Value", dollars(ti.marketImprovementValue)),
        field("Property Tax", dollars(ti.taxAmount)),
        field("Tax Delinquent Year", s(ti.taxDelinquentYear)),
        field(
          "Improvement to Tax Value",
          assessedImpr && assessed && assessedImpr <= assessed
            ? `${((assessedImpr * 100) / assessed).toFixed(3)}%`
            : null,
        ),
        field("Homestead Exemption", enriched ? yesNo(pi.taxExemptionHomeownerFlag) : null),
      ]),
    ]),
    section("HOA Information", [hoaGroups(raw)]),
    transferSection("Last Non-Arm's Length Ownership Transfer", lastNonArms, mortgages, oi),
    transferSection(
      "Last Arm's Length Sale Information",
      lastArms ?? (Object.keys(last).length ? last : null),
      mortgages,
      oi,
    ),
  ].filter(notNull);

  // --- The other tabs ------------------------------------------------------
  const foreclosure: Tab = {
    id: "foreclosure",
    label: "Foreclosure Details",
    sections: [
      section("Distress Flags", [
        group(undefined, [
          field("Pre-Foreclosure", yesNo(raw.preForeclosure)),
          field("Auction", yesNo(raw.auction)),
          field("Notice Type", s(raw.noticeType)),
          field("Trustee Sale", yesNo(raw.trusteeSale)),
          field("Sheriff's Deed", yesNo(raw.sheriffsDeed)),
          field("Bank Owned", yesNo(raw.bankOwned)),
          field("Tax Lien", yesNo(raw.taxLien)),
          field("Judgment", yesNo(raw.judgment)),
          field("Deed in Lieu", yesNo(raw.deedInLieu)),
          field("Quit Claim", yesNo(raw.quitClaim)),
          field("Inherited", yesNo(raw.inherited)),
          field("Death", yesNo(raw.death)),
        ]),
      ]),
    ].filter(notNull),
    tables: [
      table("Foreclosure Filings", foreclosures, [
        ["Recorded", (e) => usDate(e.recordingDate)],
        ["Document", (e) => s(e.documentType)],
        ["Notice", (e) => s(e.noticeType)],
        ["Case #", (e) => s(e.caseNumber)],
        ["Auction Date", (e) => usDate(e.auctionDate)],
        ["Opening Bid", (e) => dollars(e.openingBid)],
        ["Default Amount", (e) => dollars(e.defaultAmount)],
        ["Judgment", (e) => dollars(e.judgmentAmount)],
        ["Lender", (e) => s(e.lenderName)],
        ["Trustee", (e) => s(e.trusteeFullName)],
        ["Trustee Phone", (e) => s(e.trusteePhone)],
        ["Active", (e) => yesNo(e.active)],
      ]),
    ].filter(notNull),
  };

  const mls: Tab = {
    id: "mls",
    label: "MLS Details",
    sections: [
      section("Listing", [
        group(undefined, [
          field("Status", s(raw.mlsStatus) ?? (raw.mlsActive === true ? "Active" : null)),
          field("Listing Date", usDate(raw.mlsListingDate)),
          field("Listing Price", dollars(raw.mlsListingPrice)),
          field("Price / SqFt", dollars(raw.mlsListingPricePerSquareFoot)),
          field("Days on Market", count(raw.mlsDaysOnMarket)),
          field("Sold Price", dollars(raw.mlsSoldPrice)),
          field("Last Sale Date", usDate(raw.mlsLastSaleDate)),
          field("Last Status Date", usDate(raw.mlsLastStatusDate)),
          field("Failed Date", usDate(raw.mlsFailedDate)),
          field("Has Photos", raw.mlsHasPhotos === true ? "Yes" : null),
        ]),
      ]),
    ].filter(notNull),
    tables: [
      table("MLS History", arr(raw.mlsHistory), [
        ["Date", (e) => usDate(pick(e, "statusDate", "date", "listingDate"))],
        ["Status", (e) => s(e.status)],
        ["Price", (e) => dollars(pick(e, "price", "listingPrice"))],
        ["Days on Market", (e) => count(e.daysOnMarket)],
        ["Agent", (e) => s(pick(e, "agentName", "listingAgentName"))],
        ["Office", (e) => s(pick(e, "agentOffice", "listingOfficeName"))],
      ]),
    ].filter(notNull),
  };

  const demographics: Tab = {
    id: "demographics",
    label: "Demographics",
    sections: [
      section("Area", [
        group(undefined, [
          field("HUD Area", s(demo.hudAreaName)),
          field("Median Income", dollars(demo.medianIncome)),
          field("Suggested Rent", dollars(demo.suggestedRent)),
          field("FMR Year", s(demo.fmrYear)),
        ]),
        group("Fair Market Rents", [
          field("Efficiency", dollars(demo.fmrEfficiency)),
          field("1 Bedroom", dollars(demo.fmrOneBedroom)),
          field("2 Bedroom", dollars(demo.fmrTwoBedroom)),
          field("3 Bedroom", dollars(demo.fmrThreeBedroom)),
          field("4 Bedroom", dollars(demo.fmrFourBedroom)),
        ]),
      ]),
    ].filter(notNull),
    tables: [
      table("Schools", arr(raw.schools), [
        ["School", (e) => s(e.name)],
        ["Type", (e) => s(e.type)],
        ["Grades", (e) => s(e.grades)],
        ["Rating", (e) => s(e.rating)],
        ["Distance", (e) => s(e.distance)],
        ["Enrollment", (e) => count(e.enrollment)],
      ]),
    ].filter(notNull),
  };

  const tax: Tab = {
    id: "tax",
    label: "Tax Information",
    sections: [details.find((x) => x.title === "Tax Assessment Information") ?? null].filter(notNull),
    tables: [],
  };

  const history: Tab = {
    id: "history",
    label: "Mortgage & Transaction History",
    sections: [],
    tables: [
      table("Open Mortgages", current, mortgageCols),
      table("Mortgage History", arr(raw.mortgageHistory), mortgageCols),
      table("Sale History", sales, [
        ["Sale Date", (e) => usDate(e.saleDate)],
        ["Recorded", (e) => usDate(e.recordingDate)],
        ["Amount", (e) => dollars(e.saleAmount)],
        ["Document", (e) => s(e.documentType)],
        ["Doc #", (e) => s(e.documentNumber)],
        ["Arm's Length", (e) => yesNo(e.armsLength)],
        ["Method", (e) => s(e.purchaseMethod)],
        ["Buyer", (e) => s(e.buyerNames)],
        ["Seller", (e) => s(e.sellerNames)],
      ]),
    ].filter(notNull),
  };

  const tabs: Tab[] = [
    { id: "details", label: "Property Details", sections: details, tables: [] },
    ...(enriched ? [foreclosure, mls, demographics, tax, history] : []),
  ];

  return { facts, status, value, debt, lastSale, opportunity, enriched, tabs };
}

const mortgageCols: [string, (e: O) => string | null][] = [
  ["Recorded", (e) => usDate(pick(e, "recordingDate", "documentDate"))],
  ["Position", (e) => s(e.position)],
  ["Amount", (e) => dollars(e.amount)],
  ["Type", (e) => s(pick(e, "loanType", "deedType"))],
  ["Lender", (e) => s(e.lenderName)],
  ["Rate", (e) => (n(e.interestRate) ? `${n(e.interestRate)}%` : null)],
  ["Rate Type", (e) => s(e.interestRateType)],
  ["Term", (e) => count(e.term)],
  ["Maturity", (e) => usDate(e.maturityDate)],
  ["Doc #", (e) => s(e.documentNumber)],
  ["Open", (e) => yesNo(e.open)],
];
