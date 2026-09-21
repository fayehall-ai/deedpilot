/**
 * The AI Auction Scout's findings into the calendar.
 *
 * A state's research run ends with a list of sales read off the live web. Until
 * now it went nowhere but a spreadsheet download, and that spreadsheet could not
 * be fed back in — different columns, different sale-type words. This runs the
 * findings through the same matcher as Ed's workbook (`scout-ingest.ts`) as the
 * research finishes, under one rule for what may go in unattended:
 *
 *   A row the model marks `confirmed` — the page names this county, this kind
 *   of sale and this date — read from an official county page goes straight in:
 *   fill-only on a sale the calendar holds, a new `import:scout:` sale where it
 *   holds none, and the county's list link recorded as a crawl source.
 *
 *   Everything else waits in `scout_findings` for Ed: a platform listing rather
 *   than the county's page, a date the model could not confirm, a date that
 *   disagrees with the calendar, a county it could not place, a sale kind it
 *   did not recognise. Approving one runs the same matcher on that row alone.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { scoutFindings } from "../db/schema";
import type { SaleType } from "../atlas/types";
import { STATE_DATA, toSaleType } from "../atlas";
import type { ScoutRow as ResearchRow, StateReportResult } from "../ai/scout-report";
import {
  applyScoutIngest,
  decisionsOf,
  localToday,
  planScoutIngest,
  recordListLinks,
  researchChannel,
  unresolved,
} from "./scout-ingest";
import { urlOf, type ScoutRow, type ScoutRowOutcome } from "./scout-workbook";

const CHANNEL = "Auction Scout research";

/**
 * The research's sale kinds, in the schema's vocabulary.
 *
 * Three name a sale without naming what it conveys — a sheriff's tax sale, a
 * tax commissioner's sale, a county tax auction — and for those the state's own
 * sale type is the answer: that is what a tax sale in that state sells. A kind
 * outside the list is not guessed at; the row waits for a person.
 */
const KINDS: Record<string, SaleType | "state"> = {
  "tax deed": "Tax Deed",
  "redeemable tax deed": "Redeemable Deed",
  "tax foreclosure": "Tax Deed",
  "sheriff tax sale": "state",
  "tax commissioner sale": "state",
  "county tax auction": "state",
};

export function researchSaleType(kind: string, state: string): SaleType | null {
  const k = KINDS[kind.trim().toLowerCase().replace(/\s+/g, " ")];
  if (!k) return null;
  if (k !== "state") return k;
  const rule = STATE_DATA[state];
  return rule ? toSaleType(rule.type) : null;
}

/** Straight into the calendar, or wait for Ed. */
export const trusted = (r: ResearchRow) => r.verification === "confirmed" && r.officialSource === true;

/** One research row in the workbook's row shape, or the reason it cannot be. */
export function researchOutcome(r: ResearchRow, line: number): ScoutRowOutcome {
  const state = r.state.trim().toUpperCase();
  const label = r.county.trim();
  const fail = (problem: string): ScoutRowOutcome => ({ ok: false, line, label: `${label}, ${state}`, problem });
  if (!/^[A-Z]{2}$/.test(state)) return fail(`unreadable state "${r.state}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.saleDate)) return fail(`unreadable sale date "${r.saleDate}"`);
  const saleType = researchSaleType(r.saleKind, state);
  if (!saleType) return fail(`sale kind "${r.saleKind}" is not one this system reads`);

  const row: ScoutRow = {
    tab: CHANNEL,
    line,
    state,
    label,
    saleDate: r.saleDate,
    saleType,
    method: r.auctionFormat ?? r.platform ?? null,
    address: null,
    parcels: null,
    amount: null,
    contact: {},
    site: urlOf(r.platformLink ?? "") ?? urlOf(r.sourceUrl),
    listUrl: urlOf(r.countyListUrl ?? ""),
    startTime: r.saleTimeLocal,
    forward: true,
    raw: { ...r, "Auction Type": r.saleKind } as unknown as Record<string, string>,
  };
  return { ok: true, row };
}

const countyKey = (county: string) => county.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Put a row on Ed's list, or refresh it if it is already there.
 *
 * A finding Ed has already decided is left alone: the weekly research will find
 * a dismissed sale again every Sunday, and asking twice is noise.
 */
async function holdForReview(r: ResearchRow, reason: string, jobId: string | null): Promise<void> {
  await db
    .insert(scoutFindings)
    .values({
      jobId,
      state: r.state.trim().toUpperCase(),
      county: r.county.trim(),
      countyKey: countyKey(r.county),
      saleDate: r.saleDate,
      finding: r as unknown as Record<string, unknown>,
      reason,
    })
    .onConflictDoUpdate({
      target: [scoutFindings.state, scoutFindings.countyKey, scoutFindings.saleDate],
      set: { jobId, finding: r as unknown as Record<string, unknown>, reason, updatedAt: sql`now()` },
      setWhere: sql`${scoutFindings.status} = 'pending'`,
    });
}

/** Why an untrusted row is waiting, in words Ed can act on. */
function untrustedReason(r: ResearchRow): string {
  if (r.verification !== "confirmed" && !r.officialSource) {
    return "not confirmed, and read from a platform listing rather than the county's own page";
  }
  if (r.verification !== "confirmed") return "the page did not confirm this county, sale and date together";
  return "read from a platform listing rather than the county's own page";
}

export interface ResearchIngest {
  applied: { matched: number; filled: number; inserted: number; crawlsQueued: number };
  heldForReview: number;
  sourcesAdded: number;
}

/**
 * Take a finished state report into the calendar and the review list.
 */
export async function ingestResearch(result: StateReportResult, jobId: string | null): Promise<ResearchIngest> {
  const rows = result.report.rows;
  const outcomes = rows.map((r, i) => researchOutcome(r, i + 1));
  const lineRow = (line: number) => rows[line - 1];

  const auto: ScoutRowOutcome[] = [];
  let held = 0;
  const today = localToday();
  for (const o of outcomes) {
    const r = lineRow(o.ok ? o.row.line : o.line);
    /* A stored report goes stale; a sale that has happened is nobody's to review. */
    if (r.saleDate < today) continue;
    if (!o.ok) {
      await holdForReview(r, o.problem, jobId);
      held++;
    } else if (!trusted(r)) {
      await holdForReview(r, untrustedReason(r), jobId);
      held++;
    } else {
      auto.push(o);
    }
  }

  const plan = await planScoutIngest(auto, researchChannel(result.state, result.generatedAt));
  const applied = await applyScoutIngest(plan, { actor: "auction-scout" });

  /* What the matcher itself could not settle: a near miss, an ambiguous day, a county it could not place. */
  for (const u of unresolved(plan)) {
    await holdForReview(lineRow(u.line), u.problem, jobId);
    held++;
  }

  /* A sale that went in settles any finding still waiting from an earlier, less certain run. */
  for (const s of [...decisionsOf(plan, "match").map((d) => d.sale), ...plan.inserts.map((i) => i.sale)]) {
    const lead = s.rows[0];
    await db
      .update(scoutFindings)
      .set({ status: "resolved", outcome: "confirmed by a later research run", decidedBy: "auction-scout", decidedAt: new Date() })
      .where(
        and(
          eq(scoutFindings.state, lead.state),
          eq(scoutFindings.countyKey, countyKey(lead.label)),
          eq(scoutFindings.saleDate, lead.saleDate),
          eq(scoutFindings.status, "pending"),
        ),
      );
  }

  const sourcesAdded = await recordListLinks(plan, "auction-scout-research", "auction-scout");
  return {
    applied: {
      matched: decisionsOf(plan, "match").length,
      filled: applied.filled,
      inserted: applied.inserted,
      crawlsQueued: applied.enrichment.queued,
    },
    heldForReview: held,
    sourcesAdded,
  };
}

/**
 * Ed approves a finding: run the matcher on that row alone, trusting it.
 *
 * Returns what happened in a sentence. A row that still cannot be placed — its
 * date still disagrees with the calendar, the day is still ambiguous — stays on
 * the list with the reason updated, because approving a row does not make the
 * calendar's own sale disappear; that is fixed on the county's page.
 */
export async function approveFinding(id: string, actor: string): Promise<string> {
  const [f] = await db.select().from(scoutFindings).where(eq(scoutFindings.id, id)).limit(1);
  if (!f) return "That finding no longer exists.";
  if (f.status !== "pending") return `Already ${f.status}.`;

  const r = f.finding as unknown as ResearchRow;
  const outcome = researchOutcome(r, 1);
  const decide = async (status: "approved" | "pending", text: string) => {
    await db
      .update(scoutFindings)
      .set({ status, outcome: text, decidedBy: actor, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(scoutFindings.id, id));
    return text;
  };
  if (!outcome.ok) return decide("pending", `Still cannot be read: ${outcome.problem}`);

  const plan = await planScoutIngest([outcome], researchChannel(outcome.row.state, new Date().toISOString()));
  const problem = unresolved(plan)[0];
  if (problem) return decide("pending", `Still not placed: ${problem.problem}`);
  if (plan.past) return decide("approved", "The sale date has passed; nothing written.");

  const applied = await applyScoutIngest(plan, { actor });
  await recordListLinks(plan, "auction-scout-research", actor);
  const where = `${outcome.row.label}, ${outcome.row.state} ${outcome.row.saleDate}`;
  return decide(
    "approved",
    applied.inserted ? `Added ${where} to the calendar.` : `Matched ${where}; ${applied.filled ? "filled what it lacked" : "nothing new to add"}.`,
  );
}

export async function dismissFinding(id: string, actor: string): Promise<void> {
  await db
    .update(scoutFindings)
    .set({ status: "dismissed", decidedBy: actor, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scoutFindings.id, id), eq(scoutFindings.status, "pending")));
}
