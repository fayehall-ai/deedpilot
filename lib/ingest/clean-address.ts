/**
 * An extracted street address, with the tax year taken back out.
 *
 * Burnett County, Wisconsin prints the tax year in the column beside the
 * address, and extraction ran them together: "2025 27175 ENGEBRETSON RD", or
 * "2025" alone where the parcel has no address. A recent year in front of a
 * long house number is dropped, and a bare year means there is no address — which
 * is what makes the parcel read as land-only, as it should.
 */
export function cleanAddressLine(line: string | null | undefined): string | undefined {
  const s = line?.trim();
  if (!s) return undefined;
  if (/^(19|20)\d{2}$/.test(s)) return undefined;
  /*
   * Narrow on purpose. "1921 19TH ST NW" (Washington DC) and "1991 34 RD"
   * (Butler, Nebraska) are real house numbers on real streets. Burnett's leak is
   * always a recent tax year before a rural house number of four digits or more
   * and then a street name — not a run of numbers, as Wyandotte's "2015 2017
   * 2019 … South Mill" is.
   */
  return s.replace(/^20[1-3]\d\s+(?=\d{4,}\s+[A-Za-z])/, "") || undefined;
}
