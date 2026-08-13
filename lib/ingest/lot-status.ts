/**
 * Read a county's own words about what happened to a parcel.
 *
 * This is the only path to a *cause*. `reconcile.ts` can see that a parcel
 * stopped being published and writes `withdrawn`, which records an observation
 * and asserts nothing about why — owner paid, bankruptcy stay, title defect and
 * clerical error are indistinguishable from an absence. When the county prints
 * REDEEMED on the page, that is different in kind: somebody published the
 * reason, and an adapter may pass it through.
 *
 * ## Why this is shared rather than per-adapter
 *
 * Three adapters had their own copy and they had drifted. `lgbs` recognised
 * "struck" and "stayed"; `florida-clerks` did not. Worse, one Florida path read
 *
 *     status: /redeem|cancel|sold/.test(raw) ? "redeemed" : "pending"
 *
 * which recorded every **sold** and **cancelled** parcel as redeemed — a cause
 * nobody observed, written into the column a redemption analysis would read. One
 * parser with one vocabulary makes that class of drift impossible.
 *
 * ## `redeemed` here means the PRE-sale cure
 *
 * The owner paid the delinquency before the sale, so the parcel never sold. It
 * is *not* the post-sale statutory redemption that `p_redeem` models. See the
 * note on `lotStatusEnum`.
 */

import type { LotStatus } from "./types";

/**
 * Ordered, because county pages routinely carry more than one of these words —
 * "SOLD - redemption period expires 2027-01-02" must read as sold, not redeemed.
 * The most specific disposition wins, and `sold` outranks everything because a
 * sale is the terminal event.
 */
/*
 * Stems carry `\w*` so an inflection matches: `\bredeem\b` cannot match
 * "redeemed", because the trailing boundary lands before the suffix rather than
 * after it. Whole words keep a bare `\b` on both sides so "sold" does not fire
 * inside "soldier".
 */
const RULES: { status: LotStatus; pattern: RegExp }[] = [
  { status: "sold", pattern: /\b(sold|purchased|purchaser|awarded|winning bid)\b/ },
  {
    status: "struck",
    pattern: /\b(struck|no bid|no sale|forfeit\w*|escheat\w*|county acquired)\b/,
  },
  {
    status: "redeemed",
    pattern: /\b(redeem\w*|paid in full|paid prior|taxes paid|satisfied)\b/,
  },
  {
    status: "cancelled",
    pattern: /\b(cancel\w*|stayed|bankrupt\w*|void\w*|rescind\w*|set aside)\b/,
  },
  {
    status: "withdrawn",
    pattern: /\b(withdraw\w*|withdrew|pulled|removed|deleted|deferred|postpon\w*)\b/,
  },
];

/**
 * Map a county's status text to a disposition.
 *
 * Returns `pending` for anything unrecognised, including empty text. That is
 * the honest default: an unreadable status means the parcel is still listed as
 * far as we know, and guessing a disposition from an unfamiliar word would
 * invent an observation.
 */
export function parseLotStatus(raw: string | null | undefined): LotStatus {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return "pending";
  for (const rule of RULES) if (rule.pattern.test(s)) return rule.status;
  return "pending";
}

/**
 * Did the county actually say something, or are we defaulting?
 *
 * Lets a caller tell "the page said OPEN" from "the page said nothing" — the
 * two produce the same `pending` and mean different things to anything counting
 * how much of a list carries published dispositions.
 */
export function statusWasAsserted(raw: string | null | undefined): boolean {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return false;
  return RULES.some((r) => r.pattern.test(s));
}
