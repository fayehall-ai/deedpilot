/**
 * A CSV reader, to RFC 4180.
 *
 * Deliberately not `split(",")`. The auction export quotes any field
 * containing a comma, and several fields reliably do: a county's registration
 * notes run to paragraphs, and an online-sale URL carries query parameters.
 * Splitting on the delimiter tears those rows into the wrong number of columns
 * and shifts every value after the break one column left — which does not
 * throw, it produces an auction whose sale time is a fragment of a sentence.
 *
 * The three things this handles that a naive split does not:
 *
 *   - quoted fields containing the delimiter, `"Bid Up, Premium"`
 *   - the escaped quote, `""`, inside a quoted field
 *   - newlines inside a quoted field, so a multi-line note stays one row
 *
 * Returns rows of raw strings. Interpretation — which column is which, what a
 * value means, whether it is required — belongs to the caller, because the
 * error messages are far better when the caller knows what it was expecting.
 */

/** Strip a UTF-8 BOM. Excel writes one; every parser that ignores it reads
 *  the first header as `﻿State` and then cannot find the State column. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Split CSV text into rows of fields.
 *
 * A single pass with an explicit in-quotes flag rather than a regex: the
 * grammar is not regular once a field may contain a newline, and a
 * character-at-a-time loop is the honest way to say so.
 */
export function parseCsv(text: string): string[][] {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // this row has content, so a trailing CRLF ends it

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        // A doubled quote is a literal quote; a lone one closes the field.
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (c === ",") {
      endField();
      started = true;
      continue;
    }
    if (c === "\r") {
      // CRLF and a bare CR both terminate a row.
      if (src[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (c === "\n") {
      endRow();
      continue;
    }
    field += c;
    started = true;
  }

  // A file that does not end in a newline still has a final row.
  if (started || field !== "" || row.length > 0) endRow();

  // Drop a trailing empty row produced by a file ending in a newline.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }

  return rows;
}

/**
 * A header-addressed view of one row.
 *
 * Columns are looked up by name rather than position so a file with the
 * columns reordered, or with extra columns appended, still imports. Names are
 * matched case-insensitively and with punctuation and spacing folded, because
 * "Sale Date", "sale date" and "Sale  Date" are the same column and a person
 * re-exporting a spreadsheet should not have to know which one we expect.
 */
export class CsvTable {
  private index = new Map<string, number>();
  readonly headers: string[];
  readonly rows: string[][];

  constructor(parsed: string[][]) {
    this.headers = parsed[0] ?? [];
    this.rows = parsed.slice(1);
    this.headers.forEach((h, i) => {
      const key = foldHeader(h);
      // First occurrence wins; a duplicated header is the caller's problem to
      // report, not something to silently resolve to the last one.
      if (key && !this.index.has(key)) this.index.set(key, i);
    });
  }

  /** Whether every one of these column names is present. */
  hasAll(names: readonly string[]): boolean {
    return names.every((n) => this.index.has(foldHeader(n)));
  }

  /** Which of these column names are absent, for the error message. */
  missing(names: readonly string[]): string[] {
    return names.filter((n) => !this.index.has(foldHeader(n)));
  }

  /** A trimmed cell, or "" when the column is absent or the row is short. */
  cell(row: string[], name: string): string {
    const i = this.index.get(foldHeader(name));
    if (i === undefined) return "";
    return (row[i] ?? "").trim();
  }
}

function foldHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
