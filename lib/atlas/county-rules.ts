import type { CountyRule } from "./types";

// County-level tax sale due diligence — researched individually per county,
// following the Tax Sale Due Diligence Template (statutory framework,
// auction logistics, authority contacts, advanced due diligence, and a
// dated market-growth note). Keyed by 5-digit county FIPS (state FIPS +
// 3-digit county FIPS, matching counties-albers-10m.json feature ids).
//
// A county with NO entry here falls back to its state's STATE_DATA
// defaults in app.js (with an on-page "showing state-level defaults"
// flag) — that fallback is honest, not a bug, until this file grows.
//
// Every entry MUST carry `asOf` (YYYY-MM, when the auction
// logistics/contacts/growth note were last checked) and `sources`
// (array of URLs) — office holders, platform URLs, and deposit rules
// change; never assert them without a check date and a source trail.
// `growthNeighborhoods` is a read on trend, not a guarantee — treat it
// the same way: dated, sourced, and framed as directional, not certain.
// Named individual officeholders are deliberately NOT included (they
// change with elections); offices are linked by title/URL/phone instead.
//
// Batch 1 (2026-07): the 5 largest counties nationally, chosen for
// population + type diversity (Tax Deed / Tax Lien / Redeemable Deed /
// Hybrid) to establish the research pattern before further batches.
//
// Batch 2 (2026-07): the user's own source document, "A Comprehensive
// 50-State Report on Real Property Tax Auction Systems" (Ed Mitchell,
// accessed 2025-07-07 per its own citations; /Users/fayehall/Downloads/
// 50 State Tax Sale Data Compilation(1).doc). That document covers 29
// states in full (Alabama through New Hampshire, alphabetically) with a
// per-state "Key County Auction Details" table for each state's most
// populous counties. Fields populated here (auctionFormat/auctionPlatform/
// auctionFrequency/taxCollector) are exactly what that table provides;
// fields it doesn't cover (clerkOfCourt, propertyAppraiser, gisMap,
// survivingLiens, quietTitle, growthNeighborhoods) are deliberately left
// unset rather than invented — they still fall back to the state defaults
// / render as empty, same as any other county. New Jersey through Wyoming
// (21 states, alphabetically after New Hampshire) are NOT in that source
// document and still need separate research.
// Some states (CT, ME, MA, NH) run tax sales at the municipal level, not
// the county level — those entries say so explicitly rather than
// presenting one town's process as if it applies to the whole county.
//
// Batch 3 (2026-07): the remaining 21 states (New Jersey through Wyoming,
// alphabetically) not covered by the source doc — real WebSearch research
// per state, same rigor as Batch 1, each state's top 2-3 most populous
// counties by the 2024 Census estimate. Also municipal-level, not county
// (NJ, RI, VT, joining CT/ME/MA/NH above). Two live, time-sensitive flags
// surfaced during this research: New York City's entire tax lien sale
// program was suspended by Mayor Mamdani in March 2026 (Kings/Queens/New
// York counties), and Philadelphia's tax sales have been effectively
// stalled since COVID-19 (Philadelphia County) — both noted prominently
// rather than presented as normal active markets.

export const COUNTY_DATA: Record<string, CountyRule> = {
  "06037": { // Los Angeles County, CA — Tax Deed
    notes: "County-run online auction (currently GovEase; Bid4Assets was used in prior cycles — always confirm the current platform on ttc.lacounty.gov before registering). Excess-proceeds claims process applies after the sale.",
    auctionFormat: "Online",
    auctionPlatform: { label: "GovEase — Los Angeles County", url: "https://www.govease.com/los-angeles" },
    auctionFrequency: "1-2 online auctions per year (recent cycles in spring/early summer)",
    depositRules: "Register and post a deposit through GovEase in advance; deposit deadline is set per auction (e.g. the April 2026 auction's deposit deadline was April 14, 2026, 1:00pm PT) — allow up to 48 business hours for the deposit to clear.",
    taxCollector: { label: "LA County Treasurer and Tax Collector", url: "https://ttc.lacounty.gov/" },
    clerkOfCourt: { label: "LA County Registrar-Recorder/County Clerk (records deeds)", url: "https://www.lavote.gov/" },
    propertyAppraiser: { label: "LA County Assessor Portal (parcel search + GIS)", url: "https://portal.assessor.lacounty.gov/mapsearch", phone: "213-974-3211" },
    survivingLiens: "A California tax deed conveys free of most liens existing before the sale, but federal tax liens survive (the IRS keeps a 120-day post-sale redemption right), as do taxes/assessments that become payable after the sale.",
    quietTitle: "Not a statutory prerequisite, but practically required — most title insurers in California won't insure a tax-deed property without a completed quiet title action (commonly 3-6 months, $3,000-$8,000+ in legal fees), and many won't insure until a year after the deed is recorded.",
    gisMap: { label: "LA County Assessor Portal Map Search", url: "https://portal.assessor.lacounty.gov/mapsearch" },
    growthNeighborhoods: [
      { name: "West Adams", why: "Largest 8-year property-value gain in the county (~107%) per a 2025 market analysis" },
      { name: "Inglewood", why: "Major infrastructure/entertainment investment (SoFi Stadium, Intuit Dome) driving new development, transit, and jobs" },
      { name: "Culver City", why: "Cited repeatedly as combining relative affordability with beach/downtown/highway access" },
    ],
    asOf: "2026-07",
    sources: [
      "https://ttc.lacounty.gov/schedule-of-upcoming-auctions/",
      "https://ttc.lacounty.gov/wp-content/uploads/2026/03/2026A-Terms-and-Conditions.pdf",
      "https://portal.assessor.lacounty.gov/mapsearch",
      "https://www.lavote.gov/",
      "https://www.avvo.com/legal-answers/which-liens-will-survive-a-tax-deed-sale-in-califo-5155953.html",
      "https://www.taxtitleservices.com/blog/how-to-get-a-clean-title-on-tax-deed-sales/",
      "https://trueparity.com/blog/discover-the-fastest-growing-la-neighborhoods-to-watch",
    ],
  },

  "17031": { // Cook County, IL — Tax Lien
    notes: "IMPORTANT: Cook County is actively winding down its Annual Tax Sale program. Illinois Public Act 104-0460 (Feb 2026) delayed the sale originally set for August 2025, and county officials have publicly discussed phasing out property tax sales entirely in the coming years. Confirm the program's current status directly with the Treasurer before treating this as a stable, ongoing investment channel.",
    auctionFormat: "Online",
    auctionPlatform: { label: "Cook County Tax Sale (cooktaxsale.com)", url: "https://www.cooktaxsale.com/" },
    auctionFrequency: "Historically annual (fall); as of mid-2026 delayed/under active phase-out — check cookcountytreasurer.com for the current schedule",
    depositRules: "Online registration plus a collateral deposit is required in advance via cooktaxsale.com; exact deposit amount and the cleared-funds deadline are set per sale cycle.",
    taxCollector: { label: "Cook County Treasurer", url: "https://www.cookcountytreasurer.com/" },
    clerkOfCourt: { label: "Cook County Clerk (delinquent tax + redemption records)", url: "https://www.cookcountyclerkil.gov/property-taxes/tax-sales" },
    propertyAppraiser: { label: "Cook County Assessor — CookViewer parcel map", url: "https://maps.cookcountyil.gov/cookviewer/", phone: "312-443-7550" },
    survivingLiens: "The buyer receives a certificate of purchase, not the property — this is a lien sale. Owner redemption (plus statutory interest) fully extinguishes the buyer's claim; surviving-lien questions only become relevant if a tax deed is later pursued through the judicial process after redemption expires.",
    quietTitle: "A tax deed only issues after a judicial petition/notice process once the redemption period runs out — that Illinois process itself functions like a quiet-title proceeding and is a required court step, not an optional add-on.",
    gisMap: { label: "CookViewer parcel map", url: "https://maps.cookcountyil.gov/cookviewer/" },
    asOf: "2026-07",
    sources: [
      "https://www.cookcountytreasurer.com/taxsalegeneralinformation.aspx",
      "https://www.cookcountytreasurer.com/annualtaxsale.aspx",
      "https://therealdeal.com/chicago/2026/02/12/cook-county-races-clock-on-tax-sale-liability/",
      "https://www.cooktaxsale.com/",
      "https://www.cookcountyclerkil.gov/property-taxes/tax-sales",
      "https://maps.cookcountyil.gov/cookviewer/",
    ],
  },

  "48201": { // Harris County, TX — Redeemable Deed
    notes: "Eight precinct Constables run simultaneous in-person auctions on behalf of the county; property lists are published on hctax.net ahead of each sale.",
    auctionFormat: "In-person",
    auctionPlatform: { label: "Harris County Tax Office — sale listings + pre-registration", url: "https://www.hctax.net/Property/TaxSales" },
    auctionFrequency: "First Tuesday of every month, 10:00am-4:00pm (Bayou City Event Center, Houston)",
    depositRules: "No advance cash deposit — winning bidders pay in cash or certified funds (cashier's check) on the day of sale. Online pre-registration is available, but bidding itself happens in person.",
    taxCollector: { label: "Harris County Tax Assessor-Collector", url: "https://www.hctax.net/" },
    clerkOfCourt: { label: "Harris County Clerk (real property records)", url: "https://www.cclerk.hctx.net/" },
    propertyAppraiser: { label: "Harris Central Appraisal District (HCAD) Parcel Viewer", url: "https://arcweb.hcad.org/parcel-viewer-v2.0/" },
    survivingLiens: "HOA/POA liens can survive the tax sale in Texas if the association recorded its lien before the sale and the taxing authorities failed to join/notify it in the foreclosure suit — check deed records for recorded association liens before bidding.",
    quietTitle: "Not legally mandatory, but title companies generally require a completed suit-to-quiet-title (with a court order) before insuring, since the redeeming former owner's rights and any un-joined lienholders create real title risk until cleared.",
    gisMap: { label: "HCAD Parcel Viewer", url: "https://arcweb.hcad.org/parcel-viewer-v2.0/" },
    asOf: "2026-07",
    sources: [
      "https://www.hctax.net/About/Announcements/Tax%20Sale%20FAQs.pdf",
      "https://www.hctax.net/Property/TaxSales",
      "https://hcad.org/",
      "https://www.justanswer.com/real-estate-law/ceqcz-bought-lot-tax-sale-texas-poa-hoa.html",
      "https://www.avvo.com/legal-answers/on-a-property-acquired-at-tax-deed-county-auction--3110239.html",
    ],
  },

  "04013": { // Maricopa County, AZ — Tax Lien
    notes: "Online lien auction run through Real Auction; unsold liens can be purchased directly from the Treasurer afterward ('over the counter').",
    auctionFormat: "Online",
    auctionPlatform: { label: "Real Auction — Maricopa", url: "https://maricopa.arizonataxsale.com" },
    auctionFrequency: "Annual, typically held in February (bidding window opens mid-January)",
    depositRules: "Register with Real Auction and obtain a bidder number (allow 24-48 hours) before the sale; Real Auction handles deposits directly — call Real Auction (954-734-7401 / 877-361-7325) for the current deposit amount and deadline.",
    taxCollector: { label: "Maricopa County Treasurer", url: "https://treasurer.maricopa.gov/", phone: "602-506-8511" },
    clerkOfCourt: { label: "Maricopa County Recorder", url: "https://recorder.maricopa.gov/", phone: "602-506-3535" },
    propertyAppraiser: { label: "Maricopa County Assessor Parcel Viewer", url: "https://maps.mcassessor.maricopa.gov/" },
    survivingLiens: "Buying a lien does not convey the property — it's a certificate of purchase. The owner can redeem at any point before a treasurer's deed is applied for (after 3 years), so no lien is 'cleared' at the certificate stage. Once a treasurer's deed does issue, most private liens are cleared, but state/federal liens can survive.",
    quietTitle: "Arizona treasurer's deeds are widely regarded as weak title; most investors pursue a quiet title action before attempting to sell or insure the property, even though it isn't always a strict legal prerequisite to holding the deed.",
    gisMap: { label: "Maricopa County Assessor Parcel Viewer", url: "https://maps.mcassessor.maricopa.gov/" },
    asOf: "2026-07",
    sources: [
      "https://treasurer.maricopa.gov/TaxLien",
      "https://treasurer.maricopa.gov/Pages/LoadPage?page=LiensAndResearch",
      "https://www.withpavilion.com/solicitations/983f432e-c874-4e6f-bfec-3faaf2dfe302/contracts/maricopa-county_230169_realauction-com-llc",
      "https://maps.mcassessor.maricopa.gov/",
      "https://recorder.maricopa.gov/",
    ],
  },

  "12086": { // Miami-Dade County, FL — Hybrid
    notes: "Two-stage Florida system: (1) the Tax Collector runs an annual tax certificate sale on delinquent parcels (starting ~June 1); (2) if unredeemed, the certificate holder can apply for a tax deed, and the Clerk of Courts runs a separate deed auction for that specific parcel.",
    auctionFormat: "Online",
    auctionPlatform: { label: "Tax deed sales: RealForeclose (Clerk of Courts)", url: "https://www.miamidade.realforeclose.com/" },
    auctionFrequency: "Tax deed sales run on a rolling, as-scheduled basis (individual parcels list as certificates mature); the annual tax certificate sale begins around June 1",
    depositRules: "Register and post a deposit on RealForeclose before bidding; exact deposit amount is posted per sale. See the Clerk's Administrative Order 13-05 (Electronic Tax Deed Sales Procedures) for current bidding rules.",
    taxCollector: { label: "Miami-Dade County Tax Collector", url: "https://mdctaxcollector.gov/" },
    clerkOfCourt: { label: "Miami-Dade Clerk of Courts (tax deed sales)", url: "https://www.miamidadeclerk.gov/clerk/property-tax-deeds.page" },
    propertyAppraiser: { label: "Miami-Dade Property Appraiser (parcel search + GIS)", url: "https://www.miamidade.gov/pa/" },
    survivingLiens: "A Florida tax deed extinguishes most private mortgages and liens, but does not clear governmental liens (code enforcement, municipal liens) or IRS liens (120-day federal redemption right) — run a lien search with the county/city before bidding.",
    quietTitle: "Under Florida Statute 95.192(1), a tax deed holder who continuously owns the property and pays taxes for 4+ years generally does not need a quiet title action for marketable/insurable title. To get insurable title sooner, a quiet title action (with a final judgment) is the standard path.",
    gisMap: { label: "Miami-Dade Property Appraiser GIS map", url: "https://www.miamidade.gov/pa/" },
    asOf: "2026-07",
    sources: [
      "https://mdctaxcollector.gov/services/tax-certificate-sales",
      "https://www.miamidade.gov/global/service.page?Mduid_service=ser1541533132033502",
      "https://www.miamidadeclerk.gov/clerk/property-tax-deeds.page",
      "https://www.miamidade.realforeclose.com/",
      "https://www.assoc-law.com/blog/2021/02/11/do-i-need-to-file-a-quiet-title-action-if-i-own-a-property-purchased-by-tax-deed-in-florida-more-than-4-years-ago/",
    ],
  },

  "01073": { // Jefferson County, AL
    type: "Tax Lien",
    auctionFormat: "Online",
    auctionPlatform: {"label":"GovEase.com"},
    auctionFrequency: "Annually in May",
    taxCollector: {"label":"Jefferson County Tax Sale","url":"https://www.jccal.org/Default.asp?ID=168&pg=Tax+Sale"},
    notes: "Alabama lets each county choose between a Sale of Land (redeemable deed) and a Sale of Lien system — Jefferson County has elected the Tax Lien system (bid-down from 12%/year).",
    asOf: "2026-07",
    sources: ["https://www.jccal.org/Default.asp?ID=168&pg=Tax+Sale"],
  },

  "01003": { // Baldwin County, AL
    type: "Tax Lien",
    auctionFormat: "Online",
    auctionPlatform: {"label":"GovEase.com"},
    auctionFrequency: "Annually between March and June",
    taxCollector: {"label":"Baldwin County Revenue Commission — Tax Lien Parcels","url":"https://baldwincountyal.gov/government/revenue-commission/divisions/collections/tax-lien-parcels"},
    notes: "Baldwin County has elected the Tax Lien system (bid-down from 12%/year) rather than the state's traditional redeemable-deed sale of land.",
    asOf: "2026-07",
    sources: ["https://baldwincountyal.gov/government/revenue-commission/divisions/collections/tax-lien-parcels"],
  },

  "01089": { // Madison County, AL
    type: "Tax Lien",
    auctionFormat: "Online",
    auctionPlatform: {"label":"GovEase.com"},
    auctionFrequency: "Annually in the first week of May",
    taxCollector: {"label":"Madison County Tax Collector — Tax Sale","url":"https://www.madisoncountyal.gov/departments/tax-collector/tax-sale"},
    notes: "Madison County has elected the Tax Lien system (bid-down from 12%/year) rather than the state's traditional redeemable-deed sale of land.",
    asOf: "2026-07",
    sources: ["https://www.madisoncountyal.gov/departments/tax-collector/tax-sale"],
  },

  "02020": { // Anchorage County, AK
    auctionFormat: "Online",
    auctionPlatform: {"label":"Municipal online auction"},
    auctionFrequency: "Annually in May (2025 dates were May 12-14)",
    taxCollector: {"label":"Municipality of Anchorage — Real Estate","url":"https://www.muni.org/Departments/hlb/Pages/default.aspx"},
    notes: "Alaska has no county government for tax sales — the Municipality of Anchorage forecloses judicially and sells at public auction 'AS IS.' The former owner keeps a right to repurchase directly from the municipality any time before the public auction (up to 10 years for unsold inventory), so a researched property can disappear from the list at the last minute.",
    asOf: "2026-07",
    sources: ["https://www.muni.org/Departments/hlb/Pages/default.aspx"],
  },

  "02170": { // Matanuska-Susitna County, AK
    auctionFormat: "Online",
    auctionPlatform: {"label":"PublicSurplus.com"},
    auctionFrequency: "Annually in late spring (2025 dates were May 19-June 4)",
    taxCollector: {"label":"Matanuska-Susitna Borough — Land Management","url":"https://matsugov.us/land"},
    notes: "Administered by the borough, not a county. Same pre-auction repurchase-right dynamic as other Alaska boroughs — see state notes.",
    asOf: "2026-07",
    sources: ["https://matsugov.us/land"],
  },

  "02090": { // Fairbanks North Star County, AK
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Sealed bid auction"},
    auctionFrequency: "Periodically (2025 sale was Sept. 10)",
    taxCollector: {"label":"Fairbanks North Star Borough — Tax Foreclosure","url":"https://www.fnsb.gov/169/Tax-Foreclosure"},
    notes: "Administered by the borough, not a county. Same pre-auction repurchase-right dynamic as other Alaska boroughs — see state notes.",
    asOf: "2026-07",
    sources: ["https://www.fnsb.gov/169/Tax-Foreclosure"],
  },

  "04019": { // Pima County, AZ
    auctionFormat: "Online",
    auctionPlatform: {"label":"RealAuction.com"},
    auctionFrequency: "Annually in late February (2025: Feb. 27)",
    taxCollector: {"label":"Pima County Treasurer — Tax Lien Sale","url":"https://www.to.pima.gov/taxLienSale/"},
    asOf: "2026-07",
    sources: ["https://www.to.pima.gov/taxLienSale/"],
  },

  "04021": { // Pinal County, AZ
    auctionFormat: "Online",
    auctionPlatform: {"label":"RealAuction.com"},
    auctionFrequency: "Annually in February",
    taxCollector: {"label":"Pinal County Treasurer","url":"https://www.pinal.gov/treasurer/Pages/Home.aspx"},
    asOf: "2026-07",
    sources: ["https://www.pinal.gov/treasurer/Pages/Home.aspx"],
  },

  "05119": { // Pulaski County, AR
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Commissioner of State Lands (statewide)"},
    auctionFrequency: "2025 date: July 10, 2025",
    taxCollector: {"label":"Commissioner of State Lands — Auction Schedule","url":"https://www.cosl.org/Home/NextYearDates"},
    notes: "Arkansas tax sales are NOT run by the county — the state Commissioner of State Lands (COSL) runs one centralized auction schedule for all 75 counties, grouped regionally.",
    asOf: "2026-07",
    sources: ["https://www.cosl.org/Home/NextYearDates"],
  },

  "05007": { // Benton County, AR
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Commissioner of State Lands (statewide)"},
    auctionFrequency: "2025 date: August 20, 2025",
    taxCollector: {"label":"Commissioner of State Lands — Auction Schedule","url":"https://www.cosl.org/Home/NextYearDates"},
    notes: "Arkansas tax sales are NOT run by the county — the state Commissioner of State Lands (COSL) runs one centralized auction schedule for all 75 counties, grouped regionally.",
    asOf: "2026-07",
    sources: ["https://www.cosl.org/Home/NextYearDates"],
  },

  "05143": { // Washington County, AR
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Commissioner of State Lands (statewide)"},
    auctionFrequency: "2025 date: August 20, 2025",
    taxCollector: {"label":"Commissioner of State Lands — Auction Schedule","url":"https://www.cosl.org/Home/NextYearDates"},
    notes: "Arkansas tax sales are NOT run by the county — the state Commissioner of State Lands (COSL) runs one centralized auction schedule for all 75 counties, grouped regionally.",
    asOf: "2026-07",
    sources: ["https://www.cosl.org/Home/NextYearDates"],
  },

  "06073": { // San Diego County, CA
    auctionFormat: "Online",
    auctionPlatform: {"label":"MyTaxSale.com"},
    auctionFrequency: "Annually in spring (e.g. May 2025)",
    taxCollector: {"label":"San Diego County Treasurer-Tax Collector — Auction","url":"https://sdttc.mytaxsale.com/"},
    asOf: "2026-07",
    sources: ["https://sdttc.mytaxsale.com/"],
  },

  "06059": { // Orange County, CA
    auctionFormat: "Online",
    auctionPlatform: {"label":"MyTaxSale.com"},
    auctionFrequency: "Periodically; registration open year-round",
    taxCollector: {"label":"Orange County Tax Auction","url":"https://octaxauction.mytaxsale.com/"},
    asOf: "2026-07",
    sources: ["https://octaxauction.mytaxsale.com/"],
  },

  "06065": { // Riverside County, CA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Varies (e.g. Bid4Assets)"},
    auctionFrequency: "Periodically; check county site",
    taxCollector: {"label":"Riverside County Tax Sale Information","url":"https://www.rivcotax.org/tax-sale-information"},
    asOf: "2026-07",
    sources: ["https://www.rivcotax.org/tax-sale-information"],
  },

  "06071": { // San Bernardino County, CA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Varies (e.g. Bid4Assets)"},
    auctionFrequency: "Periodically; check county site",
    taxCollector: {"label":"San Bernardino County Tax Sale","url":"https://www.sbcounty.gov/arc/taxcollector/sbtaxsale/Main.aspx"},
    asOf: "2026-07",
    sources: ["https://www.sbcounty.gov/arc/taxcollector/sbtaxsale/Main.aspx"],
  },

  "08041": { // El Paso County, CO
    auctionFormat: "Online",
    auctionPlatform: {"label":"RealAuction.com"},
    auctionFrequency: "Annually in October (2024: Oct. 23)",
    taxCollector: {"label":"El Paso County Treasurer — Tax Lien Sale","url":"https://treasurer.elpasoco.com/county-treasurer/tax-lien-sale/"},
    asOf: "2026-07",
    sources: ["https://treasurer.elpasoco.com/county-treasurer/tax-lien-sale/"],
  },

  "08031": { // Denver County, CO
    auctionFormat: "Online",
    auctionPlatform: {"label":"denver.coloradotaxsale.com"},
    auctionFrequency: "Annually in November (2024: Nov. 4-6)",
    taxCollector: {"label":"Denver Dept. of Finance — Tax Lien Sale","url":"https://denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Department-of-Finance/Our-Divisions/Treasury/Property-Taxes/Real-Estate-Delinquent-Taxes-and-Tax-Lien-Sale"},
    asOf: "2026-07",
    sources: ["https://denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Department-of-Finance/Our-Divisions/Treasury/Property-Taxes/Real-Estate-Delinquent-Taxes-and-Tax-Lien-Sale"],
  },

  "08005": { // Arapahoe County, CO
    auctionFormat: "Online",
    auctionPlatform: {"label":"To be announced per sale"},
    auctionFrequency: "Annually in the fall",
    taxCollector: {"label":"Arapahoe County Treasurer","url":"https://www.arapahoegov.com/treasurer"},
    asOf: "2026-07",
    sources: ["https://www.arapahoegov.com/treasurer"],
  },

  "09001": { // Fairfield County, CT
    type: "Redeemable Deed",
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Municipal public auction"},
    auctionFrequency: "Periodically (Town of Fairfield's 2024 sale was June 18, 2024)",
    taxCollector: {"label":"Town of Fairfield — Tax Collector","url":"https://fairfieldct.org/taxcollector"},
    notes: "Connecticut has counties in name only — tax sales are run by individual municipalities. Fairfield (the largest town in Fairfield County) runs a redeemable-deed public auction; other towns in this county may use a different method (judicial foreclosure or lien assignment).",
    asOf: "2026-07",
    sources: ["https://fairfieldct.org/taxcollector"],
  },

  "09003": { // Hartford County, CT
    type: "Hybrid (Lien Assignment / Judicial Foreclosure)",
    auctionFormat: "In-person",
    auctionPlatform: {"label":"N/A — RFP process for lien assignment"},
    auctionFrequency: "N/A",
    taxCollector: {"label":"City of Hartford — Tax Office","url":"https://www.hartfordct.gov/Government/Departments/Tax"},
    notes: "Connecticut has counties in name only — tax sales are run by individual municipalities. The City of Hartford (the largest city in Hartford County) assigns tax liens to private investors via an RFP process rather than a public deed auction; other towns in this county may use a different method.",
    asOf: "2026-07",
    sources: ["https://www.hartfordct.gov/Government/Departments/Tax"],
  },

  "09009": { // New Haven County, CT
    type: "Redeemable Deed",
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Varies"},
    auctionFrequency: "Announced as needed",
    taxCollector: {"label":"City of New Haven — Assessor's Office","url":"https://www.newhavenct.gov/government/departments-divisions/assessor-s-office"},
    notes: "Connecticut has counties in name only — tax sales are run by individual municipalities. New Haven (the largest city in New Haven County) uses redeemable-deed sale/foreclosure; other towns in this county may use a different method.",
    asOf: "2026-07",
    sources: ["https://www.newhavenct.gov/government/departments-divisions/assessor-s-office"],
  },

  "10003": { // New Castle County, DE
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Sheriff's sale"},
    auctionFrequency: "Second Tuesday of each month",
    taxCollector: {"label":"New Castle County — Sheriff Sales","url":"https://www.newcastlede.gov/172/Sheriff-Sales"},
    asOf: "2026-07",
    sources: ["https://www.newcastlede.gov/172/Sheriff-Sales"],
  },

  "10005": { // Sussex County, DE
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Sheriff's sale"},
    auctionFrequency: "Periodically; check county site",
    taxCollector: {"label":"Sussex County — Sheriff's Office","url":"https://www.sussexcountyde.gov/sheriffs-office"},
    asOf: "2026-07",
    sources: ["https://www.sussexcountyde.gov/sheriffs-office"],
  },

  "10001": { // Kent County, DE
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Sheriff's sale"},
    auctionFrequency: "Approximately every 3 months (e.g. July 29, 2025)",
    taxCollector: {"label":"Kent County — Sheriff's Office","url":"https://www.kentcountyde.gov/My-Government/Departments/Sheriffs-Office"},
    asOf: "2026-07",
    sources: ["https://www.kentcountyde.gov/My-Government/Departments/Sheriffs-Office"],
  },

  "12011": { // Broward County, FL
    auctionFormat: "Online",
    auctionPlatform: {"label":"broward.deedauction.net"},
    auctionFrequency: "Monthly online deed auctions",
    taxCollector: {"label":"Broward County Records, Taxes and Treasury","url":"https://www.broward.org/RecordsTaxesTreasury/Pages/Default.aspx"},
    asOf: "2026-07",
    sources: ["https://www.broward.org/RecordsTaxesTreasury/Pages/Default.aspx"],
  },

  "12099": { // Palm Beach County, FL
    auctionFormat: "Online",
    auctionPlatform: {"label":"RealAuction.com"},
    auctionFrequency: "Monthly online deed auctions",
    taxCollector: {"label":"Palm Beach Clerk & Comptroller — Tax Deed Sales","url":"https://www.mypalmbeachclerk.com/departments/courts/tax-deeds/sale-information"},
    asOf: "2026-07",
    sources: ["https://www.mypalmbeachclerk.com/departments/courts/tax-deeds/sale-information"],
  },

  "13121": { // Fulton County, GA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Courthouse steps"},
    auctionFrequency: "First Tuesday of each month (except July)",
    taxCollector: {"label":"Fulton County Sheriff — Tax Sales","url":"https://www.fultoncountyga.gov/inside-fulton-county/fulton-county-departments/sheriff/tax-sales"},
    asOf: "2026-07",
    sources: ["https://www.fultoncountyga.gov/inside-fulton-county/fulton-county-departments/sheriff/tax-sales"],
  },

  "13135": { // Gwinnett County, GA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Announced location"},
    auctionFrequency: "Periodically (e.g. Aug. 5 & Oct. 7, 2025)",
    taxCollector: {"label":"Gwinnett County Tax Commissioner — Tax Liens & Sales","url":"https://www.gwinnetttaxcommissioner.com/property-tax/delinquent_tax/tax-liens-tax-sales"},
    asOf: "2026-07",
    sources: ["https://www.gwinnetttaxcommissioner.com/property-tax/delinquent_tax/tax-liens-tax-sales"],
  },

  "13067": { // Cobb County, GA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Courthouse steps"},
    auctionFrequency: "First Tuesday of scheduled months",
    taxCollector: {"label":"Cobb County Tax Commissioner — Tax Sales","url":"https://www.cobbtax.gov/property/tax_sale/index.php"},
    asOf: "2026-07",
    sources: ["https://www.cobbtax.gov/property/tax_sale/index.php"],
  },

  "15003": { // Honolulu County, HI
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"City & County of Honolulu — Real Property Assessment","url":"https://www.realpropertyhonolulu.com/"},
    asOf: "2026-07",
    sources: ["https://www.realpropertyhonolulu.com/"],
  },

  "15001": { // Hawaii County, HI
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Hawaii County Real Property Tax Office","url":"https://www.hawaiipropertytax.com/"},
    asOf: "2026-07",
    sources: ["https://www.hawaiipropertytax.com/"],
  },

  "15009": { // Maui County, HI
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Maui County — Real Property Assessment","url":"https://www.mauicounty.gov/1953/Real-Property-Assessment-Division"},
    asOf: "2026-07",
    sources: ["https://www.mauicounty.gov/1953/Real-Property-Assessment-Division"],
  },

  "16001": { // Ada County, ID
    auctionFormat: "Online",
    auctionPlatform: {"label":"Bid4Assets (historical — confirm current method)"},
    auctionFrequency: "Periodically (an online sale was held Oct. 2017; confirm next date with the county)",
    taxCollector: {"label":"Ada County Treasurer","url":"https://adacounty.id.gov/treasurer/"},
    asOf: "2026-07",
    sources: ["https://adacounty.id.gov/treasurer/"],
  },

  "16027": { // Canyon County, ID
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Live auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Canyon County Treasurer — Tax Deed","url":"https://www.canyoncounty.id.gov/elected-officials/treasurer/tax-deed/"},
    asOf: "2026-07",
    sources: ["https://www.canyoncounty.id.gov/elected-officials/treasurer/tax-deed/"],
  },

  "16055": { // Kootenai County, ID
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Kootenai County Treasurer","url":"https://www.kcgov.us/296/Treasurer"},
    asOf: "2026-07",
    sources: ["https://www.kcgov.us/296/Treasurer"],
  },

  "17043": { // DuPage County, IL
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Automated (R.A.M.S 2)"},
    auctionFrequency: "Annually in November (2025: Nov. 20)",
    taxCollector: {"label":"DuPage County Treasurer — Tax Sale Information","url":"https://www.dupagecounty.gov/elected_officials/treasurer/tax_sale_information.php"},
    asOf: "2026-07",
    sources: ["https://www.dupagecounty.gov/elected_officials/treasurer/tax_sale_information.php"],
  },

  "17097": { // Lake County, IL
    auctionFormat: "Online",
    auctionPlatform: {"label":"realtaxdeed.com"},
    auctionFrequency: "Annually; date varies",
    taxCollector: {"label":"Lake County Clerk — Tax Deeds","url":"https://www.lakecountyclerk.org/administrative_services/tax_deeds.aspx"},
    asOf: "2026-07",
    sources: ["https://www.lakecountyclerk.org/administrative_services/tax_deeds.aspx"],
  },

  "18097": { // Marion County, IN
    auctionFormat: "Online",
    auctionPlatform: {"label":"Varies"},
    auctionFrequency: "Annually; reports published online",
    taxCollector: {"label":"Indy.gov — Tax Sale Reports","url":"https://www.indy.gov/activity/tax-sale-reports"},
    asOf: "2026-07",
    sources: ["https://www.indy.gov/activity/tax-sale-reports"],
  },

  "18089": { // Lake County, IN
    auctionFormat: "Online",
    auctionPlatform: {"label":"ZeusAuction.com / Onyx"},
    auctionFrequency: "Multiple sales per year (e.g. May 2025)",
    taxCollector: {"label":"Lake County Auditor","url":"https://www.lakecounty.in.gov/departments/auditor"},
    asOf: "2026-07",
    sources: ["https://www.lakecounty.in.gov/departments/auditor"],
  },

  "18003": { // Allen County, IN
    auctionFormat: "Online",
    auctionPlatform: {"label":"GovEase"},
    auctionFrequency: "Annually in September (2025: Sept. 24)",
    taxCollector: {"label":"Allen County Auditor — Tax Sale","url":"https://www.allencounty.in.gov/270/Tax-Sale"},
    asOf: "2026-07",
    sources: ["https://www.allencounty.in.gov/270/Tax-Sale"],
  },

  "19153": { // Polk County, IA
    auctionFormat: "Online",
    auctionPlatform: {"label":"GovEase"},
    auctionFrequency: "Third Monday in June",
    taxCollector: {"label":"Polk County Treasurer — Tax Sale Buyer Info","url":"https://www.polkcountyiowa.gov/treasurer/information-for-tax-sale-buyers/"},
    asOf: "2026-07",
    sources: ["https://www.polkcountyiowa.gov/treasurer/information-for-tax-sale-buyers/"],
  },

  "19113": { // Linn County, IA
    auctionFormat: "Online",
    auctionPlatform: {"label":"IowaTaxAuction.com"},
    auctionFrequency: "Third Monday in June",
    taxCollector: {"label":"Linn County — 2025 Tax Sale Rules","url":"https://www.linncountyiowa.gov/1842/2025-Tax-Sale-Rules"},
    asOf: "2026-07",
    sources: ["https://www.linncountyiowa.gov/1842/2025-Tax-Sale-Rules"],
  },

  "19163": { // Scott County, IA
    auctionFormat: "Online",
    auctionPlatform: {"label":"IowaTaxAuction.com"},
    auctionFrequency: "Third Monday in June",
    taxCollector: {"label":"Scott County Treasurer — Tax Sale","url":"https://www.scottcountyiowa.gov/treasurer/tax-sale"},
    asOf: "2026-07",
    sources: ["https://www.scottcountyiowa.gov/treasurer/tax-sale"],
  },

  "20091": { // Johnson County, KS
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Courthouse"},
    auctionFrequency: "Periodically (e.g. Aug. 26, 2024)",
    taxCollector: {"label":"Johnson County — Tax Foreclosure","url":"https://www.jocogov.org/department/treasury-taxation-and-vehicles/property-tax/tax-foreclosure"},
    asOf: "2026-07",
    sources: ["https://www.jocogov.org/department/treasury-taxation-and-vehicles/property-tax/tax-foreclosure"],
  },

  "20173": { // Sedgwick County, KS
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Courthouse"},
    auctionFrequency: "Periodically; check county site",
    taxCollector: {"label":"Sedgwick County Treasurer — Delinquent Real Estate","url":"https://www.sedgwickcounty.org/treasurer/delinquent-real-estate/"},
    asOf: "2026-07",
    sources: ["https://www.sedgwickcounty.org/treasurer/delinquent-real-estate/"],
  },

  "20177": { // Shawnee County, KS
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Courthouse"},
    auctionFrequency: "Periodically; check county site",
    taxCollector: {"label":"Shawnee County Sheriff — Sales","url":"https://www.snco.us/so/page/sheriff-sales"},
    asOf: "2026-07",
    sources: ["https://www.snco.us/so/page/sheriff-sales"],
  },

  "21111": { // Jefferson County, KY
    auctionFormat: "Online",
    auctionPlatform: {"label":"Lottery system"},
    auctionFrequency: "Annually in July (2025: July 18)",
    taxCollector: {"label":"Jefferson County Clerk — Delinquent Tax Lottery","url":"https://jeffersoncountyclerk.org/delinquent-tax-lottery/"},
    asOf: "2026-07",
    sources: ["https://jeffersoncountyclerk.org/delinquent-tax-lottery/"],
  },

  "21067": { // Fayette County, KY
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Master Commissioner sales"},
    auctionFrequency: "Periodically",
    taxCollector: {"label":"Fayette County Master Commissioner","url":"http://www.faycom.info/"},
    asOf: "2026-07",
    sources: ["http://www.faycom.info/"],
  },

  "21117": { // Kenton County, KY
    auctionFormat: "Online",
    auctionPlatform: {"label":"Automated sale"},
    auctionFrequency: "Annually in July (2025: July 23)",
    taxCollector: {"label":"Kenton County Clerk — Delinquent Property Tax","url":"https://kentoncountykyclerk.com/delinquent-property-tax/"},
    asOf: "2026-07",
    sources: ["https://kentoncountykyclerk.com/delinquent-property-tax/"],
  },

  "22033": { // East Baton Rouge County, LA
    auctionFormat: "Online",
    auctionPlatform: {"label":"CivicSource.com"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"East Baton Rouge Parish Sheriff","url":"https://www.ebrso.org/"},
    asOf: "2026-07",
    sources: ["https://www.ebrso.org/"],
  },

  "22051": { // Jefferson County, LA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Judicial auction"},
    auctionFrequency: "Wednesdays at 10 a.m.",
    taxCollector: {"label":"Jefferson Parish Sheriff — Judicial Auctions","url":"https://www.jpso.com/293/Judicial-Auctions-Sales"},
    asOf: "2026-07",
    sources: ["https://www.jpso.com/293/Judicial-Auctions-Sales"],
  },

  "22071": { // Orleans County, LA
    auctionFormat: "Online",
    auctionPlatform: {"label":"CivicSource.com"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"City of New Orleans — Tax Sales & Adjudications","url":"https://nola.gov/next/treasury/topics/tax-sales-adjudications/"},
    asOf: "2026-07",
    sources: ["https://nola.gov/next/treasury/topics/tax-sales-adjudications/"],
  },

  "23005": { // Cumberland County, ME
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal sale of city-owned property"},
    auctionFrequency: "As available",
    taxCollector: {"label":"City of Portland, ME","url":"https://www.portlandmaine.gov/"},
    notes: "Maine tax sales are run by individual towns/cities, not counties. Portland (the largest city in Cumberland County) lists tax-acquired property for sale as available (increasingly via licensed real estate brokers); other towns in this county may differ.",
    asOf: "2026-07",
    sources: ["https://www.portlandmaine.gov/"],
  },

  "23019": { // Penobscot County, ME
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal sale of city-owned property"},
    auctionFrequency: "As available",
    taxCollector: {"label":"City of Bangor, ME","url":"https://www.bangormaine.gov/"},
    notes: "Maine tax sales are run by individual towns/cities, not counties. Bangor (the largest city in Penobscot County) lists tax-acquired property for sale as available; other towns in this county may differ.",
    asOf: "2026-07",
    sources: ["https://www.bangormaine.gov/"],
  },

  "23031": { // York County, ME
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal sale of city-owned property"},
    auctionFrequency: "As available",
    taxCollector: {"label":"York County Registry of Deeds","url":"https://www.yorkcountymaine.gov/"},
    notes: "Maine tax sales are run by individual towns/cities, not counties — check the specific municipality within York County.",
    asOf: "2026-07",
    sources: ["https://www.yorkcountymaine.gov/"],
  },

  "24031": { // Montgomery County, MD
    auctionFormat: "Online",
    auctionPlatform: {"label":"County tax sale"},
    auctionFrequency: "Annually in June",
    taxCollector: {"label":"Montgomery County Finance — Tax Sale","url":"https://www.montgomerycountymd.gov/finance/tax-sale.html"},
    notes: "Redemption interest rate: 20% per annum (Maryland sets this per county; rates vary 6-20% statewide).",
    asOf: "2026-07",
    sources: ["https://www.montgomerycountymd.gov/finance/tax-sale.html"],
  },

  "24033": { // Prince George's County, MD
    auctionFormat: "Online",
    auctionPlatform: {"label":"County tax sale"},
    auctionFrequency: "Annually in May",
    taxCollector: {"label":"Prince George's County — Office of Finance","url":"https://www.princegeorgescountymd.gov/329/Finance"},
    notes: "Redemption interest rate: 20% per annum (Maryland sets this per county; rates vary 6-20% statewide).",
    asOf: "2026-07",
    sources: ["https://www.princegeorgescountymd.gov/329/Finance"],
  },

  "24005": { // Baltimore County, MD
    auctionFormat: "Online",
    auctionPlatform: {"label":"County tax sale"},
    auctionFrequency: "Annually in spring",
    taxCollector: {"label":"Baltimore County — Budget & Finance Tax Sale","url":"https://www.baltimorecountymd.gov/departments/budfin/taxpayer-services/tax-sale"},
    notes: "Redemption interest rate: 12% per annum (Maryland sets this per county; rates vary 6-20% statewide).",
    asOf: "2026-07",
    sources: ["https://www.baltimorecountymd.gov/departments/budfin/taxpayer-services/tax-sale"],
  },

  "25017": { // Middlesex County, MA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"City of Lowell — Treasury Office","url":"https://www.lowellma.gov/289/Treasury-Office"},
    notes: "Massachusetts tax sales ('tax titles') are run by individual cities/towns, not counties. Lowell (a major city in Middlesex County) is shown as an example; other municipalities in this county administer their own sales.",
    asOf: "2026-07",
    sources: ["https://www.lowellma.gov/289/Treasury-Office"],
  },

  "25027": { // Worcester County, MA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"City of Worcester — Liens & Auctions","url":"https://www.worcesterma.gov/finance/liens-auctions/public-auctions"},
    notes: "Massachusetts tax sales ('tax titles') are run by individual cities/towns, not counties. Worcester (the county seat) is shown as an example; other municipalities in this county administer their own sales.",
    asOf: "2026-07",
    sources: ["https://www.worcesterma.gov/finance/liens-auctions/public-auctions"],
  },

  "25009": { // Essex County, MA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Public auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"City of Lynn — Treasurer/Collector","url":"https://www.lynnma.gov/departments/treasurer_collector.shtml"},
    notes: "Massachusetts tax sales ('tax titles') are run by individual cities/towns, not counties. Lynn (a major city in Essex County) is shown as an example; other municipalities in this county administer their own sales.",
    asOf: "2026-07",
    sources: ["https://www.lynnma.gov/departments/treasurer_collector.shtml"],
  },

  "26163": { // Wayne County, MI
    auctionFormat: "Online",
    auctionPlatform: {"label":"tax-sale.info"},
    auctionFrequency: "Annually in fall",
    taxCollector: {"label":"Wayne County Treasurer","url":"https://www.waynecounty.com/elected/treasurer/home.aspx"},
    asOf: "2026-07",
    sources: ["https://www.waynecounty.com/elected/treasurer/home.aspx"],
  },

  "26125": { // Oakland County, MI
    auctionFormat: "Online",
    auctionPlatform: {"label":"tax-sale.info"},
    auctionFrequency: "Annually in fall",
    taxCollector: {"label":"Oakland County Treasurer — Land Sale","url":"https://www.oakgov.com/government/oakland-county-treasurer-s-office/land-sale"},
    asOf: "2026-07",
    sources: ["https://www.oakgov.com/government/oakland-county-treasurer-s-office/land-sale"],
  },

  "26099": { // Macomb County, MI
    auctionFormat: "Online",
    auctionPlatform: {"label":"tax-sale.info"},
    auctionFrequency: "Annually in fall",
    taxCollector: {"label":"Macomb County Treasurer","url":"https://treasurer.macombgov.org/"},
    asOf: "2026-07",
    sources: ["https://treasurer.macombgov.org/"],
  },

  "27053": { // Hennepin County, MN
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Online or in-person, varies"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Hennepin County — Tax-Forfeited Land","url":"https://www.hennepin.us/business/property/tax-forfeited-land"},
    asOf: "2026-07",
    sources: ["https://www.hennepin.us/business/property/tax-forfeited-land"],
  },

  "27123": { // Ramsey County, MN
    auctionFormat: "Online",
    auctionPlatform: {"label":"Public Surplus"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Ramsey County — Property Sales","url":"https://www.ramseycounty.us/residents/property-home/property-sales"},
    asOf: "2026-07",
    sources: ["https://www.ramseycounty.us/residents/property-home/property-sales"],
  },

  "27037": { // Dakota County, MN
    auctionFormat: "Online",
    auctionPlatform: {"label":"Online auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Dakota County — Tax-Forfeited Property","url":"http://www.co.dakota.mn.us/HomeProperty/Forfeited"},
    asOf: "2026-07",
    sources: ["http://www.co.dakota.mn.us/HomeProperty/Forfeited"],
  },

  "28049": { // Hinds County, MS
    auctionFormat: "Online",
    auctionPlatform: {"label":"e.g. GovEase"},
    auctionFrequency: "Last Monday in August",
    taxCollector: {"label":"Hinds County Tax Collector","url":"https://www.co.hinds.ms.us/pgs/elected/taxcollector.asp"},
    asOf: "2026-07",
    sources: ["https://www.co.hinds.ms.us/pgs/elected/taxcollector.asp"],
  },

  "28047": { // Harrison County, MS
    auctionFormat: "Online",
    auctionPlatform: {"label":"e.g. GovEase"},
    auctionFrequency: "Last Monday in August",
    taxCollector: {"label":"Harrison County Chancery Clerk — Land Redemption","url":"https://www.harrisoncountymschanceryclerk.gov/landredemption.asp"},
    asOf: "2026-07",
    sources: ["https://www.harrisoncountymschanceryclerk.gov/landredemption.asp"],
  },

  "28033": { // DeSoto County, MS
    auctionFormat: "Online",
    auctionPlatform: {"label":"e.g. GovEase"},
    auctionFrequency: "Last Monday in August",
    taxCollector: {"label":"DeSoto County — Tax Sale","url":"https://www.desotocountyms.gov/508/Tax-Sale"},
    asOf: "2026-07",
    sources: ["https://www.desotocountyms.gov/508/Tax-Sale"],
  },

  "29189": { // St. Louis County, MO
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County auction"},
    auctionFrequency: "Annually in August",
    taxCollector: {"label":"St. Louis County — Delinquent Tax Sale","url":"https://stlouiscountymo.gov/st-louis-county-government/revenue/collection-division/delinquent-tax-sale/"},
    asOf: "2026-07",
    sources: ["https://stlouiscountymo.gov/st-louis-county-government/revenue/collection-division/delinquent-tax-sale/"],
  },

  "29095": { // Jackson County, MO
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Circuit court (16th Circuit) auction"},
    auctionFrequency: "Annually in August",
    taxCollector: {"label":"16th Circuit Court — Delinquent Land Tax","url":"https://www.16thcircuit.org/delinquent-land-tax"},
    notes: "Jackson County (Kansas City) uses a more judicialized process for certain properties, run through the circuit court's Delinquent Land Tax division.",
    asOf: "2026-07",
    sources: ["https://www.16thcircuit.org/delinquent-land-tax"],
  },

  "29183": { // St. Charles County, MO
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County auction"},
    auctionFrequency: "Annually in August",
    taxCollector: {"label":"St. Charles County — Collector of Revenue","url":"https://www.sccmo.org/396/Collector-of-Revenue"},
    asOf: "2026-07",
    sources: ["https://www.sccmo.org/396/Collector-of-Revenue"],
  },

  "30111": { // Yellowstone County, MT
    type: "Tax Lien Assignment",
    auctionFormat: "N/A",
    auctionPlatform: {"label":"Direct purchase from Treasurer"},
    auctionFrequency: "N/A — assignment purchase, not a scheduled auction",
    taxCollector: {"label":"Yellowstone County Treasurer","url":"https://www.yellowstonecountymt.gov/treasurer"},
    notes: "Montana has no competitive lien auction — an investor ('assignee') buys the county's existing lien directly by paying the delinquent amount in full, after mailing the owner notice of intent to purchase.",
    asOf: "2026-07",
    sources: ["https://www.yellowstonecountymt.gov/treasurer"],
  },

  "30031": { // Gallatin County, MT
    type: "Tax Lien Assignment",
    auctionFormat: "N/A",
    auctionPlatform: {"label":"Direct purchase from Treasurer"},
    auctionFrequency: "N/A — assignment purchase, not a scheduled auction",
    taxCollector: {"label":"Gallatin County Treasurer","url":"https://gallatincomt.virtualtownhall.net/treasurers-office"},
    notes: "Montana has no competitive lien auction — an investor ('assignee') buys the county's existing lien directly by paying the delinquent amount in full, after mailing the owner notice of intent to purchase.",
    asOf: "2026-07",
    sources: ["https://gallatincomt.virtualtownhall.net/treasurers-office"],
  },

  "30063": { // Missoula County, MT
    type: "Tax Lien Assignment",
    auctionFormat: "N/A",
    auctionPlatform: {"label":"Direct purchase from Treasurer"},
    auctionFrequency: "N/A — assignment purchase, not a scheduled auction",
    taxCollector: {"label":"Missoula County Clerk-Treasurer","url":"https://www.missoulacounty.us/government/financial-services/clerk-treasurer-s-office"},
    notes: "Montana has no competitive lien auction — an investor ('assignee') buys the county's existing lien directly by paying the delinquent amount in full, after mailing the owner notice of intent to purchase.",
    asOf: "2026-07",
    sources: ["https://www.missoulacounty.us/government/financial-services/clerk-treasurer-s-office"],
  },

  "31055": { // Douglas County, NE
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County auction"},
    auctionFrequency: "First Monday in March",
    taxCollector: {"label":"Douglas County Treasurer","url":"https://www.dctreasurer.org/"},
    asOf: "2026-07",
    sources: ["https://www.dctreasurer.org/"],
  },

  "31109": { // Lancaster County, NE
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County auction"},
    auctionFrequency: "First Monday in March",
    taxCollector: {"label":"Lancaster County Treasurer","url":"https://www.lancaster.ne.gov/149/Treasurer"},
    asOf: "2026-07",
    sources: ["https://www.lancaster.ne.gov/149/Treasurer"],
  },

  "31153": { // Sarpy County, NE
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County auction"},
    auctionFrequency: "First Monday in March",
    taxCollector: {"label":"Sarpy County Treasurer","url":"https://www.sarpy.gov/183/Treasurer"},
    asOf: "2026-07",
    sources: ["https://www.sarpy.gov/183/Treasurer"],
  },

  "32003": { // Clark County, NV
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Online or in-person"},
    auctionFrequency: "Periodically, often spring/fall",
    taxCollector: {"label":"Clark County Treasurer","url":"https://www.clarkcountynv.gov/treasurer"},
    asOf: "2026-07",
    sources: ["https://www.clarkcountynv.gov/treasurer"],
  },

  "32031": { // Washoe County, NV
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Online or in-person"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Washoe County Treasurer","url":"https://www.washoecounty.gov/treasurer/"},
    asOf: "2026-07",
    sources: ["https://www.washoecounty.gov/treasurer/"],
  },

  "32510": { // Carson City County, NV
    auctionFormat: "In-person",
    auctionPlatform: {"label":"In-person auction"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Carson City Treasurer","url":"https://www.carson.org/government/departments-a-f/clerk-recorder/treasurer"},
    notes: "Carson City is a consolidated city-county (independent of any county).",
    asOf: "2026-07",
    sources: ["https://www.carson.org/government/departments-a-f/clerk-recorder/treasurer"],
  },

  "33011": { // Hillsborough County, NH
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal public auction of city-owned property"},
    auctionFrequency: "As available",
    taxCollector: {"label":"City of Manchester — Finance","url":"https://www.manchesternh.gov/Departments/Finance"},
    notes: "New Hampshire tax sales are run by individual towns/cities, not counties. Manchester (the largest city in Hillsborough County) is shown as an example; Nashua (also in this county) runs its own process too.",
    asOf: "2026-07",
    sources: ["https://www.manchesternh.gov/Departments/Finance"],
  },

  "33015": { // Rockingham County, NH
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal process"},
    auctionFrequency: "As available",
    taxCollector: {"label":"Rockingham County Registry of Deeds","url":"https://www.nhdeeds.com/rockingham/"},
    notes: "New Hampshire tax sales are run by individual towns/cities, not counties — check the specific municipality within Rockingham County.",
    asOf: "2026-07",
    sources: ["https://www.nhdeeds.com/rockingham/"],
  },

  "33013": { // Merrimack County, NH
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal public auction of city-owned property"},
    auctionFrequency: "As available",
    taxCollector: {"label":"City of Concord — Finance","url":"https://www.concordnh.gov/489/Finance"},
    notes: "New Hampshire tax sales are run by individual towns/cities, not counties. Concord (the largest city in Merrimack County) is shown as an example.",
    asOf: "2026-07",
    sources: ["https://www.concordnh.gov/489/Finance"],
  },

  "34003": { // Bergen County, NJ
    auctionFormat: "Online",
    auctionPlatform: {"label":"Varies by municipality — commonly RealAuction.com"},
    auctionFrequency: "Set by each municipality (state law requires at least one sale/year)",
    taxCollector: {"label":"NJ Tax Collectors & Treasurers Association — Tax Sales","url":"https://www.tctanj.org/cn/webpage.cfm?tpid=14659"},
    notes: "New Jersey tax lien sales are run by individual municipalities, not counties — Bergen County contains dozens of towns (Hackensack, Teaneck, Fort Lee, etc.), each running its own sale. A February 2026 state bill would have the Dept. of Community Affairs standardize/vet the online vendors used statewide — worth checking for status.",
    asOf: "2026-07",
    sources: ["https://www.tctanj.org/cn/webpage.cfm?tpid=14659"],
  },

  "34023": { // Middlesex County, NJ
    auctionFormat: "Online",
    auctionPlatform: {"label":"Varies by municipality — commonly RealAuction.com"},
    auctionFrequency: "Set by each municipality (state law requires at least one sale/year)",
    taxCollector: {"label":"NJ Tax Collectors & Treasurers Association — Tax Sales","url":"https://www.tctanj.org/cn/webpage.cfm?tpid=14659"},
    notes: "New Jersey tax lien sales are run by individual municipalities, not counties — check the specific municipality within Middlesex County (e.g. New Brunswick, Edison).",
    asOf: "2026-07",
    sources: ["https://www.tctanj.org/cn/webpage.cfm?tpid=14659"],
  },

  "34013": { // Essex County, NJ
    auctionFormat: "Online",
    auctionPlatform: {"label":"Varies by municipality — commonly RealAuction.com"},
    auctionFrequency: "Set by each municipality (state law requires at least one sale/year)",
    taxCollector: {"label":"City of Newark — Tax Collector","url":"https://www.newarknj.gov/departments/finance/tax-collector"},
    notes: "New Jersey tax lien sales are run by individual municipalities, not counties. Newark (the largest city in Essex County, and in NJ) runs its own sale; other towns in this county administer separately.",
    asOf: "2026-07",
    sources: ["https://www.newarknj.gov/departments/finance/tax-collector"],
  },

  "35001": { // Bernalillo County, NM
    auctionFormat: "In-person",
    auctionPlatform: {"label":"State Property Tax Division (statewide)"},
    auctionFrequency: "Annually, in-county (2026 Bernalillo sale: July 30, 2026)",
    taxCollector: {"label":"NM Taxation & Revenue — Delinquent Property Tax Auctions","url":"https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/"},
    notes: "New Mexico tax sales are NOT run by the county — the state Taxation & Revenue Dept.'s Property Tax Division (PTD) conducts all auctions statewide, held in the county where the properties sit.",
    asOf: "2026-07",
    sources: ["https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/"],
  },

  "35013": { // Doña Ana County, NM
    auctionFormat: "In-person",
    auctionPlatform: {"label":"State Property Tax Division (statewide)"},
    auctionFrequency: "Annually, in-county",
    taxCollector: {"label":"NM Taxation & Revenue — Delinquent Property Tax Auctions","url":"https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/"},
    notes: "New Mexico tax sales are NOT run by the county — the state PTD conducts all auctions statewide.",
    asOf: "2026-07",
    sources: ["https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/"],
  },

  "35049": { // Santa Fe County, NM
    auctionFormat: "In-person",
    auctionPlatform: {"label":"State Property Tax Division (statewide)"},
    auctionFrequency: "Annually, in-county",
    taxCollector: {"label":"NM Taxation & Revenue — Delinquent Property Tax Auctions","url":"https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/"},
    notes: "New Mexico tax sales are NOT run by the county — the state PTD conducts all auctions statewide.",
    asOf: "2026-07",
    sources: ["https://www.tax.newmexico.gov/businesses/property-tax-overview/delinquent-property-tax-auctions/"],
  },

  "36047": { // Kings County, NY
    auctionFormat: "Suspended",
    auctionPlatform: {"label":"NYC Dept. of Finance (suspended 2026)"},
    auctionFrequency: "SUSPENDED as of March 2026",
    taxCollector: {"label":"NYC Dept. of Finance — Property Tax Lien Sales","url":"https://www.nyc.gov/site/finance/property/property-lien-sales.page"},
    notes: "IMPORTANT: Mayor Mamdani suspended NYC's citywide tax lien sale program in March 2026 for at least a 6-month review, with City Council legislation authorizing a shift to a public NYC Land Bank starting 2029 instead of selling debt to private investors. This is not a normal, currently-operating investor channel — confirm current status before assuming it will resume as before. Kings County = the borough of Brooklyn.",
    asOf: "2026-07",
    sources: ["https://www.nyc.gov/site/finance/property/property-lien-sales.page"],
  },

  "36081": { // Queens County, NY
    auctionFormat: "Suspended",
    auctionPlatform: {"label":"NYC Dept. of Finance (suspended 2026)"},
    auctionFrequency: "SUSPENDED as of March 2026",
    taxCollector: {"label":"NYC Dept. of Finance — Property Tax Lien Sales","url":"https://www.nyc.gov/site/finance/property/property-lien-sales.page"},
    notes: "IMPORTANT: Mayor Mamdani suspended NYC's citywide tax lien sale program in March 2026 for at least a 6-month review, with City Council legislation authorizing a shift to a public NYC Land Bank starting 2029. Queens County = the borough of Queens; the old program's impact fell disproportionately on Southeast Queens.",
    asOf: "2026-07",
    sources: ["https://www.nyc.gov/site/finance/property/property-lien-sales.page"],
  },

  "36061": { // New York County, NY
    auctionFormat: "Suspended",
    auctionPlatform: {"label":"NYC Dept. of Finance (suspended 2026)"},
    auctionFrequency: "SUSPENDED as of March 2026",
    taxCollector: {"label":"NYC Dept. of Finance — Property Tax Lien Sales","url":"https://www.nyc.gov/site/finance/property/property-lien-sales.page"},
    notes: "IMPORTANT: Mayor Mamdani suspended NYC's citywide tax lien sale program in March 2026 for at least a 6-month review, with City Council legislation authorizing a shift to a public NYC Land Bank starting 2029. New York County = the borough of Manhattan.",
    asOf: "2026-07",
    sources: ["https://www.nyc.gov/site/finance/property/property-lien-sales.page"],
  },

  "37183": { // Wake County, NC
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Clerk of Superior Court"},
    auctionFrequency: "Periodically, as properties complete foreclosure",
    taxCollector: {"label":"Wake County Tax Administration — Foreclosures","url":"https://www.wake.gov/departments-government/tax-administration/real-estate/foreclosures"},
    notes: "After the high bid, a 10-day upset-bid window reopens bidding (minimum raise: 5% of the last bid or $750, whichever is greater) — filed with the Clerk of Superior Court. The sale isn't final until 10 days pass with no upset bid.",
    asOf: "2026-07",
    sources: ["https://www.wake.gov/departments-government/tax-administration/real-estate/foreclosures"],
  },

  "37119": { // Mecklenburg County, NC
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Clerk of Court, Special Proceedings"},
    auctionFrequency: "Periodically, as properties complete foreclosure",
    taxCollector: {"label":"Mecklenburg County — Tax Foreclosure Properties","url":"https://tax.mecknc.gov/tax-foreclosure-properties"},
    notes: "Same 10-day upset-bid process as statewide (raise by 5% of last bid or $750, whichever is greater, plus a matching deposit). Filed in person at the Clerk of Court's Special Proceedings desk, Mecklenburg County Courthouse (704-686-0460).",
    asOf: "2026-07",
    sources: ["https://tax.mecknc.gov/tax-foreclosure-properties"],
  },

  "37081": { // Guilford County, NC
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Clerk of Superior Court"},
    auctionFrequency: "Periodically, as properties complete foreclosure",
    taxCollector: {"label":"Guilford County Tax Department","url":"https://www.guilfordcountync.gov/our-county/tax"},
    notes: "Same statewide judicial foreclosure + 10-day upset-bid process as Wake/Mecklenburg.",
    asOf: "2026-07",
    sources: ["https://www.guilfordcountync.gov/our-county/tax"],
  },

  "38017": { // Cass County, ND
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Auditor's office"},
    auctionFrequency: "Annually, beginning the third Tuesday of November (statewide by statute)",
    taxCollector: {"label":"Cass County Auditor/Treasurer","url":"https://www.casscountynd.gov/government/departments/auditor-treasurer"},
    notes: "North Dakota Century Code sets a statewide schedule: foreclosure notice by June 1 (for properties 4+ years delinquent), delinquent-property publication by Aug. 1, annual sale of tax-deeded land starting the third Tuesday of November.",
    asOf: "2026-07",
    sources: ["https://www.casscountynd.gov/government/departments/auditor-treasurer"],
  },

  "38015": { // Burleigh County, ND
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Auditor's office"},
    auctionFrequency: "Annually, beginning the third Tuesday of November (statewide by statute)",
    taxCollector: {"label":"Burleigh County Auditor/Treasurer — Delinquent Tax Property","url":"https://www.burleigh.gov/departments/auditortreasurer/delinquent-tax-property/"},
    notes: "North Dakota Century Code sets a statewide schedule: foreclosure notice by June 1, delinquent-property publication by Aug. 1, annual sale of tax-deeded land starting the third Tuesday of November.",
    asOf: "2026-07",
    sources: ["https://www.burleigh.gov/departments/auditortreasurer/delinquent-tax-property/"],
  },

  "38035": { // Grand Forks County, ND
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Auditor's office"},
    auctionFrequency: "Annually, beginning the third Tuesday of November (statewide by statute)",
    taxCollector: {"label":"Grand Forks County Auditor","url":"https://www.gfcounty.nd.gov/departments/auditor"},
    notes: "Same statewide North Dakota schedule as Cass/Burleigh.",
    asOf: "2026-07",
    sources: ["https://www.gfcounty.nd.gov/departments/auditor"],
  },

  "39049": { // Franklin County, OH
    auctionFormat: "Online (bulk/negotiated)",
    auctionPlatform: {"label":"Franklin County Treasurer"},
    auctionFrequency: "Annually, typically October-November",
    taxCollector: {"label":"Franklin County Treasurer — Tax Lien Sale","url":"https://treasurer.franklincountyohio.gov/Delinquent-Taxes/Tax-Lien-Sale"},
    notes: "IMPORTANT for retail investors: Franklin County sells ALL available liens as a single bulk block (worth several million dollars) via negotiated sale — individual liens are not sold to individual investors. Registration + a $500 deposit is required to participate at all.",
    asOf: "2026-07",
    sources: ["https://treasurer.franklincountyohio.gov/Delinquent-Taxes/Tax-Lien-Sale"],
  },

  "39035": { // Cuyahoga County, OH
    auctionFormat: "Online (bulk/negotiated)",
    auctionPlatform: {"label":"Cuyahoga County Treasurer"},
    auctionFrequency: "Annually, typically October-November",
    taxCollector: {"label":"Cuyahoga County Treasurer — Delinquency","url":"https://cuyahogacounty.gov/treasury/delinquency/tax-lien-certificate-sales"},
    notes: "IMPORTANT for retail investors: Cuyahoga County sells liens in bulk via negotiated sale (typically $10-17 million per sale covering hundreds of properties), not individually. No deposit required, but registration is.",
    asOf: "2026-07",
    sources: ["https://cuyahogacounty.gov/treasury/delinquency/tax-lien-certificate-sales"],
  },

  "39061": { // Hamilton County, OH
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Hamilton County Treasurer"},
    auctionFrequency: "Check with county",
    taxCollector: {"label":"Hamilton County Treasurer","url":"https://www.hamiltoncountyohio.gov/government/departments/treasurer"},
    notes: "Ohio's larger counties commonly sell delinquent tax liens in bulk to institutional buyers rather than to individual retail investors — confirm the current process directly with the Treasurer before assuming a retail-accessible auction.",
    asOf: "2026-07",
    sources: ["https://www.hamiltoncountyohio.gov/government/departments/treasurer"],
  },

  "40109": { // Oklahoma County, OK
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer resale auction"},
    auctionFrequency: "Annually in June (2026 Oklahoma County sale: June 8, 2026, 8am)",
    taxCollector: {"label":"Oklahoma County Treasurer","url":"https://www.oklahomacounty.org/elected-offices/treasurer"},
    notes: "Oklahoma's 'June Resale' sells the property itself (not a certificate) once the county has held the tax certificate for 2 years — opening bid is delinquent taxes/interest/fees owed, no redemption period after the resale.",
    asOf: "2026-07",
    sources: ["https://www.oklahomacounty.org/elected-offices/treasurer"],
  },

  "40143": { // Tulsa County, OK
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer resale auction"},
    auctionFrequency: "Annually, second Monday in June",
    taxCollector: {"label":"Tulsa County Treasurer — June Real Estate Auction","url":"https://www2.tulsacounty.org/treasurer/properties-for-sale/june-real-estate-auction/"},
    notes: "Same statewide June Resale process as Oklahoma County. Treasurer's office: 918-596-5071.",
    asOf: "2026-07",
    sources: ["https://www2.tulsacounty.org/treasurer/properties-for-sale/june-real-estate-auction/"],
  },

  "40027": { // Cleveland County, OK
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer resale auction"},
    auctionFrequency: "Annually in June (statewide resale schedule)",
    taxCollector: {"label":"Cleveland County Treasurer","url":"https://www.clevelandcountyok.com/174/Treasurer"},
    notes: "Same statewide June Resale process as Oklahoma/Tulsa counties.",
    asOf: "2026-07",
    sources: ["https://www.clevelandcountyok.com/174/Treasurer"],
  },

  "41051": { // Multnomah County, OR
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Tax Title program"},
    auctionFrequency: "Periodically (next auction anticipated summer 2026 as of April 2026)",
    taxCollector: {"label":"Multnomah County — Tax Title","url":"https://www.multco.us/tax-title"},
    notes: "Property becomes subject to foreclosure after 3 years of delinquency; the county then manages the acquired inventory through its 'Tax Title' program (foreclosure-avoidance options, asset management, and periodic sales) rather than a single fixed annual auction date.",
    asOf: "2026-07",
    sources: ["https://www.multco.us/tax-title"],
  },

  "41067": { // Washington County, OR
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Tax Title / surplus property program"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Washington County, OR — Assessment & Taxation","url":"https://www.co.washington.or.us/AssessmentTaxation/"},
    notes: "Same general 3-year judicial foreclosure + county tax-title-program pattern as Multnomah County.",
    asOf: "2026-07",
    sources: ["https://www.co.washington.or.us/AssessmentTaxation/"],
  },

  "41005": { // Clackamas County, OR
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Tax Title / surplus property program"},
    auctionFrequency: "Periodically, as announced",
    taxCollector: {"label":"Clackamas County — Tax Title","url":"https://www.clackamas.us/at/taxtitle"},
    notes: "Same general 3-year judicial foreclosure + county tax-title-program pattern as Multnomah County.",
    asOf: "2026-07",
    sources: ["https://www.clackamas.us/at/taxtitle"],
  },

  "42101": { // Philadelphia County, PA
    auctionFormat: "Online (currently inactive)",
    auctionPlatform: {"label":"Bid4Assets (philataxsales)"},
    auctionFrequency: "STALLED — tax sales stopped March 2020 (COVID); a brief 2021 online resumption was shut down again, and as of late-2023/2024 reporting had not meaningfully resumed",
    taxCollector: {"label":"Bid4Assets — Philadelphia County Sheriff Tax Sale","url":"https://www.bid4assets.com/philataxsales"},
    notes: "IMPORTANT: Philadelphia has the largest tax-delinquent property inventory in Pennsylvania (~$170M owed) but its Sheriff's tax sales have been effectively paused since COVID — confirm current status directly before assuming this is an active, liquid market. Mortgage foreclosure sales have resumed; tax sales specifically have not, per city officials.",
    asOf: "2026-07",
    sources: ["https://www.bid4assets.com/philataxsales"],
  },

  "42003": { // Allegheny County, PA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Microsoft Teams virtual sale (Sheriff's Office)"},
    auctionFrequency: "Monthly",
    taxCollector: {"label":"Allegheny County Sheriff's Office — Sheriff's Sales","url":"https://sheriffalleghenycounty.com/sheriffs-sales/"},
    notes: "Allegheny County skips Pennsylvania's upset-sale stage and goes straight to Sheriff's sales (mortgage foreclosures and delinquent-tax properties together), held monthly via virtual Microsoft Teams sessions. Register 7+ days in advance for a bidder number. Foreclosure hotline: 412-350-4704.",
    asOf: "2026-07",
    sources: ["https://sheriffalleghenycounty.com/sheriffs-sales/"],
  },

  "42091": { // Montgomery County, PA
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Upset Sale / Judicial Sale (Tax Claim Bureau)"},
    auctionFrequency: "Annually — Upset Sale typically in September, per PA's standard 3-stage process",
    taxCollector: {"label":"Montgomery County Tax Claim Bureau","url":"https://www.montgomerycountypa.gov/162/Tax-Claim-Bureau"},
    notes: "Follows Pennsylvania's standard 3-stage process: annual Upset Sale (properties sold subject to existing liens) in September, unsold parcels can proceed to a Judicial Sale (liens stripped), and finally a county repository.",
    asOf: "2026-07",
    sources: ["https://www.montgomerycountypa.gov/162/Tax-Claim-Bureau"],
  },

  "44007": { // Providence County, RI
    auctionFormat: "Online",
    auctionPlatform: {"label":"GovEase.com (City of Providence)"},
    auctionFrequency: "Annually (City of Providence collector's sale)",
    taxCollector: {"label":"City of Providence — Tax Sale Properties","url":"https://www.providenceri.gov/collector/tax-sale-properties/"},
    notes: "Rhode Island tax sales are run by individual cities/towns, not counties. Providence (the largest city in Providence County) runs its 'Collector's Sale' online via GovEase; the smallest undivided share of the parcel (min. 1%) is sold if a bidder will take it, otherwise the whole parcel. Redemption interest: 10% of the sale price if paid within 6 months. Collector's office: 401-331-5252.",
    asOf: "2026-07",
    sources: ["https://www.providenceri.gov/collector/tax-sale-properties/"],
  },

  "44003": { // Kent County, RI
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal collector's sale"},
    auctionFrequency: "Set by each municipality",
    taxCollector: {"label":"Rhode Island Division of Municipal Finance","url":"https://dor.ri.gov/municipal-finance"},
    notes: "Rhode Island tax sales are run by individual cities/towns, not counties — check the specific municipality within Kent County (e.g. Warwick, Coventry).",
    asOf: "2026-07",
    sources: ["https://dor.ri.gov/municipal-finance"],
  },

  "44009": { // Washington County, RI
    auctionFormat: "Varies",
    auctionPlatform: {"label":"Municipal collector's sale"},
    auctionFrequency: "Set by each municipality",
    taxCollector: {"label":"Rhode Island Division of Municipal Finance","url":"https://dor.ri.gov/municipal-finance"},
    notes: "Rhode Island tax sales are run by individual cities/towns, not counties — check the specific municipality within Washington County (e.g. South Kingstown, Westerly).",
    asOf: "2026-07",
    sources: ["https://dor.ri.gov/municipal-finance"],
  },

  "45045": { // Greenville County, SC
    auctionFormat: "In-person (+ online for unsold)",
    auctionPlatform: {"label":"County auction + Forfeited Land Commission"},
    auctionFrequency: "Annually (primary sale); FLC online auction for unsold parcels afterward",
    taxCollector: {"label":"Greenville County Tax Collector — Tax Sale Procedures","url":"https://www.greenvillecounty.org/taxcollector/TaxSaleProcedures.aspx"},
    notes: "Primary sale is in-person (Greenville Convention Center); unsold parcels go to the county's Forfeited Land Commission (FLC), which resells via online auction (no live bidding) with a quitclaim tax deed.",
    asOf: "2026-07",
    sources: ["https://www.greenvillecounty.org/taxcollector/TaxSaleProcedures.aspx"],
  },

  "45019": { // Charleston County, SC
    auctionFormat: "In-person (+ online for unsold)",
    auctionPlatform: {"label":"County auction + Forfeited Land Commission"},
    auctionFrequency: "Annually (primary sale); FLC afterward",
    taxCollector: {"label":"Charleston County Delinquent Tax Sale","url":"https://www.charlestoncounty.org/departments/delinquent-tax/tax-sale.php"},
    notes: "Same statewide South Carolina two-stage pattern (county sale, then Forfeited Land Commission for unsold parcels) as Greenville.",
    asOf: "2026-07",
    sources: ["https://www.charlestoncounty.org/departments/delinquent-tax/tax-sale.php"],
  },

  "45079": { // Richland County, SC
    auctionFormat: "In-person (+ online for unsold)",
    auctionPlatform: {"label":"County auction + Forfeited Land Commission"},
    auctionFrequency: "Annually (primary sale); FLC afterward",
    taxCollector: {"label":"Richland County Delinquent Tax Sale","url":"https://www.richlandcountysc.gov/Government/Departments/Delinquent-Tax/Tax-Sale"},
    notes: "Same statewide South Carolina two-stage pattern (county sale, then Forfeited Land Commission for unsold parcels) as Greenville.",
    asOf: "2026-07",
    sources: ["https://www.richlandcountysc.gov/Government/Departments/Delinquent-Tax/Tax-Sale"],
  },

  "46099": { // Minnehaha County, SD
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Annually — check the Treasurer's Notice of Sale for the exact date",
    taxCollector: {"label":"Minnehaha County Treasurer","url":"https://www.minnehahacounty.gov/dept/tr/tr.php"},
    notes: "Treasurer: Pam Nelson, 605-367-4211 / treasurer@minnehahacounty.org (confirm current officeholder before relying on a name).",
    asOf: "2026-07",
    sources: ["https://www.minnehahacounty.gov/dept/tr/tr.php"],
  },

  "46103": { // Pennington County, SD
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Annually — check the Treasurer's Notice of Sale for the exact date",
    taxCollector: {"label":"Pennington County Treasurer","url":"https://www.pennco.org/treasurer"},
    notes: "Same statewide South Dakota tax-certificate process as Minnehaha County.",
    asOf: "2026-07",
    sources: ["https://www.pennco.org/treasurer"],
  },

  "46083": { // Lincoln County, SD
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Annually — check the Treasurer's Notice of Sale for the exact date",
    taxCollector: {"label":"Lincoln County Treasurer","url":"https://www.lincolncountysd.org/172/Treasurer"},
    notes: "Same statewide South Dakota tax-certificate process as Minnehaha County.",
    asOf: "2026-07",
    sources: ["https://www.lincolncountysd.org/172/Treasurer"],
  },

  "47157": { // Shelby County, TN
    auctionFormat: "Online",
    auctionPlatform: {"label":"ZeusAuction.com (via SRI, Chancery Court Clerk & Master)"},
    auctionFrequency: "Throughout the year, per sale calendar",
    taxCollector: {"label":"Shelby County Trustee — Tax Sale","url":"https://www.shelbycountytrustee.com/108/Tax-Sale"},
    notes: "Shelby County (Memphis) moved to online sales via SRI/ZeusAuction.com effective April 2024. Property lists post ~30 days before each sale; also advertised in the Memphis Daily News.",
    asOf: "2026-07",
    sources: ["https://www.shelbycountytrustee.com/108/Tax-Sale"],
  },

  "47037": { // Davidson County, TN
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Metro Chancery Court (Clerk & Master)"},
    auctionFrequency: "Roughly monthly, June-December (2026 example: June 17, 2026, noon)",
    taxCollector: {"label":"Chancery Clerk & Master of Metro Nashville & Davidson County — Delinquent Tax Sales","url":"https://chanceryclerkandmaster.nashville.gov/fees/delinquent-tax-sales/"},
    notes: "Held at the Metro Davidson County Courthouse; registration window opens 11am, closes 12 noon sharp on sale day.",
    asOf: "2026-07",
    sources: ["https://chanceryclerkandmaster.nashville.gov/fees/delinquent-tax-sales/"],
  },

  "47093": { // Knox County, TN
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Chancery Court"},
    auctionFrequency: "Periodically, per Chancery Court sale calendar",
    taxCollector: {"label":"Knox County Trustee","url":"https://www.knoxcounty.org/trustee/"},
    notes: "Same judicial (Chancery Court) tax sale process as Shelby/Davidson, run at the county level.",
    asOf: "2026-07",
    sources: ["https://www.knoxcounty.org/trustee/"],
  },

  "48113": { // Dallas County, TX
    auctionFormat: "Online",
    auctionPlatform: {"label":"Live Online Auction via RealAuction (taxsales.lgbs.com)"},
    auctionFrequency: "First Tuesday of every month",
    taxCollector: {"label":"Dallas County — Sheriff's Sales / Tax Foreclosure Resales","url":"https://www.dallascounty.org/departments/tax/sheriff-sales.php"},
    notes: "Unlike Harris County's in-person constable auctions, Dallas County's Sheriff now runs a Live Online Auction. Registration/info: (877) 361-7325 or customerservice@realauction.com.",
    asOf: "2026-07",
    sources: ["https://www.dallascounty.org/departments/tax/sheriff-sales.php"],
  },

  "48439": { // Tarrant County, TX
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Constable auction"},
    auctionFrequency: "First Tuesday of every month, ~10am",
    taxCollector: {"label":"Tarrant County — Delinquent Tax Sales (Constable Pct. 3)","url":"https://www.tarrantcountytx.gov/en/constables/constable-3/delinquent-tax-sales.html"},
    notes: "Same in-person, first-Tuesday constable-run pattern as Harris County.",
    asOf: "2026-07",
    sources: ["https://www.tarrantcountytx.gov/en/constables/constable-3/delinquent-tax-sales.html"],
  },

  "49035": { // Salt Lake County, UT
    auctionFormat: "Online",
    auctionPlatform: {"label":"PublicSurplus.com"},
    auctionFrequency: "Annually in May (2026 sale: May 27, 2026)",
    taxCollector: {"label":"Salt Lake County — Property Tax Sale","url":"https://www.saltlakecounty.gov/property-tax/property-tax-sale/"},
    notes: "Utah's May Tax Sale is set by state law for every county. Salt Lake County requires a refundable $500 bid deposit (paid via PAYMAC) submitted several days before the sale.",
    asOf: "2026-07",
    sources: ["https://www.saltlakecounty.gov/property-tax/property-tax-sale/"],
  },

  "49049": { // Utah County, UT
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Auditor sale"},
    auctionFrequency: "Annually in May, before Memorial Day",
    taxCollector: {"label":"Utah County Auditor — May Tax Sale","url":"https://www.utahcounty.gov/dept/auditor/taxadmin/taxsale/taxsaleprocedure.html"},
    notes: "Same statewide May Tax Sale timing as Salt Lake County; run by the County Auditor's office.",
    asOf: "2026-07",
    sources: ["https://www.utahcounty.gov/dept/auditor/taxadmin/taxsale/taxsaleprocedure.html"],
  },

  "49011": { // Davis County, UT
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Auditor sale"},
    auctionFrequency: "Annually in May",
    taxCollector: {"label":"Davis County Auditor","url":"https://daviscountyutah.gov/auditor"},
    notes: "Same statewide May Tax Sale timing as Salt Lake/Utah counties.",
    asOf: "2026-07",
    sources: ["https://daviscountyutah.gov/auditor"],
  },

  "50007": { // Chittenden County, VT
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Municipal tax collector's sale"},
    auctionFrequency: "Set by each town (statutory minimum notice: 3 weeks' publication + 30 days' owner notice)",
    taxCollector: {"label":"Vermont Statutes — Title 32, Ch. 133 (Tax Sales)","url":"https://legislature.vermont.gov/statutes/fullchapter/32/133"},
    notes: "Vermont tax sales are run by individual towns, not counties — check the specific municipality within Chittenden County (e.g. Burlington). A town may extend a sale warrant once a taxpayer owes $1,500+ and is 1+ year delinquent.",
    asOf: "2026-07",
    sources: ["https://legislature.vermont.gov/statutes/fullchapter/32/133"],
  },

  "50021": { // Rutland County, VT
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Municipal tax collector's sale"},
    auctionFrequency: "Set by each town",
    taxCollector: {"label":"Vermont Statutes — Title 32, Ch. 133 (Tax Sales)","url":"https://legislature.vermont.gov/statutes/fullchapter/32/133"},
    notes: "Vermont tax sales are run by individual towns, not counties — check the specific municipality within Rutland County.",
    asOf: "2026-07",
    sources: ["https://legislature.vermont.gov/statutes/fullchapter/32/133"],
  },

  "50023": { // Washington County, VT
    auctionFormat: "In-person",
    auctionPlatform: {"label":"Municipal tax collector's sale"},
    auctionFrequency: "Set by each town",
    taxCollector: {"label":"Vermont Statutes — Title 32, Ch. 133 (Tax Sales)","url":"https://legislature.vermont.gov/statutes/fullchapter/32/133"},
    notes: "Vermont tax sales are run by individual towns, not counties — check the specific municipality within Washington County (e.g. Montpelier, Barre).",
    asOf: "2026-07",
    sources: ["https://legislature.vermont.gov/statutes/fullchapter/32/133"],
  },

  "51059": { // Fairfax County, VA
    auctionFormat: "Online",
    auctionPlatform: {"label":"At Auction, Inc. / Taxing Authority Consulting Services (TACS)"},
    auctionFrequency: "Periodically (2026 example: closing June 25, 2026)",
    taxCollector: {"label":"Fairfax County — Tax Sale of Real Estate","url":"https://www.fairfaxcounty.gov/taxes/pay/auction-tangible-property"},
    notes: "Judicial sale under a Circuit Court Decree of Sale; a 5% buyer's premium is added to the winning bid. Full payment due within 7 days of the auction closing. Purchasers cannot owe delinquent taxes to the county themselves.",
    asOf: "2026-07",
    sources: ["https://www.fairfaxcounty.gov/taxes/pay/auction-tangible-property"],
  },

  "51153": { // Prince William County, VA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Commonly TACS-administered (confirm per sale)"},
    auctionFrequency: "Periodically",
    taxCollector: {"label":"Prince William County — Delinquent Tax Sales","url":"https://www.pwcva.gov/department/finance/delinquent-tax-sales"},
    notes: "Same general Virginia judicial-sale pattern as Fairfax County (Circuit Court decree, online auction, buyer's premium).",
    asOf: "2026-07",
    sources: ["https://www.pwcva.gov/department/finance/delinquent-tax-sales"],
  },

  "51810": { // Virginia Beach County, VA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Commonly TACS-administered (confirm per sale)"},
    auctionFrequency: "Periodically",
    taxCollector: {"label":"City of Virginia Beach — Delinquent Tax Sales","url":"https://www.vbgov.com/government/departments/treasurer/Pages/delinquent-tax-sales.aspx"},
    notes: "Virginia Beach is an independent city (a county-equivalent). Same general Virginia judicial-sale pattern as Fairfax County.",
    asOf: "2026-07",
    sources: ["https://www.vbgov.com/government/departments/treasurer/Pages/delinquent-tax-sales.aspx"],
  },

  "53033": { // King County, WA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Bid4Assets.com"},
    auctionFrequency: "Annually (historically September)",
    taxCollector: {"label":"King County — Real Estate Services (Tax Title Sales)","url":"https://kingcounty.gov/en/dept/executive-services/buildings-property/facilities-management/real-estate-services/sales"},
    notes: "$2,500 deposit + $35 processing fee required to bid. Properties sold 'AS IS/WHERE IS' — buyers must do their own due diligence, no representations from the county. Questions: TaxForeclosures@kingcounty.gov.",
    asOf: "2026-07",
    sources: ["https://kingcounty.gov/en/dept/executive-services/buildings-property/facilities-management/real-estate-services/sales"],
  },

  "53053": { // Pierce County, WA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Commonly Bid4Assets.com (confirm per sale)"},
    auctionFrequency: "Annually",
    taxCollector: {"label":"Pierce County Treasurer — Foreclosure/Tax Title","url":"https://www.piercecountywa.gov/1435/Foreclosure-Tax-Title-Properties"},
    notes: "Same general Washington county-treasurer foreclosure-auction pattern as King County.",
    asOf: "2026-07",
    sources: ["https://www.piercecountywa.gov/1435/Foreclosure-Tax-Title-Properties"],
  },

  "53061": { // Snohomish County, WA
    auctionFormat: "Online",
    auctionPlatform: {"label":"Commonly Bid4Assets.com (confirm per sale)"},
    auctionFrequency: "Annually",
    taxCollector: {"label":"Snohomish County Treasurer — Foreclosure Sale","url":"https://snohomishcountywa.gov/2434/Real-Property-Tax-Foreclosure"},
    notes: "Same general Washington county-treasurer foreclosure-auction pattern as King County.",
    asOf: "2026-07",
    sources: ["https://snohomishcountywa.gov/2434/Real-Property-Tax-Foreclosure"],
  },

  "54039": { // Kanawha County, WV
    auctionFormat: "In-person",
    auctionPlatform: {"label":"WV State Auditor's Office (statewide)"},
    auctionFrequency: "Annually, one sale per county",
    taxCollector: {"label":"WV State Auditor — County Collections / Delinquent Land Results","url":"https://www.wvsao.gov/CountyCollections/delinquentlandresults"},
    notes: "Since 2022 reform (SB552), the State Auditor's Office — not county sheriffs — runs a single annual tax-lien sale per county after sheriffs certify delinquent lists. If unsold/unredeemed, neighbors get first right of refusal, then cities/land banks/counties, before other investors.",
    asOf: "2026-07",
    sources: ["https://www.wvsao.gov/CountyCollections/delinquentlandresults"],
  },

  "54003": { // Berkeley County, WV
    auctionFormat: "In-person",
    auctionPlatform: {"label":"WV State Auditor's Office (statewide)"},
    auctionFrequency: "Annually, one sale per county",
    taxCollector: {"label":"WV State Auditor — County Collections / Delinquent Land Results","url":"https://www.wvsao.gov/CountyCollections/delinquentlandresults"},
    notes: "Same statewide State Auditor-run process as Kanawha County.",
    asOf: "2026-07",
    sources: ["https://www.wvsao.gov/CountyCollections/delinquentlandresults"],
  },

  "54061": { // Monongalia County, WV
    auctionFormat: "In-person",
    auctionPlatform: {"label":"WV State Auditor's Office (statewide)"},
    auctionFrequency: "Annually, one sale per county",
    taxCollector: {"label":"WV State Auditor — County Collections / Delinquent Land Results","url":"https://www.wvsao.gov/CountyCollections/delinquentlandresults"},
    notes: "Same statewide State Auditor-run process as Kanawha County.",
    asOf: "2026-07",
    sources: ["https://www.wvsao.gov/CountyCollections/delinquentlandresults"],
  },

  "55079": { // Milwaukee County, WI
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Treasurer — Foreclosed Property Sales"},
    auctionFrequency: "Ongoing, as properties are foreclosed and listed",
    taxCollector: {"label":"Milwaukee County — Foreclosed Property Sales","url":"https://county.milwaukee.gov/EN/Treasurer/Foreclosed-Property-Sales"},
    notes: "IMPORTANT: Milwaukee County only handles tax-foreclosed properties OUTSIDE the City of Milwaukee — the City of Milwaukee runs its own separate process for property within city limits. The county forecloses via 'in rem' action, takes full title, then sells at fair market value (not a minimum-bid competitive auction).",
    asOf: "2026-07",
    sources: ["https://county.milwaukee.gov/EN/Treasurer/Foreclosed-Property-Sales"],
  },

  "55025": { // Dane County, WI
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Ongoing, as properties are foreclosed and listed",
    taxCollector: {"label":"Dane County Treasurer","url":"https://danecountytreasurer.com/"},
    notes: "Same general Wisconsin in-rem-foreclosure-then-fair-market-sale pattern as Milwaukee County.",
    asOf: "2026-07",
    sources: ["https://danecountytreasurer.com/"],
  },

  "55133": { // Waukesha County, WI
    auctionFormat: "Varies",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Ongoing, as properties are foreclosed and listed",
    taxCollector: {"label":"Waukesha County Treasurer","url":"https://www.waukeshacounty.gov/treasurer/"},
    notes: "Same general Wisconsin in-rem-foreclosure-then-fair-market-sale pattern as Milwaukee County.",
    asOf: "2026-07",
    sources: ["https://www.waukeshacounty.gov/treasurer/"],
  },

  "56021": { // Laramie County, WY
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Annually, the Thursday following Cheyenne Frontier Days (late July)",
    taxCollector: {"label":"Laramie County Treasurer — Tax Sale","url":"https://www.laramiecountywy.gov/County-Government/Elected-Officials/County-Treasurer/Tax-Sale"},
    notes: "A genuinely fixed local date tied to Cheyenne Frontier Days. Treasurer's office: 307-633-4225.",
    asOf: "2026-07",
    sources: ["https://www.laramiecountywy.gov/County-Government/Elected-Officials/County-Treasurer/Tax-Sale"],
  },

  "56025": { // Natrona County, WY
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Annually — set by the County Treasurer",
    taxCollector: {"label":"Natrona County Treasurer","url":"https://www.natronacounty-wy.gov/172/Treasurer"},
    notes: "Same statewide Wyoming tax-lien-certificate process (15%/yr + 3% penalty) as Laramie County; exact date set independently by each county treasurer.",
    asOf: "2026-07",
    sources: ["https://www.natronacounty-wy.gov/172/Treasurer"],
  },

  "56005": { // Campbell County, WY
    auctionFormat: "In-person",
    auctionPlatform: {"label":"County Treasurer"},
    auctionFrequency: "Annually — set by the County Treasurer",
    taxCollector: {"label":"Campbell County Treasurer","url":"https://www.ccgov.net/162/Treasurer"},
    notes: "Same statewide Wyoming tax-lien-certificate process as Laramie County; exact date set independently by each county treasurer.",
    asOf: "2026-07",
    sources: ["https://www.ccgov.net/162/Treasurer"],
  },
};
