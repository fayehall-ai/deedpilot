/**
 * Resolving a published county label to a FIPS code.
 *
 * Imported rows name their county the way a person writes it — "Hinds County",
 * "St. Louis City", "Juneau City and Borough" — while `counties.name` holds the
 * bare name with no designator at all ("Hinds", "St. Louis", "Juneau"). Every
 * imported auction carries a foreign key to that table, so a label that fails
 * to resolve is a row that cannot be stored, and a label that resolves to the
 * *wrong* county is a sale filed under a county that is not holding it.
 *
 * ## `(state, name)` is not unique, and the collisions are real sale venues
 *
 * Six pairs in the reference table share a state and a bare name:
 *
 *     MD  Baltimore   24005 (county)  24510 (city)
 *     MO  St. Louis   29189 (county)  29510 (city)
 *     VA  Fairfax     51059 (county)  51600 (city)
 *     VA  Franklin    51067 (county)  51620 (city)
 *     VA  Richmond    51159 (county)  51760 (city)
 *     VA  Roanoke     51161 (county)  51770 (city)
 *
 * These are not near-duplicates to be collapsed. St. Louis City and St. Louis
 * County run separate tax sales on separate dates under separate collectors,
 * and Missouri is the single largest state in the imported calendar. Matching
 * on the bare name alone would put one county's sale under the other's FIPS
 * roughly half the time, and nothing downstream could detect it.
 *
 * The designator the publisher wrote is the only thing that separates them, so
 * it is preserved through normalisation rather than discarded: `isCity` records
 * that the label said *city*, and disambiguation uses it against the FIPS
 * convention where an independent city's last three digits are >= 500. That
 * rule was checked against every collision above and splits all six. It is used
 * *only* to break a tie between same-named rows — four ordinary Texas counties
 * also have tails >= 500, and they are never ambiguous, so they never reach it.
 *
 * ## Failing to match is a reportable outcome, not a fallback
 *
 * There is no "closest match" here and no fuzzy distance threshold. A label
 * that does not resolve exactly, or that stays ambiguous after the tie-break,
 * comes back as `null` with a reason for the operator to read. Guessing would
 * turn an obvious import error into a plausible-looking auction in the wrong
 * place, which is the failure this module exists to prevent.
 */

/** A county as the reference table holds it. */
export interface CountyRef {
  fips: string;
  name: string;
  /** Two-letter abbreviation. */
  state: string;
  stateName: string;
}

/** Why a label did not resolve. Surfaced to the operator verbatim. */
export type CountyMatchFailure =
  | { kind: "unknown_state"; state: string }
  | { kind: "no_match"; state: string; county: string }
  | { kind: "ambiguous"; state: string; county: string; candidates: string[] };

export type CountyMatch =
  | {
      ok: true;
      fips: string;
      /**
       * `name` — the label named this county (or county-equivalent) itself.
       * `parent` — the label named a *municipality*, and this is the county it
       * sits in. The municipality is not discarded; it goes into the auction's
       * title, or a township sale would be indistinguishable from a county one.
       */
      via: "name" | "parent";
      /** The municipality, when `via` is `parent`. */
      municipality?: string;
    }
  | { ok: false; reason: CountyMatchFailure };

/**
 * Designators a publisher may append, longest first.
 *
 * Order matters: "city and borough" has to be tested before "borough" and
 * before "city", or Juneau loses only its last word and never matches. Only one
 * designator is stripped, so "Charles City County" sheds "county" and keeps the
 * "City" that is genuinely part of its name.
 *
 * `city-county` and `city-borough` are deliberately *not* here, even though
 * Philadelphia and Anchorage are published that way. Folding removes hyphens,
 * so "Philadelphia City-County" and "Charles City County" become the same
 * string, and a designator matching both strips Charles City down to "charles"
 * and loses a real county. The hyphen is the only thing separating them, so
 * that pair is handled in `resolve` against the unfolded label instead.
 */
const DESIGNATORS = [
  "city and borough",
  "city and county",
  "census area",
  "municipality",
  "borough",
  "parish",
  "county",
  "city",
] as const;

/**
 * Fold a label to a comparison key.
 *
 * Diacritics, punctuation and hyphens are removed rather than preserved because
 * the two sides disagree about them and neither is wrong: the reference table
 * writes "Valdez-Cordova" and a publisher may write "Valdez Cordova"; "O'Brien"
 * appears both ways. `saint` folds to `st` for the same reason — Missouri and
 * Minnesota both publish "Saint" where the table holds "St.".
 */
function fold(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'’,]/g, "")
    .replace(/[-–—/]/g, " ")
    .replace(/\bsainte\b/g, "ste")
    .replace(/\bsaint\b/g, "st")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the label said it was.
 *
 * Three states, not two. `null` means the publisher wrote a bare name and did
 * not say — which is a different fact from "county", and against a colliding
 * name it is the difference between a tie-break and a guess. An earlier version
 * folded `null` into "county" and resolved a bare "Richmond" to Richmond County
 * on the reasoning that the county is the commoner case; it is, and that is not
 * the same as it being right.
 */
export type Designator = "city" | "county" | null;

export interface NormalizedCounty {
  /** The name with at most one trailing designator removed. */
  base: string;
  /** Which designator the label carried, if any. */
  designator: Designator;
}

/**
 * Split a published label into a comparable name and what it claimed to be.
 *
 * Exported for the tests, which pin the cases that actually collide rather than
 * the happy path. Note that "city and borough" reports `county`: Juneau is a
 * borough-type consolidation, not one of the independent cities the FIPS
 * convention marks.
 */
export function normalizeCountyName(raw: string): NormalizedCounty {
  const folded = fold(raw);
  for (const d of DESIGNATORS) {
    if (folded.endsWith(` ${d}`)) {
      return {
        base: folded.slice(0, -(d.length + 1)).trim(),
        // Only a bare "city" marks an independent city. "City-County" and
        // "City-Borough" are consolidations — Philadelphia and Anchorage are
        // the county for their area, not a city sitting inside one.
        designator: d === "city" ? "city" : "county",
      };
    }
  }
  return { base: folded, designator: null };
}

/** True when a FIPS code belongs to an independent city. See the header. */
function isIndependentCityFips(fips: string): boolean {
  return Number.parseInt(fips.slice(2), 10) >= 500;
}

/**
 * An index over the reference table, built once per import rather than per row.
 *
 * Keyed by state *and* by folded name, with a second key that also removes
 * spaces so "LaSalle" and "La Salle" reach the same bucket. Both keys map to
 * lists, because the collisions above are the entire point.
 */
export class CountyIndex {
  private byState = new Map<string, Map<string, CountyRef[]>>();
  private byStateNoSpace = new Map<string, Map<string, CountyRef[]>>();
  /** Folded state name and abbreviation both resolve to the abbreviation. */
  private states = new Map<string, string>();

  constructor(rows: CountyRef[]) {
    for (const row of rows) {
      const st = row.state.toUpperCase();
      this.states.set(fold(row.state), st);
      this.states.set(fold(row.stateName), st);

      const key = fold(row.name);
      push(this.byState, st, key, row);
      push(this.byStateNoSpace, st, key.replace(/ /g, ""), row);
    }
  }

  /** Resolve a published state label to an abbreviation, or null. */
  resolveState(state: string): string | null {
    return this.states.get(fold(state)) ?? null;
  }

  /** Rows in a state under a folded key, falling back to the space-blind index. */
  private lookup(state: string, key: string): CountyRef[] {
    return (
      this.byState.get(state)?.get(key) ??
      this.byStateNoSpace.get(state)?.get(key.replace(/ /g, "")) ??
      []
    );
  }

  /**
   * Resolve a published (state, county) pair to a single FIPS code.
   *
   * Returns a reason rather than throwing: one unresolvable label out of 644
   * must not abort an import, and the operator needs to see all of them at once.
   */
  resolve(stateLabel: string, countyLabel: string): CountyMatch {
    const state = this.resolveState(stateLabel);
    if (!state) return { ok: false, reason: { kind: "unknown_state", state: stateLabel } };

    const direct = this.resolveName(state, countyLabel);
    if (direct.ok) return direct;

    /*
     * A consolidated city-county, published with the hyphen: "Philadelphia
     * City-County", "Anchorage City-Borough". Matched against the raw label
     * because the hyphen is load-bearing — see the note on DESIGNATORS.
     */
    const hyphenated = /^(.*?)\s+city-(?:county|borough)\s*$/i.exec(countyLabel.trim());
    if (hyphenated) {
      const consolidated = this.resolveName(state, hyphenated[1]);
      if (consolidated.ok) return consolidated;
    }

    /*
     * A municipal sale: "Dublin City (Laurens)", "Lumberton Township
     * (Burlington)". The publisher names the municipality holding the sale and
     * puts its county in brackets.
     *
     * Whole states depend on this. New Jersey, Connecticut, Rhode Island and
     * Vermont hold tax sales at the municipal level and essentially never at
     * the county level, so treating a bracketed label as unreadable drops those
     * states from the calendar entirely rather than partially.
     *
     * The part *outside* the brackets is tried first, because in Virginia it is
     * usually the answer: "Portsmouth City (Portsmouth)" names an independent
     * city, which is itself a county-equivalent with its own FIPS. Only when
     * that fails is the bracketed county used, and then the municipality is
     * carried back to the caller rather than dropped — a township's sale filed
     * under its county with no further label would be indistinguishable from
     * the county's own.
     */
    const bracketed = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(countyLabel.trim());
    if (bracketed) {
      const [, outer, inner] = bracketed;
      const asSelf = this.resolveName(state, outer);
      if (asSelf.ok) return asSelf;

      const asParent = this.resolveName(state, inner);
      if (asParent.ok) {
        return { ok: true, fips: asParent.fips, via: "parent", municipality: outer.trim() };
      }
    }

    /*
     * A consolidated city-county written with both names: Georgia publishes
     * "Athens-Clarke County" and "Augusta-Richmond County" where the reference
     * table holds only the county half. Tried last, and only on a label that
     * actually carried a hyphen, so it cannot reach a name that resolved
     * normally — "Valdez-Cordova" matches in full long before this.
     */
    if (countyLabel.includes("-")) {
      const tail = countyLabel.slice(countyLabel.lastIndexOf("-") + 1);
      const consolidated = this.resolveName(state, tail);
      if (consolidated.ok) return consolidated;
    }

    return direct;
  }

  /**
   * One attempt at a single name, with no bracket or hyphen handling.
   *
   * Split out so `resolve` can try several readings of an awkward label without
   * duplicating the collision logic, which is the part that must not drift.
   */
  private resolveName(state: string, countyLabel: string): CountyMatch {
    /*
     * The whole label is tried before the stripped one, because five counties
     * are *named* for a designator: Charles City and James City in Virginia,
     * and the Alaskan boroughs. Stripping first turns "Charles City" into
     * "charles", which matches nothing, and the county silently fails to
     * import. Trying the full string first costs one map lookup and makes the
     * strip a fallback rather than a precondition.
     */
    const whole = this.lookup(state, fold(countyLabel));
    if (whole.length === 1) return { ok: true, fips: whole[0].fips, via: "name" };

    const { base, designator } = normalizeCountyName(countyLabel);
    const candidates = base ? this.lookup(state, base) : [];

    if (candidates.length === 0) {
      return { ok: false, reason: { kind: "no_match", state, county: countyLabel } };
    }
    if (candidates.length === 1) return { ok: true, fips: candidates[0].fips, via: "name" };

    /*
     * Ambiguous. Only an explicit designator breaks the tie: "St. Louis City"
     * wants the independent city, "St. Louis County" wants the county, and a
     * bare "St. Louis" resolves to neither. Deliberately not a preference for
     * the more populous or more frequently seen of the two — both hold sales,
     * and a silent lean toward one would be wrong invisibly.
     */
    if (designator !== null) {
      const wanted = candidates.filter(
        (c) => isIndependentCityFips(c.fips) === (designator === "city"),
      );
      if (wanted.length === 1) return { ok: true, fips: wanted[0].fips, via: "name" };
    }

    return {
      ok: false,
      reason: {
        kind: "ambiguous",
        state,
        county: countyLabel,
        candidates: candidates.map((c) => c.fips),
      },
    };
  }
}

function push(
  outer: Map<string, Map<string, CountyRef[]>>,
  state: string,
  key: string,
  row: CountyRef,
): void {
  let inner = outer.get(state);
  if (!inner) outer.set(state, (inner = new Map()));
  const list = inner.get(key);
  if (list) list.push(row);
  else inner.set(key, [row]);
}

/** Human-readable form of a failure, for the import report. */
export function describeFailure(r: CountyMatchFailure): string {
  switch (r.kind) {
    case "unknown_state":
      return `unknown state "${r.state}"`;
    case "no_match":
      return `no county named "${r.county}" in ${r.state}`;
    case "ambiguous":
      return `"${r.county}" in ${r.state} matches ${r.candidates.join(" and ")} — add "County" or "City" to the label`;
  }
}
