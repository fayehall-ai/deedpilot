"use server";

/**
 * Ed's verdict on a briefing script. See `capeReviews` and `PackageInput.reviewNotes`.
 */
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { currentActor, isAdmin } from "@/lib/admin/auth";
import { audit } from "@/lib/admin/queue";
import { db } from "@/lib/db";
import { capeProductions, capeReviews } from "@/lib/db/schema";

export async function saveCapeReview(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const auctionId = String(formData.get("auctionId") ?? "");
  const verdict = String(formData.get("verdict") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/.test(auctionId) || !["reads-correctly", "needs-change"].includes(verdict)) return;
  /* A change with nothing said about what to change cannot be applied. */
  if (verdict === "needs-change" && !note) return;

  const [production] = await db
    .select({ hash: capeProductions.inputsHash })
    .from(capeProductions)
    .where(eq(capeProductions.auctionId, auctionId))
    .limit(1);
  const reviewer = await currentActor();
  await db.insert(capeReviews).values({
    auctionId,
    verdict,
    note: note || null,
    scriptHash: production?.hash ?? null,
    reviewer,
  });
  await audit(`cape.review_${verdict}`, auctionId, { note }, reviewer);
  revalidatePath("/cape/review");
}
