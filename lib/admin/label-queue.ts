import { readFileSync } from "node:fs";

/**
 * Sources waiting on a semantics decision, and the evidence to make it.
 *
 * The results crawl produced 3,724 candidate rows across 18 states, and not one
 * of them can be fitted until somebody states what its price column means.
 * That refusal is the system working — `labels.py` exists because
 * `winning_bid` is not the same quantity across sources, and pooling them
 * produces a "market price" model fitted mostly on tax amounts.
 *
 * What was missing is the other half: a person cannot write a label rule from a
 * refusal message. They need the source, a handful of real rows, and the
 * distribution — because the distribution is usually what gives the answer away.
 * A Florida tax-certificate page with a $137 median and an Oklahoma sheriff sale
 * with a $232,500 median are visibly not recording the same thing.
 *
 * Reads the candidate batch rather than the database on purpose: these rows are
 * deliberately *not* imported, and a review queue that could only see imported
 * rows would be empty exactly when it is needed.
 */

export interface CandidateRow {
  id: string;
  state: string;
  fips: string;
  county_name: string;
  sale_type: string;
  sale_date: string | null;
  opening_bid: number | null;
  winning_bid: number | null;
  assessed_value: number | null;
  redeemed: boolean;
  ownership_taken: boolean;
  source: string;
  notes: string;
}

export interface LabelCandidate {
  host: string;
  state: string;
  counties: string[];
  rows: number;
  /** Quartiles of `winning_bid`, which is usually what identifies the quantity. */
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  /** Share of rows where `winning_bid` equals `opening_bid` — a bid-down tell. */
  matchesOpeningBid: number;
  /**
   * True when every row carries `redeemed: false`.
   *
   * The Cook County shape. It means the field is a schema default rather than
   * an observation, and a rule for this source must set the disposition to
   * something other than "observed non-redemption" or it repeats the bug that
   * pinned Illinois at p_redeem = 0.02.
   */
  redemptionUnobserved: boolean;
  samples: CandidateRow[];
}

const DEFAULT_PATH = "data/results-candidates.jsonl";

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Read the candidate batch. Returns an empty queue when there is none. */
export function loadCandidates(path = DEFAULT_PATH): CandidateRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: CandidateRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as CandidateRow);
    } catch {
      // A malformed line is skipped rather than failing the queue — the point
      // of this view is to show what needs attention, and it must survive a
      // partially written batch.
    }
  }
  return rows;
}

/** Group candidates by publishing host, largest first. */
export function labelQueue(rows: CandidateRow[]): LabelCandidate[] {
  const byHost = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    const host = hostOf(r.source);
    byHost.set(host, [...(byHost.get(host) ?? []), r]);
  }

  return [...byHost]
    .map(([host, group]) => {
      const wins = group
        .map((g) => g.winning_bid)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .sort((a, b) => a - b);

      const withBoth = group.filter(
        (g) => typeof g.winning_bid === "number" && typeof g.opening_bid === "number",
      );
      const equal = withBoth.filter((g) => g.winning_bid === g.opening_bid).length;

      return {
        host,
        state: group[0]?.state ?? "",
        counties: [...new Set(group.map((g) => g.county_name))].sort(),
        rows: group.length,
        p25: quantile(wins, 0.25),
        median: quantile(wins, 0.5),
        p75: quantile(wins, 0.75),
        max: wins.length ? wins[wins.length - 1] : null,
        matchesOpeningBid: withBoth.length ? equal / withBoth.length : 0,
        redemptionUnobserved: group.every((g) => g.redeemed === false),
        samples: group.slice(0, 3),
      };
    })
    .sort((a, b) => b.rows - a.rows);
}

export interface LabelQueueSummary {
  hosts: number;
  rows: number;
  states: string[];
  /** Hosts whose every row carries the schema-default `redeemed: false`. */
  unobservedRedemption: number;
}

export function summariseQueue(queue: LabelCandidate[]): LabelQueueSummary {
  return {
    hosts: queue.length,
    rows: queue.reduce((n, q) => n + q.rows, 0),
    states: [...new Set(queue.map((q) => q.state))].filter(Boolean).sort(),
    unobservedRedemption: queue.filter((q) => q.redemptionUnobserved).length,
  };
}
