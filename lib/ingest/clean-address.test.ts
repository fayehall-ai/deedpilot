/**
 * Run: npx tsx lib/ingest/clean-address.test.ts
 */
import { cleanAddressLine } from "./clean-address";

function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

eq(cleanAddressLine("2025 27175 ENGEBRETSON RD"), "27175 ENGEBRETSON RD", "leaked year dropped");
eq(cleanAddressLine("2025"), undefined, "a bare year is no address");
eq(cleanAddressLine("2023"), undefined, "any recent year");
eq(cleanAddressLine("2025 MAIN ST"), "2025 MAIN ST", "a house numbered 2025 is kept");
eq(cleanAddressLine("7093 STATE RD 70"), "7093 STATE RD 70", "ordinary address untouched");
eq(cleanAddressLine("1921 19TH ST NW"), "1921 19TH ST NW", "DC house number kept");
eq(cleanAddressLine("1991 34 RD"), "1991 34 RD", "Nebraska road number kept");
eq(cleanAddressLine("2030 250th Pl Ne"), "2030 250th Pl Ne", "King County house number kept");
eq(cleanAddressLine("2015 2017 2019 2021 South Mill"), "2015 2017 2019 2021 South Mill", "a run of house numbers kept");
eq(cleanAddressLine("2025 13062 HOFFMAN RD"), "13062 HOFFMAN RD", "Burnett leak with a five-digit house number");
eq(cleanAddressLine("  "), undefined, "blank");
eq(cleanAddressLine(null), undefined, "null");

console.log("clean-address: ok");
