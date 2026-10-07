/**
 * Which tax year a sale list's "taxes owed" is for.
 *
 * Lists print the amount owed without a year column the ingest keeps, so the
 * year — when a county prints it — survives only in the lot's raw row, under
 * whatever heading that county chose: "Tax Year", "TaxYear", "Judgment
 * Through Tax Year: 2025" (Texas MVBA lists), "Years Delinquent: 2019-2023".
 * This reads it back out so the page can say "taxes owed · tax year 2025"
 * instead of an amount with no period attached.
 *
 * Only a heading that names a tax year counts. A bare "Year" column is as
 * likely to be the year built, and a sale date's year is not a tax year.
 */

/** Headings that name the tax year or years an amount is owed for. */
const YEAR_KEY =
  /(tax[\s_-]*years?|years?[\s_-]*(delinquent|due|owed)|delinquent[\s_-]*years?|judgment[\s_-]*through|certificate[\s_-]*year|cert[\s_-]*year)/i;
/** Headings that look like a year but are not a tax year. */
const NOT_TAX = /(built|sale|sold|construct|acquired|purchase)/i;

export interface TaxYear {
  /** "2025", or "2019–2023" when the list gives a span. */
  label: string;
  /** Latest year in the span, for comparisons. */
  latest: number;
}

function yearsIn(v: unknown): number[] {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  return [...s.matchAll(/\b(19[89]\d|20\d\d)\b/g)].map((m) => Number(m[1]));
}

/**
 * The tax year from a lot's raw row, or null when no heading names one.
 * Nested objects are searched one level down, where adapters keep the
 * original row under `row`/`fields`.
 */
export function taxYearFromRaw(raw: Record<string, unknown> | null | undefined): TaxYear | null {
  if (!raw) return null;
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      entries.push(...Object.entries(v as Record<string, unknown>));
    } else {
      entries.push([k, v]);
    }
  }
  const thisYear = new Date().getFullYear();
  for (const [k, v] of entries) {
    if (!YEAR_KEY.test(k) || NOT_TAX.test(k)) continue;
    const years = yearsIn(v).filter((y) => y <= thisYear + 1);
    if (!years.length) continue;
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    return { label: lo === hi ? String(hi) : `${lo}–${hi}`, latest: hi };
  }
  return null;
}
