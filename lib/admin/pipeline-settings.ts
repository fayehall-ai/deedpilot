/**
 * How hard the pipeline runs, and where those numbers live.
 *
 * The crawl cap, the research day, the state count and the cooldown were
 * hardcoded across the dispatcher route, `scout-jobs` and `research-day`.
 * Changing any of them meant a deploy, which is the wrong shape for settings
 * whose correct values move with the dispatcher cadence — the crawl cap in
 * particular exists to stop the queue outgrowing what a tick can drain, and
 * that ceiling changes the day the cron does.
 *
 * Validation is strict for the same reason it is on auction overrides: these
 * values reach a scheduler that spends money and fetches government sites. A
 * research pass of 400 states is not a typo that fails loudly — it is a queue
 * that never drains, quietly starving every crawl behind it.
 *
 * No `server-only` guard: the bounds are pure and the scripts read the settings
 * too, so a CLI plan run matches what the dispatcher will do.
 */

import { MAX_SCAN_STATES } from "@/lib/ai/scan-states";
import { eq } from "drizzle-orm";

export interface PipelineConfig {
  crawlEnabled: boolean;
  crawlMaxTasks: number;
  researchEnabled: boolean;
  researchWeekday: string;
  researchStates: number;
  researchCooldownDays: number;
  enrichEnabled: boolean;
  enrichWeeklyBudgetDollars: number;
  videoTopN: number;
}

/**
 * Built-in defaults — what applies when nobody has changed anything.
 *
 * `crawlMaxTasks` of 50 is ~150 seconds of crawling at the measured 3.0s
 * median, against a 195-second daily claiming budget. `researchStates` of 4 is
 * what a week of *leftover* budget absorbs, since research sits below every
 * crawl at priority 5.
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  crawlEnabled: true,
  crawlMaxTasks: 50,
  researchEnabled: true,
  researchWeekday: "Sun",
  researchStates: 4,
  researchCooldownDays: 6,
  enrichEnabled: true,
  /*
   * $20 a week is a thousand RentCast lookups at list price — enough to value
   * the top of every week's sales, small enough that a runaway costs little.
   */
  enrichWeeklyBudgetDollars: 20,
  /* The last hand-made batch was sixteen: the largest sales by parcel count. */
  videoTopN: 16,
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Bounds, with the reasoning that produced each ceiling.
 *
 * Deliberately wide at the top rather than pinned to today's cadence — an
 * operator moving to an hourly dispatcher should be able to raise the cap
 * without a deploy, which is the whole point. What these refuse is the value
 * that cannot be right at any cadence.
 */
export const LIMITS = {
  /** One tick cannot drain more than a few hundred counties at any cadence. */
  crawlMaxTasks: { min: 1, max: 1000 },
  /**
   * Bounded by the scan set's own ceiling rather than a copy of it. This read
   * 18 because the scan list was eighteen hand-written states; the list is now
   * derived from the calendar and can grow, and a limit that silently disagreed
   * with it would refuse a legitimate setting. Each state is a paid 1-2 minute
   * call, which is what the ceiling is really about.
   */
  researchStates: { min: 1, max: MAX_SCAN_STATES },
  /** Under a day cannot guard a daily tick; over a fortnight is not "weekly". */
  researchCooldownDays: { min: 1, max: 14 },
  /** Zero means free sources only. The ceiling is a typo guard, not a policy. */
  enrichWeeklyBudgetDollars: { min: 0, max: 2000 },
  /** Each is a rendered video and a paid narration; a hundred a week is a lot. */
  videoTopN: { min: 0, max: 100 },
} as const;

export function validateConfig(patch: Partial<PipelineConfig>): string[] {
  const errors: string[] = [];

  if (patch.crawlMaxTasks !== undefined) {
    const { min, max } = LIMITS.crawlMaxTasks;
    if (!Number.isInteger(patch.crawlMaxTasks) || patch.crawlMaxTasks < min || patch.crawlMaxTasks > max) {
      errors.push(`Counties per tick must be a whole number between ${min} and ${max}`);
    }
  }
  if (patch.researchStates !== undefined) {
    const { min, max } = LIMITS.researchStates;
    if (!Number.isInteger(patch.researchStates) || patch.researchStates < min || patch.researchStates > max) {
      errors.push(`States per research pass must be a whole number between ${min} and ${max}`);
    }
  }
  if (patch.researchCooldownDays !== undefined) {
    const { min, max } = LIMITS.researchCooldownDays;
    if (
      !Number.isInteger(patch.researchCooldownDays) ||
      patch.researchCooldownDays < min ||
      patch.researchCooldownDays > max
    ) {
      errors.push(`Research cooldown must be a whole number of days between ${min} and ${max}`);
    }
  }
  for (const [key, label] of [
    ["enrichWeeklyBudgetDollars", "Weekly enrichment budget"],
    ["videoTopN", "Sales delivered each week"],
  ] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    const { min, max } = LIMITS[key];
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${label} must be a whole number between ${min} and ${max}`);
  }
  if (patch.researchWeekday !== undefined && !(WEEKDAYS as readonly string[]).includes(patch.researchWeekday)) {
    errors.push(`Research day must be one of: ${WEEKDAYS.join(", ")}`);
  }
  return errors;
}

export class InvalidConfigError extends Error {}

async function conn() {
  const [{ db }, { pipelineSettings }] = await Promise.all([
    import("../db"),
    import("../db/schema"),
  ]);
  return { db, pipelineSettings };
}

const ROW_ID = "default";

/** Current settings, falling back to the built-in defaults. */
export async function getPipelineConfig(): Promise<PipelineConfig & { edited: boolean; updatedBy: string | null; updatedAt: Date | null }> {
  const { db, pipelineSettings } = await conn();
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, ROW_ID)).limit(1);
  if (!row) return { ...DEFAULT_CONFIG, edited: false, updatedBy: null, updatedAt: null };
  return {
    crawlEnabled: row.crawlEnabled,
    crawlMaxTasks: row.crawlMaxTasks,
    researchEnabled: row.researchEnabled,
    researchWeekday: row.researchWeekday,
    researchStates: row.researchStates,
    researchCooldownDays: row.researchCooldownDays,
    enrichEnabled: row.enrichEnabled,
    enrichWeeklyBudgetDollars: row.enrichWeeklyBudgetDollars,
    videoTopN: row.videoTopN,
    edited: true,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export async function savePipelineConfig(
  patch: Partial<PipelineConfig>,
  updatedBy = "admin",
): Promise<PipelineConfig> {
  const errors = validateConfig(patch);
  if (errors.length) throw new InvalidConfigError(errors.join("; "));

  const current = await getPipelineConfig();
  const next: PipelineConfig = {
    crawlEnabled: patch.crawlEnabled ?? current.crawlEnabled,
    crawlMaxTasks: patch.crawlMaxTasks ?? current.crawlMaxTasks,
    researchEnabled: patch.researchEnabled ?? current.researchEnabled,
    researchWeekday: patch.researchWeekday ?? current.researchWeekday,
    researchStates: patch.researchStates ?? current.researchStates,
    researchCooldownDays: patch.researchCooldownDays ?? current.researchCooldownDays,
    enrichEnabled: patch.enrichEnabled ?? current.enrichEnabled,
    enrichWeeklyBudgetDollars: patch.enrichWeeklyBudgetDollars ?? current.enrichWeeklyBudgetDollars,
    videoTopN: patch.videoTopN ?? current.videoTopN,
  };

  const { db, pipelineSettings } = await conn();
  await db
    .insert(pipelineSettings)
    .values({ id: ROW_ID, ...next, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: pipelineSettings.id,
      set: { ...next, updatedBy, updatedAt: new Date() },
    });

  return next;
}

/** Drop every change and return to the built-in cadence. */
export async function resetPipelineConfig(): Promise<void> {
  const { db, pipelineSettings } = await conn();
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, ROW_ID));
}
