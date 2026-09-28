/**
 * Record what a paid call consumed, and price it at read time.
 *
 * ## Why units are stored and dollars are not
 *
 * Vendor prices change and contracts differ. A dollar figure written into a row
 * is wrong the moment either happens, and wrong silently — the row still looks
 * authoritative. Storing tokens and search counts, which come from the
 * provider's own response and never change after the fact, keeps the record
 * true and moves the pricing to a place an operator can correct.
 *
 * ## Why the rates below are defaults, not facts
 *
 * These are list prices as configured, and they are the one thing here nobody
 * should trust without checking: rates move, and a negotiated contract is not
 * list. They are labelled as estimates everywhere they surface, and an operator
 * can override them per provider. The units they multiply are exact.
 *
 * Recording never throws. A failure to log usage must not fail the work that
 * produced it — losing a cost row is an accounting gap, losing a research pass
 * is an hour and a paid call.
 */

import { sql } from "drizzle-orm";

export type Operation =
  | "scout-research"
  | "pdf-extract"
  | "cartographer"
  | "brief"
  | "enrich"
  /*
   * A reader typing an address on the home page. Kept separate from `enrich`
   * on purpose: batch enrichment is a background cost the desk chooses, and
   * this one is spent per visitor and scales with traffic rather than with
   * inventory. Folding them together would hide the only line on the bill that
   * a stranger can increase.
   */
  | "property-lookup"
  /*
   * CAPE Component Seven — the county narration script and slide plan.
   *
   * Its own line because it is the first operation that leads directly to
   * *metered media*: a script becomes ElevenLabs characters and then an
   * encode. When the video bill is questioned, the question is really about
   * how many scripts were generated and regenerated, and that is answerable
   * only if the script call is not folded into `brief`.
   */
  | "cape-script"
  /*
   * CAPE narration — speech synthesis, billed per character.
   *
   * Recorded once the render cron started buying speech unattended: a queue
   * that spends money with nobody watching has to leave a bill behind. Only
   * characters actually synthesised are recorded, never cache hits. The billed
   * unit is stored in `inputTokens` — characters, not tokens — which lets the
   * existing per-million rate card price it without a schema change; the note
   * on each row says so.
   */
  | "cape-narration";

export interface UsageRecord {
  provider: string;
  model?: string | null;
  operation: Operation;
  inputTokens?: number | null;
  outputTokens?: number | null;
  searchCalls?: number | null;
  requests?: number | null;
  countyFips?: string | null;
  note?: string | null;
}

/**
 * Rates in US cents, per million tokens and per call.
 *
 * `searchCall` dominates a research pass: one state run makes tens of searches,
 * and at these rates the searches cost more than the tokens they produce.
 */
export interface RateCard {
  inputPerMTok: number;
  outputPerMTok: number;
  perSearchCall: number;
  perRequest: number;
}

export const DEFAULT_RATES: Record<string, RateCard> = {
  /*
   * grok-4.5 and grok-4.6 list at $2/M in and $6/M out; xAI's own per-call
   * cost figure (`cost_in_usd_ticks`) agrees. The card said $0.20 and $1.00,
   * so the Schedules card showed about a sixth of the real xAI bill. List
   * transcription runs on grok-4.20-non-reasoning at $1.25 and $2.50, so it is
   * overstated here rather than understated, which is the safe direction.
   */
  xai: { inputPerMTok: 200, outputPerMTok: 600, perSearchCall: 2.5, perRequest: 0 },
  /* Claude Opus 5, the fallback leg. */
  anthropic: { inputPerMTok: 500, outputPerMTok: 2500, perSearchCall: 1, perRequest: 0 },
  /*
   * UNVERIFIED — RealEstateAPI does not publish a per-record price. Set high on
   * purpose so the weekly budget stops early rather than late; replace with the
   * rate on the billing console.
   */
  realestateapi: { inputPerMTok: 0, outputPerMTok: 0, perSearchCall: 0, perRequest: 5 },
  attom: { inputPerMTok: 0, outputPerMTok: 0, perSearchCall: 0, perRequest: 4 },
  rentcast: { inputPerMTok: 0, outputPerMTok: 0, perSearchCall: 0, perRequest: 2 },
  batchdata: { inputPerMTok: 0, outputPerMTok: 0, perSearchCall: 0, perRequest: 3 },
  /*
   * Speech, per million *characters* (recorded in `inputTokens`). Neural2 at
   * $16/M and ElevenLabs Turbo at $50/M — the same list rates `RATE_PER_MILLION`
   * in `lib/cape/voice.ts` quotes before a run.
   */
  "google-tts": { inputPerMTok: 1600, outputPerMTok: 0, perSearchCall: 0, perRequest: 0 },
  elevenlabs: { inputPerMTok: 5000, outputPerMTok: 0, perSearchCall: 0, perRequest: 0 },
};

const FALLBACK: RateCard = { inputPerMTok: 0, outputPerMTok: 0, perSearchCall: 0, perRequest: 0 };

/** Estimated cost of one usage row, in cents. */
export function estimateCents(u: UsageRecord, rates: Record<string, RateCard> = DEFAULT_RATES): number {
  const r = rates[u.provider] ?? FALLBACK;
  return (
    ((u.inputTokens ?? 0) / 1_000_000) * r.inputPerMTok +
    ((u.outputTokens ?? 0) / 1_000_000) * r.outputPerMTok +
    (u.searchCalls ?? 0) * r.perSearchCall +
    (u.requests ?? 0) * r.perRequest
  );
}

/**
 * Write one usage row. Never throws.
 *
 * Deliberately fire-and-forget from the caller's point of view: the work that
 * produced the usage has already happened and already been paid for, so a
 * logging failure must not turn a completed research pass into a failed job.
 */
export async function recordUsage(u: UsageRecord): Promise<void> {
  try {
    const [{ db }, { apiUsage }] = await Promise.all([import("../db"), import("../db/schema")]);
    await db.insert(apiUsage).values({
      provider: u.provider,
      model: u.model ?? null,
      operation: u.operation,
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      searchCalls: u.searchCalls ?? null,
      requests: u.requests ?? null,
      countyFips: u.countyFips ?? null,
      note: u.note ?? null,
    });
  } catch (e) {
    console.warn(`[usage] not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface SpendRow {
  operation: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  requests: number;
  cents: number;
}

export interface SpendReport {
  days: number;
  rows: SpendRow[];
  totalCents: number;
  /** Day-by-day totals, so a spike is visible rather than averaged away. */
  daily: { day: string; cents: number; calls: number }[];
}

/** What has been spent, over the last N days. */
export async function spendReport(days = 30, rates = DEFAULT_RATES): Promise<SpendReport> {
  const [{ db }] = await Promise.all([import("../db")]);

  const grouped = (await db.execute(sql`
    SELECT operation, provider,
           count(*)::int                            AS calls,
           coalesce(sum(input_tokens), 0)::bigint   AS input_tokens,
           coalesce(sum(output_tokens), 0)::bigint  AS output_tokens,
           coalesce(sum(search_calls), 0)::int      AS search_calls,
           coalesce(sum(requests), 0)::int          AS requests
    FROM api_usage
    WHERE at > now() - make_interval(days => ${days})
    GROUP BY operation, provider
    ORDER BY calls DESC
  `)) as unknown as Record<string, string | number>[];

  const rows: SpendRow[] = grouped.map((g) => {
    const row = {
      operation: String(g.operation),
      provider: String(g.provider),
      calls: Number(g.calls),
      inputTokens: Number(g.input_tokens),
      outputTokens: Number(g.output_tokens),
      searchCalls: Number(g.search_calls),
      requests: Number(g.requests),
    };
    return { ...row, cents: estimateCents({ ...row, operation: row.operation as Operation }, rates) };
  });

  const byDay = (await db.execute(sql`
    SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day,
           provider,
           count(*)::int                            AS calls,
           coalesce(sum(input_tokens), 0)::bigint   AS input_tokens,
           coalesce(sum(output_tokens), 0)::bigint  AS output_tokens,
           coalesce(sum(search_calls), 0)::int      AS search_calls,
           coalesce(sum(requests), 0)::int          AS requests
    FROM api_usage
    WHERE at > now() - make_interval(days => ${days})
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `)) as unknown as Record<string, string | number>[];

  const dailyMap = new Map<string, { cents: number; calls: number }>();
  for (const d of byDay) {
    const day = String(d.day);
    const cents = estimateCents(
      {
        provider: String(d.provider),
        operation: "brief",
        inputTokens: Number(d.input_tokens),
        outputTokens: Number(d.output_tokens),
        searchCalls: Number(d.search_calls),
        requests: Number(d.requests),
      },
      rates,
    );
    const held = dailyMap.get(day) ?? { cents: 0, calls: 0 };
    dailyMap.set(day, { cents: held.cents + cents, calls: held.calls + Number(d.calls) });
  }

  return {
    days,
    rows,
    totalCents: rows.reduce((n, r) => n + r.cents, 0),
    daily: [...dailyMap].map(([day, v]) => ({ day, ...v })).sort((a, b) => b.day.localeCompare(a.day)),
  };
}
