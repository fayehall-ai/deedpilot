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

import * as cheerio from "cheerio";
import { z } from "zod";
import { NoProviderAvailableError, runStructured } from "../ai/providers";
import { PolicyBlockedError, politeFetch } from "../ingest/fetch";
import { discoveryLinks } from "../ingest/parse";
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

  /*
   * Statutory names for the same thing, state by state.
   *
   * The table above is written in the vocabulary of deed and lien states, and
   * it silently fails everywhere the legislature chose different words.
   * Kentucky is the case that exposed it: McCracken County's own delinquent-tax
   * page says "certificate of delinquency" three times, "third party purchaser"
   * once and "delinquent tax" fourteen times — and scored 2 against a threshold
   * of 4, so a page that is unambiguously the sale was rejected as not being
   * about tax sales at all. Every Kentucky county failed the same way, and KY
   * is the fourth largest state in the imported calendar.
   *
   * Each of these is a term of art. No county homepage says "certificate of
   * delinquency" or "adjudicated property" in passing, so they raise the score
   * only where they should — which is why the fix is more vocabulary rather
   * than a lower threshold.
   */
  { term: /\bcertificates?\s+of\s+delinquency/i, weight: 3, label: "certificate of delinquency (KY)" },
  { term: /\bthird[-\s]part(y|ies)\s+purchasers?/i, weight: 2, label: "third party purchaser (KY)" },
  { term: /\btax\s+sale\s+certificates?/i, weight: 3, label: "tax sale certificate" },
  { term: /\badjudicated\s+propert(y|ies)/i, weight: 3, label: "adjudicated property (LA)" },
  { term: /\bforfeited\s+land/i, weight: 3, label: "forfeited land (OH/WV)" },
  { term: /\bcollector'?s\s+deed/i, weight: 2, label: "collector's deed (MO)" },
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
/**
 * Shared, mutable fetch allowance for one county.
 *
 * Depth alone does not bound work — it multiplies. A depth-2 crawl following
 * six links, each following three more, is up to 108 fetches for one county;
 * at the polite delay a government host deserves that is minutes per county and
 * a national run never finishes. The budget is the actual limit, and it is
 * shared across the whole recursion rather than reset per branch.
 */
export interface FetchBudget {
  remaining: number;
}

export function newBudget(n = 12): FetchBudget {
  return { remaining: n };
}

export async function verifyCandidate(
  candidate: SourceCandidate,
  opts: { useLlm?: boolean; depth?: number; budget?: FetchBudget } = {},
): Promise<VerifiedSource | RejectedCandidate> {
  const budget = opts.budget ?? newBudget();
  if (budget.remaining <= 0) {
    return { ...candidate, reason: "fetch_failed", detail: "county fetch budget exhausted" };
  }
  budget.remaining--;
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
    // Probing an unknown domain is not the same as fetching a known source.
    // Two attempts at a 20s timeout is right for a county we depend on and
    // ruinous for a guessed hostname: a handful of dead guesses per county
    // turns a national run from hours into days, and nearly all of that time is
    // spent waiting on hosts that were never going to answer. A real county
    // site responds in under three seconds.
    const probe = candidate.origin === "platform_pattern" || candidate.origin === "link_followed";
    res = await politeFetch(candidate.url, {
      attempts: probe ? 1 : 2,
      timeoutMs: probe ? 8_000 : 20_000,
    });
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
    // A generated county domain resolves to a homepage — exactly the page that
    // *should* fail this check, and also the page most likely to link to the
    // sale. Crawl inward rather than rejecting: the domains were never the
    // problem, stopping at the front door was.
    //
    // Budgeted at two hops because that is the real shape of a county site:
    // homepage → Treasurer → Tax Sale. Direct links are tried first at every
    // depth, so a site that names the sale in its nav costs one fetch.
    const depth = opts.depth ?? 2;
    if (depth > 0) {
      const $ = cheerio.load(res.body);
      const { direct, department } = discoveryLinks($, candidate.url);
      // Department links only earn a hop when we still have budget beyond it.
      const toFollow = [...direct.slice(0, 3), ...(depth > 1 ? department.slice(0, 2) : [])];

      for (const link of toFollow) {
        if (budget.remaining <= 0) break;
        const followed = await verifyCandidate(
          {
            ...candidate,
            url: link,
            origin: "link_followed",
            label: `${candidate.label} → ${link.split("/").slice(3).join("/").slice(0, 40)}`,
          },
          { ...opts, depth: depth - 1, budget },
        );
        if (!("reason" in followed)) return followed;
      }
    }
    return {
      ...candidate,
      reason: "not_tax_sale_content",
      detail: `vocabulary score ${score} below ${MIN_VOCAB_SCORE}${
        signals.length ? ` (matched: ${signals.join(", ")})` : ""
      }${depth > 0 ? `; crawled ${depth} hop(s) inward, no sale page found` : ""}`,
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
