/**
 * The full property record, as ATTOM returns it.
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
const SECTIONS: SectionSpec[] = [
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

function fmtValue(v: unknown, fmt: Fmt = "text"): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  // ATTOM writes these as strings and they mean "we checked and it is not".
  if (/^(false|none available|not a trust|n\/a)$/i.test(s.trim())) return null;

  switch (fmt) {
    case "money": {
      const n = Number(v);
      return Number.isFinite(n) && n !== 0 ? money(n) : null;
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
  const paths = Array.isArray(f.path) ? f.path : [f.path];
  for (const p of paths) {
    const v = fmtValue(at(raw, p), f.fmt);
    if (v !== null) return v;
  }
  return null;
}

export function PropertyDetail({ raw }: { raw: Record<string, unknown> | null }) {
  if (!raw || Object.keys(raw).length === 0) return null;

  const sections = SECTIONS.map((s) => ({
    ...s,
    values: s.fields
      .map((f) => ({ label: f.label, value: resolve(raw, f) }))
      .filter((f): f is { label: string; value: string } => f.value !== null),
  })).filter((s) => s.values.length > 0);

  if (sections.length === 0) return null;

  const legal = fmtValue(at(raw, "summary.legal1"));
  const vintage = fmtValue(at(raw, "vintage.pubDate"), "date");
  const total = sections.reduce((n, s) => n + s.values.length, 0);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Full property record</h3>
        <span className="text-xs text-muted">
          {num(total)} fields from ATTOM
          {vintage ? ` · published ${vintage}` : ""}
        </span>
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
