/**
 * Which stored scripts carry which fixes, counted rather than asserted.
 *
 * "Is it fixed everywhere yet" is a question about 487 rows, and the honest
 * answer during a five-hour batch is a number, not a yes. Each check below is
 * the defect as it actually appeared, so a row that passes all of them is one
 * nobody needs to look at again.
 */
import "../lib/env";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, capeProductions, counties } from "../lib/db/schema";
import { capePackageInputs } from "../lib/cape/inputs";
import { capeInputsHash } from "../lib/cape/components";
import { countyMismatch } from "../lib/cape/script";

/** The Fulton slide Ed asked about, and the paragraph behind it. */
const ABSENCE =
  /\bnot (?:in|on) (?:file|record)\b|\bno (?:\w+\s+){0,3}(?:gis link|assessor record|zoning data|coordinates)\b|\b(?:zoning data is absent|not verified in (?:our|this) (?:record|file)|no source (?:here|in this file)|not collected)\b/i;
/** TDC's own production calendar, spoken to bidders. */
const CALENDAR = /\bpackage (?:is |work was |materials are )?due\b/i;
/** The internal pipeline: PropStream, Drive, GHL, Slack. */
const PIPELINE = /\bpropstream\b|\bgoogle drive\b|\bghl\b|\bviktor\b|\bslack\b/i;

async function main() {
  const inputs = await capePackageInputs();
  const wanted = new Map(inputs.map((i) => [i.auctionId, capeInputsHash(i)]));

  const rows = await db
    .select({
      auctionId: auctions.id,
      county: counties.name,
      state: counties.state,
      saleDate: auctions.saleDate,
      hash: capeProductions.inputsHash,
      script: capeProductions.script,
      figures: capeProductions.unsupportedFigures,
      error: capeProductions.error,
    })
    .from(capeProductions)
    .innerJoin(auctions, eq(auctions.id, capeProductions.auctionId))
    .innerJoin(counties, eq(counties.fips, auctions.countyFips));

  let current = 0, stale = 0, noScript = 0;
  let absence = 0, calendar = 0, pipeline = 0, wrongCounty = 0, held = 0;
  const examples: string[] = [];

  for (const r of rows) {
    const want = wanted.get(r.auctionId);
    const s = r.script as unknown as { title: string; sections: { narration: string }[] } | null;
    if (!s?.sections?.length) { noScript++; continue; }

    if (want && r.hash === want) current++;
    else stale++;

    const text = s.sections.map((x) => x.narration).join(" ");
    const hitAbsence = ABSENCE.test(text);
    const hitCalendar = CALENDAR.test(text);
    const hitPipeline = PIPELINE.test(text);
    const hitCounty = Boolean(
      countyMismatch(s as never, {
        countyName: r.county, state: r.state, saleDate: r.saleDate,
        saleDateConfirmed: true, saleType: null, platform: null,
      }),
    );

    if (hitAbsence) absence++;
    if (hitCalendar) calendar++;
    if (hitPipeline) pipeline++;
    if (hitCounty) wrongCounty++;
    if ((r.figures ?? []).length > 0 || r.error) held++;

    if ((hitAbsence || hitCalendar || hitPipeline) && examples.length < 5) {
      const m = text.match(ABSENCE) ?? text.match(CALENDAR) ?? text.match(PIPELINE);
      examples.push(`${r.county}, ${r.state} ${r.saleDate} — "…${m?.[0]}…"`);
    }
  }

  const n = rows.length - noScript;
  const pct = (x: number) => `${String(x).padStart(4)}  (${String(Math.round((100 * x) / n)).padStart(3)}%)`;

  console.log(`\n${n} stored script(s), of ${inputs.length} upcoming packages\n`);
  console.log(`  written from the current facts   ${pct(current)}`);
  console.log(`  still on an older fact sheet     ${pct(stale)}`);
  console.log(`\nDefects, as they actually appeared:\n`);
  console.log(`  mentions what we do not hold     ${pct(absence)}   ("Assessor/GIS not in file")`);
  console.log(`  speaks TDC's production calendar ${pct(calendar)}   ("the package is due…")`);
  console.log(`  names the internal pipeline      ${pct(pipeline)}   (PropStream, Drive, GHL)`);
  console.log(`  names the wrong county           ${pct(wrongCounty)}`);
  console.log(`  held, so never reaches a video   ${pct(held)}`);
  if (examples.length) {
    console.log(`\nStill carrying one:`);
    for (const e of examples) console.log(`  ${e}`);
  }
  console.log();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
