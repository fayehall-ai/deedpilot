/**
 * The county framework document — what goes in it, and where each line came from.
 *
 * Modelled on the Tax Deed Collective's DeKalb County framework, which is the
 * standard this has to meet. Its first page is a title block, an eight-row fact
 * table, an executive description and then numbered statutory sections; this
 * assembles the same thing from the atlas and the auction row.
 *
 * ## Every line traces, and an unknown says so
 *
 * A due-diligence document that guesses is worse than one that is short: a
 * bidder who acts on an invented deposit rule loses the deposit. So each fact
 * carries where it came from — the county's own research, the state statute, or
 * the sale row — and anything the atlas does not hold is printed as a question
 * for the county rather than filled with something plausible.
 *
 * `inherited` is the distinction that matters most and the one a reader cannot
 * see for themselves. DeKalb's redemption and premium are Georgia's general
 * rule, not DeKalb's verified practice; its auction format and lien treatment
 * *are* DeKalb's. The document marks which is which, because "1 year from sale"
 * read as county-verified is a different risk from the same words read as a
 * state default nobody has checked against this courthouse.
 */
import {
  getCounty, resolveCountyRule, STATE_DATA, STATE_NAMES, TYPE_DESCRIPTIONS,
} from "../atlas";
import type { AuctionLogistics } from "../db/schema";

export interface FrameworkAuction {
  saleDate: string;
  saleType: string | null;
  platform: string | null;
  startTime: string | null;
  sourceUrl: string | null;
  logistics: AuctionLogistics | null;
  lotCount: number;
  announced: number | null;
  saleDateConfirmed: boolean;
}

/**
 * `source` is not a confidence score, it is where the authority lies.
 *
 * The first cut flagged "Governing Law: state default — verify", which is
 * nonsense: a statute IS the state's, and there is nothing about O.C.G.A. Title
 * 48 for a reader to verify with DeKalb. Marking it as a weaker fact would
 * teach a reader to distrust the one line on the page that is certain.
 *
 * So statutory fields are marked `statute` — the state is the authority and
 * that is the end of it. `county` is research done for this county. `ask` is
 * reserved for what genuinely varies courthouse to courthouse and that this
 * system does not hold: the venue, the times, the deposit. Only `ask` prints a
 * warning, because only `ask` is a job for the reader.
 */
export type Authority = "county" | "statute" | "ask";
export interface Row { label: string; value: string; source: Authority }
export interface Section { heading: string; paragraphs: string[]; bullets?: string[] }

export interface Framework {
  countyLine: string;
  stateName: string;
  auctionLine: string;
  rows: Row[];
  executive: string;
  sections: Section[];
  sources: string[];
  asOf: string | null;
  /** Fields taken from the state's general rule rather than county research. */
  inherited: string[];
  generated: string;
  /** ISO sale date — what a list of frameworks is ordered by. */
  sortKey: string;
  /** Parcels this system holds for the sale, for the list's metadata line. */
  lotCount: number;
}

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** The venue as a bidder needs it: a place they can stand, or an address to ask for. */
function locationOf(a: FrameworkAuction, rule: any): string {
  const v = a.logistics?.venue;
  if (v?.text) return v.text;
  if (a.platform && a.platform !== "in_person" && a.sourceUrl) {
    return `Online — ${new URL(a.sourceUrl).hostname}`;
  }
  /*
   * The courthouse address is often only in the county's prose notes. Pulling
   * it out beats printing nothing, and printing nothing beats printing a
   * courthouse we assumed.
   */
  const m = /(\d+[^.;()]*?(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Way|Pkwy)\b[^.;()]*)/i
    .exec(rule?.notes ?? "");
  if (m) return m[1].trim();
  return "Not on file — confirm the venue on the county's sale notice";
}

function windowOf(a: FrameworkAuction, rule: any): string {
  const bits: string[] = [];
  if (rule?.auctionFrequency) bits.push(String(rule.auctionFrequency));
  if (a.startTime) bits.push(`Sale row records a start time of ${a.startTime}`);
  return bits.length
    ? bits.join(". ")
    : "Not on file — confirm check-in and bidding times on the county's sale notice";
}

function formatOf(a: FrameworkAuction, rule: any): string {
  const f = rule?.auctionFormat ? String(rule.auctionFormat) : null;
  /* "courthouse-steps" where the county says so — it tells a bidder where to stand. */
  const steps = /courthouse\s*(steps|door)/i.test(
    `${rule?.notes ?? ""} ${a.logistics?.venue?.text ?? ""}`);
  if (f && /in.?person/i.test(f)) return steps ? "Live, in-person courthouse-steps auction" : "Live, in-person auction";
  if (f) return f;
  if (a.platform === "in_person") return steps ? "Live, in-person courthouse-steps auction" : "Live, in-person auction";
  if (a.platform) return `Online auction (${a.platform})`;
  return "Not on file — confirm on the county's sale notice";
}

export function buildFramework(fips: string, a: FrameworkAuction): Framework {
  const county = getCounty(fips);
  if (!county) throw new Error(`${fips} is not a county`);
  const rule = resolveCountyRule(fips);
  if (!rule) throw new Error(`no rule resolves for ${fips}`);
  const stateRule = (STATE_DATA as any)[county.state];
  const stateName = (STATE_NAMES as any)[county.state] ?? county.state;
  const inherited = rule.inherited ?? [];
  const has = (k: string) => !inherited.includes(k);

  const known = (v: string) => !/^Not on file/.test(v);
  const loc = locationOf(a, rule);
  const win = windowOf(a, rule);
  const fmt = formatOf(a, rule);

  const rows: Row[] = [
    { label: "Auction Date", value: longDate(a.saleDate),
      source: a.saleDateConfirmed ? "county" : "ask" },
    { label: "Location", value: loc, source: known(loc) ? "county" : "ask" },
    { label: "Check-In / Event Window", value: win, source: known(win) ? "county" : "ask" },
    { label: "Sale Type", value: rule.type ?? rule.saleType, source: has("type") ? "county" : "statute" },
    { label: "Governing Law", value: rule.statute, source: "statute" },
    { label: "Redemption", value: rule.redemption, source: has("redemption") ? "county" : "statute" },
    {
      /*
       * A redeemable deed's headline number is the first-year premium, and the
       * standard this matches names it as such. On a lien it is an interest
       * rate and on a deed there is nothing to return at all.
       */
      label: rule.saleType === "Redeemable Deed" ? "Redemption Premium"
           : rule.saleType === "Tax Lien" ? "Interest to the Certificate Holder"
           : "Investor Return on Redemption",
      value: rule.returns, source: has("returns") ? "county" : "statute",
    },
    { label: "Auction Format", value: fmt, source: known(fmt) ? "county" : "ask" },
  ];

  const countThis = a.lotCount > 0
    ? `${a.lotCount.toLocaleString()} parcels are on the list this system holds`
    : a.announced && a.announced > 0
      ? `the county advertised ${a.announced.toLocaleString()} parcels; the itemised list is not yet in this system`
      : "no parcel count is on file yet";

  const executive =
    `The ${county.name} County tax sale scheduled for ${longDate(a.saleDate)} is ` +
    `${/in.?person/i.test(formatOf(a, rule)) ? "a live auction" : "an online auction"} for property ` +
    `subject to delinquent property-tax execution. ${TYPE_DESCRIPTIONS[rule.saleType]} ` +
    `Under ${rule.statute}, ${rule.redemption.toLowerCase().startsWith("none") ? "no post-sale redemption applies" : `redemption runs ${rule.redemption.toLowerCase()}`}, ` +
    `and the return to a purchaser whose position is redeemed is ${rule.returns.toLowerCase()}. ` +
    `At the time of writing, ${countThis}. Complete parcel, title, lien, occupancy, access, zoning, ` +
    `value and exit-strategy research before bidding: nothing in this document substitutes for that work.`;

  const sections: Section[] = [];

  sections.push({
    heading: "I. Statutory Framework",
    paragraphs: [
      `${stateName} conducts this sale as a ${rule.saleType.toLowerCase()} under ${rule.statute}. ` +
      `${TYPE_DESCRIPTIONS[rule.saleType]}`,
      stateRule?.notes ? `At the state level: ${stateRule.notes}` : "",
      rule.notes && rule.notes !== stateRule?.notes ? `For ${county.name} County specifically: ${rule.notes}` : "",
      /*
       * Say where the authority sits rather than casting doubt. The statute is
       * the state's and always was; what a reader should check is the county's
       * own practice around it, which is a different sentence.
       */
      inherited.length
        ? `Note on provenance. The ${inherited.map((f) => f === "type" ? "sale type" : f).join(", ")} ` +
          `above ${inherited.length === 1 ? "is" : "are"} ${stateName}'s statewide rule rather than ` +
          `something separately researched for ${county.name} County. That is ordinarily the right ` +
          `answer — a statute is the state's — but counties differ in how they apply it, so confirm ` +
          `the mechanics on the county's own sale notice.`
        : `Every statutory field above was researched for ${county.name} County specifically rather ` +
          `than taken from ${stateName}'s statewide rule.`,
    ].filter(Boolean),
  });

  sections.push({
    heading: "II. Redemption and the Purchaser's Return",
    paragraphs: [
      `Redemption: ${rule.redemption}.`,
      `Return if redeemed: ${rule.returns}.`,
      rule.saleType === "Redeemable Deed"
        ? `A redeemable deed is not ownership on sale day. A deed issues to the purchaser, and the ` +
          `former owner — and others with an interest — keep a statutory right to take the property ` +
          `back by paying the redemption amount. Capital is committed for the whole window whether or ` +
          `not it is redeemed, and the process to end that right is a separate legal step the ` +
          `purchaser must take and pay for.`
        : rule.saleType === "Tax Lien"
          ? `A lien purchase is a debt position, not a property position. The return above is what the ` +
            `debt pays if it is redeemed; taking title is a later, separate and uncertain process.`
          : `Where no post-sale redemption applies, the purchaser's capital converts to a title ` +
            `position at sale and the risk moves immediately to title, condition and possession.`,
    ],
  });

  sections.push({
    heading: "III. What the Deed Conveys",
    paragraphs: [
      rule.quietTitle
        ? String(rule.quietTitle)
        : `Not on file for ${county.name} County. Whether a quiet title action is required before a ` +
          `title insurer will write a policy is the single question that most often decides whether a ` +
          `parcel can be resold — confirm it with local counsel before bidding.`,
      `Budget the curative step in time and cost as part of the bid, not after it.`,
    ],
  });

  sections.push({
    heading: "IV. Liens and Encumbrances That Survive",
    paragraphs: [
      rule.survivingLiens
        ? String(rule.survivingLiens)
        : `Not on file for ${county.name} County. Which liens survive a tax sale is the most expensive ` +
          `thing on this page to get wrong — ask the county in writing which municipal, governmental ` +
          `and federal interests it treats as surviving, and order a full title and lien search on any ` +
          `parcel you intend to bid.`,
    ],
  });

  const mech: string[] = [];
  if (rule.depositRules) mech.push(String(rule.depositRules));
  else mech.push(`Registration, deposit and payment terms are not on file for ${county.name} County. ` +
    `Confirm them with the county before sale day: an unmet deposit keeps you from bidding, and a ` +
    `missed payment deadline can cost both the parcel and money already posted.`);
  if (a.sourceUrl) mech.push(`Sale page on file: ${a.sourceUrl}`);
  if (rule.auctionPlatform?.url) mech.push(`${rule.auctionPlatform.label}: ${rule.auctionPlatform.url}`);
  sections.push({ heading: "V. Auction Mechanics", paragraphs: mech });

  const contacts: string[] = [];
  for (const k of ["taxCollector", "clerkOfCourt", "propertyAppraiser", "gisMap"] as const) {
    const ref = (rule as any)[k];
    if (ref?.label) contacts.push(`${ref.label}${ref.url ? ` — ${ref.url}` : ""}${ref.phone ? ` — ${ref.phone}` : ""}`);
  }
  if (contacts.length) {
    sections.push({
      heading: "VI. County Offices and Records",
      paragraphs: [`Use these for parcel, title and assessment research before bidding.`],
      bullets: contacts,
    });
  }

  const growth = (rule as any).growthNeighborhoods as { name: string; why: string }[] | undefined;
  if (growth?.length) {
    sections.push({
      heading: `${contacts.length ? "VII" : "VI"}. Submarket Notes`,
      paragraphs: [`Where demand in ${county.name} County is concentrated, and why it matters to an exit.`],
      bullets: growth.map((g) => `${g.name} — ${g.why}`),
    });
  }

  const n = 5 + (contacts.length ? 1 : 0) + (growth?.length ? 1 : 0) + 1;
  const roman = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"][n];
  sections.push({
    heading: `${roman}. Before You Bid`,
    paragraphs: [`Everything below must be answered by you, from the county and from the ground.`],
    bullets: [
      "Confirm the sale date, start time and venue on the county's own notice — not on a calendar.",
      "Confirm registration, deposit amount, accepted funds and the payment deadline in writing.",
      "Order a title and lien search on every parcel you intend to bid.",
      "Ask the county which municipal and governmental liens it treats as surviving the sale.",
      "Confirm occupancy and access on the ground; a deed does not deliver possession.",
      "Inspect physical condition yourself — the sale list is not a condition report.",
      "Price the curative step (quiet title or barment) into the bid, in months and in fees.",
      "Decide the exit before bidding, and the walk-away number with it.",
    ],
  });

  return {
    countyLine: `${county.name.toUpperCase()} COUNTY, ${stateName.toUpperCase()}`,
    stateName,
    auctionLine: `${MONTHS[Number(a.saleDate.split("-")[1]) - 1]} ${Number(a.saleDate.split("-")[2])}, ${a.saleDate.split("-")[0]} Auction`,
    rows,
    executive,
    sections,
    sources: ((rule as any).sources as string[] | undefined) ?? [],
    asOf: (rule as any).asOf ?? null,
    inherited,
    generated: new Date().toISOString().slice(0, 10),
    sortKey: a.saleDate,
    lotCount: a.lotCount,
  };
}
