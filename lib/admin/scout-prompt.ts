import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { scoutPrompts } from "@/lib/db/schema";
import { DEFAULT_SCOUT_PROMPT } from "@/lib/ai/scout-report";

/**
 * The standing Auction Scout brief.
 *
 * One row, so there is one answer to "what are we asking for this week" rather
 * than a prompt per state that would drift apart within a fortnight. The
 * placeholders — {{STATE}}, {{HUB}}, {{COUNTY_SCOPE}} — are what let one brief
 * serve every state.
 */
export const SCOUT_PROMPT_ID = "default";

export interface StoredPrompt {
  template: string;
  /** False when nobody has edited it and the built-in brief is in force. */
  edited: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export async function getScoutPrompt(): Promise<StoredPrompt> {
  const [row] = await db.select().from(scoutPrompts).where(eq(scoutPrompts.id, SCOUT_PROMPT_ID)).limit(1);
  if (!row) return { template: DEFAULT_SCOUT_PROMPT, edited: false, updatedBy: null, updatedAt: null };
  return { template: row.template, edited: true, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
}

/**
 * Save an edited brief.
 *
 * Refuses a template that has lost `{{STATE}}`. Every run is scoped to one
 * state, so a brief without it asks sixteen jobs the same stateless question
 * and pays sixteen times for one answer — a mistake that would show up only as
 * a strange, expensive report.
 */
export async function saveScoutPrompt(template: string, updatedBy = "admin"): Promise<void> {
  const text = template.trim();
  if (!text) throw new Error("The prompt cannot be empty.");
  if (!text.includes("{{STATE}}")) {
    throw new Error(
      "The prompt must contain {{STATE}} — each run researches one state, and without it every state would be asked the same question.",
    );
  }

  await db
    .insert(scoutPrompts)
    .values({ id: SCOUT_PROMPT_ID, template: text, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: scoutPrompts.id,
      set: { template: text, updatedBy, updatedAt: new Date() },
    });
}

/** Drop the edit and go back to the built-in brief. */
export async function resetScoutPrompt(): Promise<void> {
  await db.delete(scoutPrompts).where(eq(scoutPrompts.id, SCOUT_PROMPT_ID));
}
