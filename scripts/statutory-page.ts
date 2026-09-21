/**
 * Write the Statutory Ground page to a file.
 *
 *   npm run statutory:page      → artifacts/statutory-ground.html
 *
 * The same page is served live at `/statutory`; see `lib/statutory/page.ts`.
 */
import "../lib/env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statutoryPage } from "../lib/statutory/page";

const OUT = path.join("artifacts", "statutory-ground.html");

async function main() {
  const page = await statutoryPage();
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, page.html);
  console.log(`${OUT}  (${Math.round(page.html.length / 1024)} KB)`);
  console.log(`  ${page.counties} counties, ${page.verified} county-verified`);
  console.log(`  ${page.withUpcoming} with an upcoming sale`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.cause?.message ?? e); process.exit(1); });
