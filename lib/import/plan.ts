/**
 * Deciding what each imported row should do to the database.
 *
 * Pulled out of `applyImport` and made pure so the de-duplication rules can be
 * tested. They are the part of the import most likely to be quietly wrong —
 * every failure mode here produces a *plausible* calendar rather than an error,
 * so a bug is invisible until someone notices a county holding the same sale
 * twice on the same day. Nothing about that shows up in a stack trace.
 *
 * No database, no clock, no IO: existing rows go in as data, decisions come out
 * as data.
 */

import type { ResolvedAuction } from "./apply";
import { IMPORT_ID_PREFIX } from "./provenance";

/** An auction already in the database, reduced to what a decision needs. */
export interface ExistingAuction {
  id: string;
  countyFips: string;
  saleDate: string;
  externalId: string;
}

export type Decision =
  /** A second row in this file with an id an earlier row already used. */
  | { kind: "duplicate_in_file"; row: ResolvedAuction }
  /** A row a previous upload created. Refresh it in place. */
  | { kind: "update"; row: ResolvedAuction; id: string }
  /** The same sale the crawler already holds. Contribute the count only. */
  | { kind: "merge"; row: ResolvedAuction; id: string }
  /** A sale nothing else has. */
  | { kind: "insert"; row: ResolvedAuction };

/** A county and date where the pairing was not one-to-one. */
export interface Ambiguity {
  countyFips: string;
  countyLabel: string;
  saleDate: string;
  existing: number;
  imported: number;
}

export interface ImportPlan {
  decisions: Decision[];
  ambiguous: Ambiguity[];
}

/** Anything this import created carries a namespaced id. */
const OWNED_PREFIX = IMPORT_ID_PREFIX;

export function planImport(rows: ResolvedAuction[], existing: ExistingAuction[]): ImportPlan {
  const decisions: Decision[] = [];
  const ambiguous: Ambiguity[] = [];

  /*
   * Rows this import already owns, keyed *without* platform.
   *
   * The unique index is (county, platform, external_id), but platform is
   * derived from the published sale site and can change between exports — a
   * county that moves from its own portal to GovEase changes it. Keying the
   * lookup on platform too would miss the existing row and insert a second one,
   * so the match is on county and id, and platform is simply updated.
   */
  const owned = new Map<string, string>();
  /** Crawled auctions by county and date — candidates for a merge. */
  const crawled = new Map<string, string[]>();

  for (const e of existing) {
    if (e.externalId.startsWith(OWNED_PREFIX)) {
      owned.set(`${e.countyFips}|${e.externalId}`, e.id);
    } else {
      const key = `${e.countyFips}|${e.saleDate}`;
      const list = crawled.get(key);
      if (list) list.push(e.id);
      else crawled.set(key, [e.id]);
    }
  }

  /* How many rows this file has per county and date, so a pairing is only made
   * when it is unambiguous from both sides. */
  const importedPerDay = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.countyFips}|${r.saleDate}`;
    importedPerDay.set(key, (importedPerDay.get(key) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const reported = new Set<string>();
  /* Merges are one-to-one: once a crawled auction has absorbed a row, it is no
   * longer a candidate. Without this, two rows differing only by id would both
   * merge into the same auction and the second would vanish silently. */
  const consumed = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.externalId)) {
      decisions.push({ kind: "duplicate_in_file", row });
      continue;
    }
    seen.add(row.externalId);

    const ownedId = owned.get(`${row.countyFips}|${row.externalId}`);
    if (ownedId) {
      decisions.push({ kind: "update", row, id: ownedId });
      continue;
    }

    const dayKey = `${row.countyFips}|${row.saleDate}`;
    const candidates = (crawled.get(dayKey) ?? []).filter((id) => !consumed.has(id));
    const importedHere = importedPerDay.get(dayKey) ?? 1;

    if (candidates.length === 1 && importedHere === 1) {
      consumed.add(candidates[0]);
      decisions.push({ kind: "merge", row, id: candidates[0] });
      continue;
    }

    if (candidates.length > 0 && !reported.has(dayKey)) {
      reported.add(dayKey);
      ambiguous.push({
        countyFips: row.countyFips,
        countyLabel: `${row.countyLabel}, ${row.stateLabel}`,
        saleDate: row.saleDate,
        existing: candidates.length,
        imported: importedHere,
      });
    }

    decisions.push({ kind: "insert", row });
  }

  return { decisions, ambiguous };
}
