/** Standalone: `npx tsx lib/lots/tax-year.test.ts`. Throws on failure. */
import { taxYearFromRaw } from "./tax-year";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

eq(taxYearFromRaw({ "Tax Year": "2025", "Amount Due": "1,204.11" }), { label: "2025", latest: 2025 }, "plain");
eq(taxYearFromRaw({ taxYear: 2024 }), { label: "2024", latest: 2024 }, "camel, number");
eq(
  taxYearFromRaw({ "Judgment Through Tax Year": "2025" }),
  { label: "2025", latest: 2025 },
  "Texas MVBA heading",
);
eq(
  taxYearFromRaw({ "Years Delinquent": "2019, 2020, 2021-2023" }),
  { label: "2019–2023", latest: 2023 },
  "span",
);
eq(taxYearFromRaw({ row: { "Cert Year": "2022" } }), { label: "2022", latest: 2022 }, "nested row");
eq(taxYearFromRaw({ "Year Built": "1979", Year: "2004", "Sale Date": "2026-10-14" }), null, "not tax years");
eq(taxYearFromRaw({ "Tax Year": "n/a" }), null, "no year in value");
eq(taxYearFromRaw(null), null, "no raw");

console.log("tax-year: ok");
