/**
 * Regenerate `data/statute.json` from the TypeScript statute atlas.
 *
 *   npm run export:statute
 *
 * ## Why this had to exist
 *
 * The statutory parameters live in `lib/deal/statute.ts`, which is what the
 * Next app and `/api/tools/maxbid` actually run on. The Python engine in
 * `src/deedpilot` reads the same parameters from `data/statute.json` — and
 * nothing wrote that file. There was a reader and no writer, so the JSON was
 * whatever someone last produced by hand.
 *
 * It had drifted exactly as you would expect: the TypeScript carried twelve
 * states and the JSON eight, frozen since 20 August. The eight it did carry
 * were byte-identical, which is the good news and also the proof that the file
 * is derived data rather than a second source of truth. Pennsylvania, Kentucky,
 * Indiana and South Carolina existed only on the TypeScript side, so the Python
 * engine silently refused to price four states the product believed it covered.
 *
 * `src/deedpilot/domain/deal/statute.py` raises on a missing file with the
 * words "this file is checked in and should never be absent" — which was not
 * true either; it was untracked. Both halves of that are fixed here: the file
 * is generated, and it is committed.
 *
 * ## Why not the existing export script
 *
 * `scripts/export-atlas-for-copilot.ts` writes `copilot/data/atlas_export.json`
 * for the older copilot runtime — a different consumer, a different path, and a
 * much larger payload that carries the whole county atlas. Pointing it at both
 * would couple two runtimes that have no reason to move together.
 *
 * ## Regenerating is safe; the max-bid goldens are not
 *
 * This file is derived, so regenerating it is the correct response to any
 * disagreement. `tests/cases/maxbid_golden.json` is the opposite: it is the
 * record of what the engine answered before the port, and regenerating THAT
 * would erase the only evidence the port is faithful. Run the suite after
 * regenerating here — if a golden moves, the statute data changed under a case
 * that depends on it, and that is a decision to make deliberately rather than
 * a file to overwrite.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATUTE_PARAMS } from "../lib/deal/statute";
import { FLOOR_RATIOS, FLOOR_RATIOS_AS_OF } from "../lib/deal/floor-ratios";

const OUT = join(process.cwd(), "data", "statute.json");

/*
 * Key order is sorted rather than source order so a regeneration produces a
 * readable diff — an added state should show as one added block, not as a
 * reshuffle of the whole file.
 */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

const payload = {
  statuteParams: sortKeys(STATUTE_PARAMS),
  floorRatios: sortKeys(FLOOR_RATIOS),
  floorRatiosAsOf: FLOOR_RATIOS_AS_OF,
};

writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");

const states = Object.keys(payload.statuteParams);
console.log(`Wrote ${OUT}`);
console.log(`  ${states.length} states: ${states.join(", ")}`);
console.log(`  ${Object.keys(payload.floorRatios).length} floor ratios, as of ${FLOOR_RATIOS_AS_OF}`);
