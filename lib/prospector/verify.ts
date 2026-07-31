/**
 * Candidate verification — does this URL actually publish tax sale data?
 *
 * Scoring is deterministic. A model may classify *what kind* of page this is,
 * but it does not get to assert that a page is a valid source: that decision
 * rests on evidence anyone can re-check — the host is a government publisher,
 * the page uses tax-sale vocabulary, it contains something that looks like a
 * parcel list. Same split the ingest judge already enforces: the model extracts,
 * code decides.
 *
 * A model's own confidence number is not evidence and is deliberately not used.
 */

import { z } from "zod";
import { NoProviderAvailableError, runStructured } from "../ai/providers";
import { PolicyBlockedError, politeFetch } from "../ingest/fetch";
import { isGovernmentSource } from "../ingest/policy";
import type {
  RejectedCandidate,
  SourceCandidate,
  SourceKind,
  VerifiedSource,
} from "./types";

/**
 * Vocabulary that distinguishes a tax sale page from the rest of a county site.
 *
 * Weighted: "tax deed sale" is decisive, "parcel" alone is not — a GIS page is
 * full of parcels and sells nothing.
 */
const VOCABULARY: { term: RegExp; weight: number; label: string }[] = [
  { term: /\btax\s+deed\s+sales?/i, weight: 3, label: "tax deed sale" },
  { term: /\btax\s+lien\s+sales?/i, weight: 3, label: "tax lien sale" },
  { term: /\bdelinquent\s+tax/i, weight: 2, label: "delinquent tax" },
  { term: /\btax\s+sales?\b/i, weight: 2, label: "tax sale" },
  { term: /\bforeclos\w*\s+(auction|sale)/i, weight: 2, label: "foreclosure auction" },
  { term: /\bcertificates?\s+of\s+purchase/i, weight: 2, label: "certificate of purchase" },
  { term: /\bstruck\s+off/i, weight: 2, label: "struck off" },
  { term: /\b(minimum|opening|upset)\s+bids?/i, weight: 2, label: "minimum/opening bid" },
  { term: /\bredemption\s+period/i, weight: 2, label: "redemption period" },
  // Apostrophe and plural both vary in the wild: "Sheriff Sales",
  // "Sheriff's Sale" and "Sheriffs Sale" are all the same page.
  { term: /\bsheriff'?s?\s+sales?/i, weight: 2, label: "sheriff sale" },
  { term: /\bbidder\s+registration/i, weight: 1, label: "bidder registration" },
  { term: /\bupset\s+(bid|sale)/i, weight: 2, label: "upset bid/sale" },
  { term: /\bmonition\s+sale/i, weight: 3, label: "monition sale" },
  { term: /\bparcels?\s*(id|number|#)/i, weight: 1, label: "parcel id" },
  { term: /\bassessed\s+value/i, weight: 1, label: "assessed value" },
];

/** Score at or above which a page counts as a tax-sale source. */
const MIN_VOCAB_SCORE = 4;

/** Rough test for a tabular parcel list — several rows of id-like tokens. */
const LIST_SHAPE = /(<tr[\s>][\s\S]{0,4000}){4,}|(\d{2,4}-\d{2,4}-\d{2,}[\s\S]{0,400}){3,}/i;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

export interface VocabularyScore {
  score: number;
  signals: string[];
  hasListShape: boolean;
}

/** Deterministic relevance scoring. Exported so the tests can pin it. */
export function scoreContent(html: string): VocabularyScore {
  const text = stripHtml(html);
  let score = 0;
  const signals: string[] = [];
  for (const { term, weight, label } of VOCABULARY) {
    if (term.test(text)) {
      score += weight;
      signals.push(label);
    }
  }
  return { score, signals, hasListShape: LIST_SHAPE.test(html) };
}

/**
 * Kind inferred from the URL and text without a model.
 *
 * Used as the answer when no LLM is configured, and as the fallback when the
 * provider chain fails — the Prospector must work offline.
 */
export function inferKind(url: string, html: string): SourceKind {
  const hay = `${url} ${stripHtml(html)}`.toLowerCase();
  if (/\b(result|sold|struck off|final report|past sale|prior sale)/.test(hay)) return "results";
  if (/\b(calendar|schedule|upcoming|sale dates)/.test(hay)) return "calendar";
  if (/\b(terms|rules|registration|how to bid|bidder information)/.test(hay)) return "rules";
  if (/\b(list|parcel|minimum bid|advertisement|notice of sale)/.test(hay)) return "listing";
  return "unknown";
}

const ClassificationSchema = z.object({
  kind: z
    .enum(["listing", "results", "rules", "calendar", "unknown"])
    .describe("What this page is primarily for."),
  scheduleHint: z
    .string()
    .max(240)
    .nullable()
    .describe(
      "Any stated sale timing, verbatim if possible (e.g. 'first Tuesday of each month'). Null if the page states none.",
    ),
});

const SYSTEM = `You classify county tax-sale web pages for an ingestion pipeline.

You are NOT deciding whether the page is a valid source — deterministic code has
already made that call from the host and the page's vocabulary. Your only jobs:

1. Say what the page is primarily for.
2. Report any sale timing the page actually states.

Do not infer a schedule that is not written on the page. Return null for
scheduleHint rather than guessing — a fabricated sale date sends crawlers at an
empty page indefinitely.`;

/**
 * Verify one candidate.
 *
 * Returns a `VerifiedSource` or a `RejectedCandidate`, never throws for the
 * ordinary failure modes: a policy block and a dead link are both results worth
 * recording, because they explain a coverage gap.
 */
export async function verifyCandidate(
  candidate: SourceCandidate,
  opts: { useLlm?: boolean } = {},
): Promise<VerifiedSource | RejectedCandidate> {
  const host = (() => {
    try {
      return new URL(candidate.url).hostname;
    } catch {
      return "";
    }
  })();

  if (!host) {
    return { ...candidate, reason: "fetch_failed", detail: "unparseable URL" };
  }

  let res;
  try {
    res = await politeFetch(candidate.url, { attempts: 2, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof PolicyBlockedError) {
      return {
        ...candidate,
        reason: "policy_blocked",
        detail: e.message,
      };
    }
    return {
      ...candidate,
      reason: "fetch_failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (res.status >= 400) {
    return { ...candidate, reason: "fetch_failed", detail: `HTTP ${res.status}` };
  }

  const isGov = isGovernmentSource(host);
  const { score, signals, hasListShape } = scoreContent(res.body);

  // A government host is preferred but does not exempt a page from having to be
  // about tax sales — a county homepage is a .gov and sells nothing.
  if (score < MIN_VOCAB_SCORE) {
    return {
      ...candidate,
      reason: "not_tax_sale_content",
      detail: `vocabulary score ${score} below ${MIN_VOCAB_SCORE}${
        signals.length ? ` (matched: ${signals.join(", ")})` : ""
      }`,
    };
  }

  let kind = inferKind(candidate.url, res.body);
  let scheduleHint: string | undefined;

  if (opts.useLlm !== false) {
    try {
      const { data } = await runStructured({
        system: SYSTEM,
        prompt:
          `URL: ${candidate.url}\n\nPAGE TEXT (truncated):\n` +
          stripHtml(res.body).slice(0, 6000),
        schema: ClassificationSchema,
        schemaName: "SourceClassification",
        maxTokens: 400,
      });
      kind = data.kind;
      scheduleHint = data.scheduleHint ?? undefined;
    } catch (e) {
      // No keys, or the chain failed. The deterministic inference stands.
      if (!(e instanceof NoProviderAvailableError)) {
        console.warn(`[prospector] classification failed for ${candidate.url}: ${e}`);
      }
    }
  }

  // Confidence is built only from checkable facts.
  let confidence = 0.3;
  if (isGov) confidence += 0.3;
  confidence += Math.min(0.25, score * 0.025);
  if (hasListShape) confidence += 0.1;
  if (candidate.origin === "atlas") confidence += 0.05;

  return {
    fips: candidate.fips,
    state: candidate.state,
    url: candidate.url,
    host,
    origin: candidate.origin,
    kind,
    isGovernment: isGov,
    confidence: Math.round(Math.min(1, confidence) * 100) / 100,
    signals,
    scheduleHint,
    verifiedOn: new Date().toISOString().slice(0, 10),
    httpStatus: res.status,
  };
}
