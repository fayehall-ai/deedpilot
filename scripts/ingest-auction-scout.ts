/**
 * Read the Auction Scout workbook into the calendar.
 *
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx>                  # plan only
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx> --apply          # write
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx> --tab "Auction Scout"
 *   npx tsx scripts/ingest-auction-scout.ts <report.xlsx> --verbose        # every match
 *
 * With no file, the newest xlsx in `data/auction-scout/`. With no `--tab`, the
 * report tab and then its source tab, in that order, so the source tab sees
 * what the report wrote and fills only what is still empty.
 *
 * ## Rows are not sales
 *
 * The report names many sales twice: once from the desk's own research — a
 * verified venue, a long sale-type label, no parcel count — and once carried
 * over from the sale calendar, with a count and the calendar's link. Michigan's
 * "Arenac County" and "Arenac County Re-Offer" on 25 September are the same
 * re-offer sale. So rows are first grouped into sales — one county, one date,
 * one body selling — and each sale takes the first non-empty value of each
 * field in sheet order, which puts the verified research ahead of the carried
 * copy. A town's sale and its county's sale on the same day stay two sales.
 *
 * ## What a sale does
 *
 * Each sale is matched to the one its county holds on that date — any sale,
 * crawled or imported. That last part is why this is not `import:apply`:
 * `planImport` only merges into *crawled* sales and treats an earlier import's
 * rows as someone else's, so two-thirds of this report would have been
 * inserted a second time beside the calendar rows it was built from.
 *
 *   matched     Fills what the held sale is missing — venue and contact, the
 *               announced parcel count — and nothing else. Its date, type,
 *               platform and citation belong to whatever crawled or imported
 *               it, and a value already there is never replaced: the report is
 *               a summary of those same sources, not a correction of them.
 *   new         A sale nothing holds. Inserted with an `import:scout:` id, so
 *               it reads as imported everywhere imported sales are treated
 *               differently, and a re-run finds it again by county and date.
 *   near miss   Nothing on that date, but a sale within three days of it. One
 *               of the two dates is wrong and nothing here can tell which, so
 *               it is reported and left alone rather than inserted twice.
 *   ambiguous   Several held sales that day and nothing in the rows to choose
 *               between them. Reported, not guessed.
 *   past        The source tab's author marks most of it "Past / audit only";
 *               those rows, and any sale dated before today, are not written.
 *
 * ## Provenance
 *
 * Logistics carry `source` naming the workbook and tab, and each tab's run is
 * recorded in the import history the console shows. The named contact goes
 * only into `logistics`, which the console reads and the public pages do not —
 * see the note on `AuctionLogistics.contact`.
 */
import "../lib/env";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, counties, type AuctionLogistics } from "../lib/db/schema";
import type { SaleType } from "../lib/atlas/types";
import { CountyIndex, describeFailure } from "../lib/import/counties";
import { derivePlatform } from "../lib/import/auction-rows";
import { IMPORT_ID_PREFIX } from "../lib/import/provenance";
import { resolveSourceUrl } from "../lib/import/source-url";
import { recordImport, recordSafely, type ImportStages } from "../lib/import/history";
import { enqueueImportEnrichment } from "../lib/import/enrich";
import {
  readJurisdiction,
  readScoutTab,
  readWorkbook,
  SCOUT_TABS,
  venueOf,
  type ScoutRow,
  type ScoutTab,
} from "../lib/import/scout-workbook";

const APPLY = process.argv.includes("--apply");
/** List every match and what it fills, not just the totals. */
const VERBOSE = process.argv.includes("--verbose");
const DIR = "data/auction-scout";
/** How far apart two dates for one county can be and still be one sale. */
const NEAR_DAYS = 3;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function workbookPath(): string {
  const given = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--tab");
  if (given) return given;
  const newest = readdirSync(DIR)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .map((f) => path.join(DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) throw new Error(`no workbook given and none in ${DIR}/`);
  return newest;
}

const today = new Date().toLocaleDateString("en-CA");
const shift = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a: string, b: string) =>
  Math.round(Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

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

interface Held {
  id: string;
  externalId: string;
  /** For a sale this script inserted, the tab that inserted it. */
  workbookTab: string | null;
  raw: Record<string, unknown> | null;
  countyFips: string;
  saleDate: string;
  title: string | null;
  platform: string;
  logistics: AuctionLogistics | null;
  announcedParcelCount: number | null;
}

/** One sale, as the one or more rows of a tab that describe it. */
interface Sale {
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
}

/** The first non-empty value in sheet order. */
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
  };
}

const titleOf = (s: Sale) => s.body ?? (s.reoffer ? "Re-Offer Sale" : null);

type Verdict =
  | { kind: "match"; held: Held }
  | { kind: "insert" }
  | { kind: "near_miss"; nearest: Held[] }
  | { kind: "ambiguous"; candidates: Held[]; why: string };

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

  const kinds = words([...sale.rows.map((r) => r.raw["Auction Type"] ?? ""), sale.reoffer ? "reoffer" : ""].join(" "));
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

function logisticsFor(sale: Sale, source: string): AuctionLogistics | null {
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
 * The row this script stores for a sale it inserts.
 *
 * The rows verbatim, plus the few keys `readAnnouncedDetail` renders on the
 * auction page, under the names it reads — without them an imported sale's
 * page is a date and an empty table. Contact details are deliberately not
 * among them. The date is ISO: the report tab holds an Excel serial, which is
 * a cell format, not a value.
 */
function rawFor(s: Sale, workbook: string, tab: ScoutTab): Record<string, unknown> {
  return {
    ...s.rows[0].raw,
    "Sale Date": s.saleDate,
    Workbook: workbook,
    "Workbook Tab": tab,
    "Workbook Rows": s.rows.map((r) => r.line),
    ...(s.rows.length > 1 ? { "Also Described As": s.rows.slice(1).map((r) => r.raw) } : {}),
    ...(s.method || s.venue ? { "Online or Onsite": s.method ?? (s.venue!.kind === "online" ? "Online" : "Live") } : {}),
    ...(s.venue?.kind === "in_person" ? { "Sale Address 1": s.venue.text } : {}),
    ...(s.amount ? { "Aggregate Sale Amount (USD)": s.amount } : {}),
    ...(s.site ? { "Online Site (Deed)": s.site } : {}),
  };
}

// ---------------------------------------------------------------------------
// One tab
// ---------------------------------------------------------------------------

async function runTab(
  file: string,
  tab: ScoutTab,
  grid: string[][],
  index: CountyIndex,
  byFips: Map<string, { state: string; name: string }>,
) {
  const started = Date.now();
  const workbook = path.basename(file);
  const source = `the Auction Scout workbook (${workbook}, ${tab} tab)`;
  /*
   * What this tab wrote before — from this workbook or an earlier one — is its
   * own to rewrite, so a corrected or newer report supersedes the last one.
   * Anything written by anyone else, including this workbook's other tab, is
   * only ever filled where empty.
   */
  const ownsLogistics = (l: AuctionLogistics | null) =>
    !!l && l.source.startsWith("the Auction Scout workbook (") && l.source.endsWith(`, ${tab} tab)`);
  const ownsSale = (h: Held) => h.externalId.startsWith(`${IMPORT_ID_PREFIX}scout:`) && h.workbookTab === tab;
  const outcomes = readScoutTab(tab, grid);

  const rejects: { line: number; label: string; problem: string }[] = [];
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
          workbookTab: sql<string | null>`${auctions.raw}->>'Workbook Tab'`,
          raw: auctions.raw,
          countyFips: auctions.countyFips,
          saleDate: auctions.saleDate,
          title: auctions.title,
          platform: auctions.platform,
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
  const decisions = sales.map((sale) => {
    let v = decide(sale, heldBy.get(sale.fips) ?? []);
    if (v.kind === "match") {
      if (claimed.has(v.held.id)) v = { kind: "ambiguous", candidates: [v.held], why: "another sale in this tab already matched it" };
      else claimed.add(v.held.id);
    }
    return { sale, ...v } as { sale: Sale } & Verdict;
  });

  // ---- what each decision writes ---------------------------------------------

  type Fill = {
    id: string;
    /** True when every value in `set` replaces one this tab wrote itself. */
    rewrite: boolean;
    set: { logistics?: AuctionLogistics | null; announcedParcelCount?: number; raw?: Record<string, unknown> };
  };
  const fills: Fill[] = [];
  let keptLogistics = 0, countDisagrees = 0, nothingToAdd = 0;
  for (const d of decisions) {
    if (d.kind !== "match") continue;
    const set: Fill["set"] = {};
    let rewrite = true;
    const logistics = logisticsFor(d.sale, source);
    if (!d.held.logistics) {
      if (logistics) {
        set.logistics = logistics;
        rewrite = false;
      }
    } else if (ownsLogistics(d.held.logistics)) {
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
    if (ours) {
      const raw = rawFor(d.sale, workbook, tab);
      if (canonical(raw) !== canonical(d.held.raw)) set.raw = raw;
    }

    if (Object.keys(set).length) fills.push({ id: d.held.id, rewrite, set });
    else nothingToAdd++;
  }

  const inserts = decisions.flatMap((d) => {
    if (d.kind !== "insert") return [];
    const s = d.sale;
    const ref = byFips.get(s.fips)!;
    const title = titleOf(s);
    const titleKey = title ? `:${[...words(title)].join("-").slice(0, 40)}` : "";
    return [
      {
        sale: s,
        values: {
          countyFips: s.fips,
          platform: derivePlatform(s.site, s.method ?? s.address),
          saleType: s.saleType,
          externalId: `${IMPORT_ID_PREFIX}scout:${s.fips}:${s.saleDate}${titleKey}`,
          title,
          saleDate: s.saleDate,
          /* Relayed from the county's own notice, not projected — see `apply.ts`. */
          saleDateConfirmed: true,
          /* A count, not a parsed list — see `apply.ts` on `listing_kind`. */
          listingKind: "unknown" as const,
          status: "scheduled" as const,
          /* The report's own citation first; the county waterfall where it has none. */
          sourceUrl:
            s.site ?? resolveSourceUrl({ countyFips: s.fips, state: ref.state, countyName: ref.name }).url,
          announcedParcelCount: s.parcels,
          logistics: logisticsFor(s, source),
          raw: rawFor(s, workbook, tab),
        },
      },
    ];
  });

  // ---- report -------------------------------------------------------------------

  const of = <K extends Verdict["kind"]>(k: K) =>
    decisions.filter((d): d is { sale: Sale } & Extract<Verdict, { kind: K }> => d.kind === k);
  console.log(`\n━━ ${tab}  (${workbook}) ━━`);
  console.log(`rows                         ${outcomes.length}`);
  console.log(`  past / audit only          ${past}  (not written)`);
  console.log(`  rejected                   ${rejects.length}`);
  console.log(`  placed in a county         ${placedRows}  (${viaParent} under a parent county)`);
  console.log(`sales those rows describe    ${sales.length}  (${placedRows - sales.length} rows repeat another row's sale)`);
  console.log(`matched to a held sale       ${of("match").length}`);
  const filling = fills.filter((f) => !f.rewrite);
  console.log(`  filling what it lacked     ${filling.length}`);
  console.log(`    venue + contact          ${filling.filter((f) => f.set.logistics).length}`);
  console.log(`    announced parcel count   ${filling.filter((f) => f.set.announcedParcelCount !== undefined).length}`);
  console.log(`  rewriting its own values   ${fills.length - filling.length}  (an earlier run of this tab wrote them)`);
  console.log(`  already had logistics      ${keptLogistics}  (kept)`);
  console.log(`  parcel count disagrees     ${countDisagrees}  (kept the held count)`);
  console.log(`  nothing to add             ${nothingToAdd}`);
  console.log(`new sales to insert          ${inserts.length}`);
  console.log(`near misses (±${NEAR_DAYS}d, left)     ${of("near_miss").length}`);
  console.log(`ambiguous (left)             ${of("ambiguous").length}`);

  if (inserts.length) {
    console.log("\nnew sales:");
    for (const { sale: s, values: v } of inserts) {
      console.log(
        `  ${s.saleDate}  ${s.where}${v.title ? ` — ${v.title}` : ""}  [${v.saleType}, ${v.platform}]` +
          `${v.announcedParcelCount !== null ? `  ${v.announcedParcelCount} parcels` : ""}` +
          `${s.rows.length > 1 ? `  (rows ${s.rows.map((r) => r.line).join(", ")})` : ""}`,
      );
    }
  }
  if (VERBOSE) {
    console.log("\nmatches:");
    const filled = new Map(fills.map((f) => [f.id, f.set]));
    for (const d of of("match")) {
      const set = filled.get(d.held.id);
      const what = set ? Object.keys(set).join(" + ") : "nothing to add";
      console.log(
        `  ${d.sale.saleDate}  ${d.sale.where} (rows ${d.sale.rows.map((r) => r.line).join(", ")})` +
          `  →  ${JSON.stringify(d.held.title ?? "")} [${d.held.platform}]  ${what}`,
      );
    }
  }
  if (of("near_miss").length) {
    console.log("\nnear misses — the report and the calendar disagree on the date:");
    for (const d of of("near_miss")) {
      console.log(`  ${d.sale.where}  report ${d.sale.saleDate}  held ${d.nearest.map((h) => h.saleDate).join(", ")}`);
    }
  }
  if (of("ambiguous").length) {
    console.log("\nambiguous — left for a person:");
    for (const d of of("ambiguous")) {
      console.log(
        `  ${d.sale.where} ${d.sale.saleDate}  held: ${d.candidates.map((h) => JSON.stringify(h.title ?? "")).join(", ")} — ${d.why}`,
      );
    }
  }
  if (rejects.length) {
    console.log("\nrejected:");
    for (const r of rejects) console.log(`  line ${r.line}  ${r.label} — ${r.problem}`);
  }

  if (!APPLY) return;

  // ---- write --------------------------------------------------------------------

  await db.transaction(async (tx) => {
    for (const f of fills) await tx.update(auctions).set(f.set).where(eq(auctions.id, f.id));
    for (const i of inserts) await tx.insert(auctions).values(i.values).onConflictDoNothing();
  });

  const untranslated = outcomes.filter((o) => !o.ok).length;
  const stages: ImportStages = {
    read: { columns: grid[0]?.length ?? 0, rows: grid.length - 1, blank: grid.length - 1 - outcomes.length },
    translate: { parsed: outcomes.length - untranslated, rejected: untranslated },
    resolve: { resolved: placedRows, viaParent, rejected: rejects.length - untranslated },
    write: {
      inserted: inserts.length,
      updated: fills.length,
      merged: of("match").length,
      duplicateInFile: placedRows - sales.length,
      ambiguous: of("ambiguous").length + of("near_miss").length,
    },
  };
  const lineOf = (s: Sale) => s.rows[0].line;
  await recordSafely(() =>
    recordImport({ source: `${workbook} — ${tab}`, via: "cli" }, stages, {
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      counties: new Set(sales.map((s) => s.fips)).size,
      durationMs: Date.now() - started,
      rejects: [
        ...rejects,
        ...of("near_miss").map((d) => ({
          line: lineOf(d.sale),
          label: d.sale.where,
          problem: `dated ${d.sale.saleDate}; the calendar holds ${d.nearest.map((h) => h.saleDate).join(", ")}`,
        })),
        ...of("ambiguous").map((d) => ({
          line: lineOf(d.sale),
          label: d.sale.where,
          problem: `${d.candidates.length} sale(s) held on ${d.sale.saleDate}; ${d.why}`,
        })),
      ],
    }),
  );

  const e = await enqueueImportEnrichment([...new Set(inserts.map((i) => i.values.countyFips))], "cli");
  console.log(
    `\nwrote ${fills.length} fill(s) and ${inserts.length} new sale(s); ` +
      `queued ${e.queued} county crawl(s) for the new sales (${e.alreadyBusy} already busy)`,
  );
}

async function main() {
  const file = workbookPath();
  const only = arg("tab");
  const tabs = only ? SCOUT_TABS.filter((t) => t === only) : [...SCOUT_TABS];
  if (only && tabs.length === 0) throw new Error(`--tab must be one of: ${SCOUT_TABS.join(", ")}`);

  const book = await readWorkbook(readFileSync(file));
  const refs = await db
    .select({ fips: counties.fips, name: counties.name, state: counties.state, stateName: counties.stateName })
    .from(counties);
  const index = new CountyIndex(refs);
  const byFips = new Map(refs.map((r) => [r.fips, { state: r.state, name: r.name }]));

  for (const tab of tabs) {
    const grid = book.get(tab);
    if (!grid) throw new Error(`"${tab}" tab not found — the workbook has: ${[...book.keys()].join(", ")}`);
    await runTab(file, tab, grid, index, byFips);
  }
  if (!APPLY) console.log("\nplan only — pass --apply to write");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
