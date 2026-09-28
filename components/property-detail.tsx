/**
 * The full property record, as ATTOM or RealEstateAPI returns it.
 *
 * `expandedprofile` comes back with 179 populated fields across ownership,
 * construction, utilities, parking, survey geography, tax assessment, sale
 * history and mortgage — and until this component existed the lot page showed
 * about eight of them. The rest were fetched, paid for, stored in
 * `lot_valuations.raw`, and never rendered.
 *
 * Read straight from `raw` rather than from columns. Promoting 179 fields to
 * columns would be a migration for every one of them and a schema that has to
 * track a vendor's payload shape; the columns that exist are the ones something
 * queries or sorts on. Display only needs to read.
 *
 * Fields with no value are omitted rather than drawn as a dash. A record for a
 * bare parcel of Arkansas timber legitimately has no roof cover, and a page
 * that lists thirty blanks to prove it buries the six figures that matter.
 */
import { money, num } from "@/lib/format";

/** A dotted path into the raw payload. */
function at(raw: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[k];
  }, raw);
}

type Fmt =
  | "text"
  | "money"
  | "number"
  | "date"
  | "acres"
  | "sqft"
  | "percent"
  | "yesno"
  /** A flag where "no" is an answer too — owner-occupied, corporate, absentee. */
  | "bool"
  /** Money where $0 is a real figure: an open mortgage of $0 means none. */
  | "money0"
  /**
   * Printed exactly as stored.
   *
   * For anything where casing is data rather than shouting: the sentence-caser
   * turned "MABELVALE, AR 72103" into "Mabelvale, Ar 72103", which is a mangled
   * postal address on a page whose point is that you can act on what it says.
   */
  | "verbatim";

interface FieldSpec {
  label: string;
  path: string | string[];
  fmt?: Fmt;
  /** Built from several fields — an owner's first and last name. Wins over `path`. */
  compute?: (raw: Record<string, unknown>) => unknown;
}

interface SectionSpec {
  title: string;
  /** Open by default. The rest fold away — see the note on scannability. */
  open?: boolean;
  fields: FieldSpec[];
}

/*
 * ATTOM's own paths, in the order a bidder reads them.
 *
 * Several fields carry more than one path because ATTOM spells the same thing
 * differently across records — `baths` sits at the top level on some payloads
 * and under `building.rooms.bathsTotal` on others. First populated path wins.
 */
const ATTOM_SECTIONS: SectionSpec[] = [
  {
    title: "Ownership",
    open: true,
    fields: [
      { label: "Owner 1", path: "assessment.owner.owner1.fullName" },
      { label: "Owner 2", path: "assessment.owner.owner2.fullName" },
      { label: "Owner type", path: "assessment.owner.description" },
      { label: "Mailing address", path: "assessment.owner.mailingAddressOneLine", fmt: "verbatim" },
      // The single most actionable field here: an absentee owner is the one you
      // can reach by post before the sale.
      { label: "Absentee", path: "summary.absenteeInd" },
      { label: "Trust", path: "assessment.owner.owner1.trustIndicator" },
    ],
  },
  {
    title: "Tax assessment",
    open: true,
    fields: [
      { label: "Assessed total", path: "assessment.assessed.assdTtlValue", fmt: "money" },
      { label: "Assessed land", path: "assessment.assessed.assdLandValue", fmt: "money" },
      {
        label: "Assessed improvement",
        path: "assessment.assessed.assdImprValue",
        fmt: "money",
      },
      { label: "Market total", path: "assessment.market.mktTtlValue", fmt: "money" },
      { label: "Market land", path: "assessment.market.mktLandValue", fmt: "money" },
      { label: "Market improvement", path: "assessment.market.mktImprValue", fmt: "money" },
      { label: "Property tax", path: "assessment.tax.taxAmt", fmt: "money" },
      { label: "Tax year", path: "assessment.tax.taxYear" },
      { label: "Tax per sqft", path: "assessment.tax.taxPerSizeUnit", fmt: "money" },
      { label: "Improvement %", path: "assessment.improvementPercent", fmt: "percent" },
      // Why the parcel is in a tax sale at all.
      { label: "Delinquent since", path: "assessment.delinquentyear" },
      { label: "Homeowner exemption", path: "assessment.tax.exemptiontype.Homeowner" },
      { label: "Tax code area", path: "area.taxCodeArea" },
    ],
  },
  {
    title: "Property characteristics",
    open: true,
    fields: [
      { label: "Property type", path: "summary.propertyType" },
      { label: "Class", path: "summary.propClass" },
      { label: "Land use", path: "summary.propLandUse" },
      { label: "Architecture", path: "summary.archStyle" },
      { label: "Year built", path: "summary.yearBuilt" },
      { label: "Major improvements", path: "building.construction.propertyStructureMajorImprovementsYear" },
      { label: "Beds", path: "building.rooms.beds", fmt: "number" },
      { label: "Baths (total)", path: ["building.rooms.bathsTotal", "baths"] },
      { label: "Baths (full)", path: "building.rooms.bathsFull" },
      { label: "Baths (partial)", path: "building.rooms.bathsPartial" },
      { label: "Stories", path: "building.summary.levels" },
      { label: "Condition", path: "building.construction.condition" },
      { label: "Construction", path: "building.construction.constructionType" },
      { label: "Frame", path: "building.construction.frameType" },
      { label: "Walls", path: "building.construction.wallType" },
      { label: "Roof cover", path: "building.construction.roofCover" },
      { label: "Roof shape", path: "building.construction.roofShape" },
      { label: "Floors", path: "building.interior.floors" },
      { label: "Heating", path: "utilities.heatingType" },
      { label: "Cooling", path: "utilities.coolingType" },
      { label: "Fireplaces", path: "building.interior.fplcCount", fmt: "number" },
      { label: "Pool", path: "lot.poolType" },
      { label: "Parking", path: ["building.parking.garageType", "building.parking.prkgType"] },
      { label: "Parking spaces", path: "building.parking.prkgSpaces" },
      { label: "Parking size", path: "building.parking.prkgSize", fmt: "sqft" },
    ],
  },
  {
    title: "Building size",
    fields: [
      { label: "Living area", path: "building.size.livingSize", fmt: "sqft" },
      { label: "Building area", path: "building.size.bldgSize", fmt: "sqft" },
      { label: "Gross area", path: "building.size.grossSize", fmt: "sqft" },
      { label: "Ground floor", path: "building.size.groundFloorSize", fmt: "sqft" },
      { label: "Universal size", path: "building.size.universalSize", fmt: "sqft" },
      { label: "Measured as", path: "building.size.sizeInd" },
    ],
  },
  {
    title: "Land & location",
    fields: [
      { label: "APN", path: "identifier.apn" },
      { label: "ATTOM ID", path: "identifier.attomId" },
      { label: "Lot size", path: "lot.lotSize1", fmt: "acres" },
      { label: "Lot area", path: "lot.lotSize2", fmt: "sqft" },
      { label: "Frontage", path: "lot.frontage" },
      { label: "Depth", path: "lot.depth" },
      { label: "Zoning", path: "lot.zoningType" },
      { label: "Lot number", path: "lot.lotNum" },
      { label: "Block", path: "area.blockNum" },
      { label: "Subdivision", path: "area.subdName" },
      { label: "Municipality", path: "area.munName" },
      { label: "County", path: "area.countrySecSubd" },
      { label: "Census tract", path: "area.censusTractIdent" },
      { label: "Census block group", path: "area.censusBlockGroup" },
      // Section-township-range: how rural parcels are actually identified.
      { label: "Section", path: "area.srvySection" },
      { label: "Township", path: "area.srvyTownship" },
      { label: "Range", path: "area.srvyRange" },
      { label: "Latitude", path: "location.latitude" },
      { label: "Longitude", path: "location.longitude" },
    ],
  },
  {
    title: "Last recorded sale",
    fields: [
      { label: "Sale amount", path: "sale.amount.saleAmt", fmt: "money" },
      { label: "Price per sqft", path: "sale.calculation.pricePerSizeUnit", fmt: "money" },
      { label: "Recorded", path: "sale.amount.saleRecDate", fmt: "date" },
      { label: "Transaction date", path: "sale.saleTransDate", fmt: "date" },
      { label: "Transaction type", path: "sale.amount.saleTransType" },
      { label: "Document number", path: "sale.amount.saleDocNum" },
      { label: "Deed type", path: "assessment.mortgage.FirstConcurrent.deedType" },
      { label: "Sale code", path: "sale.amount.saleCode" },
      { label: "Seller", path: "sale.sellerName" },
      // Two flags that change what you are buying.
      { label: "REO", path: "summary.REOflag" },
      { label: "Quit claim", path: "summary.quitClaimFlag" },
    ],
  },
  {
    title: "Mortgage on record",
    fields: [
      { label: "First mortgage", path: "assessment.mortgage.FirstConcurrent.amount", fmt: "money" },
      { label: "Second mortgage", path: "assessment.mortgage.SecondConcurrent.amount", fmt: "money" },
      { label: "Title company", path: "assessment.mortgage.title.companyName" },
    ],
  },
];

/*
 * RealEstateAPI's standard Property Search record: flat keys, booleans as
 * booleans, several money figures as strings. Ordered for a tax-sale bidder —
 * what the owner stands to lose and whether they are likely to pay, before
 * what the house is made of.
 */
const REAPI_SECTIONS: SectionSpec[] = [
  {
    title: "Value, equity & mortgage",
    open: true,
    fields: [
      { label: "Estimated value", path: "estimatedValue", fmt: "money" },
      { label: "Estimated equity", path: "estimatedEquity", fmt: "money0" },
      { label: "Equity", path: "equityPercent", fmt: "percent" },
      { label: "Open mortgage balance", path: "openMortgageBalance", fmt: "money0" },
      { label: "Est. mortgage payment", path: "estimatedMortgagePayment", fmt: "money" },
      { label: "Last mortgage amount", path: "lastMortgage1Amount", fmt: "money" },
      { label: "Lender", path: "lenderName" },
      { label: "High equity", path: "highEquity", fmt: "bool" },
      { label: "Negative equity", path: "negativeEquity", fmt: "yesno" },
      { label: "Free and clear", path: "freeClear", fmt: "yesno" },
      { label: "Adjustable rate", path: "adjustableRate", fmt: "yesno" },
      { label: "Assumable", path: "assumable", fmt: "yesno" },
      { label: "Private lender", path: "privateLender", fmt: "yesno" },
    ],
  },
  {
    title: "Distress & auction",
    open: true,
    fields: [
      { label: "Auction", path: "auction", fmt: "yesno" },
      { label: "Auction date", path: "auctionDate", fmt: "date" },
      { label: "Foreclosure", path: "foreclosure", fmt: "yesno" },
      { label: "Pre-foreclosure", path: "preForeclosure", fmt: "yesno" },
      { label: "Notice type", path: "noticeType" },
      { label: "Last recorded document", path: "documentType" },
      { label: "Tax lien", path: "taxLien", fmt: "yesno" },
      { label: "Tax delinquent year", path: "taxDelinquentYear" },
      { label: "Judgment", path: "judgment", fmt: "yesno" },
      { label: "REO", path: "reo", fmt: "yesno" },
      { label: "Owner deceased", path: "death", fmt: "yesno" },
      { label: "Inherited", path: "inherited", fmt: "yesno" },
      { label: "Vacant", path: "vacant", fmt: "bool" },
    ],
  },
  {
    title: "Ownership",
    open: true,
    fields: [
      {
        label: "Owner",
        path: "companyName",
        compute: (r) =>
          r.companyName || [r.owner1FirstName, r.owner1LastName].filter(Boolean).join(" "),
      },
      {
        label: "Owner 2",
        path: "owner2LastName",
        compute: (r) => [r.owner2FirstName, r.owner2LastName].filter(Boolean).join(" "),
      },
      { label: "Mailing address", path: "mailAddress.address", fmt: "verbatim" },
      { label: "Owner occupied", path: "ownerOccupied", fmt: "bool" },
      { label: "Absentee owner", path: "absenteeOwner", fmt: "bool" },
      { label: "Out-of-state owner", path: "outOfStateAbsenteeOwner", fmt: "yesno" },
      { label: "Corporate owned", path: "corporateOwned", fmt: "bool" },
      { label: "Cash buyer", path: "cashBuyer", fmt: "yesno" },
      { label: "Investor buyer", path: "investorBuyer", fmt: "yesno" },
      { label: "Years owned", path: "yearsOwned", fmt: "number" },
      { label: "Properties owned", path: "totalPropertiesOwned", fmt: "number" },
      { label: "Portfolio value", path: "totalPortfolioValue", fmt: "money" },
      { label: "Portfolio equity", path: "totalPortfolioEquity", fmt: "money" },
      { label: "Portfolio mortgages", path: "totalPortfolioMortgageBalance", fmt: "money" },
      { label: "Bought, last 12 months", path: "portfolioPurchasedLast12Months", fmt: "number" },
    ],
  },
  {
    title: "Property characteristics",
    open: true,
    fields: [
      { label: "Property use", path: "propertyUse" },
      { label: "Land use", path: "landUse" },
      { label: "Use code", path: "propertyUseCode" },
      { label: "Year built", path: "yearBuilt" },
      { label: "Beds", path: "bedrooms", fmt: "number" },
      { label: "Baths", path: "bathrooms", fmt: "number" },
      { label: "Stories", path: "stories", fmt: "number" },
      { label: "Rooms", path: "roomsCount", fmt: "number" },
      { label: "Units", path: "unitsCount", fmt: "number" },
      { label: "Living area", path: "squareFeet", fmt: "sqft" },
      { label: "Lot area", path: "lotSquareFeet", fmt: "sqft" },
      { label: "Air conditioning", path: "airConditioningAvailable", fmt: "yesno" },
      { label: "Basement", path: "basement", fmt: "yesno" },
      { label: "Garage", path: "garage", fmt: "yesno" },
      { label: "Pool", path: "pool", fmt: "yesno" },
      { label: "Deck", path: "deck", fmt: "yesno" },
      { label: "Patio", path: "patio", fmt: "yesno" },
      { label: "HOA", path: "hoa", fmt: "yesno" },
      { label: "Roof", path: ["roofMaterial", "roofConstruction"] },
      { label: "Flood zone", path: "floodZoneType" },
    ],
  },
  {
    title: "Tax assessment",
    fields: [
      { label: "Assessed total", path: "assessedValue", fmt: "money" },
      { label: "Assessed land", path: "assessedLandValue", fmt: "money" },
      { label: "Assessed improvement", path: "assessedImprovementValue", fmt: "money" },
      { label: "Improvement %", path: "improvementValuePercent", fmt: "percent" },
    ],
  },
  {
    title: "Sale history",
    fields: [
      { label: "Last sale", path: "lastSaleDate", fmt: "date" },
      { label: "Last sale amount", path: "lastSaleAmount", fmt: "money" },
      { label: "Bought by", path: "lastSaleBuyerNames" },
      { label: "Arm's length", path: "lastSaleArmsLength", fmt: "bool" },
      { label: "Recorded", path: "recordingDate", fmt: "date" },
      { label: "Last arm's-length sale", path: "latestArmsLengthSaleDate", fmt: "date" },
      { label: "Arm's-length amount", path: "latestArmsLengthSaleAmount", fmt: "money" },
      { label: "Prior sale", path: "priorSaleDate", fmt: "date" },
      { label: "Prior sale amount", path: "priorSaleAmount", fmt: "money" },
      { label: "Prior owner", path: "priorOwner" },
      { label: "Prior owner held", path: "priorOwnerMonthsOwned", compute: (r) => r.priorOwnerMonthsOwned ? `${r.priorOwnerMonthsOwned} months` : null },
    ],
  },
  {
    title: "Rent & listing",
    fields: [
      { label: "Suggested rent", path: "suggestedRent", compute: (r) => perMonth(r.suggestedRent) },
      { label: "Rent", path: "rentAmount", compute: (r) => perMonth(r.rentAmount) },
      { label: "For sale", path: "forSale", fmt: "yesno" },
      { label: "MLS status", path: "mlsStatus" },
      { label: "MLS type", path: "mlsType" },
      { label: "Listed", path: "mlsListingDate", fmt: "date" },
      { label: "List price", path: ["mlsListingPrice", "listingAmount"], fmt: "money" },
      { label: "Sold price", path: "mlsSoldPrice", fmt: "money" },
      { label: "MLS last sale", path: "mlsLastSaleDate", fmt: "date" },
      { label: "Days on market", path: "mlsDaysOnMarket", fmt: "number" },
      { label: "Price reduced", path: "priceReduced", fmt: "yesno" },
    ],
  },
  {
    title: "Location",
    fields: [
      { label: "APN", path: "apn", fmt: "verbatim" },
      { label: "RealEstateAPI ID", path: "id", fmt: "verbatim" },
      { label: "Neighborhood", path: "neighborhood.name" },
      { label: "Median income", path: "medianIncome", fmt: "money" },
      { label: "County", path: "address.county" },
      { label: "Latitude", path: "latitude", compute: (r) => coord(r.latitude) },
      { label: "Longitude", path: "longitude", compute: (r) => coord(r.longitude) },
    ],
  },
];

function perMonth(v: unknown): string | null {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n > 0 ? `${money(n)}/mo` : null;
}

/** Six places is about ten centimetres — anything past it is noise. */
function coord(v: unknown): string | null {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? n.toFixed(6) : null;
}

const SECTIONS: Record<"attom" | "realestateapi", SectionSpec[]> = {
  attom: ATTOM_SECTIONS,
  realestateapi: REAPI_SECTIONS,
};

function fmtValue(v: unknown, fmt: Fmt = "text"): string | null {
  if (fmt === "bool" && typeof v === "boolean") return v ? "Yes" : "No";
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  // ATTOM writes these as strings and they mean "we checked and it is not".
  if (/^(false|none available|not a trust|n\/a)$/i.test(s.trim())) return null;

  switch (fmt) {
    case "money": {
      const n = Number(v);
      return Number.isFinite(n) && n !== 0 ? money(n) : null;
    }
    case "money0": {
      const n = Number(v);
      return Number.isFinite(n) ? money(n) : null;
    }
    case "number":
    case "sqft": {
      const n = Number(v);
      if (!Number.isFinite(n) || n === 0) return null;
      return fmt === "sqft" ? `${num(n)} sqft` : num(n);
    }
    case "acres": {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? `${n} acres` : null;
    }
    case "percent": {
      const n = Number(v);
      return Number.isFinite(n) && n !== 0 ? `${n}%` : null;
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
    case "bool":
    case "yesno":
      return /^(y|yes|true)$/i.test(s) ? "Yes" : null;
    case "verbatim":
      return s;
    default:
      // ATTOM shouts. Sentence-case anything fully capitalised and longer than
      // an abbreviation, and leave APNs, codes and "SFR" alone.
      return s === s.toUpperCase() && s.length > 4 && /[A-Z]{2,}\s/.test(`${s} `)
        ? s
            .toLowerCase()
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .replace(/\bOf\b|\bAnd\b|\bThe\b/g, (m) => m.toLowerCase())
        : s;
  }
}

function resolve(raw: Record<string, unknown>, f: FieldSpec): string | null {
  if (f.compute) return fmtValue(f.compute(raw), f.fmt);
  const paths = Array.isArray(f.path) ? f.path : [f.path];
  for (const p of paths) {
    const v = fmtValue(at(raw, p), f.fmt);
    if (v !== null) return v;
  }
  return null;
}

export function PropertyDetail({
  raw,
  source = "attom",
}: {
  raw: Record<string, unknown> | null;
  source?: "attom" | "realestateapi";
}) {
  if (!raw || Object.keys(raw).length === 0) return null;

  const sections = SECTIONS[source].map((s) => ({
    ...s,
    values: s.fields
      .map((f) => ({ label: f.label, value: resolve(raw, f) }))
      .filter((f): f is { label: string; value: string } => f.value !== null),
  })).filter((s) => s.values.length > 0);

  if (sections.length === 0) return null;

  const legal = source === "attom" ? fmtValue(at(raw, "summary.legal1")) : null;

  /*
   * No field count and no vendor line.
   *
   * "57 fields from ATTOM · published 2025-12-12" answered a question nobody
   * reading a parcel page has. The count measures the payload rather than the
   * property, the vendor is an implementation detail, and the publish date was
   * routinely mistaken for the sale or assessment date sitting inches above it.
   *
   * Provenance still appears where it belongs — on the valuation card, against
   * the figure it actually qualifies.
   */
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">Full property record</h3>
      </div>

      <div className="space-y-4">
        {sections.map((s) =>
          s.open ? (
            <section key={s.title}>
              <h4 className="mb-2 text-xs uppercase tracking-wide text-muted">{s.title}</h4>
              <FieldGrid values={s.values} />
            </section>
          ) : (
            /* Folded by default. Roof shape matters once you are serious about a
               parcel, not while you are deciding whether to be. */
            <details key={s.title} className="group/sec">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs uppercase tracking-wide text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="transition-transform group-open/sec:rotate-90">
                  ›
                </span>
                {s.title}
                <span className="tnum lowercase tracking-normal opacity-60">
                  ({s.values.length})
                </span>
              </summary>
              <div className="mt-2">
                <FieldGrid values={s.values} />
              </div>
            </details>
          ),
        )}

        {legal ? (
          <section className="border-t border-border pt-3">
            <h4 className="mb-1 text-xs uppercase tracking-wide text-muted">
              Legal description
            </h4>
            <p className="text-xs leading-relaxed text-muted">{legal}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function FieldGrid({ values }: { values: { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {values.map((v) => (
        <div key={v.label}>
          <dt className="text-xs uppercase tracking-wide text-muted">{v.label}</dt>
          <dd className="mt-0.5 break-words">{v.value}</dd>
        </div>
      ))}
    </dl>
  );
}
