/**
 * The CSV reader.
 * Run: npx tsx lib/import/csv.test.ts
 *
 * The cases here are the ones that make a naive `split(",")` produce a row that
 * parses cleanly and means something else: a quoted delimiter, a quoted
 * newline, and an escaped quote. Each of those shifts later columns left
 * without raising, so nothing downstream can tell the row is wrong.
 */
import { parseCsv, CsvTable } from "./csv";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
  passed++;
}
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

eq(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]], "plain rows");
eq(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]], "CRLF, trailing newline dropped");
eq(parseCsv('a,b\n"x,y",2'), [["a", "b"], ["x,y", "2"]], "a quoted delimiter stays one field");
eq(parseCsv('a\n"he said ""no"""'), [["a"], ['he said "no"']], "a doubled quote is one quote");
eq(parseCsv('a,b\n"line1\nline2",2'), [["a", "b"], ["line1\nline2", "2"]], "a quoted newline stays in the field");
eq(parseCsv("a,b\n1,"), [["a", "b"], ["1", ""]], "a trailing empty field is kept");
eq(parseCsv("a,b\n,2"), [["a", "b"], ["", "2"]], "a leading empty field is kept");
eq(parseCsv("﻿a,b\n1,2"), [["a", "b"], ["1", "2"]], "a BOM is stripped");

/*
 * The real shape from the export: a registration note containing commas and a
 * URL containing a query string, both quoted, in the same row.
 */
const real = parseCsv(
  'County,Notes,Url\n' +
    'Hinds,"Bid Up, Premium, deposit due","https://x.com/a?auc=3827355&y=1"\n',
);
eq(real[1], ["Hinds", "Bid Up, Premium, deposit due", "https://x.com/a?auc=3827355&y=1"], "a real row keeps three fields");

// ---------------------------------------------------------------------------
// Header addressing
// ---------------------------------------------------------------------------

const t = new CsvTable(parseCsv('Sale  Date,County Name,Extra\n2026-08-31,Hinds County,x'));
assert(t.cell(t.rows[0], "sale date") === "2026-08-31", "headers fold case and spacing");
assert(t.cell(t.rows[0], "County Name") === "Hinds County", "and punctuation");
assert(t.cell(t.rows[0], "Nonexistent") === "", "an absent column reads empty, not undefined");
assert(t.hasAll(["Sale Date", "County Name"]), "hasAll finds folded names");
eq(t.missing(["Sale Date", "Auction Type"]), ["Auction Type"], "missing names the absent column");

/*
 * A short row must not throw. The export is machine-written and consistent, but
 * a person editing one row in a spreadsheet and saving can produce a row with
 * fewer cells, and losing the whole import to that is worse than reading the
 * missing cell as blank and reporting the row.
 */
const short = new CsvTable(parseCsv("A,B,C\n1"));
assert(short.cell(short.rows[0], "C") === "", "a short row reads absent cells as blank");

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

eq(parseCsv(""), [], "empty text is no rows");
eq(parseCsv("\n"), [], "a lone newline is no rows");
const headerOnly = new CsvTable(parseCsv("A,B"));
assert(headerOnly.rows.length === 0, "a header with no data rows is zero rows");

console.log(`csv.test.ts — ${passed} assertions passed`);
