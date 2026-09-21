/**
 * Auction Scout findings into the calendar: plan, then apply.
 *
 * One matcher for every way a Scout finding arrives — a tab of Ed's workbook
 * uploaded on the console or run from the terminal, or a state's AI research
 * finishing on the queue. Each arrival is a *channel*, and the channel is what
 * decides provenance and what this run may overwrite.
 *
 * ## Rows are not sales
 *
 * The report names many sales twice: once from the desk's own research — a
 * verified venue, a long sale-type label, no parcel count — and once carried
 * over from the sale calendar, with a count and the calendar's link. Michigan's
 * "Arenac County" and "Arenac County Re-Offer" on 25 September are the same
 * re-offer sale. So rows are first grouped into sales — one county, one date,
 * one body selling — and each sale takes the first non-empty value of each
 * field in row order, which puts the verified research ahead of the carried
 * copy. A town's sale and its county's sale on the same day stay two sales.
 *
 * ## What a sale does
 *
 * Each sale is matched to the one its county holds on that date — any sale,
 * crawled or imported. That last part is why this is not `import:apply`:
 * `planImport` only merges into *crawled* sales and treats an earlier import's
 * rows as someone else's, so two-thirds of the report would have been inserted
 * a second time beside the calendar rows it was built from.
 *
 *   matched     Fills what the held sale is missing — venue and contact, the
 *               announced parcel count, a start time — and nothing else. Its
 *               date, type, platform and citation belong to whatever crawled or
 *               imported it, and a value already there is never replaced: the
 *               Scout summarises those same sources, it does not correct them.
 *   new         A sale nothing holds. Inserted with an `import:scout:` id, so
 *               it reads as imported everywhere imported sales are treated
 *               differently, and a re-run finds it again by county and date.
 *   near miss   Nothing on that date, but a sale within three days of it. One
 *               of the two dates is wrong and nothing here can tell which, so
 *               it is reported and left alone rather than inserted twice.
 *   ambiguous   Several held sales that day and nothing in the rows to choose
 *               between them. Reported, not guessed.
 *   past        Rows the workbook's author marks "Past / audit only", and any
 *               sale dated before today, are not written.
 *
 * What a channel wrote on an earlier run — logistics carrying its source, the
 * row of a sale it inserted — is its own to rewrite, so a corrected or newer
 * report supersedes the last one. Anything written by anyone else is only ever
 * filled where empty.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { auctions, counties, type AuctionLogistics } from "../db/schema";
import type { SaleType } from "../atlas/types";
import { CountyIndex, describeFailure } from "./counties";
import { derivePlatform } from "./auction-rows";
import { IMPORT_ID_PREFIX } from "./provenance";
import { resolveSourceUrl } from "./source-url";
import { recordImport, recordSafely, type ImportStages, type ImportVia } from "./history";
import { enqueueImportEnrichment, type ImportEnrichment } from "./enrich";
import { validateOverrides } from "../admin/auction-override-fields";
import { recordCountySource } from "../ingest/county-sources";
import {
  readJurisdiction,
  readScoutTab,
  readWorkbook,
  SCOUT_TABS,
  venueOf,
  type ScoutRow,
  type ScoutRowOutcome,
  type ScoutTab,
} from "./scout-workbook";

/** How far apart two dates for one county can be and still be one sale. */
export const NEAR_DAYS = 3;

const shift = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a: string, b: string) =>
  Math.round(Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
export const localToday = () => new Date().toLocaleDateString("en-CA");

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface IngestChannel {
  /** Stored as `raw["Scout Channel"]` on the sales it inserts. */
  name: string;
  /** Written to `logistics.source`. */
  source: string;
  /** Whether logistics carrying this source were written by an earlier run of this channel. */
  ownsLogistics(source: string): boolean;
  /** Extra keys stored in `raw` on the sales this channel inserts. */
  rawExtra: Record<string, unknown>;
  /** The import-history label. */
  label: string;
  via: ImportVia;
}

const WORKBOOK_SOURCE = "the Auction Scout workbook (";
const RESEARCH_SOURCE = "the Auction Scout research (";

/** A tab of Ed's workbook. Any later workbook's same tab supersedes this one. */
export function workbookChannel(workbook: string, tab: string, via: ImportVia): IngestChannel {
  return {
    name: tab,
    source: `${WORKBOOK_SOURCE}${workbook}, ${tab} tab)`,
    ownsLogistics: (s) => s.startsWith(WORKBOOK_SOURCE) && s.endsWith(`, ${tab} tab)`),
    rawExtra: { Workbook: workbook, "Workbook Tab": tab },
    label: `${workbook} — ${tab}`,
    via,
  };
}

/** One state's AI research run. A later run for any state supersedes it. */
export function researchChannel(state: string, generatedAt: string): IngestChannel {
  const day = generatedAt.slice(0, 10);
  return {
    name: "Auction Scout research",
    source: `${RESEARCH_SOURCE}${state}, ${day})`,
    ownsLogistics: (s) => s.startsWith(RESEARCH_SOURCE),
    rawExtra: { "Research State": state, "Researched At": generatedAt },
    label: `Auction Scout research — ${state} ${day}`,
    via: "cli",
  };
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** Words that say what kind of thing a title names rather than which one. */
const GENERIC = new Set([
  "city", "town", "township", "village", "borough", "of", "county", "the",
  "sale", "sales", "auction", "tax", "property", "properties", "none",
]);

/**
 * The words in a title that identify it.
 *
 * "Sardis City" and "City of Sardis" are both {sardis}; "Re-Offer Sale",
 * "Reoffer Sale" and "ReOffer Sale" are all {reoffer}. A title reading "None"
 * is the calendar's way of writing no title, and comes out empty.
 */
function words(s: string | null): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/re-?offer/g, "reoffer")
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !GENERIC.has(w)),
  );
}
const within = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((w) => b.has(w));
/** A held title naming a municipality: "Sardis City", "Bartow Town". */
const MUNICIPAL = /\b(city|town|township|village|borough)\s*$/i;

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export interface Held {
  id: string;
  externalId: string;
  /** For a sale a Scout channel inserted, which one. */
  channel: string | null;
  raw: Record<string, unknown> | null;
  countyFips: string;
  saleDate: string;
  title: string | null;
  platform: string;
  startTime: string | null;
  operatorOverrides: Record<string, unknown> | null;
  logistics: AuctionLogistics | null;
  announcedParcelCount: number | null;
}

/** One sale, as the one or more rows that describe it. */
export interface Sale {
  fips: string;
  saleDate: string;
  /** The body selling when it is not the county. See `Jurisdiction.sale`. */
  body: string | null;
  reoffer: boolean;
  rows: ScoutRow[];
  where: string;
  saleType: SaleType;
  venue: AuctionLogistics["venue"] | null;
  contact: ScoutRow["contact"] | null;
  method: string | null;
  address: string | null;
  parcels: number | null;
  amount: string | null;
  site: string | null;
  listUrl: string | null;
  startTime: string | null;
}

/** The first non-empty value in row order. */
function first<T>(rows: ScoutRow[], pick: (r: ScoutRow) => T | null | undefined): T | null {
  for (const r of rows) {
    const v = pick(r);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function saleOf(fips: string, body: string | null, rows: ScoutRow[], reoffer: boolean): Sale {
  const lead = rows[0];
  return {
    fips,
    saleDate: lead.saleDate,
    body,
    reoffer,
    rows,
    where: `${lead.label}, ${lead.state}`,
    saleType: lead.saleType,
    venue: first(rows, venueOf),
    /* A whole contact from one row — never one row's name beside another's number. */
    contact: first(rows, (r) => (r.contact.name || r.contact.phone || r.contact.email ? r.contact : null)),
    method: first(rows, (r) => r.method),
    address: first(rows, (r) => r.address),
    parcels: first(rows, (r) => r.parcels),
    amount: first(rows, (r) => r.amount),
    site: first(rows, (r) => r.site),
    listUrl: first(rows, (r) => r.listUrl),
    startTime: first(rows, (r) => r.startTime),
  };
}

const titleOf = (s: Sale) => s.body ?? (s.reoffer ? "Re-Offer Sale" : null);

export type Verdict =
  | { kind: "match"; held: Held }
  | { kind: "insert" }
  | { kind: "near_miss"; nearest: Held[] }
  | { kind: "ambiguous"; candidates: Held[]; why: string };

export type Decision = { sale: Sale } & Verdict;

/**
 * Which held sale this is, if any.
 *
 * A sale by a named body — a town, a school district — is matched only to a
 * held sale carrying that name; with none, it is a sale the calendar does not
 * hold, whatever else the county is selling that day. The county's own sale is
 * matched to the one non-municipal sale it holds that day; where it holds
 * several, to the one whose title the rows' sale-type labels name ("Tax Title
 * Properties Auction", "Re-Offer"), then to the one on the platform the rows
 * cite, then to the one untitled sale beside a set of titled ones.
 */
function decide(sale: Sale, held: Held[]): Verdict {
  const sameDay = held.filter((h) => h.saleDate === sale.saleDate);
  const nearby = held.filter((h) => h.saleDate !== sale.saleDate && daysApart(h.saleDate, sale.saleDate) <= NEAR_DAYS);
  const one = (hits: Held[]): Verdict | null => (hits.length === 1 ? { kind: "match", held: hits[0] } : null);
  const nearOrNew = (near: Held[]): Verdict =>
    near.length ? { kind: "near_miss", nearest: near } : { kind: "insert" };

  if (sale.body) {
    const name = words(sale.body);
    const named = (h: Held) => within(name, words(h.title)) || within(words(h.title), name);
    const hits = sameDay.filter(named);
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits, why: `several are titled for ${sale.body}` };
    return one(hits) ?? nearOrNew(nearby.filter(named));
  }

  const county = sameDay.filter((h) => !MUNICIPAL.test(h.title ?? ""));
  if (county.length === 0) return nearOrNew(nearby.filter((h) => !MUNICIPAL.test(h.title ?? "")));
  if (county.length === 1) return { kind: "match", held: county[0] };

  const kinds = words(
    [...sale.rows.map((r) => String(r.raw["Auction Type"] ?? r.raw.saleKind ?? "")), sale.reoffer ? "reoffer" : ""].join(" "),
  );
  const platform = derivePlatform(sale.site, sale.method ?? sale.address);
  return (
    one(county.filter((h) => within(words(h.title), kinds))) ??
    one(county.filter((h) => h.platform === platform)) ??
    one(county.filter((h) => words(h.title).size === 0)) ?? {
      kind: "ambiguous",
      candidates: county,
      why: "nothing in the rows chooses one",
    }
  );
}

function logisticsFor(sale: Sale, source: string, today: string): AuctionLogistics | null {
  if (!sale.venue && !sale.contact) return null;
  return {
    ...(sale.venue ? { venue: sale.venue } : {}),
    ...(sale.contact ? { contact: sale.contact } : {}),
    source,
    importedAt: today,
  };
}

/** JSON with keys sorted, because `jsonb` hands objects back in its own key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The part of logistics that says something, for telling a real change from a re-stamp. */
const substance = (l: AuctionLogistics | null) => canonical(l ? { venue: l.venue, contact: l.contact } : null);

/**
 * The row stored for a sale a channel inserts.
 *
 * The rows verbatim, plus the few keys `readAnnouncedDetail` renders on the
 * auction page, under the names it reads — without them an imported sale's
 * page is a date and an empty table. Contact details are deliberately not
 * among them. The date is ISO: the report tab holds an Excel serial, which is
 * a cell format, not a value.
 */
function rawFor(s: Sale, channel: IngestChannel): Record<string, unknown> {
  return {
    ...s.rows[0].raw,
    "Sale Date": s.saleDate,
    ...channel.rawExtra,
    "Scout Channel": channel.name,
    "Source Rows": s.rows.map((r) => r.line),
    ...(s.rows.length > 1 ? { "Also Described As": s.rows.slice(1).map((r) => r.raw) } : {}),
    ...(s.method || s.venue ? { "Online or Onsite": s.method ?? (s.venue!.kind === "online" ? "Online" : "Live") } : {}),
    ...(s.venue?.kind === "in_person" ? { "Sale Address 1": s.venue.text } : {}),
    ...(s.amount ? { "Aggregate Sale Amount (USD)": s.amount } : {}),
    ...(s.site ? { "Online Site (Deed)": s.site } : {}),
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface Reject {
  line: number;
  label: string;
  problem: string;
}

type AuctionInsert = typeof auctions.$inferInsert;

export interface Fill {
  id: string;
  sale: Sale;
  /** True when every value in `set` replaces one this channel wrote itself. */
  rewrite: boolean;
  set: {
    logistics?: AuctionLogistics | null;
    announcedParcelCount?: number;
    raw?: Record<string, unknown>;
    operatorOverrides?: Record<string, unknown>;
  };
}

export interface IngestPlan {
  channel: IngestChannel;
  today: string;
  /** For the import history: the grid as read, when there was one. */
  read: { columns: number; rows: number; blank: number };
  translated: number;
  untranslated: number;
  past: number;
  rejects: Reject[];
  placedRows: number;
  viaParent: number;
  sales: Sale[];
  decisions: Decision[];
  fills: Fill[];
  inserts: { sale: Sale; values: AuctionInsert }[];
  keptLogistics: number;
  countDisagrees: number;
  nothingToAdd: number;
  /** County property lists the rows link, for the crawler's source table. */
  listLinks: { fips: string; url: string; where: string }[];
}

let countyCache: { index: CountyIndex; byFips: Map<string, { state: string; name: string }> } | null = null;

async function countyIndex() {
  if (countyCache) return countyCache;
  const refs = await db
    .select({ fips: counties.fips, name: counties.name, state: counties.state, stateName: counties.stateName })
    .from(counties);
  countyCache = { index: new CountyIndex(refs), byFips: new Map(refs.map((r) => [r.fips, { state: r.state, name: r.name }])) };
  return countyCache;
}

/**
 * Decide what every row would do, reading the calendar but writing nothing.
 */
export async function planScoutIngest(
  outcomes: ScoutRowOutcome[],
  channel: IngestChannel,
  opts: { read?: IngestPlan["read"]; today?: string } = {},
): Promise<IngestPlan> {
  const today = opts.today ?? localToday();
  const { index, byFips } = await countyIndex();

  const rejects: Reject[] = [];
  let past = 0, viaParent = 0, placedRows = 0;
  const groups = new Map<string, { fips: string; body: string | null; reoffer: boolean; rows: ScoutRow[] }>();

  for (const o of outcomes) {
    if (!o.ok) {
      rejects.push({ line: o.line, label: o.label, problem: o.problem });
      continue;
    }
    const row = o.row;
    const where = `${row.label}, ${row.state}`;
    if (!row.forward || row.saleDate < today) {
      past++;
      continue;
    }
    const j = readJurisdiction(row.state, row.label);
    if (!j.ok) {
      rejects.push({ line: row.line, label: where, problem: j.problem });
      continue;
    }
    const m = index.resolve(row.state, j.county);
    if (!m.ok) {
      rejects.push({ line: row.line, label: where, problem: describeFailure(m.reason) });
      continue;
    }
    /* A bracketed municipality `CountyIndex` filed under its parent keeps its name. */
    const body = j.sale ?? (m.via === "parent" ? (m.municipality ?? null) : null);
    if (m.via === "parent") viaParent++;
    placedRows++;

    const key = `${m.fips}|${row.saleDate}|${[...words(body)].sort().join(" ")}`;
    const g = groups.get(key) ?? { fips: m.fips, body, reoffer: false, rows: [] };
    g.rows.push(row);
    g.reoffer ||= j.reoffer;
    groups.set(key, g);
  }
  const sales = [...groups.values()].map((g) => saleOf(g.fips, g.body, g.rows, g.reoffer));

  const dates = sales.map((s) => s.saleDate).sort();
  const heldRows: Held[] = sales.length
    ? await db
        .select({
          id: auctions.id,
          externalId: auctions.externalId,
          channel: sql<string | null>`coalesce(${auctions.raw}->>'Scout Channel', ${auctions.raw}->>'Workbook Tab')`,
          raw: auctions.raw,
          countyFips: auctions.countyFips,
          saleDate: auctions.saleDate,
          title: auctions.title,
          platform: auctions.platform,
          startTime: auctions.startTime,
          operatorOverrides: auctions.operatorOverrides,
          logistics: auctions.logistics,
          announcedParcelCount: auctions.announcedParcelCount,
        })
        .from(auctions)
        .where(
          and(
            inArray(auctions.countyFips, [...new Set(sales.map((s) => s.fips))]),
            gte(auctions.saleDate, shift(dates[0], -NEAR_DAYS)),
            lte(auctions.saleDate, shift(dates[dates.length - 1], NEAR_DAYS)),
          ),
        )
    : [];
  const heldBy = new Map<string, Held[]>();
  for (const h of heldRows) heldBy.set(h.countyFips, [...(heldBy.get(h.countyFips) ?? []), h]);

  /* Matches are one-to-one, as in `planImport`: a held sale absorbs one of ours. */
  const claimed = new Set<string>();
  const decisions: Decision[] = sales.map((sale) => {
    let v = decide(sale, heldBy.get(sale.fips) ?? []);
    if (v.kind === "match") {
      if (claimed.has(v.held.id)) v = { kind: "ambiguous", candidates: [v.held], why: "another sale in this batch already matched it" };
      else claimed.add(v.held.id);
    }
    return { sale, ...v };
  });

  // ---- what each decision writes ---------------------------------------------

  const ownsSale = (h: Held) => h.externalId.startsWith(`${IMPORT_ID_PREFIX}scout:`) && h.channel === channel.name;
  const fills: Fill[] = [];
  let keptLogistics = 0, countDisagrees = 0, nothingToAdd = 0;
  for (const d of decisions) {
    if (d.kind !== "match") continue;
    const set: Fill["set"] = {};
    let rewrite = true;
    const logistics = logisticsFor(d.sale, channel.source, today);
    if (!d.held.logistics) {
      if (logistics) {
        set.logistics = logistics;
        rewrite = false;
      }
    } else if (channel.ownsLogistics(d.held.logistics.source)) {
      if (substance(logistics) !== substance(d.held.logistics)) set.logistics = logistics;
    } else if (logistics) keptLogistics++;

    const ours = ownsSale(d.held);
    if (d.sale.parcels !== null && d.held.announcedParcelCount === null) {
      set.announcedParcelCount = d.sale.parcels;
      rewrite = false;
    } else if (d.sale.parcels !== null && d.held.announcedParcelCount !== d.sale.parcels) {
      if (ours) set.announcedParcelCount = d.sale.parcels;
      else countDisagrees++;
    }

    /*
     * A start time goes in as an operator correction, never as a column write:
     * `start_time` is adapter-owned and the next crawl's upsert would revert it
     * (`import-auction-csv.ts` documents the morning that happened). Only where
     * nothing has published one, and through the same validator the console
     * uses — an out-of-domain value raises inside that upsert on every crawl.
     */
    const overrides = d.held.operatorOverrides ?? {};
    if (d.sale.startTime && !d.held.startTime && !overrides.startTime && !validateOverrides({ startTime: d.sale.startTime }).length) {
      set.operatorOverrides = { ...overrides, startTime: d.sale.startTime };
      rewrite = false;
    }

    if (ours) {
      const raw = rawFor(d.sale, channel);
      if (canonical(raw) !== canonical(d.held.raw)) set.raw = raw;
    }

    if (Object.keys(set).length) fills.push({ id: d.held.id, sale: d.sale, rewrite, set });
    else nothingToAdd++;
  }

  const inserts = decisions.flatMap((d) => {
    if (d.kind !== "insert") return [];
    const s = d.sale;
    const ref = byFips.get(s.fips)!;
    const title = titleOf(s);
    const titleKey = title ? `:${[...words(title)].join("-").slice(0, 40)}` : "";
    const values: AuctionInsert = {
      countyFips: s.fips,
      platform: derivePlatform(s.site, s.method ?? s.address),
      saleType: s.saleType,
      externalId: `${IMPORT_ID_PREFIX}scout:${s.fips}:${s.saleDate}${titleKey}`,
      title,
      saleDate: s.saleDate,
      /* Relayed from the county's own notice, not projected — see `apply.ts`. */
      saleDateConfirmed: true,
      /* A count, not a parsed list — see `apply.ts` on `listing_kind`. */
      listingKind: "unknown",
      status: "scheduled",
      startTime: s.startTime,
      /* The Scout's own citation first; the county waterfall where it has none. */
      sourceUrl: s.site ?? resolveSourceUrl({ countyFips: s.fips, state: ref.state, countyName: ref.name }).url,
      announcedParcelCount: s.parcels,
      logistics: logisticsFor(s, channel.source, today),
      raw: rawFor(s, channel),
    };
    return [{ sale: s, values }];
  });

  const listLinks = sales
    .filter((s) => s.listUrl)
    .map((s) => ({ fips: s.fips, url: s.listUrl!, where: s.where }));

  const untranslated = outcomes.filter((o) => !o.ok).length;
  return {
    channel,
    today,
    read: opts.read ?? { columns: 0, rows: outcomes.length, blank: 0 },
    translated: outcomes.length - untranslated,
    untranslated,
    past,
    rejects,
    placedRows,
    viaParent,
    sales,
    decisions,
    fills,
    inserts,
    keptLogistics,
    countDisagrees,
    nothingToAdd,
    listLinks,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export const decisionsOf = <K extends Verdict["kind"]>(plan: IngestPlan, k: K) =>
  plan.decisions.filter((d): d is { sale: Sale } & Extract<Verdict, { kind: K }> => d.kind === k);

/** The rows that did not go in, as the import history and the review list word them. */
export function unresolved(plan: IngestPlan): Reject[] {
  const lineOf = (s: Sale) => s.rows[0].line;
  return [
    ...plan.rejects,
    ...decisionsOf(plan, "near_miss").map((d) => ({
      line: lineOf(d.sale),
      label: d.sale.where,
      problem: `dated ${d.sale.saleDate}; the calendar holds ${d.nearest.map((h) => h.saleDate).join(", ")}`,
    })),
    ...decisionsOf(plan, "ambiguous").map((d) => ({
      line: lineOf(d.sale),
      label: d.sale.where,
      problem: `${d.candidates.length} sale(s) held on ${d.sale.saleDate}; ${d.why}`,
    })),
  ];
}

export interface IngestResult {
  filled: number;
  inserted: number;
  enrichment: ImportEnrichment;
}

/**
 * Write the plan in one transaction, record it in the import history, and
 * queue crawls for the counties it touched.
 */
export async function applyScoutIngest(plan: IngestPlan, opts: { actor?: string } = {}): Promise<IngestResult> {
  const started = Date.now();
  await db.transaction(async (tx) => {
    for (const f of plan.fills) await tx.update(auctions).set(f.set).where(eq(auctions.id, f.id));
    for (const i of plan.inserts) await tx.insert(auctions).values(i.values).onConflictDoNothing();
  });

  const dates = plan.sales.map((s) => s.saleDate).sort();
  const stages: ImportStages = {
    read: plan.read,
    translate: { parsed: plan.translated, rejected: plan.untranslated },
    resolve: { resolved: plan.placedRows, viaParent: plan.viaParent, rejected: plan.rejects.length - plan.untranslated },
    write: {
      inserted: plan.inserts.length,
      updated: plan.fills.length,
      merged: decisionsOf(plan, "match").length,
      duplicateInFile: plan.placedRows - plan.sales.length,
      ambiguous: decisionsOf(plan, "ambiguous").length + decisionsOf(plan, "near_miss").length,
    },
  };
  await recordSafely(() =>
    recordImport({ source: plan.channel.label, via: plan.channel.via, actor: opts.actor }, stages, {
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      counties: new Set(plan.sales.map((s) => s.fips)).size,
      durationMs: Date.now() - started,
      rejects: unresolved(plan),
    }),
  );

  /*
   * Every county the plan placed a sale in, not only the new ones: a matched
   * sale can hold no parcels either, and `enqueueImportEnrichment` itself
   * decides which counties actually need a crawl.
   */
  const touched = [...new Set([...plan.inserts.map((i) => i.values.countyFips), ...decisionsOf(plan, "match").map((d) => d.held.countyFips)])];
  const enrichment = await enqueueImportEnrichment(touched, opts.actor ?? plan.channel.via);
  return { filled: plan.fills.length, inserted: plan.inserts.length, enrichment };
}

/**
 * Record the property-list links of the sales a plan placed as crawl sources.
 * Returns how many were new. Policy is checked per link; see `recordCountySource`.
 */
export async function recordListLinks(plan: IngestPlan, origin: string, addedBy: string): Promise<number> {
  let added = 0;
  for (const link of plan.listLinks) {
    const outcome = await recordCountySource({ countyFips: link.fips, url: link.url, origin, addedBy, note: link.where });
    if (outcome === "added") added++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** The plan as lines of text — for the terminal and the console alike. */
export function describePlan(plan: IngestPlan, opts: { verbose?: boolean } = {}): string[] {
  const out: string[] = [];
  const n = (k: Verdict["kind"]) => decisionsOf(plan, k).length;
  const filling = plan.fills.filter((f) => !f.rewrite);
  out.push(`rows                         ${plan.translated + plan.untranslated}`);
  out.push(`  past / audit only          ${plan.past}  (not written)`);
  out.push(`  rejected                   ${plan.rejects.length}`);
  out.push(`  placed in a county         ${plan.placedRows}  (${plan.viaParent} under a parent county)`);
  out.push(`sales those rows describe    ${plan.sales.length}  (${plan.placedRows - plan.sales.length} rows repeat another row's sale)`);
  out.push(`matched to a held sale       ${n("match")}`);
  out.push(`  filling what it lacked     ${filling.length}`);
  out.push(`    venue + contact          ${filling.filter((f) => f.set.logistics).length}`);
  out.push(`    announced parcel count   ${filling.filter((f) => f.set.announcedParcelCount !== undefined).length}`);
  out.push(`    start time               ${filling.filter((f) => f.set.operatorOverrides).length}`);
  out.push(`  rewriting its own values   ${plan.fills.length - filling.length}  (an earlier run of this channel wrote them)`);
  out.push(`  already had logistics      ${plan.keptLogistics}  (kept)`);
  out.push(`  parcel count disagrees     ${plan.countDisagrees}  (kept the held count)`);
  out.push(`  nothing to add             ${plan.nothingToAdd}`);
  out.push(`new sales to insert          ${plan.inserts.length}`);
  out.push(`near misses (±${NEAR_DAYS}d, left)     ${n("near_miss")}`);
  out.push(`ambiguous (left)             ${n("ambiguous")}`);

  if (plan.inserts.length) {
    out.push("", "new sales:");
    for (const { sale: s, values: v } of plan.inserts) {
      out.push(
        `  ${s.saleDate}  ${s.where}${v.title ? ` — ${v.title}` : ""}  [${v.saleType}, ${v.platform}]` +
          `${v.announcedParcelCount != null ? `  ${v.announcedParcelCount} parcels` : ""}` +
          `${s.rows.length > 1 ? `  (rows ${s.rows.map((r) => r.line).join(", ")})` : ""}`,
      );
    }
  }
  if (opts.verbose) {
    out.push("", "matches:");
    const filled = new Map(plan.fills.map((f) => [f.id, f.set]));
    for (const d of decisionsOf(plan, "match")) {
      const set = filled.get(d.held.id);
      out.push(
        `  ${d.sale.saleDate}  ${d.sale.where} (rows ${d.sale.rows.map((r) => r.line).join(", ")})` +
          `  →  ${JSON.stringify(d.held.title ?? "")} [${d.held.platform}]  ${set ? Object.keys(set).join(" + ") : "nothing to add"}`,
      );
    }
  }
  if (n("near_miss")) {
    out.push("", "near misses — the Scout and the calendar disagree on the date:");
    for (const d of decisionsOf(plan, "near_miss")) {
      out.push(`  ${d.sale.where}  Scout ${d.sale.saleDate}  held ${d.nearest.map((h) => h.saleDate).join(", ")}`);
    }
  }
  if (n("ambiguous")) {
    out.push("", "ambiguous — left for a person:");
    for (const d of decisionsOf(plan, "ambiguous")) {
      out.push(`  ${d.sale.where} ${d.sale.saleDate}  held: ${d.candidates.map((h) => JSON.stringify(h.title ?? "")).join(", ")} — ${d.why}`);
    }
  }
  if (plan.rejects.length) {
    out.push("", "rejected:");
    for (const r of plan.rejects) out.push(`  line ${r.line}  ${r.label} — ${r.problem}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A whole workbook
// ---------------------------------------------------------------------------

export interface WorkbookTabOutcome {
  tab: ScoutTab;
  plan: IngestPlan;
  result: IngestResult | null;
  /** New crawl sources recorded from the tab's property-list links. */
  sourcesAdded: number;
}

/**
 * Plan — and with `apply`, write — each Scout tab of a workbook, in order.
 *
 * The report tab goes first so the source tab, applied after it, sees what the
 * report wrote and fills only what is still empty. Without `apply` each tab is
 * planned against the calendar as it stands.
 */
export async function ingestWorkbook(
  bytes: Uint8Array,
  workbook: string,
  opts: { apply: boolean; via: ImportVia; actor?: string; tabs?: readonly ScoutTab[] },
): Promise<WorkbookTabOutcome[]> {
  const book = await readWorkbook(bytes);
  const tabs = opts.tabs ?? SCOUT_TABS;
  const missing = tabs.filter((t) => !book.has(t));
  if (missing.length === tabs.length) {
    throw new Error(`no Auction Scout tab found — the workbook has: ${[...book.keys()].join(", ")}`);
  }

  const out: WorkbookTabOutcome[] = [];
  for (const tab of tabs) {
    const grid = book.get(tab);
    if (!grid) continue;
    const outcomes = readScoutTab(tab, grid);
    const plan = await planScoutIngest(outcomes, workbookChannel(workbook, tab, opts.via), {
      read: { columns: grid[0]?.length ?? 0, rows: grid.length - 1, blank: grid.length - 1 - outcomes.length },
    });
    const result = opts.apply ? await applyScoutIngest(plan, { actor: opts.actor }) : null;
    const sourcesAdded = opts.apply ? await recordListLinks(plan, "auction-scout-workbook", opts.actor ?? opts.via) : 0;
    out.push({ tab, plan, result, sourcesAdded });
  }
  return out;
}
