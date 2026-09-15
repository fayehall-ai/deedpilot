/**
 * Re-judge stored scripts against the current verifier.
 *
 *   npx tsx scripts/cape-reverify.ts            # report
 *   npx tsx scripts/cape-reverify.ts --apply    # write the corrected verdicts
 *
 * ## Why re-verify rather than regenerate
 *
 * When the verifier is wrong, the script it held is not. `verifyNarration`
 * reads figures out of finished narration and compares them to the facts; a bug
 * in that reading produces a false verdict on correct text. Regenerating is
 * then the worst available response — it spends a model call to roll the same
 * dice again, and the new script is no more likely to pass than the one already
 * written.
 *
 * A batch of 454 packages held 82 on figures that were never spoken: "Section
 * eighteen twelve six hundred nine" summed to 3609, "New Jersey Statutes
 * Annotated fifty-four five" to 59, and Bergen County's population split at its
 * own comma into 978,000 and 641. Those scripts needed a second opinion, not a
 * rewrite.
 *
 * ## Why the facts are rebuilt rather than stored
 *
 * The comparison needs the fact sheet the script was written from, and that is
 * not kept — only its hash is. So the package is recomputed here and the check
 * is skipped where the hash no longer matches: a script written from facts that
 * have since changed is stale, which is a different problem with a different
 * answer (regenerate), and quietly clearing its verdict would hide that.
 */
import "../lib/env";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, capeProductions, counties } from "../lib/db/schema";
import { capePackageInputs } from "../lib/cape/inputs";
import { buildPackage, capeInputsHash } from "../lib/cape/components";
import { factSheet, verifyNarration, type CapeScript } from "../lib/cape/script";

const APPLY = process.argv.includes("--apply");

async function main() {
  const inputs = await capePackageInputs();
  const byId = new Map(inputs.map((i) => [i.auctionId, i]));

  const rows = await db
    .select({
      auctionId: capeProductions.auctionId,
      county: counties.name,
      state: counties.state,
      saleDate: auctions.saleDate,
      hash: capeProductions.inputsHash,
      script: capeProductions.script,
      figures: capeProductions.unsupportedFigures,
    })
    .from(capeProductions)
    .innerJoin(auctions, eq(auctions.id, capeProductions.auctionId))
    .innerJoin(counties, eq(counties.fips, auctions.countyFips));

  let checked = 0, cleared = 0, stillHeld = 0, stale = 0, newlyHeld = 0;
  const examples: string[] = [];

  for (const r of rows) {
    const script = r.script as unknown as CapeScript | null;
    if (!script?.sections?.length) continue;

    const input = byId.get(r.auctionId);
    if (!input || capeInputsHash(input) !== r.hash) {
      stale++;
      continue;
    }

    checked++;
    const pkg = buildPackage(input);
    const facts = factSheet(pkg, {
      countyName: input.countyName,
      state: input.state,
      saleDate: input.saleDate,
      saleDateConfirmed: input.saleDateConfirmed,
      saleType: input.saleType,
      platform: input.platform,
      population: input.population,
      countyFips: input.countyFips,
    });

    const before = r.figures ?? [];
    const after = verifyNarration(script, facts);

    if (before.length > 0 && after.length === 0) {
      cleared++;
      if (examples.length < 8) {
        examples.push(`${r.county}, ${r.state} ${r.saleDate} — was held on ${before.join(", ")}`);
      }
    } else if (after.length > 0) {
      if (before.length === 0) newlyHeld++;
      else stillHeld++;
    }

    if (APPLY && JSON.stringify(before) !== JSON.stringify(after)) {
      await db
        .update(capeProductions)
        .set({ unsupportedFigures: after, updatedAt: new Date() })
        .where(eq(capeProductions.auctionId, r.auctionId));
    }
  }

  console.log(`\n${checked} script(s) re-judged, ${stale} skipped as stale\n`);
  console.log(`  holds cleared by the corrected verifier : ${cleared}`);
  console.log(`  still held, figure genuinely unsupported: ${stillHeld}`);
  console.log(`  newly held by the corrected verifier    : ${newlyHeld}`);
  console.log(APPLY ? "\nverdicts written" : "\nreport only — pass --apply to write");
  if (examples.length) {
    console.log("\ncleared:");
    for (const e of examples) console.log("  " + e);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
